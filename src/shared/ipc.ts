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
 * The channel table.
 *
 * `request` is validated in main before the handler runs; `response` is
 * validated in main before the value crosses back, so a handler bug surfaces
 * here rather than as a confusing failure in the renderer.
 */
export const IPC_CONTRACT = {
  'app:getInfo': { request: empty, response: appInfoSchema },
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
