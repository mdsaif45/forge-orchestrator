import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm'
import { z } from 'zod'
import {
  evidenceArtifactSchema,
  testCountsSchema,
  isTerminalWorkflowState,
  summariseEvidence,
  transition,
  workflowCheckpointSchema,
  workflowLimitsSchema,
  workflowSchema,
  workflowStepSchema,
  type Actor,
  type EvidenceArtifact,
  type ProjectId,
  type QuestionId,
  type Workflow,
  type WorkflowCheckpoint,
  type WorkflowId,
  type WorkflowLimits,
  type WorkflowState,
  type WorkflowStep,
  type WorkflowTrigger,
} from '@shared/domain'
import type { ForgeDatabase } from './connection'
import { EventStore } from './eventStore'
import { applyEvent } from './projections'
import { fromJson, parseRow } from './rows'
import { evidenceArtifacts, workflows, workflowSteps } from './schema'

/**
 * The command layer for workflows.
 *
 * Every mutation is append-then-project, like `ProjectStore`, but with one extra
 * guarantee that matters more here than anywhere else: **the event is written before the
 * side effect runs**.
 *
 * ```
 * checkpoint(step) ──> event persisted ──> side effect ──> result event persisted
 *        │                                      │
 *   killed here                            killed here
 *        │                                      │
 *   resume: redo the step                  resume: continue
 * ```
 *
 * That ordering is why a crash is recoverable rather than merely survivable. If the record
 * of what was being attempted is written only *after* the attempt, then a process killed
 * mid-step leaves no trace of the step, and resume has to guess. Writing first means the
 * worst case is a step redone, not a step lost — which is also why steps must be
 * idempotent.
 */

export interface StartWorkflowInput {
  readonly workflowId: WorkflowId
  readonly projectId: ProjectId
  readonly taskId: Workflow['taskId']
  readonly templateId: string
  readonly limits?: Partial<WorkflowLimits>
  readonly startedAt: string
}

export class WorkflowStore {
  private readonly events: EventStore

  constructor(private readonly db: ForgeDatabase) {
    this.events = new EventStore(db)
  }

  start(input: StartWorkflowInput, actor: Actor): Workflow {
    const limits = workflowLimitsSchema.parse(input.limits ?? {})

    this.db.transaction(() => {
      const event = this.events.append(
        {
          type: 'workflow.started',
          payload: {
            workflowId: input.workflowId,
            taskId: input.taskId,
            templateId: input.templateId,
            limits,
            startedAt: input.startedAt,
          },
        },
        { projectId: input.projectId, actor, occurredAt: input.startedAt },
      )

      applyEvent(this.db, event)
    })

    const workflow = this.find(input.workflowId)
    if (workflow === null) {
      throw new Error(`Workflow ${input.workflowId} was not projected after being started`)
    }

    return workflow
  }

  /**
   * Applies a trigger, writing the transition to the log before touching the read model.
   *
   * The legality check is `transition()`'s, which throws on an illegal move — so an
   * impossible transition never reaches the log. That ordering matters: a rejected trigger
   * must leave no trace, or the log would record state changes that did not happen.
   */
  apply(
    workflowId: WorkflowId,
    trigger: WorkflowTrigger,
    actor: Actor,
    occurredAt: string,
    options: {
      readonly reason?: string | undefined
      readonly questionId?: QuestionId | undefined
    } = {},
  ): Workflow {
    const workflow = this.require(workflowId)

    const result = transition(workflow.state, trigger, {
      resumeState: workflow.resumeState,
      iteration: workflow.iteration,
      maxIterations: workflow.limits.maxIterations,
    })

    this.db.transaction(() => {
      const transitioned = this.events.append(
        {
          type: 'workflow.transitioned',
          payload: {
            workflowId,
            from: result.from,
            to: result.to,
            iteration: result.iteration,
            blockedByQuestionId:
              result.to === 'AWAITING_USER' ? (options.questionId ?? null) : null,
          },
        },
        {
          projectId: this.projectIdOf(workflowId),
          actor,
          occurredAt,
          ...(options.reason === undefined ? {} : { reason: options.reason }),
        },
      )
      applyEvent(this.db, transitioned)

      // A halt needs its reason recorded, and `workflowSchema` refuses a halted workflow
      // without one. Emitted as its own event so the log distinguishes "moved to
      // HALTED_LIMIT" from "and here is why".
      if (result.to === 'HALTED_LIMIT' || result.to === 'HALTED_POLICY') {
        const halted = this.events.append(
          {
            type: 'workflow.halted',
            payload: {
              workflowId,
              state: result.to,
              haltReason:
                options.reason ??
                (result.to === 'HALTED_LIMIT'
                  ? `Reached the maximum of ${String(workflow.limits.maxIterations)} iterations`
                  : 'A policy was violated'),
            },
          },
          { projectId: this.projectIdOf(workflowId), actor, occurredAt },
        )
        applyEvent(this.db, halted)
      }

      if (isTerminalWorkflowState(result.to)) {
        const finished = this.events.append(
          {
            type: 'workflow.finished',
            payload: { workflowId, state: result.to, finishedAt: occurredAt },
          },
          { projectId: this.projectIdOf(workflowId), actor, occurredAt },
        )
        applyEvent(this.db, finished)
      }
    })

    return this.require(workflowId)
  }

  /**
   * Records what is about to be attempted, before it is attempted.
   *
   * This is the write-ahead half of crash recovery. `lastOperation` is deliberately
   * human-readable: it is what the resume banner shows the user, and "spawning the
   * implementer" is more useful than a step index alone.
   */
  checkpoint(
    workflowId: WorkflowId,
    checkpoint: WorkflowCheckpoint,
    actor: Actor,
    occurredAt: string,
  ): void {
    const parsed = workflowCheckpointSchema.parse(checkpoint)

    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'workflow.checkpointed', payload: { workflowId, checkpoint: parsed } },
        { projectId: this.projectIdOf(workflowId), actor, occurredAt },
      )
      applyEvent(this.db, event)
    })
  }

  /** Records a step beginning. Safe to call again for the same step id on a resume. */
  startStep(workflowId: WorkflowId, step: WorkflowStep, actor: Actor, occurredAt: string): void {
    const parsed = workflowStepSchema.parse(step)

    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'step.started', payload: { workflowId, step: parsed } },
        { projectId: this.projectIdOf(workflowId), actor, occurredAt },
      )
      applyEvent(this.db, event)
    })
  }

  finishStep(
    workflowId: WorkflowId,
    stepId: WorkflowStep['id'],
    outcome: {
      readonly verdict: WorkflowStep['verdict']
      readonly changeSetId: WorkflowStep['changeSetId']
    },
    actor: Actor,
    occurredAt: string,
  ): void {
    this.db.transaction(() => {
      const event = this.events.append(
        {
          type: 'step.finished',
          payload: {
            workflowId,
            stepId,
            verdict: outcome.verdict,
            changeSetId: outcome.changeSetId,
            finishedAt: occurredAt,
          },
        },
        { projectId: this.projectIdOf(workflowId), actor, occurredAt },
      )
      applyEvent(this.db, event)
    })
  }

  /**
   * Records what Forge observed when it ran a command itself (axiom A3).
   *
   * Written after the run rather than before it, unlike a step: the artifact *is* the
   * result, so there is nothing to write ahead of. The step's own checkpoint is what
   * makes a crash mid-run recoverable — the command is simply re-run, which is safe
   * because a build or test run is idempotent in the only sense that matters here
   * (running it again produces evidence, not a second side effect on the domain).
   */
  recordEvidence(artifact: EvidenceArtifact, actor: Actor, occurredAt: string): void {
    const parsed = evidenceArtifactSchema.parse(artifact)

    this.db.transaction(() => {
      const event = this.events.append(
        {
          type: 'evidence.recorded',
          payload: {
            artifact: parsed,
            workflowId: parsed.workflowId,
            stepId: parsed.stepId,
            summary: summariseEvidence(parsed),
          },
        },
        { projectId: this.projectIdOf(parsed.workflowId), actor, occurredAt },
      )
      applyEvent(this.db, event)
    })
  }

  /**
   * Evidence recorded for one step, oldest first.
   *
   * Read-only, like every other reader here: the verdict is recomputed from the
   * artifact by `evidencePassed` rather than stored, so no row can claim a verdict
   * that disagrees with the exit code beside it.
   */
  evidenceForStep(stepId: WorkflowStep['id']): readonly EvidenceArtifact[] {
    const rows = this.db
      .select()
      .from(evidenceArtifacts)
      .where(eq(evidenceArtifacts.stepId, stepId))
      .orderBy(asc(evidenceArtifacts.recordedAt))
      .all()

    return rows.map((row) =>
      parseRow(
        evidenceArtifactSchema,
        {
          id: row.id,
          workflowId: row.workflowId,
          stepId: row.stepId,
          kind: row.kind,
          command: row.command,
          cwd: row.cwd,
          outcome: row.outcome,
          exitCode: row.exitCode,
          durationMs: row.durationMs,
          stdout: row.stdout,
          stderr: row.stderr,
          truncated: row.truncated !== 0,
          counts:
            row.counts === null
              ? null
              : fromJson(testCountsSchema, row.counts, 'evidence_artifacts.counts'),
          failure: row.failure,
          recordedAt: row.recordedAt,
        },
        'evidence_artifacts',
      ),
    )
  }

  /**
   * Workflows that were mid-step when the process stopped.
   *
   * "Interrupted" is defined as *has a checkpoint and has not finished* — a definition
   * that falls out of the write-ahead ordering rather than needing a flag: a checkpoint is
   * written before a step's side effects and cleared when the workflow finishes, so its
   * presence on an unfinished workflow means something was in flight when the process
   * died.
   *
   * Detecting this at startup is what makes the offer of Resume or Abandon possible.
   */
  findInterrupted(): readonly Workflow[] {
    return this.db
      .select()
      .from(workflows)
      .where(and(isNotNull(workflows.checkpoint), isNull(workflows.finishedAt)))
      .all()
      .map((row) => this.toDomain(row))
  }

  find(workflowId: WorkflowId): Workflow | null {
    const row = this.db.select().from(workflows).where(eq(workflows.id, workflowId)).all().at(0)
    return row === undefined ? null : this.toDomain(row)
  }

  listForProject(projectId: ProjectId): readonly Workflow[] {
    return this.db
      .select()
      .from(workflows)
      .where(eq(workflows.projectId, projectId))
      .orderBy(asc(workflows.startedAt))
      .all()
      .map((row) => this.toDomain(row))
  }

  private require(workflowId: WorkflowId): Workflow {
    const workflow = this.find(workflowId)
    if (workflow === null) throw new Error(`Unknown workflow "${workflowId}"`)
    return workflow
  }

  projectIdOf(workflowId: WorkflowId): ProjectId {
    const row = this.db
      .select({ projectId: workflows.projectId })
      .from(workflows)
      .where(eq(workflows.id, workflowId))
      .all()
      .at(0)

    if (row === undefined) throw new Error(`Unknown workflow "${workflowId}"`)
    return row.projectId as ProjectId
  }

  /**
   * Assembles the workflow and validates it on the way out.
   *
   * Parsing here is what catches a projection that produced an impossible combination —
   * `AWAITING_USER` with no resume state, a halt with no reason — at the boundary rather
   * than several layers into the engine.
   */
  private toDomain(row: typeof workflows.$inferSelect): Workflow {
    const steps = this.db
      .select()
      .from(workflowSteps)
      .where(eq(workflowSteps.workflowId, row.id))
      .orderBy(asc(workflowSteps.index))
      .all()
      .map((step) =>
        parseRow(
          workflowStepSchema,
          {
            id: step.id,
            index: step.index,
            role: step.role,
            runtimeId: step.runtimeId,
            state: step.state,
            contextRef: step.contextRef,
            reportStatus: step.reportStatus,
            verdict: step.verdict,
            changeSetId: step.changeSetId,
            startedAt: step.startedAt,
            finishedAt: step.finishedAt,
          },
          'workflow_steps row',
        ),
      )

    return parseRow(
      workflowSchema,
      {
        id: row.id,
        taskId: row.taskId,
        templateId: row.templateId,
        state: row.state,
        iteration: row.iteration,
        limits: fromJson(workflowLimitsSchema, row.limits, 'workflows.limits'),
        steps,
        checkpoint:
          row.checkpoint === null
            ? null
            : fromJson(workflowCheckpointSchema, row.checkpoint, 'workflows.checkpoint'),
        resumeState: row.resumeState,
        blockedByQuestionId: row.blockedByQuestionId,
        haltReason: row.haltReason,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
      },
      'workflows row',
    )
  }
}

/** What the user is offered when an interrupted workflow is found at startup. */
export const resumeDecisionSchema = z.enum(['resume', 'abandon'])
export type ResumeDecision = z.infer<typeof resumeDecisionSchema>

/**
 * What a resume would do, without doing it.
 *
 * Computed so the UI can describe the choice concretely — state, step n/m, and the last
 * operation attempted — rather than asking the user to approve something unspecified.
 */
export interface ResumePlan {
  readonly workflowId: WorkflowId
  readonly state: WorkflowState
  readonly stepIndex: number
  readonly totalSteps: number
  readonly lastOperation: string
  /** The snapshotted packet the interrupted step will replay. */
  readonly inputRef: string | null
  readonly startedAt: string
}

export function planResume(workflow: Workflow): ResumePlan | null {
  const checkpoint = workflow.checkpoint
  if (checkpoint === null) return null

  return {
    workflowId: workflow.id,
    state: checkpoint.state,
    stepIndex: checkpoint.stepIndex,
    totalSteps: workflow.steps.length,
    lastOperation: checkpoint.lastOperation,
    inputRef: checkpoint.inputRef,
    startedAt: checkpoint.startedAt,
  }
}
