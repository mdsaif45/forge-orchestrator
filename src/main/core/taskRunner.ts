import { randomUUID } from 'node:crypto'
import { basename, resolve } from 'node:path'
import {
  compileContext,
  evidenceIdSchema,
  FORGE_DEFAULT_RULES,
  parseAgentReport,
  projectIdSchema,
  renderPromptPacket,
  repositoryIdSchema,
  resolveEffectivePolicy,
  runIdSchema,
  runtimeIdSchema,
  sessionIdSchema,
  stepEvidenceSchema,
  stepIdSchema,
  taskIdSchema,
  taskSchema,
  workflowIdSchema,
  type AgentReport,
  type CriterionResult,
  type Discrepancy,
  type IAgentRuntime,
  type PromptPacket,
  type RuleScope,
  type RunId,
  type RuntimeEvent,
  type RuntimeStatus,
  type SessionHandle,
  type SessionOptions,
  type Sha,
  type StepEvidence,
  type Task,
} from '@shared/domain'
import { GitService } from '../git'
import { readRepositoryInstructions } from '../context/repositoryInstructions'
import type { AgentTurnRequest, AgentTurnPlan } from '../providers/agentTurn'
import type { AgentLoopResult } from '../providers/agentLoop'
import { buildChangeSet } from '../evidence/changeSetBuilder'
import { verifyStep } from '../evidence/verifier'
import type { ForgeCore } from './forgeCore'
import { resolveEffectiveModel, type ActiveModel } from '../providers/activeModel'

export type DirectTaskEvent =
  | { readonly kind: 'status'; readonly text: string }
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'content'; readonly text: string }
  | { readonly kind: 'tool_start'; readonly name: string; readonly detail?: string }
  | {
      readonly kind: 'tool_end'
      readonly name: string
      readonly ok: boolean
      readonly detail?: string
    }
  | { readonly kind: 'discrepancy'; readonly detail: string }
  | {
      readonly kind: 'verification'
      readonly verdict: string
      readonly detail: string
      readonly criteria?: readonly CriterionResult[] | undefined
    }

export interface DirectTaskOptions {
  /** The root directory of the repository/workspace. */
  readonly workspacePath: string

  /** The user instruction / task objective. */
  readonly task: string

  /** Optional model override (e.g. "qwen2.5-coder:7b", "claude-3-7-sonnet"). */
  readonly model?: string | undefined

  /** Optional provider override (e.g. "ollama", "openai", "openrouter", "anthropic"). */
  readonly providerId?: string | undefined

  /** Optional endpoint URL. */
  readonly endpointUrl?: string | undefined

  /** Optional API key. */
  readonly apiKey?: string | undefined

  /** Maximum rounds allowed for the agent turn (default: 15). */
  readonly maxRounds?: number | undefined

  /** Optional allowed path globs. */
  readonly allowedPaths?: readonly string[] | undefined

  /** Optional forbidden path globs. */
  readonly forbiddenPaths?: readonly string[] | undefined

  /** Event listener for real-time progress. */
  readonly onEvent?: ((event: DirectTaskEvent) => void) | undefined

  /** Optional agent runtime implementing IAgentRuntime (defaults to core.runtimes.resolve('forge-native-agent')). */
  readonly runtime?: IAgentRuntime | undefined

  /** Injectable turn runner for tests. */
  readonly runTurn?:
    | ((
        request: AgentTurnRequest,
        onEvent: (event: {
          readonly kind: 'reasoning' | 'content' | 'tool'
          readonly text: string
        }) => void,
      ) => Promise<AgentLoopResult & { readonly plan: AgentTurnPlan }>)
    | undefined
}

export interface TaskExecutionResult {
  readonly ok: boolean
  readonly runId: RunId
  readonly task: string
  readonly summary: string
  readonly baseSha: Sha
  readonly filesChanged: readonly string[]
  readonly physicalDiff: {
    readonly files: readonly { path: string; insertions: number; deletions: number }[]
    readonly patch: string
  }
  readonly discrepancies: readonly Discrepancy[]
  readonly outOfScopeFiles: readonly string[]
  readonly verification?:
    | {
        readonly passed: boolean
        readonly verdict: string
        readonly findings: readonly string[]
        readonly criteria?: readonly CriterionResult[] | undefined
      }
    | undefined
  /** Authoritative EVIDENCE-001 domain contract. */
  readonly evidence: StepEvidence
  readonly exitCode: number
  readonly rounds: number
  readonly durationMs: number
}

/**
 * Parses an AgentReport from the model's text response, with fallback to JSON extraction.
 */
function extractReport(text: string, physicalChangedPaths: readonly string[]): AgentReport {
  const parsed = parseAgentReport(text)
  if (parsed.ok) {
    return parsed.report
  }

  // Fallback: look for fenced or bare JSON with "status"
  const jsonMatch =
    /```(?:json)?\s*(\{[\s\S]*?"status"[\s\S]*?\})\s*```/.exec(text) ??
    /(\{[\s\S]*?"status"[\s\S]*?\})/.exec(text)

  if (jsonMatch?.[1] !== undefined) {
    try {
      const raw: unknown = JSON.parse(jsonMatch[1].trim())
      if (typeof raw === 'object' && raw !== null) {
        const obj = raw as Record<string, unknown>
        const rawStatus = typeof obj.status === 'string' ? obj.status.toLowerCase() : ''
        const status: 'completed' | 'blocked' | 'question' =
          rawStatus === 'completed' || rawStatus === 'complete' || rawStatus === 'done'
            ? 'completed'
            : rawStatus === 'question'
              ? 'question'
              : 'blocked'

        return {
          status,
          summary: typeof obj.summary === 'string' ? obj.summary : text.slice(0, 2000),
          filesChanged: Array.isArray(obj.filesChanged)
            ? obj.filesChanged.filter((f): f is string => typeof f === 'string')
            : physicalChangedPaths,
          commandsRun: Array.isArray(obj.commandsRun)
            ? obj.commandsRun.filter((c): c is string => typeof c === 'string')
            : [],
          testsRun: typeof obj.testsRun === 'boolean' ? obj.testsRun : false,
          openQuestions: [],
          assumptions: Array.isArray(obj.assumptions)
            ? obj.assumptions.filter((a): a is string => typeof a === 'string')
            : [],
        }
      }
    } catch {
      // Ignore JSON parse failure
    }
  }

  // Synthesize report honest to observed physical changes
  return {
    status: 'completed',
    summary: text.trim().slice(0, 2000),
    filesChanged: [...physicalChangedPaths],
    commandsRun: [],
    testsRun: false,
    openQuestions: [],
    assumptions: [],
  }
}

/**
 * Adapter enabling tests or callers passing a direct `runTurn` function to run
 * through the first-class `IAgentRuntime` session lifecycle.
 */
function createTurnAdapter(
  runTurn: NonNullable<DirectTaskOptions['runTurn']>,
  model: ActiveModel,
  workspacePath: string,
): IAgentRuntime {
  const pendingEvents: RuntimeEvent[] = []
  let completed = false
  const runtimeId = runtimeIdSchema.parse('test-turn-adapter')

  return {
    id: runtimeId,
    capabilities: ['repo-read', 'file-write', 'test', 'plan', 'review', 'terminal'],
    simulated: false,
    supportsAccountIsolation: false,
    instructionFilenames: [],
    // eslint-disable-next-line @typescript-eslint/require-await
    async start(_options: SessionOptions): Promise<SessionHandle> {
      completed = false
      return {
        sessionId: sessionIdSchema.parse(`session-${randomUUID()}`),
        runtimeId,
      }
    },
    async send(_session: SessionHandle, packet: PromptPacket): Promise<void> {
      const turnResult = await runTurn(
        {
          providerId: model.providerId,
          model: model.model,
          endpointUrl: model.endpointUrl,
          apiKey: model.apiKey,
          systemPrompt: renderPromptPacket(packet),
          repositoryPath: workspacePath,
          allowedPaths: packet.allowedPaths.length > 0 ? packet.allowedPaths : undefined,
          forbiddenPaths: packet.forbiddenPaths.length > 0 ? packet.forbiddenPaths : undefined,
          maxRounds: 15,
          messages: [{ role: 'user', content: packet.objective }],
        },
        (event) => {
          if (event.kind === 'tool') {
            pendingEvents.push({
              type: 'tool',
              at: new Date().toISOString(),
              name: event.text,
              detail: '',
            })
          } else {
            pendingEvents.push({ type: 'chunk', at: new Date().toISOString(), text: event.text })
          }
        },
      )
      pendingEvents.push({ type: 'chunk', at: new Date().toISOString(), text: turnResult.content })
      pendingEvents.push({ type: 'state', at: new Date().toISOString(), state: 'completed' })
      completed = true
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async *events(_session: SessionHandle): AsyncIterable<RuntimeEvent> {
      while (pendingEvents.length > 0) {
        const ev = pendingEvents.shift()
        if (ev !== undefined) yield ev
      }
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async status(session: SessionHandle): Promise<RuntimeStatus> {
      return {
        sessionId: session.sessionId,
        state: completed ? 'completed' : 'working',
        lastActivityAt: new Date().toISOString(),
        failure: null,
      }
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async cancel(): Promise<void> {
      completed = true
    },
    // eslint-disable-next-line @typescript-eslint/require-await
    async dispose(): Promise<void> {
      pendingEvents.length = 0
    },
  }
}

/**
 * Executes an autonomous coding task directly using the Native Forge Agent,
 * measuring the physical git diff and generating authoritative evidence.
 */
export async function executeDirectTask(
  core: ForgeCore,
  options: DirectTaskOptions,
): Promise<TaskExecutionResult> {
  const startTime = Date.now()
  const workspacePath = resolve(options.workspacePath)
  const git = new GitService({ repositoryPath: workspacePath })

  options.onEvent?.({ kind: 'status', text: `Verifying repository at ${workspacePath}...` })
  await git.status()

  // Capture baseline git commit SHA before any agent modifications
  let baseSha: Sha
  try {
    const snap = await git.snapshot({ allowDirty: true })
    baseSha = snap.sha
  } catch {
    const head = await git.headSha()
    if (head === null) {
      throw new Error('Cannot run task on a repository with no commits')
    }
    baseSha = head
  }

  // Ensure project exists in Forge control plane
  const existingProjects = core.projects.list()
  let projectView = existingProjects.find(
    (p) => resolve(p.repository.absolutePath).toLowerCase() === workspacePath.toLowerCase(),
  )

  if (projectView === undefined) {
    options.onEvent?.({ kind: 'status', text: 'Registering project in Forge control plane...' })
    const defaultBranchObj = await git.defaultBranch()
    const defaultBranch = defaultBranchObj?.name ?? (await git.currentBranch()) ?? 'main'
    projectView = await core.projects.create({
      name: basename(workspacePath),
      repositoryPath: workspacePath,
      defaultBranch,
      buildCommand: null,
      testCommand: null,
      tech: [],
      rules: [],
    })
  }

  const projectDetail = await core.projects.get(projectView.id)
  if (projectDetail === null) {
    throw new Error(`Failed to load project details for ${projectView.id}`)
  }

  const model = resolveEffectiveModel(core.activeModel.read(), options)
  options.onEvent?.({
    kind: 'status',
    text: `Configured agent with ${model.providerId} (${model.model})`,
  })

  // Read repository-level instructions (AGENTS.md, FORGE.md)
  const repositoryInstructions = await readRepositoryInstructions(workspacePath, [
    'AGENTS.md',
    'FORGE.md',
    '.forge/instructions.md',
  ])

  const effectiveRules = resolveEffectivePolicy([
    ...FORGE_DEFAULT_RULES,
    ...projectDetail.rules.map((r) => ({
      scope: r.scope as RuleScope,
      key: r.key,
      statement: r.statement,
      source: r.source,
    })),
  ])

  const taskId = taskIdSchema.parse(randomUUID())
  const runId = runIdSchema.parse(randomUUID())
  const stepId = stepIdSchema.parse(randomUUID())

  // Persist execution Run in SQLite
  core.runs.createRun({
    id: runId,
    projectId: projectIdSchema.parse(projectDetail.project.id),
    taskId,
    type: 'direct-task',
    status: 'running',
    startedAt: new Date(startTime).toISOString(),
    finishedAt: null,
    exitCode: null,
    summary: null,
    error: null,
    metadata: {
      task: options.task,
      model: model.model,
      providerId: model.providerId,
      workspacePath,
    },
  })

  const emitRunEvent = (type: string, payload: Record<string, unknown> = {}): void => {
    core.runs.appendEvent(runId, {
      stepId,
      type,
      payload,
      occurredAt: new Date().toISOString(),
    })
  }

  emitRunEvent('run.started', { task: options.task, model: model.model })

  try {
    const task: Task = taskSchema.parse({
      id: taskId,
      objective: options.task,
      constraints: [],
      completionCriteria: [
        { kind: 'no-assumptions', description: 'No unverified assumptions', params: {} },
        ...(projectDetail.project.repository.buildCommand !== null
          ? [{ kind: 'build' as const, description: 'Build passes', params: {} }]
          : []),
        ...(projectDetail.project.repository.testCommand !== null
          ? [{ kind: 'tests' as const, description: 'Tests pass', params: {} }]
          : []),
      ],
      scope: {
        allowedPaths: options.allowedPaths ? [...options.allowedPaths] : [],
        forbiddenPaths: options.forbiddenPaths ? [...options.forbiddenPaths] : [],
      },
      lockedDecisionIds: [],
      correctsTaskId: null,
      createdAt: new Date().toISOString(),
    })

    const compiled = compileContext({
      role: 'implementer',
      task,
      rules: effectiveRules,
      lockedDecisions: [],
      files: [],
      previousAttempt: null,
      reviewFindings: [],
      answeredQuestions: [],
      repositoryInstructions,
    })

    // Resolve agent runtime via IAgentRuntime abstraction (AGENT-001)
    const runtime: IAgentRuntime =
      options.runtime ??
      (options.runTurn !== undefined
        ? createTurnAdapter(options.runTurn, model, workspacePath)
        : core.runtimes.resolve('forge-native-agent'))

    // Persist execution Step in SQLite
    core.runs.createStep({
      id: stepId,
      runId,
      index: 0,
      role: 'implementer',
      runtimeId: runtime.id,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      summary: null,
      changeSetId: null,
      evidenceId: null,
    })

    options.onEvent?.({ kind: 'status', text: `Starting session with runtime "${runtime.id}"...` })
    emitRunEvent('step.started', { role: 'implementer', runtimeId: runtime.id })

    // Persist prompt packet as physical artifact
    await core.artifacts.writeArtifact({
      runId,
      stepId,
      kind: 'prompt-packet',
      name: 'prompt-packet.json',
      content: JSON.stringify(compiled.packet, null, 2),
      mimeType: 'application/json',
    })

    const session = await runtime.start({
      repositoryPath: workspacePath,
      role: 'implementer',
      timeoutMs: (options.maxRounds ?? 15) * 60_000,
    })

    let rawContent = ''
    try {
      await runtime.send(session, compiled.packet)

      for await (const event of runtime.events(session)) {
        if (event.type === 'tool') {
          emitRunEvent('tool.call', { name: event.name, detail: event.detail })
          options.onEvent?.({ kind: 'tool_start', name: event.name, detail: event.detail })
        } else if (event.type === 'chunk') {
          rawContent += event.text
          options.onEvent?.({ kind: 'content', text: event.text })
        }
      }
    } finally {
      await runtime.dispose(session)
    }

    if (rawContent.length > 0) {
      await core.artifacts.writeArtifact({
        runId,
        stepId,
        kind: 'agent-raw',
        name: 'agent-response.txt',
        content: rawContent,
        mimeType: 'text/plain; charset=utf-8',
      })
    }

    options.onEvent?.({ kind: 'status', text: 'Reconciling physical git diff with agent claim...' })

    // Measure physical git diff directly from repository
    const diff = await git.diffWorktree(baseSha)
    const physicalPaths = diff.files.map((f) => f.path)

    if (diff.patch && diff.patch.length > 0) {
      await core.artifacts.writeArtifact({
        runId,
        stepId,
        kind: 'diff',
        name: 'physical.patch',
        content: diff.patch,
        mimeType: 'text/x-diff',
      })
    }

    const report = extractReport(rawContent, physicalPaths)
    const now = new Date().toISOString()

    // Authoritative physical reconciliation
    const built = await buildChangeSet(git, {
      baseSha,
      report,
      scope: {
        allowedPaths: options.allowedPaths ? [...options.allowedPaths] : [],
        forbiddenPaths: options.forbiddenPaths ? [...options.forbiddenPaths] : [],
      },
      authorActor: 'agent:implementer',
      stepId,
      taskId,
      capturedAt: now,
    })

    // Persist authoritative ChangeSet in database
    core.changeSetStore.record(
      built.changeSet,
      projectIdSchema.parse(projectDetail.project.id),
      'agent:implementer',
      now,
    )

    for (const discrepancy of built.reconciliation.discrepancies) {
      emitRunEvent('discrepancy', {
        kind: discrepancy.kind,
        path: discrepancy.path,
        detail: discrepancy.detail,
      })
      options.onEvent?.({
        kind: 'discrepancy',
        detail: `[${discrepancy.kind}] ${discrepancy.path}: ${discrepancy.detail}`,
      })
    }

    // Run independent verification and completion criteria assessment
    options.onEvent?.({
      kind: 'status',
      text: 'Running independent verification and criteria evaluation...',
    })
    const vResult = await verifyStep({
      repository: {
        ...projectDetail.project.repository,
        id: repositoryIdSchema.parse(projectDetail.project.repository.id),
      },
      workflowId: workflowIdSchema.parse(randomUUID()),
      stepId,
      report,
      reconciliation: built.reconciliation,
      task,
    })

    const verification = {
      passed: vResult.passed,
      verdict: vResult.verdict,
      findings: vResult.findings,
      criteria: vResult.criteria,
    }

    // Persist verification stdout / stderr artifacts
    for (const cmdArt of vResult.artifacts) {
      if (cmdArt.stdout) {
        await core.artifacts.writeArtifact({
          runId,
          stepId,
          kind: 'stdout',
          name: `verify-${cmdArt.kind}-stdout.log`,
          content: cmdArt.stdout,
          mimeType: 'text/plain; charset=utf-8',
        })
      }
      if (cmdArt.stderr) {
        await core.artifacts.writeArtifact({
          runId,
          stepId,
          kind: 'stderr',
          name: `verify-${cmdArt.kind}-stderr.log`,
          content: cmdArt.stderr,
          mimeType: 'text/plain; charset=utf-8',
        })
      }
    }

    emitRunEvent('verification', {
      verdict: vResult.verdict,
      passed: vResult.passed,
      detail: vResult.detail,
      criteria: vResult.criteria,
    })

    options.onEvent?.({
      kind: 'verification',
      verdict: vResult.verdict,
      detail: vResult.detail,
      criteria: vResult.criteria,
    })

    // Determine clean exit code contract (0=OK, 1=Fail, 2=Halt/Policy)
    let exitCode = 0
    if (built.reconciliation.outOfScope.length > 0) {
      exitCode = 2 // Policy violation (out of scope edits)
    } else if (report.status === 'blocked' || !vResult.passed) {
      exitCode = 1 // Execution, criteria, or test failure
    }

    // Authoritative EVIDENCE-001 domain contract
    const evidence: StepEvidence = stepEvidenceSchema.parse({
      id: evidenceIdSchema.parse(randomUUID()),
      taskId,
      stepId,
      workflowId: null,
      actor: 'agent:implementer',
      baseSha,
      headSha: null,
      changeSet: built.changeSet,
      commandArtifacts: vResult.artifacts,
      criteria: vResult.criteria,
      discrepancies: built.reconciliation.discrepancies,
      passed: exitCode === 0,
      verdict: exitCode === 0 ? 'pass' : 'fail',
      findings: vResult.findings,
      falseClaims: vResult.falseClaims,
      recordedAt: now,
    })

    const durationMs = Date.now() - startTime

    // Finish step in durable store
    core.runs.finishStep(stepId, {
      status: exitCode === 0 ? 'completed' : 'failed',
      finishedAt: new Date().toISOString(),
      summary: report.summary,
      changeSetId: built.changeSet.id,
      evidenceId: evidence.id,
    })

    // Finish run in durable store
    core.runs.finishRun(runId, {
      status: exitCode === 0 ? 'completed' : 'failed',
      finishedAt: new Date().toISOString(),
      exitCode,
      summary: report.summary,
      error: exitCode !== 0 ? verification.verdict : null,
    })

    emitRunEvent('run.finished', { exitCode, passed: exitCode === 0 })

    return {
      ok: exitCode === 0,
      runId,
      task: options.task,
      summary: report.summary,
      baseSha,
      filesChanged: physicalPaths,
      physicalDiff: {
        files: diff.files.map((f) => ({
          path: f.path,
          insertions: f.insertions,
          deletions: f.deletions,
        })),
        patch: diff.patch,
      },
      discrepancies: built.reconciliation.discrepancies,
      outOfScopeFiles: built.reconciliation.outOfScope,
      verification,
      evidence,
      exitCode,
      rounds: 1,
      durationMs,
    }
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err)
    try {
      core.runs.finishStep(stepId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        summary: 'Step failed with error',
      })
    } catch {
      // Step may not have been created yet
    }
    try {
      core.runs.finishRun(runId, {
        status: 'failed',
        finishedAt: new Date().toISOString(),
        exitCode: 1,
        summary: 'Task execution failed',
        error: errorMsg,
      })
    } catch {
      // Run record may fail
    }
    throw err
  }
}
