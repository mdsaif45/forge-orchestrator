import { randomUUID } from 'node:crypto'
import {
  repositoryIdSchema,
  stepIdSchema,
  type Actor,
  type AgentReport,
  type ChangeSet,
  type IAgentRuntime,
  type OutputDefinition,
  type PromptPacket,
  type Repository,
  type Role,
  type RuntimeEvent,
  type StepId,
  type Task,
  type WorkflowArtifact,
  permissionForRole,
} from '@shared/domain'
import type { DecisionStore } from '../db/decisionStore'
import type { ProjectStore } from '../db/projectStore'
import type { WorkflowStore } from '../db/workflowStore'
import { buildChangeSet } from '../evidence/changeSetBuilder'
import { verifyStep } from '../evidence/verifier'
import type { GitService } from '../git'
import { exchange, type ExchangeOutcome } from '../runtimes/exchange'
import type { RuntimeRegistry } from '../runtimes/registry'
import type { LeafNodeExecutor, NodeExecutionContext, NodeExecutionResult } from './graphExecutor'

/**
 * Production options for configuring the generic LeafRunner.
 * Structurally free of testing seams.
 */
export interface LeafRunnerOptions {
  readonly registry: RuntimeRegistry
  readonly defaultRuntimeId?: string | undefined
  readonly gitServiceFactory?: ((path: string) => GitService) | undefined
  readonly decisionStore?: DecisionStore | undefined
  readonly workflowStore?: WorkflowStore | undefined
  readonly projectStore?: ProjectStore | undefined
  readonly task?: Task | undefined
  readonly repository?: Repository | undefined
  readonly actor?: Actor | undefined
  readonly compilePacket?:
    ((ctx: NodeExecutionContext, role: Role) => Promise<PromptPacket> | PromptPacket) | undefined
  readonly exchangeFn?: typeof exchange | undefined
  readonly verifyFn?: typeof verifyStep | undefined
  readonly onEvent?: ((event: RuntimeEvent) => void) | undefined
}

/**
 * Test-only options extending production LeafRunnerOptions with testing seams.
 * Structurally segregated so production factories and configuration types
 * do not expose or accept testing seams.
 */
export interface TestLeafRunnerOptions extends LeafRunnerOptions {
  /**
   * TEST SEAM ONLY: When true, allows unauthenticated approval or rejection strings in `initialContext`
   * to satisfy or cancel user gates in isolated tests.
   *
   * In production, `initialContext` is untrusted caller-controlled input and MUST NEVER be treated
   * as proof of human approval or rejection. User gates remain strictly fail-closed (resumably blocked).
   */
  readonly testOnlyAllowContextDecision?: boolean | undefined
}

function isExplicitVerdictOutput(outDef: OutputDefinition): boolean {
  return (
    outDef.kind === 'verdict' || outDef.name === 'verdict' || outDef.name === 'verification_verdict'
  )
}

/**
 * Generic Leaf Runner (WORK-005).
 *
 * Executes leaf workflow graph nodes (`agent`, `verification`, `user_gate`)
 * without owning DAG scheduling, worktree allocation/disposal, or durable persistence.
 */
export class LeafRunner {
  constructor(private readonly options: LeafRunnerOptions | TestLeafRunnerOptions) {}

  /**
   * Main execution seam satisfying `LeafNodeExecutor`.
   */
  async execute(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    // 1. Check immediate cancellation
    if (ctx.signal.aborted) {
      return { status: 'cancelled', error: 'Execution cancelled by signal' }
    }

    // 2. Validate declared input slots (fail closed if required slots missing)
    for (const slot of ctx.node.inputs) {
      const isRequired = slot.required
      if (isRequired && !ctx.incomingSlots.has(slot.name)) {
        return {
          status: 'failed',
          error: `Node "${ctx.node.id}" missing required input slot "${slot.name}"`,
        }
      }
    }

    // 3. Dispatch based on node type
    switch (ctx.node.type) {
      case 'agent':
        return this.executeAgent(ctx)

      case 'verification':
        return this.executeVerification(ctx)

      case 'user_gate':
        return this.executeUserGate(ctx)

      case 'router':
        return {
          status: 'failed',
          error: 'Router nodes are graph control-flow nodes and must be executed by GraphExecutor',
        }

      default: {
        const exhaustiveCheck: never = ctx.node.type
        return {
          status: 'failed',
          error: `Unsupported node type "${exhaustiveCheck as string}"`,
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Agent Node Execution
  // ---------------------------------------------------------------------------

  private async executeAgent(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    const role: Role = ctx.node.config.role ?? 'implementer'
    let runtimeId = ctx.node.config.providerId ?? this.options.defaultRuntimeId

    if (!runtimeId) {
      const candidates = this.options.registry.candidatesForRole(role)
      const firstCandidate = candidates[0]
      if (!firstCandidate) {
        return {
          status: 'failed',
          error: `No runtime registered capable of holding role "${role}"`,
        }
      }
      runtimeId = firstCandidate.id
    }

    let runtime: IAgentRuntime
    try {
      runtime = this.options.registry.resolveForRole(runtimeId, role)
    } catch (err: unknown) {
      return {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }
    }

    // Assemble PromptPacket
    let packet: PromptPacket
    if (this.options.compilePacket) {
      packet = await this.options.compilePacket(ctx, role)
    } else {
      packet = this.buildDefaultPacket(ctx, role)
    }

    // Session lifecycle: start and dispose in finally block
    const worktreePath = ctx.worktreePath ?? '.'
    const session = await runtime.start({
      repositoryPath: worktreePath,
      role,
      permissionMode:
        ctx.node.config.permissionMode === 'full-access'
          ? 'bypassPermissions'
          : permissionForRole(role, ctx.node.config.permissionMode !== 'read-only').mode,
      timeoutMs: ctx.node.config.timeoutMs,
    })

    // Listen to abort signal to cancel active session
    const abortHandler = () => {
      void runtime.cancel(session, 'cancelled by signal').catch(() => undefined)
    }

    if (ctx.signal.aborted) {
      abortHandler()
    } else {
      ctx.signal.addEventListener('abort', abortHandler, { once: true })
    }

    let outcome: ExchangeOutcome
    try {
      const exchangeFn = this.options.exchangeFn ?? exchange
      outcome = await exchangeFn(runtime, session, packet, this.options.onEvent)
    } catch (err: unknown) {
      if (ctx.signal.aborted) {
        return { status: 'cancelled', error: 'Execution cancelled by signal' }
      }
      return {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }
    } finally {
      ctx.signal.removeEventListener('abort', abortHandler)
      await runtime.dispose(session)
    }

    if (ctx.signal.aborted) {
      return { status: 'cancelled', error: 'Execution cancelled by signal' }
    }

    if (!outcome.ok) {
      if (outcome.providerLimit) {
        return { status: 'failed', error: `provider-limit: ${outcome.message}` }
      }
      return { status: 'failed', error: outcome.message }
    }

    const { report } = outcome

    if (report.status === 'blocked' || report.status === 'question') {
      return {
        status: 'blocked',
        error: report.summary,
        awaitingUser: true,
        resumable: true,
      }
    }

    // Reconcile git diff for non-read-only permission modes
    let changeSet: ChangeSet | undefined
    if (
      ctx.node.config.permissionMode !== 'read-only' &&
      ctx.worktreePath &&
      this.options.gitServiceFactory
    ) {
      const task = this.resolveTask(ctx)
      if (!task) {
        return {
          status: 'failed',
          error: `Agent node "${ctx.node.id}" cannot build changeset: authoritative task is unavailable`,
        }
      }

      const git = this.options.gitServiceFactory(ctx.worktreePath)
      const validStepId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        ctx.node.id,
      )
        ? (ctx.node.id as StepId)
        : stepIdSchema.parse(randomUUID())

      const built = await buildChangeSet(git, {
        baseSha: ctx.forkSha,
        report,
        scope: task.scope,
        authorActor: this.options.actor ?? 'system',
        stepId: validStepId,
        taskId: task.id,
        capturedAt: new Date().toISOString(),
      })

      if (!built.reconciliation.inScope) {
        return {
          status: 'failed',
          error: `Policy violation: ${String(built.reconciliation.outOfScope.length)} file(s) modified outside scope (${built.reconciliation.outOfScope.join(', ')})`,
          changeSet: built.changeSet,
        }
      }

      changeSet = built.changeSet
    }

    // Materialize declared output artifacts in-memory
    const artifacts = this.buildAgentArtifacts(ctx, report)

    return {
      status: 'completed',
      changeSet,
      artifacts,
    }
  }

  private buildDefaultPacket(ctx: NodeExecutionContext, role: Role): PromptPacket {
    const incomingTextParts: string[] = []
    for (const [name, artifact] of ctx.incomingSlots.entries()) {
      incomingTextParts.push(
        `--- Input Slot "${name}" (${artifact.title}) ---\n${artifact.content}`,
      )
    }
    if (ctx.initialContext) {
      for (const [k, v] of Object.entries(ctx.initialContext)) {
        if (!ctx.incomingSlots.has(k)) {
          incomingTextParts.push(`--- Context "${k}" ---\n${v}`)
        }
      }
    }

    const objective =
      ctx.node.title + (incomingTextParts.length > 0 ? `\n\n${incomingTextParts.join('\n\n')}` : '')

    return {
      role,
      objective,
      constraints: ['Never guess.', 'Stay in scope.'],
      rules: ['Adhere strictly to protocol.'],
      lockedDecisions: [],
      allowedPaths: [],
      forbiddenPaths: ['.git', '.env*'],
      relevantFiles: [],
      reviewFindings: [],
      previousAttempt: null,
      completionCriteria: ctx.node.outputs.map((o) => o.name),
      answeredQuestions: [],
      repositoryInstructions: null,
      correction: null,
    }
  }

  private buildAgentArtifacts(ctx: NodeExecutionContext, report: AgentReport): WorkflowArtifact[] {
    const artifacts: WorkflowArtifact[] = []
    const now = new Date().toISOString()

    for (const outDef of ctx.node.outputs) {
      let content = report.summary
      if (outDef.format === 'json') {
        content = JSON.stringify(report, null, 2)
      }

      artifacts.push({
        id: randomUUID(),
        workflowId: ctx.workflowId,
        nodeId: ctx.node.id,
        kind: outDef.kind,
        format: outDef.format,
        title: `${ctx.node.title} - ${outDef.name}`,
        content,
        metadata: {
          outputName: outDef.name,
          filesChanged: report.filesChanged,
          commandsRun: report.commandsRun,
          testsRun: report.testsRun,
        },
        createdAt: now,
      })
    }

    return artifacts
  }

  // ---------------------------------------------------------------------------
  // Verification Node Execution
  // ---------------------------------------------------------------------------

  private async executeVerification(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    if (!ctx.worktreePath) {
      return {
        status: 'failed',
        error: `Verification node "${ctx.node.id}" requires an isolated worktree path`,
      }
    }

    const repoConfig = this.resolveRepository(ctx)
    if (!repoConfig) {
      return {
        status: 'failed',
        error: `Verification configuration unavailable: repository configuration for project "${ctx.projectId}" not found`,
      }
    }

    const task = this.resolveTask(ctx)
    if (!task) {
      return {
        status: 'failed',
        error: `Verification configuration unavailable: task for workflow "${ctx.workflowId}" not found`,
      }
    }

    if (!repoConfig.buildCommand && !repoConfig.testCommand) {
      return {
        status: 'failed',
        error: `Verification configuration error: repository has neither buildCommand nor testCommand configured`,
      }
    }

    const verifyFn = this.options.verifyFn ?? verifyStep
    const validStepId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      ctx.node.id,
    )
      ? (ctx.node.id as StepId)
      : stepIdSchema.parse(randomUUID())

    const result = await verifyFn({
      repository: {
        id: repositoryIdSchema.parse(repoConfig.id),
        absolutePath: ctx.worktreePath,
        defaultBranch: repoConfig.defaultBranch,
        buildCommand: repoConfig.buildCommand,
        testCommand: repoConfig.testCommand,
        tech: repoConfig.tech,
      },
      workflowId: ctx.workflowId,
      stepId: validStepId,
      report: null,
      task,
      signal: ctx.signal,
    })

    const now = new Date().toISOString()
    const artifacts: WorkflowArtifact[] = []

    // Separate declared outputs into evidence deliverables vs. explicit verdict outputs
    const evidenceOutputs = ctx.node.outputs.filter((o) => !isExplicitVerdictOutput(o))
    const verdictOutputs = ctx.node.outputs.filter((o) => isExplicitVerdictOutput(o))

    // 1. Map genuine EvidenceArtifacts produced by verifyStep()
    for (let idx = 0; idx < result.artifacts.length; idx++) {
      const ea = result.artifacts[idx]
      if (!ea) continue
      const declaredOutput =
        evidenceOutputs.find(
          (o) => o.kind === ea.kind || o.name === ea.kind || o.name === `${ea.kind}_evidence`,
        ) ??
        evidenceOutputs[idx] ??
        evidenceOutputs[0]

      const kind = declaredOutput?.kind ?? 'stage-output'
      const title = declaredOutput?.name ?? `${ea.kind} verification evidence`
      artifacts.push({
        id: randomUUID(),
        workflowId: ctx.workflowId,
        nodeId: ctx.node.id,
        kind,
        format: 'text',
        title,
        content: `[Command: ${ea.command}]\n[ExitCode: ${String(ea.exitCode)}]\n${ea.stdout}\n${ea.stderr}`,
        metadata: {
          evidenceId: ea.id,
          command: ea.command,
          outcome: ea.outcome,
          exitCode: ea.exitCode,
          durationMs: ea.durationMs,
          counts: ea.counts,
          evidenceKind: ea.kind,
          outputName: declaredOutput?.name,
        },
        createdAt: now,
      })
    }

    // 2. Map explicit verdict outputs ONLY if declared by the node contract
    for (const outDef of verdictOutputs) {
      const content =
        outDef.format === 'json'
          ? JSON.stringify(
              {
                passed: result.passed,
                verdict: result.verdict,
                detail: result.detail,
                findings: result.findings,
                falseClaims: result.falseClaims,
              },
              null,
              2,
            )
          : result.passed
            ? `Verification passed: ${result.detail || 'all checks passed'}`
            : `Verification failed: ${result.findings.join('; ') || result.detail || 'checks failed'}`

      artifacts.push({
        id: randomUUID(),
        workflowId: ctx.workflowId,
        nodeId: ctx.node.id,
        kind: outDef.kind,
        format: outDef.format,
        title: `${ctx.node.title} - ${outDef.name}`,
        content,
        metadata: {
          outputName: outDef.name,
          passed: result.passed,
          verdict: result.verdict,
          detail: result.detail,
          findings: result.findings,
        },
        createdAt: now,
      })
    }

    // Axiom A3: Never fabricate placeholder evidence artifacts!
    // If result.artifacts is empty and node required evidence outputs, returning only genuine artifacts
    // ensures GraphExecutor.matchRequiredOutputs fails closed instead of accepting fabricated placeholders.

    if (!result.passed) {
      return {
        status: 'failed',
        error: `Verification failed: ${result.findings.join('; ') || result.detail || 'tests or build failed'}`,
        artifacts,
      }
    }

    return {
      status: 'completed',
      artifacts,
      evidenceId: result.artifacts[0]?.id,
    }
  }

  // ---------------------------------------------------------------------------
  // User Gate Node Execution
  // ---------------------------------------------------------------------------

  private executeUserGate(ctx: NodeExecutionContext): NodeExecutionResult {
    // 1. Authoritative cancellation: check abort signal
    if (ctx.signal.aborted) {
      return {
        status: 'cancelled',
        error: 'Execution cancelled by signal',
      }
    }

    const allowContextDecision =
      'testOnlyAllowContextDecision' in this.options &&
      this.options.testOnlyAllowContextDecision === true

    // 2. Isolated test seam: if explicitly enabled, evaluate initialContext decision signals
    if (allowContextDecision) {
      const gateSignal =
        ctx.initialContext?.[`${ctx.node.id}.approval`] ??
        ctx.initialContext?.[ctx.node.id] ??
        ctx.initialContext?.approval ??
        ctx.initialContext?.user_decision

      // TEST SEAM ONLY: explicit rejection in initialContext returns cancelled
      if (gateSignal === 'rejected' || gateSignal === 'declined' || gateSignal === 'denied') {
        return {
          status: 'cancelled',
          error: 'User declined approval',
        }
      }

      // TEST SEAM ONLY: explicit approval in initialContext completes gate
      if (gateSignal === 'approved' || gateSignal === 'accepted') {
        const now = new Date().toISOString()
        const artifacts: WorkflowArtifact[] = []

        for (const outDef of ctx.node.outputs) {
          artifacts.push({
            id: randomUUID(),
            workflowId: ctx.workflowId,
            nodeId: ctx.node.id,
            kind: outDef.kind,
            format: outDef.format,
            title: `${ctx.node.title} - ${outDef.name}`,
            content: JSON.stringify({ approved: true, approvedAt: now }),
            metadata: {
              approved: true,
              outputName: outDef.name,
            },
            createdAt: now,
          })
        }

        if (artifacts.length === 0) {
          artifacts.push({
            id: randomUUID(),
            workflowId: ctx.workflowId,
            nodeId: ctx.node.id,
            kind: 'stage-output',
            format: 'json',
            title: `${ctx.node.title} - approval`,
            content: JSON.stringify({ approved: true, approvedAt: now }),
            metadata: { approved: true },
            createdAt: now,
          })
        }

        return {
          status: 'completed',
          artifacts,
        }
      }
    }

    // 3. In production (or when test seam is disabled/omitted), any caller-supplied string in initialContext
    // (whether 'approved', 'rejected', etc.) is untrusted and CANNOT authorize a human decision or cancel the graph.
    // Without an authenticated, gate-scoped human decision (Axiom A4), the gate remains resumably blocked.
    // - An attempt number (attempt > 1) is NOT evidence of human approval.
    // - An unrelated project-wide locked decision does NOT satisfy or unblock this gate.
    // - An unauthenticated string in initialContext does NOT unblock or cancel the gate in production.
    const untrustedSignal =
      ctx.initialContext?.[`${ctx.node.id}.approval`] ??
      ctx.initialContext?.[ctx.node.id] ??
      ctx.initialContext?.approval ??
      ctx.initialContext?.user_decision

    const errorMsg = untrustedSignal
      ? `User gate "${ctx.node.title}" cannot be decided by untrusted context input (requires authenticated human decision)`
      : `User gate "${ctx.node.title}" awaiting human approval`

    return {
      status: 'blocked',
      awaitingUser: true,
      resumable: true,
      error: errorMsg,
    }
  }

  // ---------------------------------------------------------------------------
  // Store Resolution Helpers
  // ---------------------------------------------------------------------------

  private resolveTask(ctx: NodeExecutionContext): Task | null {
    if (ctx.task) return ctx.task
    const taskId = ctx.taskId ?? this.options.task?.id
    if (taskId && this.options.workflowStore) {
      const fromStore = this.options.workflowStore.getTask(taskId)
      if (fromStore) return fromStore
    }
    if (ctx.workflowId && this.options.workflowStore) {
      const workflow = this.options.workflowStore.find(ctx.workflowId)
      if (workflow?.taskId) {
        const fromStore = this.options.workflowStore.getTask(workflow.taskId)
        if (fromStore) return fromStore
      }
    }
    return this.options.task ?? null
  }

  private resolveRepository(ctx: NodeExecutionContext): Repository | null {
    if (ctx.repository) return ctx.repository
    if (this.options.projectStore && ctx.projectId) {
      const project = this.options.projectStore.findById(ctx.projectId)
      if (project?.repository) return project.repository
    }
    return this.options.repository ?? null
  }
}

/**
 * Creates a LeafNodeExecutor function suitable for passing to GraphExecutorOptions.
 */
export function createLeafRunner(options: LeafRunnerOptions): LeafNodeExecutor {
  const runner = new LeafRunner(options)
  return (ctx: NodeExecutionContext) => runner.execute(ctx)
}

/**
 * Creates a LeafNodeExecutor function with test-only options for isolated testing seams.
 */
export function createTestLeafRunner(options: TestLeafRunnerOptions): LeafNodeExecutor {
  const runner = new LeafRunner(options)
  return (ctx: NodeExecutionContext) => runner.execute(ctx)
}
