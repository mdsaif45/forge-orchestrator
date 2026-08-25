import { writeFile } from 'node:fs/promises'
import { app, clipboard, dialog, BrowserWindow } from 'electron'
import { APP_NAME } from '@shared/app'
import { TEMPLATES } from '@shared/domain'
import { generateWorkflowReportMarkdown } from '../audit/workflowReportGenerator'
import type { ProjectService } from '../projects/projectService'
import { validateRepository } from '../projects/validateRepository'
import type { IpcHandlerMap } from './router'
import type { WorkflowService } from '../workflows/workflowService'
import type { QuestionService } from '../questions/questionService'
import type { DecisionService } from '../decisions/decisionService'
import type { ChangeSetService } from '../changesets/changeSetService'
import type { AccountService } from '../accounts/accountService'
import type { RuntimeRegistry } from '../runtimes/registry'
import type { BindingService } from '../bindings/bindingService'
import type { EnrollmentService } from '../accounts/enrollmentService'
import { openTerminal } from '../accounts/terminalLauncher'

export interface IpcDependencies {
  readonly projects: ProjectService
  readonly workflows: WorkflowService
  readonly questions: QuestionService
  readonly decisions: DecisionService
  readonly changeSets: ChangeSetService
  readonly accounts: AccountService
  readonly registry: RuntimeRegistry
  readonly bindings: BindingService
  readonly enrollment: EnrollmentService
}

export function createIpcHandlers({
  projects,
  workflows,
  questions,
  decisions,
  changeSets,
  accounts,
  registry,
  bindings,
  enrollment,
}: IpcDependencies): IpcHandlerMap {
  /**
   * Gathers everything a report needs and renders it.
   *
   * Shared by the two export channels so the copy and the saved file cannot drift
   * apart — a report that differs depending on how it was delivered would undermine
   * the point of an audit artifact.
   */
  const buildReport = (
    workflowId: string,
  ): { readonly reportMarkdown: string; readonly suggestedFileName: string } => {
    const wfView = workflows.get(workflowId)
    if (wfView === null) throw new Error(`Workflow ${workflowId} not found`)

    const projectId = workflows.getProjectId(workflowId)
    const project = projects.list().find((candidate) => candidate.id === projectId)
    const projectName = project ? project.name : 'Unknown Project'

    const reportMarkdown = generateWorkflowReportMarkdown({
      workflow: wfView,
      projectName,
      decisions: projectId !== null ? decisions.list(projectId) : [],
      questions: projectId !== null ? questions.list(projectId) : [],
    })

    // Colons are illegal in a Windows filename, so the timestamp cannot go in raw.
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const slug = projectName.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '')

    return {
      reportMarkdown,
      suggestedFileName: `forge-audit-${slug === '' ? 'workflow' : slug}-${stamp}.md`,
    }
  }

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

    /**
     * The clipboard, via main.
     *
     * `navigator.clipboard` needs a secure context, and a packaged renderer loads
     * from `file://` — the log viewer's copy button failed there silently, because
     * the rejected promise was discarded (#104). Electron's clipboard has no origin
     * restriction.
     */
    'clipboard:writeText': ({ text }) => {
      clipboard.writeText(text)
      return {}
    },

    'runtime:list': () => ({
      runtimes: registry.list().map((runtime) => ({
        id: runtime.id,
        simulated: runtime.simulated,
        supportsAccountIsolation: runtime.supportsAccountIsolation,
        capabilities: [...runtime.capabilities],
      })),
    }),

    'binding:list': ({ projectId }) => bindings.list(projectId),

    'binding:set': (request) => bindings.set(request),

    'project:probeRepository': ({ path }) => validateRepository(path),

    'project:create': (request) => projects.create(request),

    'project:list': () => ({ projects: projects.list() }),

    'project:get': ({ projectId }) => projects.get(projectId),

    'project:update': (request) => projects.update(request),

    'rule:set': ({ projectId, scope, key, statement }) =>
      projects.setRule(projectId, scope, key, statement),

    'rule:remove': ({ projectId, ruleId }) => projects.removeRule(projectId, ruleId),

    'workflow:list': ({ projectId }) => ({ workflows: workflows.list(projectId) }),

    'workflow:get': ({ workflowId }) => workflows.get(workflowId),

    'workflow:getActive': ({ projectId }) => workflows.getActive(projectId),

    'workflow:start': (request) => workflows.start(request),

    'workflow:cancel': ({ workflowId, reason }) => workflows.cancel(workflowId, reason),

    'workflow:resume': ({ workflowId }) => workflows.resume(workflowId),

    'workflow:approveAndStartImplementation': ({ workflowId }) =>
      workflows.approveAndStartImplementation(workflowId),

    'workflow:getPacket': ({ packetRef }) => workflows.getPacket(packetRef),

    'workflow:exportReport': ({ workflowId }) => ({
      reportMarkdown: buildReport(workflowId).reportMarkdown,
      exportedAt: new Date().toISOString(),
    }),

    /**
     * Writes the report to a file, because the renderer cannot.
     *
     * A packaged renderer loads from `file://`, which is not a secure context, so
     * `navigator.clipboard.writeText` rejects there — the original delivery path
     * worked in `npm run dev` over http and failed in the shipped app (#104). The
     * sandboxed renderer also has no filesystem access, so both the dialog and the
     * write belong here.
     */
    'workflow:saveReport': async ({ workflowId }) => {
      const { reportMarkdown, suggestedFileName } = buildReport(workflowId)

      const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows().at(0)
      const options = {
        defaultPath: suggestedFileName,
        filters: [
          { name: 'Markdown', extensions: ['md'] },
          { name: 'All files', extensions: ['*'] },
        ],
      }

      const result = await (parent === undefined
        ? dialog.showSaveDialog(options)
        : dialog.showSaveDialog(parent, options))

      if (result.canceled || result.filePath === '') return { savedPath: null }

      await writeFile(result.filePath, reportMarkdown, 'utf8')
      return { savedPath: result.filePath }
    },

    'question:list': ({ projectId, unansweredOnly }) => ({
      questions: questions.list(projectId, unansweredOnly),
    }),

    'question:get': ({ questionId }) => questions.get(questionId),

    'question:answer': ({ questionId, answer, promoteToDecision }) =>
      workflows.answerQuestion(questionId, answer, promoteToDecision),

    'decision:list': ({ projectId, status }) => ({
      decisions: decisions.list(projectId, status),
    }),

    'decision:get': ({ decisionId }) => decisions.get(decisionId),

    'decision:propose': (request) => decisions.propose(request),

    'decision:approve': ({ decisionId }) => decisions.approve(decisionId),

    'decision:lock': ({ decisionId }) => decisions.lock(decisionId),

    'decision:supersede': (request) => decisions.supersede(request),

    'changeset:list': ({ projectId }) => ({
      changeSets: changeSets.list(projectId),
    }),

    'changeset:get': ({ changeSetId }) => changeSets.get(changeSetId),

    'git:getWorkingDiff': (request) => changeSets.getWorkingDiff(request.projectId),

    'git:listFiles': (request) => changeSets.listFiles(request.projectId),

    'git:readFile': (request) => changeSets.readFile(request.projectId, request.path),

    'git:writeFile': (request) =>
      changeSets.writeFile(request.projectId, request.path, request.content),

    'account:enrollmentStatus': async ({ accountId, runtimeId }) => {
      const status = await enrollment.status(runtimeId, accountId)
      return {
        accountId: status.accountId,
        isolatable: status.isolatable,
        home: status.home,
        loggedIn: status.auth.loggedIn,
        authMethod: status.auth.authMethod,
        email: status.auth.email,
      }
    },

    /**
     * Prepares the home, then hands the sign-in to a terminal the user owns.
     *
     * `prepare` throws when the runtime cannot isolate accounts, which surfaces as a
     * failure envelope rather than a window that would sign in as the wrong identity.
     */
    'account:beginEnrollment': async ({ accountId, runtimeId }) => {
      const home = await enrollment.prepare(runtimeId, accountId)
      openTerminal(enrollment.enrollmentCommand(runtimeId, home))
      return { home }
    },

    'account:revokeEnrollment': async ({ accountId }) => {
      await enrollment.revoke(accountId)
      return {}
    },

    'account:list': ({ provider }) => ({
      accounts: accounts.list(provider),
    }),

    'account:register': (request) => accounts.register(request),

    'account:updateStatus': (request) => accounts.updateStatus(request),

    'account:remove': ({ accountId }) => {
      accounts.remove(accountId)
      return { success: true }
    },

    'template:list': () => ({
      templates: Object.values(TEMPLATES),
    }),

    'template:get': ({ templateId }) =>
      Object.hasOwn(TEMPLATES, templateId) ? TEMPLATES[templateId as keyof typeof TEMPLATES] : null,
  }
}
