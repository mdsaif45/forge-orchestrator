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
  /**
   * Writes text to the system clipboard.
   *
   * Owned by main because `navigator.clipboard` requires a secure context and a
   * packaged renderer loads from `file://`, where it rejects with a permission error
   * (#104). Electron's own clipboard module has no such restriction.
   */
  'clipboard:writeText': {
    request: z.strictObject({ text: z.string() }),
    response: empty,
  },
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
  /**
   * Changes a project's name and repository settings.
   *
   * The repository path is deliberately absent: pointing a project at a different
   * repository invalidates every recorded path, diff base, and changeset, so that is
   * a new project rather than an edit (#112).
   *
   * An omitted field is left unchanged; an explicit null clears a command. Those are
   * different intents, and collapsing them would make it impossible to unset one.
   */
  'project:update': {
    request: z.strictObject({
      projectId: z.string(),
      name: z.string().optional(),
      defaultBranch: z.string().optional(),
      buildCommand: z.string().nullable().optional(),
      testCommand: z.string().nullable().optional(),
      tech: z.array(z.string()).readonly().optional(),
    }),
    response: projectDetailSchema.nullable(),
  },
  'project:delete': {
    request: z.strictObject({ projectId: z.string() }),
    response: z.strictObject({ success: z.boolean() }),
  },
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
  'workflow:approveAndStartImplementation': {
    request: z.strictObject({ workflowId: z.string() }),
    response: workflowDetailViewSchema,
  },
  'workflow:getPacket': {
    request: z.strictObject({ packetRef: z.string() }),
    response: promptPacketViewSchema.nullable(),
  },
  'workflow:exportReport': {
    request: z.strictObject({ workflowId: z.string() }),
    response: z.strictObject({
      reportMarkdown: z.string(),
      exportedAt: z.string(),
    }),
  },
  /**
   * Writes the audit report to a file the user chooses.
   *
   * Separate from `exportReport` because delivery belongs in main: the renderer
   * loads from `file://` in a packaged build, which is not a secure context, so
   * `navigator.clipboard` rejects there and the sandbox has no filesystem access
   * either (#104). `savedPath` is null when the user cancels the dialog, which is an
   * ordinary outcome rather than an error.
   */
  'workflow:saveReport': {
    request: z.strictObject({ workflowId: z.string() }),
    response: z.strictObject({
      savedPath: z.string().nullable(),
    }),
  },
  /**
   * The registered runtimes and whether each is real.
   *
   * Read-only and minimal on purpose: #101 needs it to warn, before a workflow
   * starts, that nothing but a simulated runtime is available. Binding runtimes to
   * roles is #102's job and deliberately not exposed here.
   */
  'runtime:list': {
    request: empty,
    response: z.strictObject({
      runtimes: z
        .array(
          z.strictObject({
            id: z.string(),
            simulated: z.boolean(),
            /** False when concurrent sessions of this runtime share one account (#111). */
            supportsAccountIsolation: z.boolean(),
            capabilities: z.array(z.string()).readonly(),
          }),
        )
        .readonly(),
    }),
  },
  'binding:list': {
    request: z.strictObject({ projectId: z.string() }),
    response: roleBindingsViewSchema,
  },
  'binding:set': {
    request: z.strictObject({
      projectId: z.string(),
      role: z.string(),
      runtimeId: z.string(),
    }),
    response: agentBindingViewSchema,
  },
  'question:list': {
    request: z.strictObject({ projectId: z.string(), unansweredOnly: z.boolean().optional() }),
    response: z.strictObject({ questions: z.array(openQuestionViewSchema).readonly() }),
  },
  'question:get': {
    request: z.strictObject({ questionId: z.string() }),
    response: openQuestionViewSchema.nullable(),
  },
  'question:answer': {
    request: z.strictObject({
      questionId: z.string(),
      answer: z.string().min(1),
      promoteToDecision: z.boolean().optional(),
    }),
    response: openQuestionViewSchema,
  },
  'decision:list': {
    request: z.strictObject({ projectId: z.string(), status: z.string().optional() }),
    response: z.strictObject({ decisions: z.array(decisionViewSchema).readonly() }),
  },
  'decision:get': {
    request: z.strictObject({ decisionId: z.string() }),
    response: decisionViewSchema.nullable(),
  },
  'decision:propose': {
    request: z.strictObject({
      projectId: z.string(),
      statement: z.string().min(1),
      rationale: z.string().min(1),
    }),
    response: decisionViewSchema,
  },
  'decision:approve': {
    request: z.strictObject({ decisionId: z.string() }),
    response: decisionViewSchema,
  },
  'decision:lock': {
    request: z.strictObject({ decisionId: z.string() }),
    response: decisionViewSchema,
  },
  'decision:supersede': {
    request: z.strictObject({
      decisionId: z.string(),
      replacementStatement: z.string().min(1),
      replacementRationale: z.string().min(1),
    }),
    response: z.strictObject({
      superseded: decisionViewSchema,
      replacement: decisionViewSchema,
    }),
  },
  'changeset:list': {
    request: z.strictObject({ projectId: z.string() }),
    response: z.strictObject({ changeSets: z.array(changeSetViewSchema).readonly() }),
  },
  'changeset:get': {
    request: z.strictObject({ changeSetId: z.string() }),
    response: changeSetViewSchema.nullable(),
  },
  'git:getWorkingDiff': {
    request: z.strictObject({ projectId: z.string() }),
    response: z.strictObject({
      files: z.array(changedFileViewSchema).readonly(),
      patch: z.string(),
    }),
  },
  /**
   * Every file git tracks or would track, for browsing the repository (#107).
   *
   * Ignored files are excluded by git itself, so the list cannot drift from
   * `.gitignore` the way a matcher of ours would.
   */
  'git:listFiles': {
    request: z.strictObject({ projectId: z.string() }),
    response: z.strictObject({ files: z.array(z.string()).readonly() }),
  },
  'git:readFile': {
    request: z.strictObject({ projectId: z.string(), path: z.string() }),
    response: z.strictObject({ content: z.string() }),
  },
  'git:writeFile': {
    request: z.strictObject({
      projectId: z.string(),
      path: z.string(),
      content: z.string(),
    }),
    response: z.strictObject({ success: z.boolean() }),
  },
  /**
   * What Forge can establish about an account right now.
   *
   * `isolatable` false means the provider cannot hold more than one identity on this
   * machine, which is a different problem from "not signed in" and has a different
   * remedy — so the two are reported separately rather than collapsed (#111).
   */
  'account:enrollmentStatus': {
    request: z.strictObject({ accountId: z.string(), runtimeId: z.string() }),
    response: z.strictObject({
      accountId: z.string(),
      isolatable: z.boolean(),
      home: z.string().nullable(),
      loggedIn: z.boolean(),
      authMethod: z.string(),
      email: z.string().nullable(),
    }),
  },
  /**
   * Opens the user's terminal to sign in, isolated to this account's home.
   *
   * Forge prepares the environment and hands the window over; the vendor CLI performs
   * the login and writes its own credential. Nothing here returns or transports a
   * secret, and the outcome is learned by probing status afterwards.
   */
  'account:beginEnrollment': {
    request: z.strictObject({ accountId: z.string(), runtimeId: z.string() }),
    response: z.strictObject({ home: z.string() }),
  },
  /** Deletes the account's home, which is the whole of revoking its local access. */
  'account:revokeEnrollment': {
    request: z.strictObject({ accountId: z.string() }),
    response: empty,
  },
  'account:list': {
    request: z.strictObject({ provider: z.string().optional() }),
    response: z.strictObject({ accounts: z.array(accountViewSchema).readonly() }),
  },
  'account:register': {
    request: z.strictObject({
      provider: z.string().min(1),
      label: z.string().min(1),
    }),
    response: accountViewSchema,
  },
  'account:updateStatus': {
    request: z.strictObject({
      accountId: z.string(),
      status: z.enum(['connected', 'expired', 'rate_limited', 'disconnected']),
    }),
    response: accountViewSchema,
  },
  'account:remove': {
    request: z.strictObject({ accountId: z.string() }),
    response: z.strictObject({ success: z.boolean() }),
  },
  'template:list': {
    request: empty,
    response: z.strictObject({ templates: z.array(workflowTemplateViewSchema).readonly() }),
  },
  'template:get': {
    request: z.strictObject({ templateId: z.string() }),
    response: workflowTemplateViewSchema.nullable(),
  },
  'terminal:spawn': {
    request: z.strictObject({
      projectId: z.string(),
      runtimeId: z.string().nullable().optional(),
      command: z.string().optional(),
      args: z.array(z.string()).readonly().optional(),
      cwd: z.string().optional(),
      env: z.record(z.string(), z.string()).optional(),
      cols: z.number().optional(),
      rows: z.number().optional(),
    }),
    response: z.strictObject({
      terminalId: z.string(),
      pid: z.number().optional(),
    }),
  },
  'terminal:write': {
    request: z.strictObject({
      terminalId: z.string(),
      data: z.string(),
    }),
    response: empty,
  },
  'terminal:resize': {
    request: z.strictObject({
      terminalId: z.string(),
      cols: z.number(),
      rows: z.number(),
    }),
    response: empty,
  },
  'terminal:kill': {
    request: z.strictObject({
      terminalId: z.string(),
    }),
    response: empty,
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
