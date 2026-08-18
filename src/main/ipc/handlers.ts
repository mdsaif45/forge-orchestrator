import { app } from 'electron'
import { APP_NAME } from '@shared/app'
import type { IpcHandlerMap } from './router'

/**
 * The concrete handler for every declared channel.
 *
 * The type is exhaustive over the contract, so declaring a channel without
 * implementing it here is a compile error.
 */
export const ipcHandlers: IpcHandlerMap = {
  'app:getInfo': () => ({
    name: APP_NAME,
    version: app.getVersion(),
    platform: process.platform,
    versions: {
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      node: process.versions.node,
    },
  }),
}
