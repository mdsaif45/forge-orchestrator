import { z } from 'zod'

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
  /** The branch checked out right now. Not the same thing as `defaultBranch`. */
  branch: z.string().nullable(),
  /**
   * The repository's default branch — the merge target, and the base a diff is
   * measured against.
   *
   * Null when it cannot be determined, which is a real answer rather than a licence
   * to fall back to `branch`: conflating the two was the #100 defect, where a project
   * created on a feature branch recorded that branch as its default and silently
   * changed every downstream scope verdict.
   */
  defaultBranch: z.string().nullable(),
  /**
   * Which rule produced `defaultBranch`, so the UI can tell a fact from a guess (#140).
   *
   * ```
   * origin-head  the remote stating its own default — authoritative, shown as a fact
   * config       init.defaultBranch, and that branch exists here
   * convention   `main` or `master` happened to exist — a guess that matched
   * ```
   *
   * Null exactly when `defaultBranch` is null. Kept as a separate field rather than
   * folded into one object because `defaultBranch` is already consumed in several
   * places, and widening it there would be a change with no reader.
   */
  defaultBranchSource: z.enum(['origin-head', 'config', 'convention']).nullable(),
  /** Local branches, so the user picks a default instead of accepting a guess. */
  branches: z.array(z.string()).readonly(),
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
  /**
   * True when the runtime that produced this step replays scripted output rather than
   * doing real work.
   *
   * Carried to the renderer so a simulated run cannot be mistaken for a verified one
   * (#101). Null when no runtime is bound yet, which is distinct from "known to be
   * real" and must not be rendered as reassurance.
   */
  simulated: z.boolean().nullable(),
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

export const templateStepViewSchema = z.strictObject({
  role: z.string(),
  label: z.string(),
  advanceTrigger: z.string(),
  performedByForge: z.boolean(),
})

export const workflowTemplateViewSchema = z.strictObject({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  steps: z.array(templateStepViewSchema).readonly(),
})

export type WorkflowTemplateView = z.infer<typeof workflowTemplateViewSchema>

export const slotDefinitionViewSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.string().min(1),
  required: z.boolean().default(true),
  formHint: z.string().optional(),
  description: z.string().optional(),
})
export type SlotDefinitionView = z.infer<typeof slotDefinitionViewSchema>

export const outputDefinitionViewSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.string().min(1),
  format: z.enum(['markdown', 'diff', 'json', 'text']).default('markdown'),
  requiredH1: z.string().optional(),
  requiredSections: z.array(z.string()).readonly().default([]),
  description: z.string().optional(),
})
export type OutputDefinitionView = z.infer<typeof outputDefinitionViewSchema>

export const nodeRuntimeConfigViewSchema = z.strictObject({
  agentExecutable: z.string().optional(),
  argsTemplate: z.string().optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).readonly().default([]),
  permissionMode: z.enum(['read-only', 'developer', 'full-access']).default('developer'),
})
export type NodeRuntimeConfigView = z.infer<typeof nodeRuntimeConfigViewSchema>

export const workflowNodeViewSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  templateId: z.string().optional(),
  type: z.enum(['agent', 'user_gate', 'verification', 'router']),
  runtimeType: z.enum(['forge-native', 'cli-agent', 'human', 'forge-engine']),
  config: nodeRuntimeConfigViewSchema.default({
    skills: [],
    permissionMode: 'developer',
  }),
  inputs: z.array(slotDefinitionViewSchema).readonly().default([]),
  outputs: z.array(outputDefinitionViewSchema).readonly().default([]),
  position: z.strictObject({ x: z.number(), y: z.number() }).optional(),
})
export type WorkflowNodeView = z.infer<typeof workflowNodeViewSchema>

export const workflowEdgeViewSchema = z.strictObject({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().optional(),
  target: z.string().min(1),
  targetHandle: z.string().optional(),
})
export type WorkflowEdgeView = z.infer<typeof workflowEdgeViewSchema>

export const workflowTemplateV2ViewSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.number().int().positive().default(1),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  category: z.string().default('General'),
  nodes: z.array(workflowNodeViewSchema).min(1).readonly(),
  edges: z.array(workflowEdgeViewSchema).readonly().default([]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})
export type WorkflowTemplateV2View = z.infer<typeof workflowTemplateV2ViewSchema>

export const workflowArtifactViewSchema = z.strictObject({
  id: z.string().min(1),
  workflowId: z.string().min(1),
  nodeId: z.string().min(1),
  stepIndex: z.number().int().nonnegative().optional(),
  kind: z.string().min(1),
  format: z.enum(['markdown', 'diff', 'json', 'text']),
  title: z.string().min(1),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).readonly().default({}),
  createdAt: z.string().min(1),
})
export type WorkflowArtifactView = z.infer<typeof workflowArtifactViewSchema>

export const artifactKindViewSchema = z.enum([
  'stdout',
  'stderr',
  'tool-input',
  'tool-output',
  'diff',
  'prompt-packet',
  'agent-raw',
  'custom',
])

export const artifactMetadataViewSchema = z.strictObject({
  id: z.string().min(1),
  runId: z.string().min(1),
  stepId: z.string().nullable(),
  kind: artifactKindViewSchema,
  name: z.string().min(1),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().nonnegative(),
  sha256: z.string().min(1),
  relativePath: z.string().min(1),
  createdAt: z.string().min(1),
})

export type ArtifactMetadataView = z.infer<typeof artifactMetadataViewSchema>

export const artifactWindowViewSchema = z.strictObject({
  /** Base64-encoded bytes of the read window. Preserves arbitrary binary without UTF-8 corruption. */
  data: z.string(),
  /** The transport encoding of `data`. Always 'base64'. */
  encoding: z.literal('base64'),
  /** Total byte length of the artifact on disk. */
  totalBytes: z.number().int().nonnegative(),
})

export type ArtifactWindowView = z.infer<typeof artifactWindowViewSchema>

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

export const evidenceRefViewSchema = z.strictObject({
  path: z.string(),
  line: z.number().int().positive().nullable(),
  note: z.string(),
})

export type EvidenceRefView = z.infer<typeof evidenceRefViewSchema>

export const openQuestionViewSchema = z.strictObject({
  id: z.string(),
  projectId: z.string().optional(),
  question: z.string(),
  whyUndetermined: z.string(),
  evidence: z.array(evidenceRefViewSchema).readonly(),
  options: z.array(z.string()).readonly(),
  recommendation: z.string().nullable(),
  askedBy: z.string(),
  askedAt: z.string(),
  answer: z.string().nullable(),
  answeredAt: z.string().nullable(),
  answeredBy: z.string().nullable(),
})

export type OpenQuestionView = z.infer<typeof openQuestionViewSchema>

export const decisionViewSchema = z.strictObject({
  id: z.string(),
  projectId: z.string().optional(),
  statement: z.string(),
  rationale: z.string(),
  status: z.enum(['proposed', 'approved', 'locked', 'superseded']),
  proposedBy: z.string(),
  proposedAt: z.string(),
  lockedAt: z.string().nullable(),
  lockedBy: z.string().nullable(),
  supersededBy: z.string().nullable(),
  originQuestionId: z.string().nullable(),
})

export type DecisionView = z.infer<typeof decisionViewSchema>

export const changedFileViewSchema = z.strictObject({
  path: z.string(),
  changeType: z.enum(['added', 'modified', 'deleted', 'renamed']),
  previousPath: z.string().nullable(),
  insertions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
})

export type ChangedFileView = z.infer<typeof changedFileViewSchema>

export const discrepancyViewSchema = z.strictObject({
  path: z.string(),
  kind: z.enum(['claimed-but-unchanged', 'changed-but-unclaimed', 'outside-scope']),
  detail: z.string(),
})

export type DiscrepancyView = z.infer<typeof discrepancyViewSchema>

export const changeSetViewSchema = z.strictObject({
  id: z.string(),
  projectId: z.string().optional(),
  baseSha: z.string(),
  headSha: z.string().nullable(),
  files: z.array(changedFileViewSchema).readonly(),
  patch: z.string(),
  authorActor: z.string(),
  stepId: z.string(),
  taskId: z.string(),
  correctsChangeSetId: z.string().nullable(),
  reviewVerdict: z.string().nullable(),
  discrepancies: z.array(discrepancyViewSchema).readonly(),
  capturedAt: z.string(),
})

export type ChangeSetView = z.infer<typeof changeSetViewSchema>

export const accountViewSchema = z.strictObject({
  id: z.string(),
  provider: z.string().min(1),
  label: z.string().min(1),
  status: z.enum(['connected', 'expired', 'rate_limited', 'disconnected']),
  lastUsedAt: z.string().nullable(),
  createdAt: z.string(),
})

export type AccountView = z.infer<typeof accountViewSchema>

export const agentBindingViewSchema = z.strictObject({
  id: z.string(),
  role: z.string(),
  runtimeId: z.string(),
  accountId: z.string().nullable(),
  /** Null when the bound runtime is no longer registered — unknown, not "real". */
  simulated: z.boolean().nullable(),
})

export type AgentBindingView = z.infer<typeof agentBindingViewSchema>

/**
 * Every assignable role with its current binding and the runtimes eligible for it.
 *
 * Eligibility is computed in main from declared capabilities, so the UI cannot offer a
 * pairing that binding would then refuse.
 */
export const roleBindingsViewSchema = z.strictObject({
  roles: z
    .array(
      z.strictObject({
        role: z.string(),
        binding: agentBindingViewSchema.nullable(),
        eligibleRuntimes: z
          .array(
            z.strictObject({
              id: z.string(),
              simulated: z.boolean(),
              /** False when concurrent sessions share one account (#111). */
              supportsAccountIsolation: z.boolean(),
            }),
          )
          .readonly(),
      }),
    )
    .readonly(),
})

export type RoleBindingsView = z.infer<typeof roleBindingsViewSchema>

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

export const providerChunkPayloadSchema = z.strictObject({
  streamId: z.string(),
  /**
   * `tool` is progress from an agent turn — which tool ran and how it went.
   *
   * A separate kind rather than prose in `content`, because it is not part of
   * the model's answer and must not be saved into the message as if it were.
   */
  kind: z.enum(['reasoning', 'content', 'tool']),
  text: z.string(),
})

export type ProviderChunkPayload = z.infer<typeof providerChunkPayloadSchema>
