import { z } from 'zod'
import { actorSchema, eventIdSchema, projectIdSchema, timestampSchema } from './ids'

/**
 * The event type union.
 *
 * Enumerated rather than free-form so a projection can switch exhaustively over
 * it: adding a type without handling it becomes a compile error, which is what
 * keeps read models honest as the domain grows (#16).
 */
export const EVENT_TYPES = [
  'project.created',
  'project.updated',
  'repository.bound',
  'rule.set',
  'rule.removed',
  'binding.set',
  'decision.proposed',
  'decision.approved',
  'decision.locked',
  'decision.superseded',
  'question.asked',
  'question.answered',
  'task.created',
  'workflow.started',
  'workflow.transitioned',
  'workflow.checkpointed',
  'workflow.halted',
  'workflow.finished',
  'step.started',
  'step.finished',
  'changeset.captured',
  'changeset.reviewed',
  'evidence.recorded',
] as const

export const eventTypeSchema = z.enum(EVENT_TYPES)
export type EventType = z.infer<typeof eventTypeSchema>

/**
 * One appended fact.
 *
 * The log is append-only: events are never updated and never deleted. Read models
 * are projections over it, and must be rebuildable from events alone — asserted by
 * a replay test in #16.
 *
 * `seq` is monotonic **per project** and assigned inside the same transaction as
 * the write, so ordering is total within a project without needing a global lock.
 *
 * `payload` is `unknown` here because each type carries a different shape. It is
 * validated against a per-type schema at the command layer rather than in this
 * envelope, which keeps the envelope stable as types are added.
 */
export const domainEventSchema = z.strictObject({
  id: eventIdSchema,
  projectId: projectIdSchema,
  seq: z.number().int().positive(),
  type: eventTypeSchema,
  payload: z.unknown(),
  actor: actorSchema,
  /** Why this happened, when the reason is not obvious from the type alone. */
  reason: z.string().min(1).nullable(),
  occurredAt: timestampSchema,
})

export type DomainEvent = z.infer<typeof domainEventSchema>
