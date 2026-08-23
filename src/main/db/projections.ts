import { eq } from 'drizzle-orm'
import type { DomainEvent, EventPayloads, EventType, ProjectId } from '@shared/domain'
import type { ForgeDatabase } from './connection'
import {
  decisions,
  evidenceArtifacts,
  openQuestions,
  projects,
  repositories,
  rules,
  tasks,
  workflows,
  workflowSteps,
} from './schema'
import { toJson } from './rows'

/**
 * Read models, derived from the event log.
 *
 * The tables these write are a cache: they can be dropped and rebuilt from events
 * alone, which is the property that makes the log authoritative rather than
 * decorative. A test asserts the rebuild reproduces byte-identical rows.
 *
 * Only the entities #18 needs are projected here. Each remaining entity gets its
 * projection with the feature that reads it, so an unused read model cannot drift
 * unnoticed.
 */

/** Narrows an event to a specific type, so the payload type follows. */
function isType<T extends EventType>(
  event: DomainEvent,
  type: T,
): event is DomainEvent & { type: T; payload: EventPayloads[T] } {
  return event.type === type
}

/**
 * Applies one event to the read models.
 *
 * Exhaustive over `EventType` by construction: the `default` branch throws on an
 * unhandled type rather than ignoring it, because a silently skipped event means a
 * projection that quietly disagrees with the log.
 */
export function applyEvent(db: ForgeDatabase, event: DomainEvent): void {
  if (isType(event, 'project.created')) {
    db.insert(projects)
      .values({
        id: event.projectId,
        name: event.payload.name,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.createdAt,
      })
      .onConflictDoUpdate({
        target: projects.id,
        set: { name: event.payload.name, updatedAt: event.payload.createdAt },
      })
      .run()
    return
  }

  if (isType(event, 'project.updated')) {
    db.update(projects)
      .set({ name: event.payload.name, updatedAt: event.payload.updatedAt })
      .where(eq(projects.id, event.projectId))
      .run()
    return
  }

  if (isType(event, 'repository.bound')) {
    const repository = event.payload.repository
    db.insert(repositories)
      .values({
        id: repository.id,
        projectId: event.projectId,
        absolutePath: repository.absolutePath,
        defaultBranch: repository.defaultBranch,
        buildCommand: repository.buildCommand,
        testCommand: repository.testCommand,
        tech: toJson(repository.tech),
      })
      .onConflictDoUpdate({
        target: repositories.id,
        set: {
          absolutePath: repository.absolutePath,
          defaultBranch: repository.defaultBranch,
          buildCommand: repository.buildCommand,
          testCommand: repository.testCommand,
          tech: toJson(repository.tech),
        },
      })
      .run()
    return
  }

  if (isType(event, 'rule.set')) {
    const rule = event.payload.rule
    db.insert(rules)
      .values({
        id: rule.id,
        projectId: event.projectId,
        scope: rule.scope,
        key: rule.key,
        statement: rule.statement,
        source: rule.source,
        createdAt: rule.createdAt,
      })
      .onConflictDoUpdate({
        target: [rules.projectId, rules.scope, rules.key],
        set: { statement: rule.statement, source: rule.source, id: rule.id },
      })
      .run()
    return
  }

  if (isType(event, 'rule.removed')) {
    db.delete(rules).where(eq(rules.id, event.payload.ruleId)).run()
    return
  }

  /**
   * Tasks.
   *
   * Projected here rather than with #35 because a workflow's foreign key points at a task,
   * and `rebuildProjections` deletes the project — which cascades to `tasks`. With this
   * unprojected, replaying a workflow failed with `FOREIGN KEY constraint failed`: the task
   * had been deleted and nothing recreated it. Found by the replay test, and it would have
   * broken every resume in production, not only in tests.
   */
  if (isType(event, 'task.created')) {
    const task = event.payload.task
    db.insert(tasks)
      .values({
        id: task.id,
        projectId: event.projectId,
        objective: task.objective,
        constraints: toJson(task.constraints),
        completionCriteria: toJson(task.completionCriteria),
        scope: toJson(task.scope),
        lockedDecisionIds: toJson(task.lockedDecisionIds),
        correctsTaskId: task.correctsTaskId,
        createdAt: task.createdAt,
      })
      .onConflictDoUpdate({
        target: tasks.id,
        set: {
          objective: task.objective,
          constraints: toJson(task.constraints),
          completionCriteria: toJson(task.completionCriteria),
          scope: toJson(task.scope),
          lockedDecisionIds: toJson(task.lockedDecisionIds),
        },
      })
      .run()
    return
  }

  // ---- Workflows (#27, #28) ------------------------------------------------
  //
  // Every writer below is an upsert or an absolute `set`, never a read-modify-write.
  // That is what makes replay safe: applying the same event twice has to leave the same
  // row, because a resume re-applies the tail of the log by design (#28). An
  // `iteration = iteration + 1` here would double-count on every replay.

  if (isType(event, 'workflow.started')) {
    const payload = event.payload
    db.insert(workflows)
      .values({
        id: payload.workflowId,
        projectId: event.projectId,
        taskId: payload.taskId,
        templateId: payload.templateId,
        state: 'DISCOVERY',
        iteration: 0,
        limits: toJson(payload.limits),
        checkpoint: null,
        resumeState: null,
        blockedByQuestionId: null,
        haltReason: null,
        startedAt: payload.startedAt,
        finishedAt: null,
      })
      .onConflictDoUpdate({
        target: workflows.id,
        set: { templateId: payload.templateId, limits: toJson(payload.limits) },
      })
      .run()
    return
  }

  if (isType(event, 'workflow.transitioned')) {
    const payload = event.payload
    db.update(workflows)
      .set({
        state: payload.to,
        // Absolute, taken from the event, so a replay cannot advance it further.
        iteration: payload.iteration,
        // Recorded on the way in and cleared on the way out, matching the invariant
        // `workflowSchema` enforces: only AWAITING_USER may name a resume state.
        resumeState: payload.to === 'AWAITING_USER' ? payload.from : null,
        blockedByQuestionId:
          payload.to === 'AWAITING_USER' ? (payload.blockedByQuestionId ?? null) : null,
      })
      .where(eq(workflows.id, payload.workflowId))
      .run()
    return
  }

  if (isType(event, 'workflow.checkpointed')) {
    db.update(workflows)
      .set({ checkpoint: toJson(event.payload.checkpoint) })
      .where(eq(workflows.id, event.payload.workflowId))
      .run()
    return
  }

  if (isType(event, 'workflow.halted')) {
    db.update(workflows)
      .set({ state: event.payload.state, haltReason: event.payload.haltReason })
      .where(eq(workflows.id, event.payload.workflowId))
      .run()
    return
  }

  if (isType(event, 'workflow.finished')) {
    db.update(workflows)
      .set({
        state: event.payload.state,
        finishedAt: event.payload.finishedAt,
        // A finished workflow has nothing in flight, so the checkpoint is cleared —
        // which is also what makes "interrupted" detectable as "checkpoint is not null".
        checkpoint: null,
      })
      .where(eq(workflows.id, event.payload.workflowId))
      .run()
    return
  }

  if (isType(event, 'step.started')) {
    const step = event.payload.step
    db.insert(workflowSteps)
      .values({
        id: step.id,
        workflowId: event.payload.workflowId,
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
      })
      // Keyed on the step id, so re-running an interrupted step reuses its row instead
      // of colliding with the unique (workflow, index) constraint.
      .onConflictDoUpdate({
        target: workflowSteps.id,
        set: { state: step.state, contextRef: step.contextRef, startedAt: step.startedAt },
      })
      .run()
    return
  }

  if (isType(event, 'step.finished')) {
    const payload = event.payload
    db.update(workflowSteps)
      .set({
        verdict: payload.verdict,
        changeSetId: payload.changeSetId,
        finishedAt: payload.finishedAt,
      })
      .where(eq(workflowSteps.id, payload.stepId))
      .run()
    return
  }

  if (isType(event, 'evidence.recorded')) {
    const { artifact } = event.payload
    db.insert(evidenceArtifacts)
      .values({
        id: artifact.id,
        projectId: event.projectId,
        workflowId: artifact.workflowId,
        stepId: artifact.stepId,
        kind: artifact.kind,
        command: artifact.command,
        cwd: artifact.cwd,
        outcome: artifact.outcome,
        exitCode: artifact.exitCode,
        durationMs: artifact.durationMs,
        stdout: artifact.stdout,
        stderr: artifact.stderr,
        truncated: artifact.truncated ? 1 : 0,
        counts: artifact.counts === null ? null : toJson(artifact.counts),
        failure: artifact.failure,
        recordedAt: artifact.recordedAt,
      })
      // An absolute overwrite rather than a read-modify-write, so replaying the same
      // event leaves the same row. An artifact is immutable once recorded, so the
      // conflict case only arises on replay.
      .onConflictDoUpdate({
        target: evidenceArtifacts.id,
        set: {
          outcome: artifact.outcome,
          exitCode: artifact.exitCode,
          durationMs: artifact.durationMs,
          stdout: artifact.stdout,
          stderr: artifact.stderr,
          truncated: artifact.truncated ? 1 : 0,
          counts: artifact.counts === null ? null : toJson(artifact.counts),
          failure: artifact.failure,
        },
      })
      .run()
    return
  }

  if (isType(event, 'question.asked')) {
    const q = event.payload.question
    db.insert(openQuestions)
      .values({
        id: q.id,
        projectId: event.projectId,
        question: q.question,
        whyUndetermined: q.whyUndetermined,
        evidence: toJson(q.evidence),
        options: toJson(q.options),
        recommendation: q.recommendation,
        askedBy: q.askedBy,
        askedAt: q.askedAt,
        answer: q.answer,
        answeredAt: q.answeredAt,
        answeredBy: q.answeredBy,
      })
      .onConflictDoUpdate({
        target: openQuestions.id,
        set: {
          question: q.question,
          whyUndetermined: q.whyUndetermined,
          evidence: toJson(q.evidence),
          options: toJson(q.options),
          recommendation: q.recommendation,
          answer: q.answer,
          answeredAt: q.answeredAt,
          answeredBy: q.answeredBy,
        },
      })
      .run()
    return
  }

  if (isType(event, 'question.answered')) {
    const payload = event.payload
    db.update(openQuestions)
      .set({
        answer: payload.answer,
        answeredAt: payload.answeredAt,
        answeredBy: 'user',
      })
      .where(eq(openQuestions.id, payload.questionId))
      .run()
    return
  }

  if (isType(event, 'decision.proposed')) {
    const d = event.payload.decision
    db.insert(decisions)
      .values({
        id: d.id,
        projectId: event.projectId,
        statement: d.statement,
        rationale: d.rationale,
        status: d.status,
        proposedBy: d.proposedBy,
        proposedAt: d.proposedAt,
        lockedAt: d.lockedAt,
        lockedBy: d.lockedBy,
        supersededBy: d.supersededBy,
        originQuestionId: d.originQuestionId,
      })
      .onConflictDoUpdate({
        target: decisions.id,
        set: {
          statement: d.statement,
          rationale: d.rationale,
          status: d.status,
          proposedBy: d.proposedBy,
          proposedAt: d.proposedAt,
          lockedAt: d.lockedAt,
          lockedBy: d.lockedBy,
          supersededBy: d.supersededBy,
          originQuestionId: d.originQuestionId,
        },
      })
      .run()
    return
  }

  if (isType(event, 'decision.approved')) {
    const payload = event.payload
    db.update(decisions)
      .set({
        status: 'approved',
      })
      .where(eq(decisions.id, payload.decisionId))
      .run()
    return
  }

  if (isType(event, 'decision.locked')) {
    const payload = event.payload
    db.update(decisions)
      .set({
        status: 'locked',
        lockedAt: payload.lockedAt,
        lockedBy: 'user',
      })
      .where(eq(decisions.id, payload.decisionId))
      .run()
    return
  }

  if (isType(event, 'decision.superseded')) {
    const payload = event.payload
    db.update(decisions)
      .set({
        status: 'superseded',
        supersededBy: payload.supersededBy,
      })
      .where(eq(decisions.id, payload.decisionId))
      .run()
    return
  }

  // Everything else is recorded in the log but has no read model yet. This is a
  // deliberate no-op rather than an error: the events are still replayable, and
  // their projections arrive with the features that read them.
  if (PROJECTED_LATER.has(event.type)) return

  throw new Error(`No projection for event type "${event.type}"`)
}

/**
 * Event types that are logged now and projected later, with the issue that will
 * do it. Listing them explicitly means a genuinely unknown type still throws.
 */
const PROJECTED_LATER: ReadonlySet<EventType> = new Set([
  'binding.set', // #31
  'changeset.captured', // #34
  'changeset.reviewed', // #36
])

/**
 * Rebuilds every read model for a project from its events.
 *
 * Deletes the projected rows first, so the result depends only on the log. If a
 * rebuild produced different output from the incremental path, one of the two is
 * wrong — and the test that compares them is how that gets caught.
 */
export function rebuildProjections(
  db: ForgeDatabase,
  projectId: ProjectId,
  events: readonly DomainEvent[],
): void {
  db.transaction((tx) => {
    // Cascades from `projects` remove repositories and rules, so this one delete
    // clears the whole projected tree.
    tx.delete(projects).where(eq(projects.id, projectId)).run()

    for (const event of events) {
      applyEvent(tx, event)
    }
  })
}
