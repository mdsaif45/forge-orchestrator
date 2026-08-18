import { contextBridge, ipcRenderer } from 'electron'
import type { IpcChannel, IpcRequest, IpcResponse, IpcResult } from '@shared/ipc'
import type { ForgeApi } from './api'

/**
 * The only bridge between renderer and main.
 *
 * `call` is module-private on purpose: it is the shared plumbing behind the
 * named methods below and is never exposed, so nothing reachable from the
 * renderer accepts a channel name as an argument (axiom A7).
 *
 * It passes the router's result envelope through untouched. Unwrapping happens
 * in the renderer — see the note in `./api`.
 */
function call<C extends IpcChannel>(
  channel: C,
  request: IpcRequest<C>,
): Promise<IpcResult<IpcResponse<C>>> {
  return ipcRenderer.invoke(channel, request) as Promise<IpcResult<IpcResponse<C>>>
}

const api: ForgeApi = {
  app: {
    getInfo: () => call('app:getInfo', {}),
  },
}

contextBridge.exposeInMainWorld('forge', api)
