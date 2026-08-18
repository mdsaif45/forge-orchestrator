import type { ForgeApi } from '../../preload/api'

declare global {
  interface Window {
    /** Injected by the preload bridge. The renderer's only route to main. */
    readonly forge: ForgeApi
  }
}
