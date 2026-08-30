import type {
  AccountView,
  AgentBindingView,
  RoleBindingsView,
  AppInfo,
  ChangedFileView,
  ChangeSetView,
  CreateProjectRequest,
  DecisionView,
  IpcResult,
  OpenQuestionView,
  ProjectDetail,
  ProjectView,
  PromptPacketView,
  RepositoryProbe,
  WorkflowDetailView,
  WorkflowEventPayload,
  WorkflowLogPayload,
  WorkflowSummaryView,
  WorkflowTemplateView,
} from '@shared/ipc'

/**
 * The renderer-visible surface.
 *
 * Every capability is an explicit, named method. There is no
 * `invoke(channel, ...)` passthrough, so the renderer cannot reach a channel
 * that this interface does not name — even one that exists in the contract.
 *
 * Methods resolve an `IpcResult` envelope rather than throwing, because the
 * context bridge serializes errors structurally: the prototype and any own
 * properties are stripped, so a thrown error arrives as a bare `Error` and its
 * `code` is lost. Envelopes are plain data and cross intact. `@renderer/ipc`
 * unwraps them into real errors on the renderer side, where the stack is useful.
 */
export interface ForgeApi {
  readonly app: {
    /** Resolves app identity and runtime versions from the main process. */
    getInfo: () => Promise<IpcResult<AppInfo>>
  }
  readonly dialog: {
    /**
     * Opens the native directory picker. Resolves a null path when cancelled.
     *
     * Main owns the dialog because the renderer is sandboxed; this is also the only
     * way the renderer learns a filesystem path it did not receive from a project.
     */
    pickDirectory: () => Promise<IpcResult<{ readonly path: string | null }>>
  }
  readonly clipboard: {
    /**
     * Writes text to the system clipboard through main.
     *
     * `navigator.clipboard` is unavailable to a packaged renderer, which loads from
     * `file://` and is therefore not a secure context (#104).
     */
    writeText: (text: string) => Promise<IpcResult<Record<string, never>>>
  }
  readonly runtime: {
    /** Registered runtimes and whether each produces scripted output. */
    list: () => Promise<
      IpcResult<{
        readonly runtimes: readonly {
          readonly id: string
          readonly simulated: boolean
          readonly supportsAccountIsolation: boolean
          readonly capabilities: readonly string[]
        }[]
      }>
    >
  }
  readonly binding: {
    /** Assignable roles, their current bindings, and the runtimes eligible for each. */
    list: (projectId: string) => Promise<IpcResult<RoleBindingsView>>
    set: (
      projectId: string,
      role: string,
      runtimeId: string,
    ) => Promise<IpcResult<AgentBindingView>>
  }
  readonly project: {
    /** Reports what a candidate folder is, with named reasons when it is unusable. */
    probeRepository: (path: string) => Promise<IpcResult<RepositoryProbe>>
    create: (request: CreateProjectRequest) => Promise<IpcResult<ProjectView>>
    list: () => Promise<IpcResult<{ readonly projects: readonly ProjectView[] }>>
    /** Resolves null when the id does not exist, rather than failing. */
    get: (projectId: string) => Promise<IpcResult<ProjectDetail | null>>
    /**
     * Changes name and repository settings. The repository path is not editable.
     *
     * An omitted field is left unchanged; an explicit null clears a command.
     */
    update: (request: {
      readonly projectId: string
      readonly name?: string
      readonly defaultBranch?: string
      readonly buildCommand?: string | null
      readonly testCommand?: string | null
      readonly tech?: readonly string[]
    }) => Promise<IpcResult<ProjectDetail | null>>
    /** Permanently removes a project from Forge sessions and local SQLite database. */
    delete: (projectId: string) => Promise<IpcResult<{ readonly success: boolean }>>
  }
  readonly rule: {
    /**
     * Sets one rule at one scope, returning the project's new state.
     *
     * The (scope, key) pair is the identity, so setting a key that a wider scope
     * already defines is how an override is expressed — the whole detail comes back
     * so the caller re-reads the resolved policy instead of patching its own copy.
     */
    set: (
      projectId: string,
      scope: string,
      key: string,
      statement: string,
    ) => Promise<IpcResult<ProjectDetail | null>>
    remove: (projectId: string, ruleId: string) => Promise<IpcResult<ProjectDetail | null>>
  }
  readonly workflow: {
    list: (
      projectId: string,
    ) => Promise<IpcResult<{ readonly workflows: readonly WorkflowSummaryView[] }>>
    get: (workflowId: string) => Promise<IpcResult<WorkflowDetailView | null>>
    getActive: (projectId: string) => Promise<IpcResult<WorkflowDetailView | null>>
    start: (request: {
      readonly projectId: string
      readonly taskId?: string
      readonly templateId?: string
      readonly objective?: string
    }) => Promise<IpcResult<WorkflowDetailView>>
    cancel: (workflowId: string, reason?: string) => Promise<IpcResult<WorkflowDetailView | null>>
    resume: (workflowId: string) => Promise<IpcResult<WorkflowDetailView | null>>
    approveAndStartImplementation: (workflowId: string) => Promise<IpcResult<WorkflowDetailView>>
    getPacket: (packetRef: string) => Promise<IpcResult<PromptPacketView | null>>
    exportReport: (workflowId: string) => Promise<
      IpcResult<{
        readonly reportMarkdown: string
        readonly exportedAt: string
      }>
    >
    /** `savedPath` is null when the user cancels the save dialog. */
    saveReport: (workflowId: string) => Promise<IpcResult<{ readonly savedPath: string | null }>>
  }
  readonly question: {
    list: (
      projectId: string,
      unansweredOnly?: boolean,
    ) => Promise<IpcResult<{ readonly questions: readonly OpenQuestionView[] }>>
    get: (questionId: string) => Promise<IpcResult<OpenQuestionView | null>>
    answer: (
      questionId: string,
      answer: string,
      promoteToDecision?: boolean,
    ) => Promise<IpcResult<OpenQuestionView>>
  }
  readonly decision: {
    list: (
      projectId: string,
      status?: string,
    ) => Promise<IpcResult<{ readonly decisions: readonly DecisionView[] }>>
    get: (decisionId: string) => Promise<IpcResult<DecisionView | null>>
    propose: (request: {
      readonly projectId: string
      readonly statement: string
      readonly rationale: string
    }) => Promise<IpcResult<DecisionView>>
    approve: (decisionId: string) => Promise<IpcResult<DecisionView>>
    lock: (decisionId: string) => Promise<IpcResult<DecisionView>>
    supersede: (request: {
      readonly decisionId: string
      readonly replacementStatement: string
      readonly replacementRationale: string
    }) => Promise<
      IpcResult<{
        readonly superseded: DecisionView
        readonly replacement: DecisionView
      }>
    >
  }
  readonly changeset: {
    list: (
      projectId: string,
    ) => Promise<IpcResult<{ readonly changeSets: readonly ChangeSetView[] }>>
    get: (changeSetId: string) => Promise<IpcResult<ChangeSetView | null>>
  }
  readonly account: {
    list: (provider?: string) => Promise<IpcResult<{ readonly accounts: readonly AccountView[] }>>
    register: (request: {
      readonly provider: string
      readonly label: string
    }) => Promise<IpcResult<AccountView>>
    updateStatus: (request: {
      readonly accountId: string
      readonly status: 'connected' | 'expired' | 'rate_limited' | 'disconnected'
    }) => Promise<IpcResult<AccountView>>
    remove: (accountId: string) => Promise<IpcResult<{ readonly success: boolean }>>
    /** What Forge can establish about an account: isolatable, enrolled, signed in. */
    enrollmentStatus: (
      accountId: string,
      runtimeId: string,
    ) => Promise<
      IpcResult<{
        readonly accountId: string
        readonly isolatable: boolean
        readonly home: string | null
        readonly loggedIn: boolean
        readonly authMethod: string
        readonly email: string | null
      }>
    >
    /** Opens the user own terminal to sign in, isolated to this account. */
    beginEnrollment: (
      accountId: string,
      runtimeId: string,
    ) => Promise<IpcResult<{ readonly home: string }>>
    revokeEnrollment: (accountId: string) => Promise<IpcResult<Record<string, never>>>
  }
  readonly git: {
    getWorkingDiff: (projectId: string) => Promise<
      IpcResult<{
        readonly files: readonly ChangedFileView[]
        readonly patch: string
      }>
    >
    /** Every file git tracks or would track, for the Explorer view. */
    listFiles: (projectId: string) => Promise<IpcResult<{ readonly files: readonly string[] }>>
    readFile: (projectId: string, path: string) => Promise<IpcResult<{ readonly content: string }>>
    writeFile: (
      projectId: string,
      path: string,
      content: string,
    ) => Promise<IpcResult<{ readonly success: boolean }>>
  }
  readonly template: {
    list: () => Promise<IpcResult<{ readonly templates: readonly WorkflowTemplateView[] }>>
    get: (templateId: string) => Promise<IpcResult<WorkflowTemplateView | null>>
  }
  readonly terminal: {
    spawn: (request: {
      readonly projectId: string
      readonly runtimeId?: string | null | undefined
      readonly command?: string | undefined
      readonly args?: readonly string[] | undefined
      readonly cwd?: string | undefined
      readonly env?: Readonly<Record<string, string>> | undefined
      readonly cols?: number | undefined
      readonly rows?: number | undefined
    }) => Promise<IpcResult<{ readonly terminalId: string; readonly pid?: number | undefined }>>
    write: (terminalId: string, data: string) => Promise<IpcResult<Record<string, never>>>
    resize: (
      terminalId: string,
      cols: number,
      rows: number,
    ) => Promise<IpcResult<Record<string, never>>>
    kill: (terminalId: string) => Promise<IpcResult<Record<string, never>>>
  }
  readonly onWorkflowEvent: (listener: (event: WorkflowEventPayload) => void) => () => void
  readonly onWorkflowLog: (listener: (log: WorkflowLogPayload) => void) => () => void
  readonly onTerminalData: (
    listener: (payload: { readonly terminalId: string; readonly chunk: string }) => void,
  ) => () => void
  readonly onTerminalExit: (
    listener: (payload: { readonly terminalId: string; readonly exitCode: number | null }) => void,
  ) => () => void
}

