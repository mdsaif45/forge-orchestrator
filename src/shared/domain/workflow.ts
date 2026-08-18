import { z } from 'zod'
import { reportStatusSchema, roleSchema, verdictSchema, workflowStateSchema } from './enums'
import {
  changeSetIdSchema,
  questionIdSchema,
  stepIdSchema,
  taskIdSchema,
  timestampSchema,
  workflowIdSchema,
} from './ids'

/**
 * The bounds a workflow runs within (axiom A5).
 *
 * Every one of these exists because of a specific failure mode: without an
 * iteration cap two agents ping-pong forever; without an idle timeout a hung CLI
 * stalls silently; without a total budget a workflow can consume a day.
 */
export const workflowLimitsSchema = z.strictObject({
  maxIterations: z.number().int().positive().default(5),
  stepTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(30 * 60 * 1000),
  idleTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(10 * 60 * 1000),
  totalTimeoutMs: z
    .number()
    .int()
    .positive()
    .default(4 * 60 * 60 * 1000),
  maxRetries: z.number().int().nonnegative().default(3),
})

export type WorkflowLimits = z.infer<typeof workflowLimitsSchema>

/**
 * One attempt at one role's part of the work.
 *
 * `contextRef` points at the snapshotted prompt packet rather than embedding it, so
 * a resumed workflow replays the exact context it originally sent instead of
 * recompiling it from state that has since moved on (#28, #30).
 */
export const workflowStepSchema = z.strictObject({
  id: stepIdSchema,
  index: z.number().int().nonnegative(),
  role: roleSchema,
  /** Null for `system` steps, which Forge performs itself. */
  runtimeId: z.string().min(1).nullable(),
  state: workflowStateSchema,
  contextRef: z.string().min(1).nullable(),
  reportStatus: reportStatusSchema.nullable(),
  verdict: verdictSchema.nullable(),
  changeSetId: changeSetIdSchema.nullable(),
  startedAt: timestampSchema.nullable(),
  finishedAt: timestampSchema.nullable(),
})

export type WorkflowStep = z.infer<typeof workflowStepSchema>

/**
 * A checkpoint written before a step's side effects run.
 *
 * Write-ahead on purpose: if the process dies mid-step, the record of what was
 * being attempted already exists, so resume is exact rather than inferred (#28).
 */
export const workflowCheckpointSchema = z.strictObject({
  stepIndex: z.number().int().nonnegative(),
  state: workflowStateSchema,
  startedAt: timestampSchema,
  lastOperation: z.string().min(1),
})

export type WorkflowCheckpoint = z.infer<typeof workflowCheckpointSchema>

export const workflowSchema = z
  .strictObject({
    id: workflowIdSchema,
    taskId: taskIdSchema,
    templateId: z.string().min(1),
    state: workflowStateSchema,
    /** Counts review cycles, not steps: it is what `maxIterations` bounds. */
    iteration: z.number().int().nonnegative(),
    limits: workflowLimitsSchema,
    steps: z.array(workflowStepSchema).readonly(),
    checkpoint: workflowCheckpointSchema.nullable(),
    /** The state to return to once a blocking question is answered. */
    resumeState: workflowStateSchema.nullable(),
    blockedByQuestionId: questionIdSchema.nullable(),
    /** Machine-readable reason a workflow halted, alongside the human explanation. */
    haltReason: z.string().min(1).nullable(),
    startedAt: timestampSchema,
    finishedAt: timestampSchema.nullable(),
  })
  .check((ctx) => {
    const workflow = ctx.value

    // `AWAITING_USER` without a resume state would strand the workflow: nothing
    // would know where to continue from once the answer arrives.
    if (workflow.state === 'AWAITING_USER' && workflow.resumeState === null) {
      ctx.issues.push({
        code: 'custom',
        input: workflow,
        path: ['resumeState'],
        message: 'A workflow awaiting the user must record the state to resume into',
      })
    }

    if (workflow.state !== 'AWAITING_USER' && workflow.blockedByQuestionId !== null) {
      ctx.issues.push({
        code: 'custom',
        input: workflow,
        path: ['blockedByQuestionId'],
        message: 'Only a workflow awaiting the user may name a blocking question',
      })
    }

    const isHalted = workflow.state === 'HALTED_LIMIT' || workflow.state === 'HALTED_POLICY'
    if (isHalted && workflow.haltReason === null) {
      ctx.issues.push({
        code: 'custom',
        input: workflow,
        path: ['haltReason'],
        message: 'A halted workflow must record why it halted',
      })
    }

    if (workflow.iteration > workflow.limits.maxIterations) {
      ctx.issues.push({
        code: 'custom',
        input: workflow,
        path: ['iteration'],
        message: 'Iteration count cannot exceed the configured maximum',
      })
    }
  })

export type Workflow = z.infer<typeof workflowSchema>
