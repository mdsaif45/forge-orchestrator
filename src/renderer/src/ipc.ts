import type { IpcErrorCode, IpcResult } from '@shared/ipc'

/** An IPC failure, as seen by renderer code. */
export class ForgeIpcError extends Error {
  constructor(
    readonly code: IpcErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'ForgeIpcError'
  }
}

/**
 * Unwraps a result envelope from the preload bridge.
 *
 * The error is constructed here rather than in preload because the context
 * bridge strips error prototypes and own properties on the way across, which
 * would lose `code`. Building it on this side keeps the class intact and gives a
 * stack that points at the calling component.
 */
export function unwrap<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value
  throw new ForgeIpcError(result.code, result.message)
}
