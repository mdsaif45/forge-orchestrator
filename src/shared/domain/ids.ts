import { z } from 'zod'

/**
 * Branded identifiers.
 *
 * Every entity gets its own nominal type, so passing a `TaskId` where a
 * `WorkflowId` is expected is a compile error rather than a runtime mystery.
 * Forge will hold many parallel id-shaped values — project, task, workflow, step,
 * changeset, decision, question — and they are all UUIDs, which makes them
 * structurally identical and therefore easy to swap by accident.
 */

/**
 * The brand is a phantom type parameter: it exists only in the type system and is
 * supplied explicitly, since there is no runtime argument to infer it from.
 *
 * `no-unnecessary-type-parameters` flags a parameter used once in the signature,
 * which is accurate here and also precisely the mechanism — the brand's only job is
 * to make the return type nominal. Disabled deliberately rather than worked around
 * by threading a value that would exist only to satisfy the rule.
 */
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters
function id<Brand extends string>() {
  return z.uuid().brand<Brand>()
}

export const projectIdSchema = id<'ProjectId'>()
export const repositoryIdSchema = id<'RepositoryId'>()
export const ruleIdSchema = id<'RuleId'>()
export const agentBindingIdSchema = id<'AgentBindingId'>()
export const decisionIdSchema = id<'DecisionId'>()
export const questionIdSchema = id<'QuestionId'>()
export const taskIdSchema = id<'TaskId'>()
export const workflowIdSchema = id<'WorkflowId'>()
export const stepIdSchema = id<'StepId'>()
export const changeSetIdSchema = id<'ChangeSetId'>()
export const evidenceIdSchema = id<'EvidenceId'>()
export const eventIdSchema = id<'EventId'>()

export type ProjectId = z.infer<typeof projectIdSchema>
export type RepositoryId = z.infer<typeof repositoryIdSchema>
export type RuleId = z.infer<typeof ruleIdSchema>
export type AgentBindingId = z.infer<typeof agentBindingIdSchema>
export type DecisionId = z.infer<typeof decisionIdSchema>
export type QuestionId = z.infer<typeof questionIdSchema>
export type TaskId = z.infer<typeof taskIdSchema>
export type WorkflowId = z.infer<typeof workflowIdSchema>
export type StepId = z.infer<typeof stepIdSchema>
export type ChangeSetId = z.infer<typeof changeSetIdSchema>
export type EvidenceId = z.infer<typeof evidenceIdSchema>
export type EventId = z.infer<typeof eventIdSchema>

/**
 * An ISO-8601 timestamp, stored as a string.
 *
 * Deliberately not a `Date`: these values cross the IPC boundary, where a `Date`
 * survives structured cloning but does not survive the JSON round trip used for
 * prompt packets and event payloads. One representation everywhere avoids a class
 * of "works in main, breaks in the packet" bugs.
 */
export const timestampSchema = z.iso.datetime()
export type Timestamp = z.infer<typeof timestampSchema>

/**
 * A repository-relative POSIX path.
 *
 * Normalised to forward slashes even on Windows, because these paths are compared
 * against `git` output, embedded in prompt packets, and matched against glob-based
 * scope rules — three places where a backslash would silently fail to match.
 */
export const repoPathSchema = z
  .string()
  .min(1)
  .refine((value) => !value.includes('\\'), {
    message: 'Use forward slashes: repository paths are POSIX-style, even on Windows',
  })
  .refine((value) => !value.startsWith('/') && !/^[a-zA-Z]:/.test(value), {
    message: 'Repository paths are relative to the repository root',
  })
export type RepoPath = z.infer<typeof repoPathSchema>

/** A git object id. Accepts both abbreviated and full SHA-1 hex. */
export const shaSchema = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, 'Expected a lowercase hex git SHA of 7 to 40 characters')
export type Sha = z.infer<typeof shaSchema>

/**
 * Who performed an action.
 *
 * Present on every event, and the reason the log can answer "why is the code like
 * this?" months later. `agent:<id>` keeps the specific runtime attributable, so an
 * agent's claim can be checked against what actually happened (axiom A3).
 */
export const actorSchema = z.union([
  z.literal('user'),
  z.literal('system'),
  z.templateLiteral(['agent:', z.string().min(1)]),
])
export type Actor = z.infer<typeof actorSchema>
