import { contextBridge } from 'electron'
import type { ForgeApi } from './api'

/**
 * The only bridge between renderer and main.
 *
 * Deliberately exposes no `invoke(channel, ...)` passthrough: every capability
 * must be an explicit, named method. The typed channel allowlist and zod
 * payload validation land in #9.
 */
const api: ForgeApi = {
  versions: {
    electron: process.versions.electron ?? 'unknown',
    chrome: process.versions.chrome ?? 'unknown',
    node: process.versions.node ?? 'unknown',
  },
}

contextBridge.exposeInMainWorld('forge', api)
