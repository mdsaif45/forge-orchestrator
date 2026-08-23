import { z } from 'zod'
import type { EventType } from './event'
import { accountSchema } from './account'
import { changeSetSchema } from './changeset'
import { decisionSchema } from './decision'
import { accountStatusSchema, verdictSchema, workflowStateSchema } from './enums'
import { evidenceArtifactSchema } from './evidence'
import {
  accountIdSchema,
  actorSchema,
  changeSetIdSchema,
  decisionIdSchema,
  questionIdSchema,
  ruleIdSchema,
  stepIdSchema,
  taskIdSchema,
  timestampSchema,
  workflowIdSchema,
} from './ids'
import { agentBindingSchema, repositorySchema, ruleSchema } from './project'
import { openQuestionSchema } from './question'
import { findingSchema } from './review'
import { taskSchema } from './task'
import { workflowCheckpointSchema, workflowLimitsSchema, workflowStepSchema } from './workflow'

/**
 * One payload schema per event type.
 *
 * The envelope in `event.ts` types `payload` as `unknown`, because each type
 * carries a different shape. This map is what narrows it: the log validates
 * against the entry for the event's type on the way in, and a projection parses
 * with the same entry on the way out, so a payload cannot be written in one shape
 * and read in another.
 *
 * Payloads carry **what changed**, not the whole entity, except where the entity
 * is the thing being created. A full snapshot on every edit would make the log a
 * duplicate of the tables it is supposed to explain.
 */

const projectCreated = z.strictObject({
  name: z.string().min(1),
  createdAt: timestampSchema,
})

const projectUpdated = z.strictObject({
  name: z.string().min(1),
  updatedAt: timestampSchema,
})

const repositoryBound = z.strictObject({
  repository: repositorySchema,
})

const ruleSet = z.strictObject({
  rule: ruleSchema,
})

const ruleRemoved = z.strictObject({
  ruleId: ruleIdSchema,
})

const bindingSet = z.strictObject({
  binding: agentBindingSchema,
})

const decisionProposed = z.strictObject({
  decision: decisionSchema,
})

const decisionApproved = z.strictObject({
  decisionId: decisionIdSchema,
  approvedAt: timestampSchema,
})

const decisionLocked = z.strictObject({
  decisionId: decisionIdSchema,
  lockedAt: timestampSchema,
})

const decisionSuperseded = z.strictObject({
  decisionId: decisionIdSchema,
  supersededBy: decisionIdSchema,
})

const questionAsked = z.strictObject({
  question: openQuestionSchema,
})

const questionAnswered = z.strictObject({
  questionId: questionIdSchema,
  answer: z.string().min(1),
  answeredAt: timestampSchema,
  /** Set when the answer was promoted into a locked decision. */
  promotedToDecisionId: decisionIdSchema.nullable(),
})

const taskCreated = z.strictObject({
  task: taskSchema,
})

const workflowStarted = z.strictObject({
  workflowId: workflowIdSchema,
  taskId: taskIdSchema,
  templateId: z.string().min(1),
  limits: workflowLimitsSchema,
  startedAt: timestampSchema,
})

/**
 * A state change.
 *
 * `from` is recorded as well as `to` so the log reads as a history rather than a
 * set of assertions, and so an illegal transition is visible after the fact.
 */
const workflowTransitioned = z.strictObject({
  workflowId: workflowIdSchema,
  from: workflowStateSchema,
  to: workflowStateSchema,
  iteration: z.number().int().nonnegative(),
  blockedByQuestionId: questionIdSchema.nullable().optional(),
})

const workflowCheckpointed = z.strictObject({
  workflowId: workflowIdSchema,
  checkpoint: workflowCheckpointSchema,
})

const workflowHalted = z.strictObject({
  workflowId: workflowIdSchema,
  state: workflowStateSchema,
  haltReason: z.string().min(1),
})

const workflowFinished = z.strictObject({
  workflowId: workflowIdSchema,
  state: workflowStateSchema,
  finishedAt: timestampSchema,
})

const stepStarted = z.strictObject({
  workflowId: workflowIdSchema,
  step: workflowStepSchema,
})

const stepFinished = z.strictObject({
  workflowId: workflowIdSchema,
  stepId: stepIdSchema,
  verdict: verdictSchema.nullable(),
  changeSetId: changeSetIdSchema.nullable(),
  finishedAt: timestampSchema,
})

const changeSetCaptured = z.strictObject({
  changeSet: changeSetSchema,
})

/**
 * A completed review.
 *
 * Carries the reviewer's own claim alongside the verdict of record, because the two
 * can differ: Forge overrides a PASS that the evidence contradicts (#36), and a log
 * that kept only the outcome could not show that the disagreement happened.
 */
const changeSetReviewed = z.strictObject({
  changeSetId: changeSetIdSchema,
  /** The verdict of record, after any override. */
  verdict: verdictSchema,
  /** What the reviewer claimed, before Forge checked it against the evidence. */
  claimedVerdict: verdictSchema,
  overridden: z.boolean(),
  reason: z.string().min(1),
  findings: z.array(findingSchema).readonly(),
  reviewedBy: actorSchema,
})

/**
 * Evidence Forge gathered itself (axiom A3).
 *
 * The whole artifact is the payload rather than a summary of it, because the log is
 * the authority: a projection rebuilt from a summary could not reproduce the output
 * a reviewer read, and evidence that cannot be reproduced is not evidence. The
 * output is capped at capture time, which is what keeps this bounded.
 */
const evidenceRecorded = z.strictObject({
  artifact: evidenceArtifactSchema,
  /** Denormalised so the log can be filtered without parsing every payload. */
  workflowId: workflowIdSchema,
  stepId: stepIdSchema,
  summary: z.string().min(1),
})

const accountRegistered = z.strictObject({
  account: accountSchema,
})

const accountStatusUpdated = z.strictObject({
  accountId: accountIdSchema,
  status: accountStatusSchema,
  lastUsedAt: timestampSchema.nullable().optional(),
})

const accountRemoved = z.strictObject({
  accountId: accountIdSchema,
})

/**
 * The payload map.
 *
 * Every key in `EVENT_TYPES` must appear here; the `satisfies` below turns a
 * missing entry into a compile error rather than a runtime surprise.
 */
export const EVENT_PAYLOADS = {
  'project.created': projectCreated,
  'project.updated': projectUpdated,
  'repository.bound': repositoryBound,
  'rule.set': ruleSet,
  'rule.removed': ruleRemoved,
  'binding.set': bindingSet,
  'decision.proposed': decisionProposed,
  'decision.approved': decisionApproved,
  'decision.locked': decisionLocked,
  'decision.superseded': decisionSuperseded,
  'question.asked': questionAsked,
  'question.answered': questionAnswered,
  'task.created': taskCreated,
  'workflow.started': workflowStarted,
  'workflow.transitioned': workflowTransitioned,
  'workflow.checkpointed': workflowCheckpointed,
  'workflow.halted': workflowHalted,
  'workflow.finished': workflowFinished,
  'step.started': stepStarted,
  'step.finished': stepFinished,
  'changeset.captured': changeSetCaptured,
  'changeset.reviewed': changeSetReviewed,
  'evidence.recorded': evidenceRecorded,
  'account.registered': accountRegistered,
  'account.status_updated': accountStatusUpdated,
  'account.removed': accountRemoved,
} as const

// Every event type must have a payload schema. A missing entry is a compile error
// here rather than a runtime failure at the first write of that type.
type _PayloadsCoverEveryEventType = EventType extends keyof typeof EVENT_PAYLOADS
  ? keyof typeof EVENT_PAYLOADS extends EventType
    ? true
    : ['payload map has entries that are not event types']
  : ['event types missing a payload schema']
const _payloadCoverage: _PayloadsCoverEveryEventType = true
void _payloadCoverage

export type EventPayloads = {
  readonly [K in keyof typeof EVENT_PAYLOADS]: z.infer<(typeof EVENT_PAYLOADS)[K]>
}

/** A typed event: the type and its payload, before the envelope is added. */
export type EventInput = {
  readonly [K in keyof EventPayloads]: {
    readonly type: K
    readonly payload: EventPayloads[K]
  }
}[keyof EventPayloads]
