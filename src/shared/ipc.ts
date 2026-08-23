import { z } from 'zod'

/**
 * The IPC contract — the single source of truth for the main/renderer boundary.
 *
 * Every channel is declared here once, with a schema for its request and its
 * response. The preload bridge, the main-process router, and the renderer types
 * are all derived from this object, so a channel cannot exist on one side
 * without existing on the other.
 *
 * Adding a capability means adding an entry here. There is deliberately no
 * generic passthrough: an undeclared channel is unreachable, not merely
 * discouraged (axiom A7).
 */

/** Payload schemas are strict: unknown keys are a rejection, not a silent drop. */
const empty = z.strictObject({})

export const appInfoSchema = z.strictObject({
  name: z.string(),
  version: z.string(),
  platform: z.string(),
  versions: z.strictObject({
    electron: z.string(),
    chrome: z.string(),
    node: z.string(),
  }),
})

export type AppInfo = z.infer<typeof appInfoSchema>

/**
 * Why a candidate folder cannot — or should not — be bound as a repository.
 *
 * Coded rather than free text so the renderer can decide presentation (a blocker
 * versus a warning) without matching on message strings, and so a new reason
 * cannot be added without both sides knowing about it.
 */
export const REPOSITORY_PROBE_CODES = [
  'empty-path',
  'not-absolute',
  'missing',
  'not-a-directory',
  'not-a-repository',
  'inside-repository',
  'no-commits',
  'detached-head',
] as const

export const repositoryProbeProblemSchema = z.strictObject({
  code: z.enum(REPOSITORY_PROBE_CODES),
  /** Written for the user, naming the specific thing to fix. */
  detail: z.string().min(1),
})

export type RepositoryProbeProblem = z.infer<typeof repositoryProbeProblemSchema>

/**
 * What Forge observed about a candidate repository.
 *
 * `isRepository` false means nothing else here is meaningful. A dirty worktree is
 * reported but is not a blocker: binding a repository with work in progress is
 * normal, and the refusal that matters happens later, when a workflow captures a
 * base SHA (`GitService.snapshot`).
 */
export const repositoryProbeSchema = z.strictObject({
  path: z.string(),
  isRepository: z.boolean(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  dirty: z.boolean(),
  /** Capped for display; `dirtyCount` carries the true total. */
  dirtyPaths: z.array(z.string()).readonly(),
  dirtyCount: z.number().int().nonnegative(),
  problems: z.array(repositoryProbeProblemSchema).readonly(),
})

export type RepositoryProbe = z.infer<typeof repositoryProbeSchema>

/** What the create-project form submits. Ids and timestamps are assigned in main. */
export const createProjectRequestSchema = z.strictObject({
  name: z.string().min(1),
  repositoryPath: z.string().min(1),
  defaultBranch: z.string().min(1),
  buildCommand: z.string().min(1).nullable(),
  testCommand: z.string().min(1).nullable(),
  tech: z.array(z.string().min(1)).readonly(),
  /** Free-text statements, one rule each, scoped to the project. */
  rules: z.array(z.string().min(1)).readonly(),
})

export type CreateProjectRequest = z.infer<typeof createProjectRequestSchema>

/**
 * A project as the renderer sees it.
 *
 * Structurally the domain `Project`, redeclared here because the contract is the
 * boundary's own type: `src/shared/domain` may not be reachable from the preload
 * types, and a channel schema that referenced it would couple the wire format to
 * an internal shape that is free to change. `projectSchema` remains the authority
 * in main; this is validated against what crosses.
 */
export const projectViewSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  repository: z.strictObject({
    id: z.string(),
    absolutePath: z.string(),
    defaultBranch: z.string(),
    buildCommand: z.string().nullable(),
    testCommand: z.string().nullable(),
    tech: z.array(z.string()).readonly(),
  }),
  createdAt: z.string(),
  updatedAt: z.string(),
})

export type ProjectView = z.infer<typeof projectViewSchema>

export const ruleViewSchema = z.strictObject({
  id: z.string(),
  scope: z.string(),
  key: z.string(),
  statement: z.string(),
  source: z.string(),
  createdAt: z.string(),
})

export type RuleView = z.infer<typeof ruleViewSchema>

/**
 * One rule of the effective policy, with what it displaced.
 *
 * `shadowed` is what lets a settings screen show *where* a value came from and which
 * wider rule it replaced — the difference between inherited and overridden. A
 * resolved policy that dropped the losers would make an override indistinguishable
 * from a rule that was simply set once.
 */
export const effectiveRuleViewSchema = z.strictObject({
  key: z.string(),
  statement: z.string(),
  scope: z.string(),
  source: z.string(),
  shadowed: z
    .array(
      z.strictObject({
        statement: z.string(),
        scope: z.string(),
        source: z.string(),
      }),
    )
    .readonly(),
})

export type EffectiveRuleView = z.infer<typeof effectiveRuleViewSchema>

/** A project plus the live repository state, which is read fresh rather than stored. */
export const projectDetailSchema = z.strictObject({
  project: projectViewSchema,
  rules: z.array(ruleViewSchema).readonly(),
  /** Forge's defaults merged with this project's rules, most specific winning. */
  policy: z.array(effectiveRuleViewSchema).readonly(),
  /** Null when the bound path is no longer a readable repository. */
  probe: repositoryProbeSchema.nullable(),
})

export type ProjectDetail = z.infer<typeof projectDetailSchema>

export const pickDirectoryResponseSchema = z.strictObject({
  path: z.string().nullable(),
})

export type PickDirectoryResponse = z.infer<typeof pickDirectoryResponseSchema>

export const workflowStepViewSchema = z.strictObject({
  id: z.string(),
  index: z.number().int().nonnegative(),
  role: z.string(),
  runtimeId: z.string().nullable(),
  state: z.string(),
  contextRef: z.string().nullable(),
  reportStatus: z.string().nullable(),
  verdict: z.string().nullable(),
  changeSetId: z.string().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
})

export type WorkflowStepView = z.infer<typeof workflowStepViewSchema>

export const workflowCheckpointViewSchema = z.strictObject({
  stepIndex: z.number().int().nonnegative(),
  state: z.string(),
  startedAt: z.string(),
  lastOperation: z.string(),
  inputRef: z.string().nullable(),
})

export type WorkflowCheckpointView = z.infer<typeof workflowCheckpointViewSchema>

export const workflowSummaryViewSchema = z.strictObject({
  id: z.string(),
  taskId: z.string(),
  templateId: z.string(),
  state: z.string(),
  iteration: z.number().int().nonnegative(),
  maxIterations: z.number().int().positive(),
  haltReason: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  stepCount: z.number().int().nonnegative(),
})

export type WorkflowSummaryView = z.infer<typeof workflowSummaryViewSchema>

export const workflowDetailViewSchema = z.strictObject({
  id: z.string(),
  taskId: z.string(),
  templateId: z.string(),
  state: z.string(),
  iteration: z.number().int().nonnegative(),
  limits: z.strictObject({
    maxIterations: z.number().int().positive(),
    stepTimeoutMs: z.number().int().positive(),
    idleTimeoutMs: z.number().int().positive(),
    totalTimeoutMs: z.number().int().positive(),
  }),
  steps: z.array(workflowStepViewSchema).readonly(),
  checkpoint: workflowCheckpointViewSchema.nullable(),
  resumeState: z.string().nullable(),
  blockedByQuestionId: z.string().nullable(),
  haltReason: z.string().nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
})

export type WorkflowDetailView = z.infer<typeof workflowDetailViewSchema>

export const promptPacketViewSchema = z.strictObject({
  role: z.string(),
  objective: z.string(),
  constraints: z.array(z.string()).readonly(),
  rules: z.array(z.string()).readonly(),
  lockedDecisions: z.array(z.string()).readonly(),
  allowedPaths: z.array(z.string()).readonly(),
  forbiddenPaths: z.array(z.string()).readonly(),
  relevantFiles: z.array(z.string()).readonly(),
  reviewFindings: z.array(z.string()).readonly(),
  previousAttempt: z
    .strictObject({
      summary: z.string(),
      diffStat: z.string(),
    })
    .nullable(),
  completionCriteria: z.array(z.string()).readonly(),
  answeredQuestions: z
    .array(z.strictObject({ question: z.string(), answer: z.string() }))
    .readonly(),
})

export type PromptPacketView = z.infer<typeof promptPacketViewSchema>

export const workflowEventPayloadSchema = z.strictObject({
  workflowId: z.string(),
  type: z.string(),
  state: z.string().optional(),
  detail: z.string().optional(),
  at: z.string(),
})

export type WorkflowEventPayload = z.infer<typeof workflowEventPayloadSchema>

export const workflowLogPayloadSchema = z.strictObject({
  workflowId: z.string(),
  stepIndex: z.number().int().nonnegative(),
  text: z.string(),
  at: z.string(),
})

export type WorkflowLogPayload = z.infer<typeof workflowLogPayloadSchema>

/**
 * The channel table.
 *
 * `request` is validated in main before the handler runs; `response` is
 * validated in main before the value crosses back, so a handler bug surfaces
 * here rather than as a confusing failure in the renderer.
 */
export const IPC_CONTRACT = {
  'app:getInfo': { request: empty, response: appInfoSchema },
  'dialog:pickDirectory': { request: empty, response: pickDirectoryResponseSchema },
  'project:probeRepository': {
    request: z.strictObject({ path: z.string() }),
    response: repositoryProbeSchema,
  },
  'project:create': {
    request: createProjectRequestSchema,
    response: projectViewSchema,
  },
  'project:list': {
    request: empty,
    response: z.strictObject({ projects: z.array(projectViewSchema).readonly() }),
  },
  'project:get': {
    request: z.strictObject({ projectId: z.string() }),
    response: projectDetailSchema.nullable(),
  },
  /**
   * Sets one rule at one scope. Overwrites the rule with the same (scope, key),
   * which is how an override is expressed rather than accumulating near-duplicates.
   */
  'rule:set': {
    request: z.strictObject({
      projectId: z.string(),
      scope: z.string(),
      key: z.string().min(1),
      statement: z.string().min(1),
    }),
    response: projectDetailSchema.nullable(),
  },
  'rule:remove': {
    request: z.strictObject({ projectId: z.string(), ruleId: z.string() }),
    response: projectDetailSchema.nullable(),
  },
  'workflow:list': {
    request: z.strictObject({ projectId: z.string() }),
    response: z.strictObject({ workflows: z.array(workflowSummaryViewSchema).readonly() }),
  },
  'workflow:get': {
    request: z.strictObject({ workflowId: z.string() }),
    response: workflowDetailViewSchema.nullable(),
  },
  'workflow:getActive': {
    request: z.strictObject({ projectId: z.string() }),
    response: workflowDetailViewSchema.nullable(),
  },
  'workflow:start': {
    request: z.strictObject({
      projectId: z.string(),
      taskId: z.string().optional(),
      templateId: z.string().optional(),
      objective: z.string().optional(),
    }),
    response: workflowDetailViewSchema,
  },
  'workflow:cancel': {
    request: z.strictObject({ workflowId: z.string(), reason: z.string().optional() }),
    response: workflowDetailViewSchema.nullable(),
  },
  'workflow:resume': {
    request: z.strictObject({ workflowId: z.string() }),
    response: workflowDetailViewSchema.nullable(),
  },
  'workflow:getPacket': {
    request: z.strictObject({ packetRef: z.string() }),
    response: promptPacketViewSchema.nullable(),
  },
} as const satisfies IpcContractShape

interface IpcChannelSpec {
  readonly request: z.ZodType
  readonly response: z.ZodType
}

type IpcContractShape = Readonly<Record<string, IpcChannelSpec>>

export type IpcContract = typeof IPC_CONTRACT

/** Union of every declared channel name. A typo is a compile error. */
export type IpcChannel = keyof IpcContract

export type IpcRequest<C extends IpcChannel> = z.infer<IpcContract[C]['request']>
export type IpcResponse<C extends IpcChannel> = z.infer<IpcContract[C]['response']>

export const IPC_CHANNELS = Object.keys(IPC_CONTRACT) as readonly IpcChannel[]

export function isIpcChannel(value: unknown): value is IpcChannel {
  return typeof value === 'string' && Object.hasOwn(IPC_CONTRACT, value)
}

/**
 * Failures cross the boundary as data, never as a thrown Error.
 *
 * Electron serializes a rejected `invoke` into an opaque string that loses the
 * cause, so the router resolves an explicit result envelope instead. The
 * renderer-side bridge unwraps it and throws locally, where the stack is useful.
 */
export const IPC_ERROR_CODES = [
  'INVALID_REQUEST',
  'INVALID_RESPONSE',
  'UNKNOWN_CHANNEL',
  'HANDLER_FAILED',
] as const

export type IpcErrorCode = (typeof IPC_ERROR_CODES)[number]

export interface IpcFailure {
  readonly ok: false
  readonly code: IpcErrorCode
  readonly message: string
}

export interface IpcSuccess<T> {
  readonly ok: true
  readonly value: T
}

export type IpcResult<T> = IpcSuccess<T> | IpcFailure
