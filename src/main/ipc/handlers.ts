import { app, dialog, BrowserWindow } from 'electron'
import { APP_NAME } from '@shared/app'
import type { ProjectService } from '../projects/projectService'
import { validateRepository } from '../projects/validateRepository'
import type { IpcHandlerMap } from './router'
import type { WorkflowService } from '../workflows/workflowService'
import type { QuestionService } from '../questions/questionService'

export interface IpcDependencies {
  readonly projects: ProjectService
  readonly workflows: WorkflowService
  readonly questions: QuestionService
}

export function createIpcHandlers({
  projects,
  workflows,
  questions,
}: IpcDependencies): IpcHandlerMap {
  return {
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

    /**
     * The native directory picker.
     *
     * Owned by main because the renderer is sandboxed and has no filesystem access;
     * this is also why the renderer never receives a path it did not get from here
     * or type deliberately.
     */
    'dialog:pickDirectory': async () => {
      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().at(0)

      const result = await (parent === undefined
        ? dialog.showOpenDialog({ properties: ['openDirectory'] })
        : dialog.showOpenDialog(parent, { properties: ['openDirectory'] }))

      return { path: result.canceled ? null : (result.filePaths.at(0) ?? null) }
    },

    'project:probeRepository': ({ path }) => validateRepository(path),

    'project:create': (request) => projects.create(request),

    'project:list': () => ({ projects: projects.list() }),

    'project:get': ({ projectId }) => projects.get(projectId),

    'rule:set': ({ projectId, scope, key, statement }) =>
      projects.setRule(projectId, scope, key, statement),

    'rule:remove': ({ projectId, ruleId }) => projects.removeRule(projectId, ruleId),

    'workflow:list': ({ projectId }) => ({ workflows: workflows.list(projectId) }),

    'workflow:get': ({ workflowId }) => workflows.get(workflowId),

    'workflow:getActive': ({ projectId }) => workflows.getActive(projectId),

    'workflow:start': (request) => workflows.start(request),

    'workflow:cancel': ({ workflowId, reason }) => workflows.cancel(workflowId, reason),

    'workflow:resume': ({ workflowId }) => workflows.resume(workflowId),

    'workflow:getPacket': ({ packetRef }) => workflows.getPacket(packetRef),

    'question:list': ({ projectId, unansweredOnly }) => ({
      questions: questions.list(projectId, unansweredOnly),
    }),

    'question:get': ({ questionId }) => questions.get(questionId),

    'question:answer': ({ questionId, answer, promoteToDecision }) =>
      workflows.answerQuestion(questionId, answer, promoteToDecision),
  }
}
