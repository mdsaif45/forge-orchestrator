import { z } from 'zod'
import { accountStatusSchema } from './enums'
import { accountIdSchema, timestampSchema } from './ids'

/**
 * A provider account managed by Forge (#44).
 *
 * Switching accounts changes only runtime credentials or active sessions, and never
 * mutates project state, decisions, or workflow history.
 *
 * `provider` is an opaque identifier (e.g. string), preserving provider agnosticism (Axiom A6).
 */
export const accountSchema = z.strictObject({
  id: accountIdSchema,
  provider: z.string().min(1),
  label: z.string().min(1),
  status: accountStatusSchema,
  lastUsedAt: timestampSchema.nullable(),
  createdAt: timestampSchema,
})

export type Account = z.infer<typeof accountSchema>
