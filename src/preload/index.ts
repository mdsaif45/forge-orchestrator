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
  dialog: {
    pickDirectory: () => call('dialog:pickDirectory', {}),
  },
  project: {
    probeRepository: (path) => call('project:probeRepository', { path }),
    create: (request) => call('project:create', request),
    list: () => call('project:list', {}),
    get: (projectId) => call('project:get', { projectId }),
  },
  rule: {
    set: (projectId, scope, key, statement) =>
      call('rule:set', { projectId, scope, key, statement }),
    remove: (projectId, ruleId) => call('rule:remove', { projectId, ruleId }),
  },
  workflow: {
    list: (projectId) => call('workflow:list', { projectId }),
    get: (workflowId) => call('workflow:get', { workflowId }),
    getActive: (projectId) => call('workflow:getActive', { projectId }),
    start: (request) => call('workflow:start', request),
    cancel: (workflowId, reason) => call('workflow:cancel', { workflowId, reason }),
    resume: (workflowId) => call('workflow:resume', { workflowId }),
    getPacket: (packetRef) => call('workflow:getPacket', { packetRef }),
  },
  question: {
    list: (projectId, unansweredOnly) => call('question:list', { projectId, unansweredOnly }),
    get: (questionId) => call('question:get', { questionId }),
    answer: (questionId, answer, promoteToDecision) =>
      call('question:answer', { questionId, answer, promoteToDecision }),
  },
  decision: {
    list: (projectId, status) => call('decision:list', { projectId, status }),
    get: (decisionId) => call('decision:get', { decisionId }),
    propose: (request) => call('decision:propose', request),
    approve: (decisionId) => call('decision:approve', { decisionId }),
    lock: (decisionId) => call('decision:lock', { decisionId }),
    supersede: (request) => call('decision:supersede', request),
  },
  changeset: {
    list: (projectId) => call('changeset:list', { projectId }),
    get: (changeSetId) => call('changeset:get', { changeSetId }),
  },
  git: {
    getWorkingDiff: (projectId) => call('git:getWorkingDiff', { projectId }),
    readFile: (projectId, path) => call('git:readFile', { projectId, path }),
    writeFile: (projectId, path, content) => call('git:writeFile', { projectId, path, content }),
  },
  onWorkflowEvent: (listener) => {
    const handler = (_event: unknown, payload: unknown) => {
      listener(payload as Parameters<typeof listener>[0])
    }
    ipcRenderer.on('workflow:event', handler)
    return () => {
      ipcRenderer.removeListener('workflow:event', handler)
    }
  },
  onWorkflowLog: (listener) => {
    const handler = (_event: unknown, payload: unknown) => {
      listener(payload as Parameters<typeof listener>[0])
    }
    ipcRenderer.on('workflow:log', handler)
    return () => {
      ipcRenderer.removeListener('workflow:log', handler)
    }
  },
}

contextBridge.exposeInMainWorld('forge', api)
