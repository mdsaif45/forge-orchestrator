import { randomUUID } from 'node:crypto'
import { and, asc, desc, eq, gte, sql } from 'drizzle-orm'
import {
  runEventSchema,
  runRecordSchema,
  stepRecordSchema,
  type ChangeSetId,
  type EvidenceId,
  type ProjectId,
  type RunEvent,
  type RunEventInput,
  type RunId,
  type RunRecord,
  type RunStatus,
  type StepId,
  type StepRecord,
} from '@shared/domain'
import type { ForgeDatabase } from './connection'
import { fromJson, parseRow, toJson } from './rows'
import { runEvents, runs, runSteps } from './schema'

/**
 * Storage repository for execution runs, steps, and run lifecycle events.
 */
export class RunStore {
  constructor(private readonly db: ForgeDatabase) {}

  /**
   * Records a new execution run.
   */
  createRun(run: RunRecord): RunRecord {
    const validated = parseRow(runRecordSchema, run, 'createRun input')

    this.db
      .insert(runs)
      .values({
        id: validated.id,
        projectId: validated.projectId,
        taskId: validated.taskId,
        type: validated.type,
        status: validated.status,
        startedAt: validated.startedAt,
        finishedAt: validated.finishedAt,
        exitCode: validated.exitCode,
        summary: validated.summary,
        error: validated.error,
        metadata: toJson(validated.metadata),
      })
      .run()

    return validated
  }

  /**
   * Retrieves a run by its ID.
   */
  getRun(id: RunId): RunRecord | null {
    const row = this.db.select().from(runs).where(eq(runs.id, id)).get()
    if (row === undefined) return null

    return parseRow(
      runRecordSchema,
      {
        ...row,
        metadata: fromJson(runRecordSchema.shape.metadata, row.metadata, 'runs.metadata'),
      },
      'runs.getRun',
    )
  }

  /**
   * Lists runs ordered newest first, with optional filtering by project or status.
   */
  listRuns(
    options: {
      readonly limit?: number | undefined
      readonly projectId?: ProjectId | undefined
      readonly status?: RunStatus | undefined
    } = {},
  ): readonly RunRecord[] {
    const limit = options.limit ?? 50
    const conditions = []

    if (options.projectId !== undefined) {
      conditions.push(eq(runs.projectId, options.projectId))
    }
    if (options.status !== undefined) {
      conditions.push(eq(runs.status, options.status))
    }

    const query = this.db.select().from(runs)
    const filtered = conditions.length === 0 ? query : query.where(and(...conditions))

    const rows = filtered.orderBy(desc(runs.startedAt)).limit(limit).all()

    return rows.map((row) =>
      parseRow(
        runRecordSchema,
        {
          ...row,
          metadata: fromJson(runRecordSchema.shape.metadata, row.metadata, 'runs.metadata'),
        },
        'runs.listRuns',
      ),
    )
  }

  /**
   * Lists runs for a project ordered newest first.
   */
  listRunsForProject(projectId: ProjectId, limit = 50): readonly RunRecord[] {
    return this.listRuns({ projectId, limit })
  }

  /**
   * Updates a run when it finishes.
   */
  finishRun(
    id: RunId,
    update: {
      readonly status: RunStatus
      readonly finishedAt: string
      readonly exitCode?: number | null | undefined
      readonly summary?: string | null | undefined
      readonly error?: string | null | undefined
    },
  ): RunRecord {
    this.db
      .update(runs)
      .set({
        status: update.status,
        finishedAt: update.finishedAt,
        ...(update.exitCode !== undefined ? { exitCode: update.exitCode } : {}),
        ...(update.summary !== undefined ? { summary: update.summary } : {}),
        ...(update.error !== undefined ? { error: update.error } : {}),
      })
      .where(eq(runs.id, id))
      .run()

    const current = this.getRun(id)
    if (current === null) {
      throw new Error(`Run ${id} not found after update`)
    }
    return current
  }

  /**
   * Records a new execution step within a run.
   */
  createStep(step: StepRecord): StepRecord {
    const validated = parseRow(stepRecordSchema, step, 'createStep input')

    this.db
      .insert(runSteps)
      .values({
        id: validated.id,
        runId: validated.runId,
        index: validated.index,
        role: validated.role,
        runtimeId: validated.runtimeId,
        status: validated.status,
        startedAt: validated.startedAt,
        finishedAt: validated.finishedAt,
        summary: validated.summary,
        changeSetId: validated.changeSetId,
        evidenceId: validated.evidenceId,
      })
      .run()

    return validated
  }

  /**
   * Retrieves a step by its ID.
   */
  getStep(id: StepId): StepRecord | null {
    const row = this.db.select().from(runSteps).where(eq(runSteps.id, id)).get()
    if (row === undefined) return null

    return parseRow(stepRecordSchema, row, 'runSteps.getStep')
  }

  /**
   * Lists all steps for a run ordered by step index.
   */
  listStepsForRun(runId: RunId): readonly StepRecord[] {
    const rows = this.db
      .select()
      .from(runSteps)
      .where(eq(runSteps.runId, runId))
      .orderBy(asc(runSteps.index))
      .all()

    return rows.map((row) => parseRow(stepRecordSchema, row, 'runSteps.listStepsForRun'))
  }

  /**
   * Updates a step when it completes or halts.
   */
  finishStep(
    id: StepId,
    update: {
      readonly status: RunStatus
      readonly finishedAt: string
      readonly summary?: string | null | undefined
      readonly changeSetId?: ChangeSetId | null | undefined
      readonly evidenceId?: EvidenceId | null | undefined
    },
  ): StepRecord {
    this.db
      .update(runSteps)
      .set({
        status: update.status,
        finishedAt: update.finishedAt,
        ...(update.summary !== undefined ? { summary: update.summary } : {}),
        ...(update.changeSetId !== undefined ? { changeSetId: update.changeSetId } : {}),
        ...(update.evidenceId !== undefined ? { evidenceId: update.evidenceId } : {}),
      })
      .where(eq(runSteps.id, id))
      .run()

    const current = this.getStep(id)
    if (current === null) {
      throw new Error(`Step ${id} not found after update`)
    }
    return current
  }

  /**
   * Appends an event to the run's sequential log.
   */
  appendEvent(runId: RunId, input: RunEventInput): RunEvent {
    return this.db.transaction((tx) => {
      const rows = tx
        .select({ max: sql<number | null>`max(${runEvents.seq})` })
        .from(runEvents)
        .where(eq(runEvents.runId, runId))
        .all()

      const seq = (rows.at(0)?.max ?? 0) + 1
      const now = input.occurredAt ?? new Date().toISOString()
      const eventId = randomUUID()

      const event: RunEvent = parseRow(
        runEventSchema,
        {
          id: eventId,
          runId,
          seq,
          stepId: input.stepId ?? null,
          type: input.type,
          payload: input.payload,
          occurredAt: now,
        },
        'runEvents.appendEvent',
      )

      tx.insert(runEvents)
        .values({
          id: event.id,
          runId: event.runId,
          seq: event.seq,
          stepId: event.stepId,
          type: event.type,
          payload: toJson(event.payload),
          occurredAt: event.occurredAt,
        })
        .run()

      return event
    })
  }

  /**
   * Retrieves events for a run ordered by sequence number.
   */
  listEventsForRun(runId: RunId, fromSeq = 1): readonly RunEvent[] {
    const rows = this.db
      .select()
      .from(runEvents)
      .where(and(eq(runEvents.runId, runId), gte(runEvents.seq, fromSeq)))
      .orderBy(asc(runEvents.seq))
      .all()

    return rows.map((row) =>
      parseRow(
        runEventSchema,
        {
          ...row,
          payload: fromJson(runEventSchema.shape.payload, row.payload, 'runEvents.payload'),
        },
        'runEvents.listEventsForRun',
      ),
    )
  }
}
