import { z } from 'zod'
import {
  IPC_CONTRACT,
  isIpcChannel,
  type IpcChannel,
  type IpcErrorCode,
  type IpcFailure,
  type IpcRequest,
  type IpcResponse,
  type IpcResult,
} from '@shared/ipc'

/**
 * The routing core.
 *
 * Deliberately free of any `electron` import so it can be exercised in plain
 * Node — the boundary rules are the part most worth testing, and they should not
 * require a window to verify. `register.ts` binds this to `ipcMain`.
 */

/** A handler receives an already-validated request and returns a typed response. */
export type IpcHandler<C extends IpcChannel> = (
  request: IpcRequest<C>,
) => IpcResponse<C> | Promise<IpcResponse<C>>

/** Every channel in the contract must have exactly one handler. */
export type IpcHandlerMap = {
  readonly [C in IpcChannel]: IpcHandler<C>
}

function failure(code: IpcErrorCode, message: string): IpcFailure {
  return { ok: false, code, message }
}

/**
 * Routes one call, enforcing three guarantees rather than trusting them:
 *
 *   1. the channel is in the contract — an undeclared name is refused before any
 *      handler lookup happens
 *   2. the request is parsed before the handler runs, so a handler never sees
 *      unvalidated input
 *   3. the response is parsed before it crosses back, so a handler returning the
 *      wrong shape fails loudly here instead of corrupting the renderer
 */
export async function invokeChannel(
  handlers: IpcHandlerMap,
  channel: string,
  rawRequest: unknown,
): Promise<IpcResult<unknown>> {
  if (!isIpcChannel(channel)) {
    return failure('UNKNOWN_CHANNEL', `Channel "${channel}" is not in the IPC contract`)
  }

  const spec = IPC_CONTRACT[channel]

  const parsedRequest = spec.request.safeParse(rawRequest ?? {})
  if (!parsedRequest.success) {
    return failure('INVALID_REQUEST', `${channel}: ${z.prettifyError(parsedRequest.error)}`)
  }

  let raw: unknown
  try {
    // The contract keys the handler map, so this lookup is total; the casts are
    // needed only because TypeScript cannot narrow the generic through an
    // indexed access on a mapped type.
    const handler = handlers[channel]
    raw = await handler(parsedRequest.data)
  } catch (error) {
    return failure('HANDLER_FAILED', `${channel}: ${describe(error)}`)
  }

  const parsedResponse = spec.response.safeParse(raw)
  if (!parsedResponse.success) {
    return failure('INVALID_RESPONSE', `${channel}: ${z.prettifyError(parsedResponse.error)}`)
  }

  return { ok: true, value: parsedResponse.data }
}

function describe(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : 'Unknown error'
}
