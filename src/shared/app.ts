/**
 * Types shared across the main / preload / renderer boundary.
 *
 * Nothing in `src/shared` may import from `node:*`, `electron`, or `react` —
 * it is compiled into all three targets. Keep it pure data and pure functions.
 */

export const APP_NAME = 'Forge'

/** Filled in properly by the hardened IPC work in #9. */
export interface AppInfo {
  readonly name: string
  readonly version: string
  readonly platform: string
}
