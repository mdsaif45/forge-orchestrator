import { z } from 'zod'
import {
  changeSetIdSchema,
  evidenceIdSchema,
  projectIdSchema,
  runIdSchema,
  stepIdSchema,
  taskIdSchema,
  timestampSchema,
} from './ids'
import { runtimeIdSchema } from './runtime'

/** Lifecycle status of a run or step. */
export const runStatusSchema = z.enum(['running', 'completed', 'failed', 'halted'])
export type RunStatus = z.infer<typeof runStatusSchema>

/** Whether a run was triggered directly (e.g. CLI) or via a workflow DAG. */
export const runTypeSchema = z.enum(['direct-task', 'workflow'])
export type RunType = z.infer<typeof runTypeSchema>

/**
 * An execution run in Forge.
 *
 * Provides stable identity for task runs across CLI and workflow engines.
 */
export const runRecordSchema = z.strictObject({
  id: runIdSchema,
  projectId: projectIdSchema,
  taskId: taskIdSchema,
  type: runTypeSchema,
  status: runStatusSchema,
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  exitCode: z.number().int().nullable(),
  summary: z.string().nullable(),
  error: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
})

export type RunRecord = z.infer<typeof runRecordSchema>

/**
 * A discrete execution step inside a run.
 */
export const stepRecordSchema = z.strictObject({
  id: stepIdSchema,
  runId: runIdSchema,
  index: z.number().int().nonnegative(),
  role: z.string().min(1),
  runtimeId: runtimeIdSchema.nullable(),
  status: runStatusSchema,
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable(),
  summary: z.string().nullable(),
  changeSetId: changeSetIdSchema.nullable(),
  evidenceId: evidenceIdSchema.nullable(),
})

export type StepRecord = z.infer<typeof stepRecordSchema>
