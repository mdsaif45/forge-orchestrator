import { randomUUID } from 'node:crypto'
import { and, asc, eq, gt, sql } from 'drizzle-orm'
import { z } from 'zod'
import {
  domainEventSchema,
  eventIdSchema,
  EVENT_PAYLOADS,
  type Actor,
  type DomainEvent,
  type EventInput,
  type EventType,
  type ProjectId,
} from '@shared/domain'
import type { ForgeDatabase } from './connection'
import { events } from './schema'

/**
 * The append-only event log.
 *
 * Events are never updated and never deleted. Read models are projections over
 * this table, which is what makes "why is the code like this?" answerable months
 * later, and what lets an agent's claim be checked against what actually happened
 * (axiom A3).
 */

export interface AppendOptions {
  readonly projectId: ProjectId
  readonly actor: Actor
  /** Why this happened, when the type alone does not say. */
  readonly reason?: string
  readonly occurredAt: string
}

export class EventStore {
  constructor(private readonly db: ForgeDatabase) {}

  /**
   * Appends one event and returns it with its assigned sequence number.
   *
   * The payload is validated against the schema for its type before anything is
   * written, so a malformed payload cannot enter the log — an event that cannot be
   * replayed is worse than a rejected write, because the damage only surfaces at
   * rebuild time.
   */
  append(input: EventInput, options: AppendOptions): DomainEvent {
    const [appended] = this.appendMany([input], options)
    if (appended === undefined) throw new Error('append produced no event')
    return appended
  }

  /**
   * Appends several events atomically, with consecutive sequence numbers.
   *
   * One transaction per command, not per event: a command that emits two events
   * must not be observable half-applied, or a projection could read a state the
   * domain never occupied.
   */
  appendMany(inputs: readonly EventInput[], options: AppendOptions): readonly DomainEvent[] {
    if (inputs.length === 0) return []

    const validated = inputs.map((input) => ({
      type: input.type,
      payload: validatePayload(input.type, input.payload),
    }))

    return this.db.transaction((tx) => {
      // Read the current maximum inside the transaction. SQLite serialises
      // writers, so no two appends can observe the same value and collide — and
      // if one somehow did, the (project_id, seq) primary key would reject it.
      const rows = tx
        .select({ max: sql<number | null>`max(${events.seq})` })
        .from(events)
        .where(eq(events.projectId, options.projectId))
        .all()

      let seq = (rows.at(0)?.max ?? 0) + 1

      const appended: DomainEvent[] = []

      for (const { type, payload } of validated) {
        const event: DomainEvent = {
          // Parsed rather than cast, so the branded type is earned rather than asserted.
          id: eventIdSchema.parse(randomUUID()),
          projectId: options.projectId,
          seq,
          type,
          payload,
          actor: options.actor,
          reason: options.reason ?? null,
          occurredAt: options.occurredAt,
        }

        tx.insert(events)
          .values({
            projectId: event.projectId,
            seq: event.seq,
            id: event.id,
            type: event.type,
            payload: JSON.stringify(event.payload),
            actor: event.actor,
            reason: event.reason,
            occurredAt: event.occurredAt,
          })
          .run()

        appended.push(event)
        seq += 1
      }

      return appended
    })
  }

  /** Every event for a project, in sequence order. */
  read(projectId: ProjectId): readonly DomainEvent[] {
    return this.db
      .select()
      .from(events)
      .where(eq(events.projectId, projectId))
      .orderBy(asc(events.seq))
      .all()
      .map((row) => toDomainEvent(row))
  }

  /**
   * Events after a sequence number, for incremental projection.
   *
   * A projection that has already consumed up to `seq` can catch up without
   * replaying from the beginning.
   */
  readSince(projectId: ProjectId, seq: number): readonly DomainEvent[] {
    return this.db
      .select()
      .from(events)
      .where(and(eq(events.projectId, projectId), gt(events.seq, seq)))
      .orderBy(asc(events.seq))
      .all()
      .map((row) => toDomainEvent(row))
  }

  /** The highest sequence number for a project, or 0 if it has no events. */
  latestSeq(projectId: ProjectId): number {
    const rows = this.db
      .select({ max: sql<number | null>`max(${events.seq})` })
      .from(events)
      .where(eq(events.projectId, projectId))
      .all()

    return rows.at(0)?.max ?? 0
  }

  /** Projects that have events, for rebuilding every read model at startup. */
  projectIds(): readonly ProjectId[] {
    return this.db
      .selectDistinct({ projectId: events.projectId })
      .from(events)
      .all()
      .map((row) => row.projectId as ProjectId)
  }
}

/**
 * Validates a payload against the schema for its event type.
 *
 * Exported because the projections use it too: the same schema on the way in and
 * on the way out means a payload cannot be written in one shape and read in
 * another. Returns `unknown` rather than the type-specific payload, since both
 * call sites here feed the result into `DomainEvent.payload`, which is `unknown`
 * itself — the projection layer is where a payload is narrowed back to a specific
 * shape via `isType`.
 */
export function validatePayload(type: EventType, payload: unknown): unknown {
  const schema: z.ZodType = EVENT_PAYLOADS[type]
  const result = schema.safeParse(payload)

  if (!result.success) {
    throw new Error(`Invalid payload for ${type}: ${z.prettifyError(result.error)}`)
  }

  return result.data
}

function toDomainEvent(row: typeof events.$inferSelect): DomainEvent {
  let payload: unknown
  try {
    payload = JSON.parse(row.payload)
  } catch {
    throw new Error(`Event ${row.id} (${row.type}) has a payload that is not valid JSON`)
  }

  // Parsed on the way out as well as in: a row from an older version, or one
  // edited by hand, fails here rather than corrupting a projection.
  const event = domainEventSchema.safeParse({
    id: row.id,
    projectId: row.projectId,
    seq: row.seq,
    type: row.type,
    payload: validatePayload(row.type as EventType, payload),
    actor: row.actor,
    reason: row.reason,
    occurredAt: row.occurredAt,
  })

  if (!event.success) {
    throw new Error(`Event ${row.id} is malformed: ${z.prettifyError(event.error)}`)
  }

  return event.data
}
