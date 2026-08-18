import type { AppInfo, IpcResult } from '@shared/ipc'

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
}
