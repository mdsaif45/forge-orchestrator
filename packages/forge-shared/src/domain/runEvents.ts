import { z } from 'zod'
import { runIdSchema, stepIdSchema, timestampSchema } from './ids'

/**
 * An append-only lifecycle event emitted during an execution run.
 */
export const runEventSchema = z.strictObject({
  id: z.uuid(),
  runId: runIdSchema,
  seq: z.number().int().positive(),
  stepId: stepIdSchema.nullable(),
  type: z.string().min(1),
  payload: z.record(z.string(), z.unknown()),
  occurredAt: timestampSchema,
})

export type RunEvent = z.infer<typeof runEventSchema>

export interface RunEventInput {
  readonly stepId?: string | null | undefined
  readonly type: string
  readonly payload: Record<string, unknown>
  readonly occurredAt?: string | undefined
}
