import type {
  AppInfo,
  CreateProjectRequest,
  IpcResult,
  ProjectDetail,
  ProjectView,
  PromptPacketView,
  RepositoryProbe,
  WorkflowDetailView,
  WorkflowEventPayload,
  WorkflowLogPayload,
  WorkflowSummaryView,
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
  readonly project: {
    /** Reports what a candidate folder is, with named reasons when it is unusable. */
    probeRepository: (path: string) => Promise<IpcResult<RepositoryProbe>>
    create: (request: CreateProjectRequest) => Promise<IpcResult<ProjectView>>
    list: () => Promise<IpcResult<{ readonly projects: readonly ProjectView[] }>>
    /** Resolves null when the id does not exist, rather than failing. */
    get: (projectId: string) => Promise<IpcResult<ProjectDetail | null>>
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
    getPacket: (packetRef: string) => Promise<IpcResult<PromptPacketView | null>>
  }
  readonly onWorkflowEvent: (listener: (event: WorkflowEventPayload) => void) => () => void
  readonly onWorkflowLog: (listener: (log: WorkflowLogPayload) => void) => () => void
}
