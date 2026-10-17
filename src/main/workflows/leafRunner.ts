import { randomUUID } from 'node:crypto'
import {
  repositoryIdSchema,
  stepIdSchema,
  type Actor,
  type AgentReport,
  type ChangeSet,
  type IAgentRuntime,
  type PromptPacket,
  type Role,
  type RuntimeEvent,
  type StepId,
  type TaskId,
  type WorkflowArtifact,
  permissionForRole,
} from '@shared/domain'
import type { DecisionStore } from '../db/decisionStore'
import { buildChangeSet } from '../evidence/changeSetBuilder'
import { verifyStep } from '../evidence/verifier'
import type { GitService } from '../git'
import { exchange, type ExchangeOutcome } from '../runtimes/exchange'
import type { RuntimeRegistry } from '../runtimes/registry'
import type {
  LeafNodeExecutor,
  NodeExecutionContext,
  NodeExecutionResult,
} from './graphExecutor'

/**
 * Options for configuring the generic LeafRunner.
 */
export interface LeafRunnerOptions {
  readonly registry: RuntimeRegistry
  readonly defaultRuntimeId?: string | undefined
  readonly gitServiceFactory?: ((path: string) => GitService) | undefined
  readonly decisionStore?: DecisionStore | undefined
  readonly actor?: Actor | undefined
  readonly compilePacket?:
    | ((ctx: NodeExecutionContext, role: Role) => Promise<PromptPacket> | PromptPacket)
    | undefined
  readonly exchangeFn?: typeof exchange | undefined
  readonly verifyFn?: typeof verifyStep | undefined
  readonly onEvent?: ((event: RuntimeEvent) => void) | undefined
}

/**
 * Generic Leaf Runner (WORK-005).
 *
 * Executes leaf workflow graph nodes (`agent`, `verification`, `user_gate`)
 * without owning DAG scheduling, worktree allocation/disposal, or durable persistence.
 */
export class LeafRunner {
  constructor(private readonly options: LeafRunnerOptions) {}

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

    // Reconcile git diff for developer permission mode
    let changeSet: ChangeSet | undefined
    if (
      ctx.node.config.permissionMode === 'developer' &&
      ctx.worktreePath &&
      this.options.gitServiceFactory
    ) {
      const git = this.options.gitServiceFactory(ctx.worktreePath)
      const validStepId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        ctx.node.id,
      )
        ? (ctx.node.id as StepId)
        : stepIdSchema.parse(randomUUID())

      const built = await buildChangeSet(git, {
        baseSha: ctx.forkSha,
        report,
        scope: { allowedPaths: [], forbiddenPaths: [] },
        authorActor: this.options.actor ?? 'system',
        stepId: validStepId,
        taskId: 'default-task' as TaskId,
        capturedAt: new Date().toISOString(),
      })
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
      incomingTextParts.push(`--- Input Slot "${name}" (${artifact.title}) ---\n${artifact.content}`)
    }
    if (ctx.initialContext) {
      for (const [k, v] of Object.entries(ctx.initialContext)) {
        if (!ctx.incomingSlots.has(k)) {
          incomingTextParts.push(`--- Context "${k}" ---\n${v}`)
        }
      }
    }

    const objective =
      ctx.node.title +
      (incomingTextParts.length > 0 ? `\n\n${incomingTextParts.join('\n\n')}` : '')

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

  private buildAgentArtifacts(
    ctx: NodeExecutionContext,
    report: AgentReport,
  ): WorkflowArtifact[] {
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

    const verifyFn = this.options.verifyFn ?? verifyStep
    const validStepId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      ctx.node.id,
    )
      ? (ctx.node.id as StepId)
      : stepIdSchema.parse(randomUUID())

    const result = await verifyFn({
      repository: {
        id: repositoryIdSchema.parse(randomUUID()),
        absolutePath: ctx.worktreePath,
        defaultBranch: 'main',
        buildCommand: null,
        testCommand: null,
        tech: [],
      },
      workflowId: ctx.workflowId,
      stepId: validStepId,
      report: null,
      signal: ctx.signal,
    })

    const now = new Date().toISOString()
    const artifacts: WorkflowArtifact[] = result.artifacts.map((ea, idx) => {
      const declaredOutput = ctx.node.outputs[idx] ?? ctx.node.outputs[0]
      const kind = declaredOutput?.kind ?? 'stage-output'
      const title = declaredOutput?.name ?? `${ea.kind} verification evidence`
      return {
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
        },
        createdAt: now,
      }
    })

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
    // 1. Check for explicit rejection signal
    if (
      ctx.initialContext?.approval === 'rejected' ||
      ctx.initialContext?.user_decision === 'rejected'
    ) {
      return {
        status: 'cancelled',
        error: 'User declined approval',
      }
    }

    // 2. Check for explicit resume / approval
    // A gate unblocks when explicitly resumed by the user (attempt > 1 or explicit approval signal)
    const isExplicitlyApproved =
      ctx.attempt > 1 ||
      ctx.initialContext?.approval === 'approved' ||
      ctx.initialContext?.user_decision === 'approved'

    if (!isExplicitlyApproved) {
      // Deterministic human-in-the-loop pause: NEVER auto-pass on arbitrary project decisions
      return {
        status: 'blocked',
        awaitingUser: true,
        resumable: true,
        error: `User gate "${ctx.node.title}" awaiting human approval`,
      }
    }

    // 3. User has approved: emit declared outputs in-memory
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

/**
 * Creates a LeafNodeExecutor function suitable for passing to GraphExecutorOptions.
 */
export function createLeafRunner(options: LeafRunnerOptions): LeafNodeExecutor {
  const runner = new LeafRunner(options)
  return (ctx: NodeExecutionContext) => runner.execute(ctx)
}
