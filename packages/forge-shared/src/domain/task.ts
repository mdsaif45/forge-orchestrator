import { z } from 'zod'
import { criterionKindSchema } from './enums'
import { decisionIdSchema, taskIdSchema, timestampSchema } from './ids'

/**
 * One machine-checkable condition for "done" (axiom A3).
 *
 * Criteria are evaluated against evidence Forge gathered itself, never against an
 * agent's summary. `params` is deliberately loose because each kind needs different
 * inputs; the evaluator in #35 narrows it per kind.
 */
export const completionCriterionSchema = z.strictObject({
  kind: criterionKindSchema,
  /** Human-readable, so a failure can be shown without decoding params. */
  description: z.string().min(1),
  params: z.record(z.string(), z.unknown()).readonly(),
})

export type CompletionCriterion = z.infer<typeof completionCriterionSchema>

/**
 * Which paths a task may touch.
 *
 * Globs are matched against repository-relative POSIX paths. An empty
 * `allowedPaths` means "anywhere not forbidden" — the common case early in a
 * project, where over-constraining would block legitimate work. Enforced in #34.
 */
export const scopePolicySchema = z.strictObject({
  allowedPaths: z.array(z.string().min(1)).readonly(),
  forbiddenPaths: z.array(z.string().min(1)).readonly(),
})

export type ScopePolicy = z.infer<typeof scopePolicySchema>

/**
 * What to achieve, and how completion will be judged.
 *
 * A task requires at least one completion criterion: without one, "done" would be
 * a matter of opinion, which is the failure this whole design exists to prevent.
 */
export const taskSchema = z.strictObject({
  id: taskIdSchema,
  objective: z.string().min(1),
  constraints: z.array(z.string().min(1)).readonly(),
  completionCriteria: z.array(completionCriterionSchema).min(1).readonly(),
  scope: scopePolicySchema,
  /** Decisions this task must respect, resolved when the packet is compiled. */
  lockedDecisionIds: z.array(decisionIdSchema).readonly(),
  /** Set when this task exists to fix findings from a previous review. */
  correctsTaskId: taskIdSchema.nullable(),
  createdAt: timestampSchema,
})

export type Task = z.infer<typeof taskSchema>
