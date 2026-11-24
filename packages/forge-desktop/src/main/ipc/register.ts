import { ipcMain } from 'electron'
import { IPC_CHANNELS } from '@shared/ipc'
import { invokeChannel, type IpcHandlerMap } from './router'

/**
 * Binds the router to `ipcMain`, one handler per declared channel.
 *
 * Only contract channels get a listener, so an undeclared channel has nothing
 * to invoke and Electron rejects it at its own layer — the router's
 * `UNKNOWN_CHANNEL` result is the second line of defence, not the only one.
 */
export function registerIpcHandlers(handlers: IpcHandlerMap): void {
  for (const channel of IPC_CHANNELS) {
    ipcMain.handle(channel, (_event, rawRequest: unknown) =>
      invokeChannel(handlers, channel, rawRequest),
    )
  }
}
