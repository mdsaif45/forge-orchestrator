import { z } from 'zod'
import { decisionStatusSchema } from './enums'
import { actorSchema, decisionIdSchema, questionIdSchema, timestampSchema } from './ids'

/**
 * A choice, recorded once and then binding (axiom A4).
 *
 * `rationale` is required rather than optional: a decision without a reason cannot
 * be re-evaluated later, and "why is it like this?" is the question this entity
 * exists to answer.
 *
 * `lockedAt` and `lockedBy` are only set in the `locked` state, and only a user may
 * set them — no agent-reachable path may lock, unlock, or supersede a decision
 * (#40).
 */
export const decisionSchema = z
  .strictObject({
    id: decisionIdSchema,
    statement: z.string().min(1),
    rationale: z.string().min(1),
    status: decisionStatusSchema,
    /** Who proposed it — often an agent, which is fine; only locking is restricted. */
    proposedBy: actorSchema,
    proposedAt: timestampSchema,
    lockedAt: timestampSchema.nullable(),
    lockedBy: actorSchema.nullable(),
    /** Set when a change request replaces this decision, giving it lineage. */
    supersededBy: decisionIdSchema.nullable(),
    /** Present when the decision was promoted from an answered question. */
    originQuestionId: questionIdSchema.nullable(),
  })
  .check((ctx) => {
    const decision = ctx.value

    // A locked decision must record who locked it and when, otherwise the audit
    // trail claims a guarantee it cannot evidence.
    if (
      decision.status === 'locked' &&
      (decision.lockedAt === null || decision.lockedBy === null)
    ) {
      ctx.issues.push({
        code: 'custom',
        input: decision,
        path: ['lockedAt'],
        message: 'A locked decision must record lockedAt and lockedBy',
      })
    }

    // Only a user may lock. This is the schema-level half of axiom A4; the
    // command layer enforces the same rule (#40).
    if (
      decision.status === 'locked' &&
      decision.lockedBy !== null &&
      decision.lockedBy !== 'user'
    ) {
      ctx.issues.push({
        code: 'custom',
        input: decision,
        path: ['lockedBy'],
        message: 'Only the user may lock a decision',
      })
    }

    if (decision.status !== 'superseded' && decision.supersededBy !== null) {
      ctx.issues.push({
        code: 'custom',
        input: decision,
        path: ['supersededBy'],
        message: 'Only a superseded decision may name its replacement',
      })
    }

    if (decision.status === 'superseded' && decision.supersededBy === null) {
      ctx.issues.push({
        code: 'custom',
        input: decision,
        path: ['supersededBy'],
        message: 'A superseded decision must name the decision that replaced it',
      })
    }
  })

export type Decision = z.infer<typeof decisionSchema>

/** A decision that an agent must treat as binding, as sent in a prompt packet. */
export const lockedDecisionSchema = z.strictObject({
  id: decisionIdSchema,
  statement: z.string().min(1),
  rationale: z.string().min(1),
})

export type LockedDecision = z.infer<typeof lockedDecisionSchema>
