import { and, asc, desc, eq, isNotNull, isNull } from 'drizzle-orm'
import { z } from 'zod'
import {
  completionCriterionSchema,
  decisionIdSchema,
  evidenceArtifactSchema,
  graphCheckpointSchema,
  graphNodeRunSchema,
  graphRunSchema,
  graphStateSnapshotSchema,
  isTerminalWorkflowState,
  scopePolicySchema,
  summariseEvidence,
  taskIdSchema,
  testCountsSchema,
  transition,
  workflowCheckpointSchema,
  workflowLimitsSchema,
  workflowSchema,
  workflowStepSchema,
  type Actor,
  type ChangeSetId,
  type EvidenceArtifact,
  type GraphCheckpoint,
  type GraphNodeRun,
  type GraphRun,
  type GraphRunStatus,
  type GraphStateSnapshot,
  type NodeStatus,
  type ProjectId,
  type QuestionId,
  type Role,
  type Task,
  type TaskId,
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
import {
  evidenceArtifacts,
  graphCheckpoints,
  graphNodeRuns,
  graphRuns,
  tasks,
  workflows,
  workflowSteps,
} from './schema'

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

export interface StartGraphRunInput {
  readonly graphRunId: string
  readonly projectId: ProjectId
  readonly workflowId: WorkflowId
  readonly templateId: string
  readonly startedAt: string
}

export interface UpdateGraphRunStatusInput {
  readonly projectId: ProjectId
  readonly graphRunId: string
  readonly status: GraphRunStatus
  readonly iteration?: number
  readonly haltReason?: string | null
  readonly finishedAt?: string | null
  readonly error?: string | null
  readonly occurredAt: string
}

export interface RecordNodeAttemptInput {
  readonly id: string
  readonly projectId: ProjectId
  readonly graphRunId: string
  readonly nodeId: string
  readonly attempt: number
  readonly status: 'pending' | 'ready' | 'running'
  readonly role?: Role | null
  readonly runtimeId?: string | null
  readonly contextRef?: string | null
  readonly startedAt: string
}

export interface UpdateNodeAttemptInput {
  readonly projectId: ProjectId
  readonly graphRunId: string
  readonly nodeId: string
  readonly attempt: number
  readonly status: 'completed' | 'failed' | 'skipped' | 'blocked' | 'cancelled'
  readonly changeSetId?: ChangeSetId | null
  readonly evidenceId?: string | null
  readonly finishedAt?: string | null
  readonly error?: string | null
  readonly occurredAt: string
}

export interface WriteGraphCheckpointInput {
  readonly id: string
  readonly projectId: ProjectId
  readonly graphRunId: string
  readonly nodeId: string
  readonly operation: string
  readonly stateSnapshot: GraphStateSnapshot
  readonly occurredAt: string
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

  /**
   * Retrieves a persisted task by its ID, deserializing its JSON fields according to domain schemas.
   */
  getTask(taskId: TaskId): Task | null {
    const taskRow = this.db.select().from(tasks).where(eq(tasks.id, taskId)).get()
    if (!taskRow) return null
    return {
      id: taskIdSchema.parse(taskRow.id),
      objective: taskRow.objective,
      constraints: fromJson(z.array(z.string()), taskRow.constraints, 'tasks.constraints'),
      completionCriteria: fromJson(
        z.array(completionCriterionSchema),
        taskRow.completionCriteria,
        'tasks.completionCriteria',
      ),
      scope: fromJson(scopePolicySchema, taskRow.scope, 'tasks.scope'),
      lockedDecisionIds: fromJson(
        z.array(decisionIdSchema),
        taskRow.lockedDecisionIds,
        'tasks.lockedDecisionIds',
      ),
      correctsTaskId:
        taskRow.correctsTaskId === null ? null : taskIdSchema.parse(taskRow.correctsTaskId),
      createdAt: taskRow.createdAt,
    }
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

  // --- M6 Generic Workflow Graph Persistence Methods ---

  startGraphRun(input: StartGraphRunInput, actor: Actor): GraphRun {
    this.db.transaction(() => {
      const event = this.events.append(
        {
          type: 'graph.started',
          payload: {
            graphRunId: input.graphRunId,
            workflowId: input.workflowId,
            templateId: input.templateId,
            startedAt: input.startedAt,
          },
        },
        { projectId: input.projectId, actor, occurredAt: input.startedAt },
      )

      applyEvent(this.db, event)
    })

    const run = this.getGraphRun(input.graphRunId)
    if (run === null) {
      throw new Error(`Graph run "${input.graphRunId}" was not projected after being started`)
    }
    return run
  }

  getGraphRun(graphRunId: string): GraphRun | null {
    const row = this.db.select().from(graphRuns).where(eq(graphRuns.id, graphRunId)).all().at(0)

    return row === undefined ? null : this.toGraphRunDomain(row)
  }

  updateGraphRunStatus(input: UpdateGraphRunStatusInput, actor: Actor): GraphRun {
    this.db.transaction(() => {
      const event = this.events.append(
        {
          type: 'graph.status_updated',
          payload: {
            graphRunId: input.graphRunId,
            status: input.status,
            iteration: input.iteration,
            haltReason: input.haltReason,
            error: input.error,
            finishedAt: input.finishedAt,
          },
        },
        { projectId: input.projectId, actor, occurredAt: input.occurredAt },
      )

      applyEvent(this.db, event)
    })

    const run = this.getGraphRun(input.graphRunId)
    if (run === null) {
      throw new Error(`Graph run "${input.graphRunId}" was not found after status update`)
    }
    return run
  }

  recordNodeAttempt(input: RecordNodeAttemptInput, actor: Actor): GraphNodeRun {
    // Enforce attempt monotonicity: attempt must be 1 for initial attempt, or previousAttempt + 1
    const existingAttempts = this.getNodeAttempts(input.graphRunId, input.nodeId)
    const latestAttempt = existingAttempts.at(-1)

    if (latestAttempt === undefined) {
      if (input.attempt !== 1) {
        throw new Error(
          `Attempt monotonicity violation: initial attempt for node "${input.nodeId}" in run "${input.graphRunId}" must be 1 (got ${String(input.attempt)})`,
        )
      }
    } else {
      const expectedAttempt = latestAttempt.attempt + 1
      if (input.attempt !== expectedAttempt) {
        throw new Error(
          `Attempt monotonicity violation: next attempt for node "${input.nodeId}" in run "${input.graphRunId}" must be ${String(expectedAttempt)} (got ${String(input.attempt)})`,
        )
      }
    }

    this.db.transaction(() => {
      const event = this.events.append(
        {
          type: 'graph_node.attempt_started',
          payload: {
            id: input.id,
            graphRunId: input.graphRunId,
            nodeId: input.nodeId,
            attempt: input.attempt,
            status: input.status,
            role: input.role,
            runtimeId: input.runtimeId,
            contextRef: input.contextRef,
            startedAt: input.startedAt,
          },
        },
        { projectId: input.projectId, actor, occurredAt: input.startedAt },
      )

      applyEvent(this.db, event)
    })

    const attempt = this.getNodeAttempt(input.graphRunId, input.nodeId, input.attempt)
    if (attempt === null) {
      throw new Error(
        `Node attempt ${input.nodeId}#${String(input.attempt)} was not projected after being recorded`,
      )
    }
    return attempt
  }

  updateNodeAttempt(input: UpdateNodeAttemptInput, actor: Actor): GraphNodeRun {
    // Enforce terminal attempt immutability: once completed/failed/skipped/blocked/cancelled, attempt is immutable
    const existing = this.getNodeAttempt(input.graphRunId, input.nodeId, input.attempt)
    if (existing === null) {
      throw new Error(
        `Node attempt not found: run="${input.graphRunId}", node="${input.nodeId}", attempt=${String(input.attempt)}`,
      )
    }

    const TERMINAL_STATUSES: readonly NodeStatus[] = [
      'completed',
      'failed',
      'skipped',
      'blocked',
      'cancelled',
    ]
    if (TERMINAL_STATUSES.includes(existing.status)) {
      throw new Error(
        `Terminal attempt immutability violation: node "${input.nodeId}" attempt ${String(input.attempt)} is in terminal status "${existing.status}" and cannot be updated`,
      )
    }

    this.db.transaction(() => {
      const event = this.events.append(
        {
          type: 'graph_node.attempt_updated',
          payload: {
            graphRunId: input.graphRunId,
            nodeId: input.nodeId,
            attempt: input.attempt,
            status: input.status,
            changeSetId: input.changeSetId,
            evidenceId: input.evidenceId,
            finishedAt: input.finishedAt,
            error: input.error,
          },
        },
        { projectId: input.projectId, actor, occurredAt: input.occurredAt },
      )

      applyEvent(this.db, event)
    })

    const updated = this.getNodeAttempt(input.graphRunId, input.nodeId, input.attempt)
    if (updated === null) {
      throw new Error(
        `Node attempt ${input.nodeId}#${String(input.attempt)} was not found after update`,
      )
    }
    return updated
  }

  getNodeAttempt(graphRunId: string, nodeId: string, attempt: number): GraphNodeRun | null {
    const row = this.db
      .select()
      .from(graphNodeRuns)
      .where(
        and(
          eq(graphNodeRuns.graphRunId, graphRunId),
          eq(graphNodeRuns.nodeId, nodeId),
          eq(graphNodeRuns.attempt, attempt),
        ),
      )
      .all()
      .at(0)

    return row === undefined ? null : this.toGraphNodeRunDomain(row)
  }

  getNodeAttempts(graphRunId: string, nodeId?: string): readonly GraphNodeRun[] {
    const query = this.db
      .select()
      .from(graphNodeRuns)
      .where(
        nodeId !== undefined
          ? and(eq(graphNodeRuns.graphRunId, graphRunId), eq(graphNodeRuns.nodeId, nodeId))
          : eq(graphNodeRuns.graphRunId, graphRunId),
      )
      .orderBy(asc(graphNodeRuns.nodeId), asc(graphNodeRuns.attempt))
      .all()

    return query.map((row) => this.toGraphNodeRunDomain(row))
  }

  /**
   * Option A read derivation: logical NodeRun state is derived from the latest attempt
   * (highest attempt number) for each nodeId in the graph run.
   */
  getLatestNodeRuns(graphRunId: string): readonly GraphNodeRun[] {
    const rows = this.db
      .select()
      .from(graphNodeRuns)
      .where(eq(graphNodeRuns.graphRunId, graphRunId))
      .orderBy(asc(graphNodeRuns.nodeId), desc(graphNodeRuns.attempt))
      .all()

    const latestByNode = new Map<string, GraphNodeRun>()
    for (const row of rows) {
      if (!latestByNode.has(row.nodeId)) {
        latestByNode.set(row.nodeId, this.toGraphNodeRunDomain(row))
      }
    }

    return Array.from(latestByNode.values())
  }

  /**
   * Write-ahead checkpoint semantics: writes checkpoint event to log and projects to table
   * before node execution proceeds.
   */
  writeGraphCheckpoint(input: WriteGraphCheckpointInput, actor: Actor): GraphCheckpoint {
    this.db.transaction(() => {
      const event = this.events.append(
        {
          type: 'graph.checkpointed',
          payload: {
            id: input.id,
            graphRunId: input.graphRunId,
            nodeId: input.nodeId,
            operation: input.operation,
            stateSnapshot: input.stateSnapshot,
            occurredAt: input.occurredAt,
          },
        },
        { projectId: input.projectId, actor, occurredAt: input.occurredAt },
      )

      applyEvent(this.db, event)
    })

    const row = this.db
      .select()
      .from(graphCheckpoints)
      .where(eq(graphCheckpoints.id, input.id))
      .all()
      .at(0)

    if (row === undefined) {
      throw new Error(`Graph checkpoint "${input.id}" was not projected after being written`)
    }
    return this.toGraphCheckpointDomain(row)
  }

  getLatestGraphCheckpoint(graphRunId: string): GraphCheckpoint | null {
    const row = this.db
      .select()
      .from(graphCheckpoints)
      .where(eq(graphCheckpoints.graphRunId, graphRunId))
      .orderBy(desc(graphCheckpoints.occurredAt), desc(graphCheckpoints.id))
      .all()
      .at(0)

    return row === undefined ? null : this.toGraphCheckpointDomain(row)
  }

  findInterruptedGraphRuns(projectId?: ProjectId): readonly GraphRun[] {
    if (projectId !== undefined) {
      const rows = this.db
        .select({
          id: graphRuns.id,
          workflowId: graphRuns.workflowId,
          templateId: graphRuns.templateId,
          status: graphRuns.status,
          iteration: graphRuns.iteration,
          startedAt: graphRuns.startedAt,
          finishedAt: graphRuns.finishedAt,
          haltReason: graphRuns.haltReason,
          error: graphRuns.error,
        })
        .from(graphRuns)
        .innerJoin(workflows, eq(graphRuns.workflowId, workflows.id))
        .where(
          and(
            eq(workflows.projectId, projectId),
            eq(graphRuns.status, 'running'),
            isNull(graphRuns.finishedAt),
          ),
        )
        .all()

      return rows.map((row) => this.toGraphRunDomain(row))
    }

    const rows = this.db
      .select()
      .from(graphRuns)
      .where(and(eq(graphRuns.status, 'running'), isNull(graphRuns.finishedAt)))
      .all()

    return rows.map((row) => this.toGraphRunDomain(row))
  }

  private toGraphRunDomain(row: typeof graphRuns.$inferSelect): GraphRun {
    return parseRow(
      graphRunSchema,
      {
        id: row.id,
        workflowId: row.workflowId,
        templateId: row.templateId,
        status: row.status,
        iteration: row.iteration,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        haltReason: row.haltReason,
        error: row.error,
      },
      'graph_runs row',
    )
  }

  private toGraphNodeRunDomain(row: typeof graphNodeRuns.$inferSelect): GraphNodeRun {
    return parseRow(
      graphNodeRunSchema,
      {
        id: row.id,
        graphRunId: row.graphRunId,
        nodeId: row.nodeId,
        attempt: row.attempt,
        status: row.status,
        role: row.role,
        runtimeId: row.runtimeId,
        contextRef: row.contextRef,
        changeSetId: row.changeSetId,
        evidenceId: row.evidenceId,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
        error: row.error,
      },
      'graph_node_runs row',
    )
  }

  private toGraphCheckpointDomain(row: typeof graphCheckpoints.$inferSelect): GraphCheckpoint {
    return parseRow(
      graphCheckpointSchema,
      {
        id: row.id,
        graphRunId: row.graphRunId,
        nodeId: row.nodeId,
        operation: row.operation,
        stateSnapshot: fromJson(
          graphStateSnapshotSchema,
          row.stateSnapshot,
          'graph_checkpoints.stateSnapshot',
        ),
        occurredAt: row.occurredAt,
      },
      'graph_checkpoints row',
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
