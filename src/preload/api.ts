/**
 * The renderer-visible surface, as a type.
 *
 * It grows only through explicit, named methods — never a generic
 * `invoke(channel, ...)` passthrough. See #9 for the channel allowlist and
 * payload validation that back these methods.
 */
export interface ForgeApi {
  readonly versions: {
    readonly electron: string
    readonly chrome: string
    readonly node: string
  }
}
