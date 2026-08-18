import { app, dialog, BrowserWindow } from 'electron'
import { APP_NAME } from '@shared/app'
import type { ProjectService } from '../projects/projectService'
import { validateRepository } from '../projects/validateRepository'
import type { IpcHandlerMap } from './router'

/**
 * The concrete handler for every declared channel.
 *
 * A factory rather than a constant because domain handlers need the database, which
 * is opened during startup. The dependencies are passed in rather than imported so
 * the map can be built against a temporary database in a test without an Electron
 * process — the same reason `router.ts` takes its handlers as a parameter.
 *
 * The type is exhaustive over the contract, so declaring a channel without
 * implementing it here is a compile error.
 */
export interface IpcDependencies {
  readonly projects: ProjectService
}

export function createIpcHandlers({ projects }: IpcDependencies): IpcHandlerMap {
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
  }
}
