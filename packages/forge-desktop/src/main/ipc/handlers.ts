import { writeFile } from 'node:fs/promises'
import { app, clipboard, dialog, BrowserWindow } from 'electron'
import { APP_NAME } from '@shared/app'
import type { IpcResponse, ModelDetail, ProviderChunkPayload } from '@shared/ipc'
import {
  artifactIdSchema,
  runIdSchema,
  TEMPLATES,
  type AccountId,
  type AgentInstanceId,
  type Capability,
  type ProjectId,
} from '@shared/domain'
import type { AgentInstanceStore } from '@forge/core/db/agentInstanceStore'
import type { CustomRuntimeStore } from '@forge/core/db/customRuntimeStore'
import { generateWorkflowReportMarkdown } from '@forge/core/audit/workflowReportGenerator'
import type { ProjectService } from '@forge/core/projects/projectService'
import { validateRepository } from '@forge/core/projects/validateRepository'
import type { IpcHandlerMap } from './router'
import type { WorkflowService } from '@forge/core/workflows/workflowService'
import type { QuestionService } from '@forge/core/questions/questionService'
import type { DecisionService } from '@forge/core/decisions/decisionService'
import type { ChangeSetService } from '@forge/core/changesets/changeSetService'
import type { AccountService } from '@forge/core/accounts/accountService'
import { runtimeDescription, runtimeExecutable, type RuntimeRegistry } from '@forge/runtimes'
import { streamChat } from '@forge/core/providers/chatStream'
import { runAgentTurn } from '@forge/core/providers/agentTurn'
import { devModelTracker } from '@forge/core/providers/devModelTracker'
import { discoverOllamaModels } from '@forge/core/providers/ollamaDiscovery'
import type { BindingService } from '@forge/core/bindings/bindingService'
import type { EnrollmentService } from '@forge/core/accounts/enrollmentService'
import { openTerminal } from '@forge/core/accounts/terminalLauncher'

import type { TerminalService } from '@forge/core/terminal/terminalService'
import { TemplateV2Store } from '@forge/core/templates/templateV2Store'
import type { ArtifactService } from '@forge/core/artifacts/artifactService'
import {
  detectInstalledClis,
  loadAgentDefaults,
  saveAgentDefaults,
  saveCustomCli,
  removeCustomCli,
  probeRuntimeExecutable,
} from '@forge/runtimes'

export interface IpcDependencies {
  readonly projects: ProjectService
  readonly workflows: WorkflowService
  readonly questions: QuestionService
  readonly decisions: DecisionService
  readonly changeSets: ChangeSetService
  readonly accounts: AccountService
  readonly agentInstances?: AgentInstanceStore
  readonly customRuntimes?: CustomRuntimeStore
  readonly registry: RuntimeRegistry
  readonly bindings: BindingService
  readonly enrollment: EnrollmentService
  readonly terminal: TerminalService
  readonly templatesV2?: TemplateV2Store
  readonly artifactService?: ArtifactService
  /**
   * Broadcasts one chunk of a streamed model reply.
   *
   * Injected rather than reached for, because a handler has no window to send
   * to — `index.ts` owns which windows exist and fans out to them, exactly as it
   * does for terminal and workflow events.
   */
  readonly emitProviderChunk?: (payload: ProviderChunkPayload) => void
  /**
   * Records which model the native agent runtime should use.
   *
   * Injected because the store is a file main owns, and a handler should not
   * decide where it lives. Optional so a test can build the map without one.
   */
  readonly setActiveModel?: (model: {
    readonly providerId: string
    readonly model: string
    readonly endpointUrl?: string | undefined
    readonly apiKey?: string | undefined
  }) => void
  readonly registerCustomCli?: (cli: {
    readonly id: string
    readonly name: string
    readonly executable: string
    readonly defaultArgs?: readonly string[] | undefined
  }) => void
}

export function createIpcHandlers({
  projects,
  workflows,
  questions,
  decisions,
  changeSets,
  accounts,
  agentInstances,
  customRuntimes,
  registry,
  bindings,
  enrollment,
  terminal,
  templatesV2,
  artifactService,
  emitProviderChunk,
  setActiveModel,
  registerCustomCli,
}: IpcDependencies): IpcHandlerMap {
  const templatesV2Store = templatesV2 ?? new TemplateV2Store()

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

    'runtime:list': async () => {
      const runtimes = await Promise.all(
        registry.list().map(async (runtime) => {
          const named = runtimeExecutable(runtime.id)
          const executable = runtime.simulated || named === runtime.id ? null : named
          const probe = await probeRuntimeExecutable(executable, {
            isSimulated: runtime.simulated,
          })

          return {
            id: runtime.id,
            simulated: runtime.simulated,
            supportsAccountIsolation: runtime.supportsAccountIsolation,
            capabilities: [...runtime.capabilities],
            executable,
            available: probe.available,
            version: probe.version,
            health: probe.health,
            latencyMs: probe.latencyMs,
            label: runtimeDescription(runtime.id),
          }
        }),
      )

      return { runtimes }
    },

    'runtime:detectClis': async () => ({
      clis: await detectInstalledClis(),
    }),

    'runtime:getAgentDefaults': () => loadAgentDefaults(),

    'runtime:setAgentDefaults': (request) => saveAgentDefaults(request),

    'runtime:addCustomCli': (request) => {
      saveCustomCli({
        id: request.id,
        name: request.name,
        executable: request.executable,
        defaultArgs: request.defaultArgs,
      })
      if (customRuntimes) {
        customRuntimes.create(
          {
            slug: request.id,
            name: request.name,
            command: request.executable,
            argsTemplate: request.defaultArgs ? request.defaultArgs.join(' ') : null,
            capabilities: (request.capabilities as readonly Capability[] | undefined) ?? [
              'repo-read',
              'file-write',
              'terminal',
            ],
            permissionMode: request.permissionMode ?? 'developer',
            instructionFilenames: request.instructionFilenames ?? [],
            env: request.env ?? null,
          },
          'user',
          new Date().toISOString(),
        )
      }
      registerCustomCli?.(request)
      return { success: true }
    },

    'runtime:removeCustomCli': ({ id }) => {
      removeCustomCli(id)
      if (customRuntimes) {
        const found = customRuntimes.findBySlug(id) ?? customRuntimes.find(id)
        if (found) {
          customRuntimes.remove(found.id, 'user', new Date().toISOString())
        }
      }
      if (registry.has(id)) {
        registry.unregister(id)
      }
      return { success: true }
    },

    'binding:list': ({ projectId }) => bindings.list(projectId),

    'binding:set': (request) => bindings.set(request),

    'project:probeRepository': ({ path }) => validateRepository(path),

    'project:create': (request) => projects.create(request),

    'project:list': () => ({ projects: projects.list() }),

    'project:get': ({ projectId }) => projects.get(projectId),

    'project:update': (request) => projects.update(request),

    'project:delete': ({ projectId }) => ({ success: projects.delete(projectId) }),

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

    'workflow:interject': ({ workflowId, stepIndex, text }) =>
      workflows.interject(workflowId, stepIndex, text),

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

    'workflow:getLogs': (request) => workflows.getLogs(request),

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
    'decision:recordGate': (request) => decisions.recordGateDecision(request),

    'changeset:list': ({ projectId }) => ({
      changeSets: changeSets.list(projectId),
    }),

    'changeset:get': ({ changeSetId }) => changeSets.get(changeSetId),

    'artifacts:listForRun': ({ runId }) => {
      if (!artifactService) {
        throw new Error('ArtifactService is not configured')
      }
      return {
        artifacts: artifactService.listArtifacts(runIdSchema.parse(runId)),
      }
    },

    'artifacts:getMetadata': ({ artifactId }) => {
      if (!artifactService) {
        throw new Error('ArtifactService is not configured')
      }
      return {
        artifact: artifactService.getMetadata(artifactIdSchema.parse(artifactId)),
      }
    },

    'artifacts:readWindow': async ({ artifactId, offsetBytes, lengthBytes }) => {
      if (!artifactService) {
        throw new Error('ArtifactService is not configured')
      }
      const res = await artifactService.readWindow(
        artifactIdSchema.parse(artifactId),
        offsetBytes,
        lengthBytes,
      )
      return {
        data: res.data.toString('base64'),
        encoding: 'base64' as const,
        totalBytes: res.totalBytes,
      }
    },

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

    'agentInstance:list': ({ projectId }) => {
      const instances = agentInstances ? agentInstances.list(projectId as ProjectId) : []
      return { instances }
    },

    'agentInstance:create': (request) => {
      if (!agentInstances) {
        throw new Error('AgentInstanceStore is not configured')
      }
      return agentInstances.create(
        {
          projectId: request.projectId as ProjectId,
          ...(request.label !== undefined ? { label: request.label } : {}),
          provider: request.provider,
          accountId: request.accountId ? (request.accountId as AccountId) : null,
          role: request.role,
        },
        'user',
        new Date().toISOString(),
      )
    },

    'agentInstance:update': (request) => {
      if (!agentInstances) {
        throw new Error('AgentInstanceStore is not configured')
      }
      return agentInstances.updateLabel(
        request.id as AgentInstanceId,
        request.label,
        'user',
        new Date().toISOString(),
      )
    },

    'agentInstance:remove': ({ id }) => {
      if (!agentInstances) {
        throw new Error('AgentInstanceStore is not configured')
      }
      agentInstances.remove(id as AgentInstanceId, 'user', new Date().toISOString())
      return { success: true }
    },

    'template:list': () => ({
      templates: Object.values(TEMPLATES),
    }),

    'template:get': ({ templateId }) =>
      Object.hasOwn(TEMPLATES, templateId) ? TEMPLATES[templateId as keyof typeof TEMPLATES] : null,

    'template:listV2': ({ status }) => ({
      templates: templatesV2Store.list(status),
    }),

    'template:getV2': ({ templateId }) => templatesV2Store.get(templateId),

    'template:saveV2': ({ template }) => templatesV2Store.save(template),

    'template:deleteV2': ({ templateId }) => ({
      success: templatesV2Store.delete(templateId),
    }),

    'terminal:spawn': async (request) => terminal.spawn(request),

    'terminal:write': ({ terminalId, data }) => {
      terminal.write(terminalId, data)
      return {}
    },

    'terminal:resize': ({ terminalId, cols, rows }) => {
      terminal.resize(terminalId, cols, rows)
      return {}
    },

    'terminal:kill': async ({ terminalId }) => {
      await terminal.kill(terminalId)
      return {}
    },

    'terminal:buffer': ({ terminalId }) => ({
      buffer: terminal.getBuffer(terminalId),
    }),

    'provider:scanModels': async ({ providerId, endpointUrl }) => {
      try {
        const cleanBase = endpointUrl.replace(/\/$/, '')
        let detected: string[] = []
        let details: ModelDetail[] | undefined = undefined

        if (providerId === 'ollama' || cleanBase.includes('11434')) {
          const discovery = await discoverOllamaModels({
            endpointUrl: cleanBase,
            probeCapabilities: false,
          })
          if (!discovery.reachable && discovery.error) {
            return {
              ok: false,
              models: [],
              error: discovery.error,
            }
          }
          detected = discovery.models.map((m) => m.name)
          details = discovery.models.map((m) => ({
            name: m.name,
            model: m.model,
            family: m.family,
            parameterSize: m.parameterSize,
            quantization: m.quantization,
            sizeBytes: m.sizeBytes,
            modifiedAt: m.modifiedAt,
            isCodingModel: m.isCodingModel,
            capabilities: m.capabilities,
          }))
        } else {
          const endpoint = cleanBase.endsWith('/v1')
            ? `${cleanBase}/models`
            : `${cleanBase}/v1/models`
          const res = await fetch(endpoint)
          if (!res.ok) {
            return {
              ok: false,
              models: [],
              error: `Service returned HTTP ${String(res.status)}: ${res.statusText}`,
            }
          }
          const data = (await res.json()) as { data?: { id?: string }[] }
          if (Array.isArray(data.data)) {
            detected = data.data.map((m) => m.id ?? '').filter((id) => id.length > 0)
          }
        }

        if (detected.length === 0) {
          return {
            ok: false,
            models: [],
            error: `Connected to ${endpointUrl}, but 0 models were found on this instance.`,
          }
        }

        return {
          ok: true,
          models: detected,
          ...(details ? { details } : {}),
          error: null,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          ok: false,
          models: [],
          error: `Could not connect to ${endpointUrl}. Service is offline or unreachable (${msg}).`,
        }
      }
    },

    /**
     * A turn in which the model uses tools against the project itself.
     *
     * The workspace is resolved here from the bound repository rather than
     * taken from the request: the renderer names a project, never a directory,
     * so it cannot point an agent at somewhere else on disk (A7).
     */
    /**
     * Records the renderer's model choice so a workflow in main can use it.
     *
     * Ask mode sends the model with each turn and never needs this; a workflow
     * runs in main, where the renderer's stored provider list is unreachable.
     */
    'provider:setActiveModel': ({ providerId, model, endpointUrl, apiKey }) => {
      setActiveModel?.({ providerId, model, endpointUrl, apiKey })
      return { ok: true as const }
    },

    'provider:agentTurn': async ({
      streamId,
      projectId,
      providerId,
      model,
      endpointUrl,
      apiKey,
      systemPrompt,
      messages,
    }) => {
      const detail = await projects.get(projectId)
      if (detail === null) {
        return {
          ok: false,
          content: '',
          reasoning: '',
          toolsUsed: [],
          rounds: 0,
          stoppedAtLimit: false,
          error: `Unknown project "${projectId}".`,
          capabilities: { tools: false, vision: false, thinking: false, source: 'unreachable' },
        }
      }

      const result = await runAgentTurn(
        {
          providerId,
          model,
          endpointUrl,
          apiKey,
          systemPrompt,
          repositoryPath: detail.project.repository.absolutePath,
          messages,
          projectId: detail.project.id,
          setRule: async (scope, key, statement) => {
            await projects.setRule(detail.project.id, scope, key, statement)
          },
          getRules: async () => {
            const fresh = await projects.get(detail.project.id)
            return (
              fresh?.rules.map((r) => ({
                scope: r.scope,
                key: r.key,
                statement: r.statement,
              })) ?? []
            )
          },
        },
        (event) => {
          emitProviderChunk?.({ streamId, kind: event.kind, text: event.text })
        },
      )

      return {
        ok: result.ok,
        content: result.content,
        reasoning: result.reasoning,
        toolsUsed: result.toolsUsed.map((tool) => ({ name: tool.name, ok: tool.ok })),
        rounds: result.rounds,
        stoppedAtLimit: result.stoppedAtLimit,
        error: result.error,
        capabilities: result.plan.capabilities,
      }
    },

    /**
     * The streaming counterpart, which pushes text as it arrives.
     *
     * The awaited result still carries the assembled reply, so a caller that
     * missed a chunk (a window opened mid-stream, say) is not left with a
     * partial message — the pushed chunks are for liveness, the return value is
     * the record.
     */
    'provider:chatStream': async ({
      streamId,
      providerId,
      model,
      endpointUrl,
      apiKey,
      systemPrompt,
      messages,
    }) => {
      const result = await streamChat(
        {
          providerId,
          model,
          endpointUrl,
          apiKey,
          systemPrompt,
          messages,
        },
        (chunk) => {
          emitProviderChunk?.({ streamId, kind: chunk.kind, text: chunk.text })
        },
      )

      return {
        ok: result.ok,
        content: result.content,
        reasoning: result.reasoning,
        error: result.error,
      }
    },

    'provider:chat': async ({ providerId, model, endpointUrl, apiKey, systemPrompt, messages }) => {
      try {
        const fullMessages = [
          ...(systemPrompt ? [{ role: 'system' as const, content: systemPrompt }] : []),
          ...messages,
        ]

        if (providerId === 'ollama' || endpointUrl?.includes('11434')) {
          const cleanBase = (endpointUrl ?? 'http://localhost:11434').replace(/\/$/, '')
          const res = await fetch(`${cleanBase}/api/chat`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              model,
              messages: fullMessages,
              stream: false,
            }),
          })

          if (!res.ok) {
            const errText = await res.text().catch(() => res.statusText)
            return {
              ok: false,
              content: '',
              error: `Ollama error (${String(res.status)}): ${errText}`,
            }
          }

          const data = (await res.json()) as { message?: { content: string } }
          return {
            ok: true,
            content: data.message?.content ?? '',
            error: null,
          }
        }

        // OpenAI / LM Studio / DeepSeek / Mistral / OpenRouter / Custom compatible endpoint
        let targetEndpoint = endpointUrl ?? ''
        if (!targetEndpoint) {
          if (providerId === 'openai') targetEndpoint = 'https://api.openai.com/v1'
          else if (providerId === 'deepseek') targetEndpoint = 'https://api.deepseek.com/v1'
          else if (providerId === 'openrouter') targetEndpoint = 'https://openrouter.ai/api/v1'
          else if (providerId === 'mistral') targetEndpoint = 'https://api.mistral.ai/v1'
          else if (providerId === 'lmstudio') targetEndpoint = 'http://localhost:1234/v1'
        }

        const cleanBase = targetEndpoint.replace(/\/$/, '')
        const url = cleanBase.endsWith('/chat/completions')
          ? cleanBase
          : cleanBase.endsWith('/v1')
            ? `${cleanBase}/chat/completions`
            : `${cleanBase}/v1/chat/completions`

        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
        }
        if (apiKey) {
          headers.Authorization = `Bearer ${apiKey}`
        }

        const res = await fetch(url, {
          method: 'POST',
          headers,
          body: JSON.stringify({
            model,
            messages: fullMessages,
            stream: false,
          }),
        })

        if (!res.ok) {
          const errText = await res.text().catch(() => res.statusText)
          return {
            ok: false,
            content: '',
            error: `API error (${String(res.status)}): ${errText}`,
          }
        }

        const data = (await res.json()) as {
          choices?: { message?: { content: string } }[]
        }
        const text = data.choices?.[0]?.message?.content ?? ''
        return {
          ok: true,
          content: text,
          error: null,
        }
      } catch (err) {
        return {
          ok: false,
          content: '',
          error: err instanceof Error ? err.message : String(err),
        }
      }
    },

    'dev:getModelCalls': () => {
      const calls = devModelTracker.getHistory()
      return { calls: calls as unknown as IpcResponse<'dev:getModelCalls'>['calls'] }
    },

    'dev:clearModelCalls': () => {
      devModelTracker.clear()
      return { ok: true as const }
    },
  }
}
