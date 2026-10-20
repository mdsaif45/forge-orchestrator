import { randomUUID } from 'node:crypto'
import {
  artifactIdSchema,
  assessReview,
  assessStepPolicy,
  changeSetIdSchema,
  effectivePermissionsForRole,
  formatPolicyHaltReason,
  permissionForRole,
  repositoryIdSchema,
  reviewOutcomeSchema,
  stepIdSchema,
  validateBindingPermissions,
  type Actor,
  type AgentReport,
  type ChangeSet,
  type CriterionResult,
  type EvidenceArtifact,
  type OutputDefinition,
  type PromptPacket,
  type Repository,
  type ReviewReport,
  type Role,
  type RuntimeEvent,
  type StepId,
  type Task,
  type WorkflowArtifact,
} from '@shared/domain'
import type { BindingStore } from '../db/bindingStore'
import type { DecisionStore } from '../db/decisionStore'
import type { ProjectStore } from '../db/projectStore'
import type { WorkflowStore } from '../db/workflowStore'
import { buildChangeSet, type BuiltChangeSet } from '../evidence/changeSetBuilder'
import { verifyStep } from '../evidence/verifier'
import type { GitService } from '../git'
import type { BindingSet } from '../runtimes/bindings'
import { exchange, type ExchangeOutcome } from '../runtimes/exchange'
import type { RuntimeRegistry } from '../runtimes/registry'
import type { LeafNodeExecutor, NodeExecutionContext, NodeExecutionResult } from './graphExecutor'
import { nodeRequiresFileWrite, resolveRoleRuntime } from './roleResolution'

/**
 * Production options for configuring the generic LeafRunner.
 * Structurally free of testing seams.
 */
export interface LeafRunnerOptions {
  readonly registry: RuntimeRegistry
  readonly defaultRuntimeId?: string | undefined
  readonly bindingStore?: BindingStore | undefined
  readonly bindings?: BindingSet | undefined
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

function isExplicitVerdictOutput(outDef: OutputDefinition): boolean {
  return (
    outDef.kind === 'verdict' || outDef.name === 'verdict' || outDef.name === 'verification_verdict'
  )
}

const INCOMPATIBLE_DOMAINS: Record<string, readonly string[]> = {
  tests: [
    'build',
    'compile',
    'lint',
    'eslint',
    'stylelint',
    'rubocop',
    'flake8',
    'ruff',
    'typecheck',
    'type-check',
    'tsc',
    'mypy',
    'pyright',
    'diff',
    'patch',
    'changeset',
  ],
  build: [
    'test',
    'tests',
    'spec',
    'jest',
    'vitest',
    'pytest',
    'mocha',
    'lint',
    'eslint',
    'stylelint',
    'rubocop',
    'flake8',
    'ruff',
    'typecheck',
    'type-check',
    'tsc',
    'mypy',
    'pyright',
    'diff',
    'patch',
    'changeset',
  ],
  'custom-command': ['diff', 'patch', 'changeset'],
}

function textMatchesAny(text: string, keywords: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return keywords.some((kw) => lower.includes(kw))
}

function isEvidenceCompatible(
  ea: EvidenceArtifact,
  outDef: OutputDefinition,
  allArtifacts: readonly EvidenceArtifact[],
): boolean {
  // 1. Reject if outDef semantics or identity belong to an incompatible domain
  const incompatibleKeywords = INCOMPATIBLE_DOMAINS[ea.kind]
  if (
    incompatibleKeywords &&
    (textMatchesAny(outDef.name, incompatibleKeywords) ||
      textMatchesAny(outDef.kind, incompatibleKeywords))
  ) {
    return false
  }

  // 2. Direct kind match
  if (outDef.kind === ea.kind) {
    return true
  }

  const nameLower = outDef.name.toLowerCase()
  const kindLower = outDef.kind.toLowerCase()

  if (ea.kind === 'tests') {
    if (
      nameLower === 'tests' ||
      nameLower === 'test' ||
      nameLower === 'tests_evidence' ||
      nameLower === 'test_evidence' ||
      nameLower === 'test_report' ||
      nameLower === 'tests_report' ||
      nameLower === 'test_results' ||
      nameLower === 'tests_results' ||
      nameLower === 'test_output' ||
      nameLower === 'tests_output' ||
      kindLower === 'test' ||
      kindLower === 'test_evidence' ||
      kindLower === 'verification_results'
    ) {
      return true
    }

    // Generic verification outputs: 'verification_report', 'verification_evidence', 'verification_results', etc.
    if (
      nameLower === 'verification_report' ||
      nameLower === 'verification_evidence' ||
      nameLower === 'verification_results' ||
      nameLower === 'verification_log' ||
      nameLower === 'verification_output' ||
      (kindLower === 'stage-output' && nameLower.includes('verification'))
    ) {
      return true
    }
  }

  if (ea.kind === 'build') {
    if (
      nameLower === 'build' ||
      nameLower === 'build_evidence' ||
      nameLower === 'build_log' ||
      nameLower === 'build_output' ||
      nameLower === 'build_report' ||
      nameLower === 'build_results' ||
      kindLower === 'build_evidence' ||
      kindLower === 'build_output'
    ) {
      return true
    }

    // Generic verification output can match build ONLY IF no test artifacts were produced
    const hasTestsArtifact = allArtifacts.some((a) => a.kind === 'tests')
    if (
      !hasTestsArtifact &&
      (nameLower === 'verification_report' ||
        nameLower === 'verification_evidence' ||
        nameLower === 'verification_results' ||
        nameLower === 'verification_log' ||
        nameLower === 'verification_output' ||
        (kindLower === 'stage-output' && nameLower.includes('verification')))
    ) {
      return true
    }
  }

  if (ea.kind === 'custom-command') {
    if (
      nameLower === 'custom-command' ||
      nameLower === 'custom_command' ||
      nameLower === 'command_evidence' ||
      nameLower === 'command_output' ||
      kindLower === 'custom-command' ||
      kindLower === 'command_evidence'
    ) {
      return true
    }

    const cmdLower = ea.command.toLowerCase()
    if (cmdLower.includes('lint') && textMatchesAny(nameLower, ['lint'])) {
      return true
    }
    if (
      (cmdLower.includes('type') || cmdLower.includes('tsc')) &&
      textMatchesAny(nameLower, ['type', 'tsc'])
    ) {
      return true
    }
  }

  return false
}

function formatError(err: unknown): string {
  if (err instanceof Error) {
    return err.message
  }
  if (typeof err === 'string') {
    return err
  }
  return JSON.stringify(err)
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
    let resolved: ReturnType<typeof resolveRoleRuntime>
    try {
      resolved = resolveRoleRuntime({
        node: ctx.node,
        projectId: ctx.projectId,
        executionBindings: ctx.bindings,
        compositionBindings: this.options.bindings,
        bindingStore: this.options.bindingStore,
        registry: this.options.registry,
        defaultRuntimeId: ctx.runtimeId ?? this.options.defaultRuntimeId,
      })
    } catch (err: unknown) {
      return {
        status: 'failed',
        error: err instanceof Error ? err.message : String(err),
      }
    }

    const { runtime, runtimeId, binding } = resolved
    if (binding !== undefined) {
      validateBindingPermissions(binding)
    }
    const effectivePermissions = effectivePermissionsForRole(role, binding)
    const effectivePermitsWrite = effectivePermissions.writeFiles
    const isWritable = nodeRequiresFileWrite(ctx.node) && effectivePermitsWrite

    // Preflight for read-only execution with a worktree:
    // Independent measurement requires a Git service and an authoritative baseline SHA.
    // Never treat missing dependencies or missing baseline as proof that no changes occurred.
    if (!isWritable && ctx.worktreePath) {
      if (!this.options.gitServiceFactory) {
        return {
          status: 'failed',
          runtimeId,
          error: `Agent node "${ctx.node.id}" cannot enforce read-only policy: Git service factory is required for execution with worktree`,
        }
      }
      if (!ctx.forkSha || ctx.forkSha.trim() === '') {
        return {
          status: 'failed',
          runtimeId,
          error: `Agent node "${ctx.node.id}" cannot enforce read-only policy: Authoritative forkSha baseline is required for execution with worktree`,
        }
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
        ctx.node.config.permissionMode === 'full-access' && effectivePermitsWrite
          ? 'bypassPermissions'
          : permissionForRole(role, isWritable).mode,
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

    let outcome: ExchangeOutcome | undefined
    let exchangeError: unknown
    let disposalError: unknown
    try {
      const exchangeFn = this.options.exchangeFn ?? exchange
      outcome = await exchangeFn(runtime, session, packet, this.options.onEvent)
    } catch (err: unknown) {
      exchangeError = err
    } finally {
      ctx.signal.removeEventListener('abort', abortHandler)
      try {
        await runtime.dispose(session)
      } catch (err: unknown) {
        disposalError = err
      }
    }

    // Independent worktree diff measurement for read-only execution with a worktree.
    // Must be measured immediately after session disposal to audit disk state across
    // every outcome (success, failure, blocked/question, abort, or disposal failure).
    let readOnlyDiffFiles: readonly string[] | null = null
    let readOnlyViolation: string | undefined

    if (!isWritable && ctx.worktreePath) {
      const gitFactory = this.options.gitServiceFactory
      if (!gitFactory) {
        readOnlyViolation = `Agent node "${ctx.node.id}" cannot measure worktree diff: Git service factory is unavailable`
      } else {
        try {
          const git = gitFactory(ctx.worktreePath)
          const diff = await git.diffWorktree(ctx.forkSha)
          readOnlyDiffFiles = diff.files.map((f) => f.path)
          if (readOnlyDiffFiles.length > 0) {
            readOnlyViolation = `Policy violation: Role "${role}" in read-only mode modified ${String(readOnlyDiffFiles.length)} file(s) in the worktree: ${readOnlyDiffFiles.join(', ')}`
          }
        } catch (err: unknown) {
          readOnlyViolation = `Agent node "${ctx.node.id}" failed to measure worktree diff: ${formatError(err)}`
        }
      }
    }

    // If unauthorized modifications or measurement failure occurred, fail closed immediately.
    // Unauthorized changes must never be masked as clean cancellations, resumable pauses, or raw exchange failures.
    if (readOnlyViolation !== undefined) {
      return {
        status: 'failed',
        runtimeId,
        error: readOnlyViolation,
      }
    }

    // Preserve cancellation if aborted cleanly without worktree violations
    if (ctx.signal.aborted) {
      return {
        status: 'cancelled',
        runtimeId,
        error:
          disposalError !== undefined
            ? `Execution cancelled by signal (disposal error: ${formatError(disposalError)})`
            : 'Execution cancelled by signal',
      }
    }

    // Handle exchange exception if no worktree violations occurred
    if (exchangeError !== undefined) {
      const baseError = formatError(exchangeError)
      return {
        status: 'failed',
        runtimeId,
        error:
          disposalError !== undefined
            ? `${baseError} (disposal error: ${formatError(disposalError)})`
            : baseError,
      }
    }

    if (!outcome?.ok) {
      const baseMsg = outcome?.providerLimit
        ? `provider-limit: ${outcome.message}`
        : (outcome?.message ?? 'Exchange failed')
      return {
        status: 'failed',
        runtimeId,
        error:
          disposalError !== undefined
            ? `${baseMsg} (disposal error: ${formatError(disposalError)})`
            : baseMsg,
      }
    }

    // Fail closed if session disposal failed, even when exchange succeeded
    if (disposalError !== undefined) {
      return {
        status: 'failed',
        runtimeId,
        error: `Agent node "${ctx.node.id}" session disposal failed: ${formatError(disposalError)}`,
      }
    }

    const { report } = outcome

    if (report.status === 'blocked' || report.status === 'question') {
      return {
        status: 'blocked',
        runtimeId,
        error: report.summary,
        awaitingUser: true,
        resumable: true,
      }
    }

    const task = this.resolveTask(ctx)
    const policyAssessment = assessStepPolicy({
      ...(binding !== undefined ? { binding } : {}),
      role,
      permissions: effectivePermissions,
      report,
      forbiddenPaths: task?.scope.forbiddenPaths ?? [],
      ...(readOnlyDiffFiles !== null ? { changedPaths: readOnlyDiffFiles } : {}),
    })
    if (!policyAssessment.allowed) {
      return {
        status: 'failed',
        runtimeId,
        error: `Policy violation: ${formatPolicyHaltReason(policyAssessment.violations)}`,
      }
    }

    // Reconcile git diff for writable execution with a worktree
    let changeSet: ChangeSet | undefined

    if (isWritable && ctx.worktreePath) {
      if (!this.options.gitServiceFactory) {
        return {
          status: 'failed',
          runtimeId,
          error: `Agent node "${ctx.node.id}" cannot build changeset: Git service factory is required for writable execution with worktree`,
        }
      }

      const task = this.resolveTask(ctx)
      if (!task) {
        return {
          status: 'failed',
          runtimeId,
          error: `Agent node "${ctx.node.id}" cannot build changeset: authoritative task is unavailable`,
        }
      }

      const git = this.options.gitServiceFactory(ctx.worktreePath)
      const validStepId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        ctx.node.id,
      )
        ? (ctx.node.id as StepId)
        : stepIdSchema.parse(randomUUID())

      let built: BuiltChangeSet
      try {
        built = await buildChangeSet(git, {
          baseSha: ctx.forkSha,
          report,
          scope: task.scope,
          authorActor: this.options.actor ?? 'system',
          stepId: validStepId,
          taskId: task.id,
          capturedAt: new Date().toISOString(),
        })
      } catch (err: unknown) {
        return {
          status: 'failed',
          runtimeId,
          error: `Agent node "${ctx.node.id}" failed to capture or reconcile changeset: ${err instanceof Error ? err.message : String(err)}`,
        }
      }

      if (!built.reconciliation.inScope) {
        return {
          status: 'failed',
          runtimeId,
          error: `Policy violation: ${String(built.reconciliation.outOfScope.length)} file(s) modified outside scope (${built.reconciliation.outOfScope.join(', ')})`,
          changeSet: built.changeSet,
        }
      }

      changeSet = built.changeSet
    }

    if (
      role === 'reviewer' &&
      (ctx.node.outputs.some((o) => o.kind === 'review_report' || o.name === 'review_verdict') ||
        ctx.node.outputs.length > 0)
    ) {
      return this.executeReviewerNode(ctx, runtimeId, report)
    }

    // Materialize declared output artifacts in-memory
    const artifacts = this.buildAgentArtifacts(ctx, report, changeSet)

    return {
      status: 'completed',
      runtimeId,
      changeSet,
      artifacts,
    }
  }

  private executeReviewerNode(
    ctx: NodeExecutionContext,
    runtimeId: string,
    report: AgentReport,
  ): NodeExecutionResult {
    // 1. Locate preceding verification evidence
    let verificationArtifact = Array.from(ctx.incomingSlots.values()).find(
      (a) =>
        a.kind === 'evidence' ||
        a.kind === 'stage-output' ||
        a.kind === 'verification_report' ||
        a.metadata.outputName === 'verification_report' ||
        (typeof a.title === 'string' && a.title.toLowerCase().includes('verification')),
    )
    verificationArtifact ??= ctx.inputArtifacts.find(
      (a) =>
        a.kind === 'evidence' ||
        a.kind === 'stage-output' ||
        a.kind === 'verification_report' ||
        a.metadata.outputName === 'verification_report' ||
        (typeof a.title === 'string' && a.title.toLowerCase().includes('verification')),
    )

    if (!verificationArtifact) {
      return {
        status: 'failed',
        runtimeId,
        error: 'Reviewer node requires verification evidence from preceding verification step',
      }
    }

    // 2. Extract criteria results from verification evidence
    let criteria: readonly CriterionResult[] | undefined
    if (Array.isArray(verificationArtifact.metadata.criteria)) {
      criteria = verificationArtifact.metadata.criteria as readonly CriterionResult[]
    } else {
      try {
        const parsed: unknown = JSON.parse(verificationArtifact.content)
        if (
          parsed &&
          typeof parsed === 'object' &&
          'criteria' in parsed &&
          Array.isArray(parsed.criteria)
        ) {
          criteria = parsed.criteria as readonly CriterionResult[]
        }
      } catch {
        // Content is not JSON
      }
    }

    if (!criteria || !Array.isArray(criteria)) {
      return {
        status: 'failed',
        runtimeId,
        error: 'Verification evidence is missing valid criteria results',
      }
    }

    // Zero-criteria fail-closed invariant
    if (criteria.length === 0) {
      return {
        status: 'failed',
        runtimeId,
        error:
          'Verification evidence has zero criteria results. Cannot perform review without verified completion criteria.',
      }
    }

    // 3. Lineage validation: identify authoritative implementation changeset
    const changesetArtifact = ctx.inputArtifacts.find(
      (a) => a.kind === 'changeset' || a.metadata.outputName === 'changeset',
    )
    const authoritativeChangeSetId =
      (changesetArtifact?.metadata.changeSetId as string | undefined) ??
      changesetArtifact?.id ??
      ctx.initialContext?.changeSetId

    if (!authoritativeChangeSetId) {
      return {
        status: 'failed',
        runtimeId,
        error: 'Reviewer node requires an implementation changeset',
      }
    }

    const verificationCsId = verificationArtifact.metadata.changeSetId as string | undefined
    if (verificationCsId && verificationCsId !== authoritativeChangeSetId) {
      return {
        status: 'failed',
        runtimeId,
        error: `Lineage rejection: verification evidence (${verificationCsId}) does not match implementation changeset (${authoritativeChangeSetId})`,
      }
    }

    if (
      verificationArtifact.metadata.iteration !== undefined &&
      ctx.iteration !== undefined &&
      verificationArtifact.metadata.iteration !== ctx.iteration
    ) {
      const iterStr =
        typeof verificationArtifact.metadata.iteration === 'number' ||
        typeof verificationArtifact.metadata.iteration === 'string'
          ? String(verificationArtifact.metadata.iteration)
          : 'unknown'
      return {
        status: 'failed',
        runtimeId,
        error: `Lineage rejection: verification evidence iteration (${iterStr}) does not match current iteration (${String(ctx.iteration)})`,
      }
    }

    // 4. Construct trusted ReviewReport
    const validStepId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      ctx.node.id,
    )
      ? (ctx.node.id as StepId)
      : stepIdSchema.parse(randomUUID())

    const reviewReport: ReviewReport = {
      changeSetId: changeSetIdSchema.parse(authoritativeChangeSetId),
      stepId: validStepId,
      claimedVerdict: report.claimedVerdict ?? 'unknown',
      findings: report.findings ?? [],
      summary: report.summary,
      reviewedAt: new Date().toISOString(),
    }

    // 5. Authoritative assessReview computation
    const outcome = assessReview(reviewReport, criteria)
    reviewOutcomeSchema.parse(outcome)

    // Fail-closed if verdict could not be verified
    if (outcome.verdict === 'unknown') {
      return {
        status: 'failed',
        runtimeId,
        error: `Review outcome is UNKNOWN: ${outcome.reason}`,
      }
    }

    // 6. Emit exact review_verdict deliverable
    const now = new Date().toISOString()
    const reviewArtifact: WorkflowArtifact = {
      id: randomUUID(),
      workflowId: ctx.workflowId,
      nodeId: ctx.node.id,
      kind: 'review_report',
      format: 'json',
      title: `${ctx.node.title} - review_verdict`,
      content: JSON.stringify(
        {
          verdict: outcome.verdict,
          overridden: outcome.overridden,
          reason: outcome.reason,
          rejectingFindings: outcome.rejectingFindings,
          corrections: outcome.corrections,
          changeSetId: authoritativeChangeSetId,
          stepId: validStepId,
          iteration: ctx.iteration ?? 1,
          evidenceId: (verificationArtifact.metadata.evidenceId as string | undefined) ?? null,
        },
        null,
        2,
      ),
      metadata: {
        outputName: 'review_verdict',
        verdict: outcome.verdict,
        overridden: outcome.overridden,
        reason: outcome.reason,
        changeSetId: authoritativeChangeSetId,
        stepId: validStepId,
        iteration: ctx.iteration ?? 1,
        evidenceId: verificationArtifact.metadata.evidenceId ?? null,
      },
      createdAt: now,
    }

    return {
      status: 'completed',
      runtimeId,
      artifacts: [reviewArtifact],
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

  private buildAgentArtifacts(
    ctx: NodeExecutionContext,
    report: AgentReport,
    changeSet?: ChangeSet,
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
          ...(changeSet?.id ? { changeSetId: changeSet.id } : {}),
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

    const changesetArtifact = ctx.inputArtifacts.find(
      (a) => a.kind === 'changeset' || a.metadata.outputName === 'changeset',
    )
    const changeSetId =
      (changesetArtifact?.metadata.changeSetId as string | undefined) ??
      changesetArtifact?.id ??
      null

    // Separate declared outputs into evidence deliverables vs. explicit verdict outputs
    const evidenceOutputs = ctx.node.outputs.filter((o) => !isExplicitVerdictOutput(o))
    const verdictOutputs = ctx.node.outputs.filter((o) => isExplicitVerdictOutput(o))

    const unclaimedEvidenceOutputs = [...evidenceOutputs]

    // 1. Map genuine EvidenceArtifacts produced by verifyStep()
    for (const ea of result.artifacts) {
      // Find compatible declared output from unclaimed evidence outputs:
      // Priority 1: Specific name/kind matches (not generic 'verification_*')
      // Priority 2: Generic verification outputs
      let matchIndex = unclaimedEvidenceOutputs.findIndex(
        (o) =>
          isEvidenceCompatible(ea, o, result.artifacts) &&
          !o.name.toLowerCase().includes('verification'),
      )
      if (matchIndex === -1) {
        matchIndex = unclaimedEvidenceOutputs.findIndex((o) =>
          isEvidenceCompatible(ea, o, result.artifacts),
        )
      }

      const declaredOutput =
        matchIndex !== -1 ? unclaimedEvidenceOutputs.splice(matchIndex, 1)[0] : undefined

      const kind = declaredOutput ? declaredOutput.kind : ea.kind
      const title = declaredOutput
        ? `${ctx.node.title} - ${declaredOutput.name}`
        : `${ctx.node.title} - ${ea.kind} evidence`

      artifacts.push({
        id: randomUUID(),
        workflowId: ctx.workflowId,
        nodeId: ctx.node.id,
        kind,
        format: declaredOutput?.format === 'json' ? 'json' : 'text',
        title,
        content:
          declaredOutput?.format === 'json'
            ? JSON.stringify(
                {
                  evidenceId: ea.id,
                  command: ea.command,
                  outcome: ea.outcome,
                  exitCode: ea.exitCode,
                  durationMs: ea.durationMs,
                  counts: ea.counts,
                  stdout: ea.stdout,
                  stderr: ea.stderr,
                  criteria: result.criteria,
                  passed: result.passed,
                  verdict: result.verdict,
                  changeSetId,
                },
                null,
                2,
              )
            : `[Command: ${ea.command}]\n[ExitCode: ${String(ea.exitCode)}]\n${ea.stdout}\n${ea.stderr}`,
        metadata: {
          evidenceId: ea.id,
          command: ea.command,
          outcome: ea.outcome,
          exitCode: ea.exitCode,
          durationMs: ea.durationMs,
          counts: ea.counts,
          evidenceKind: ea.kind,
          criteria: result.criteria,
          passed: result.passed,
          verdict: result.verdict,
          iteration: ctx.iteration ?? 1,
          ...(changeSetId ? { changeSetId } : {}),
          ...(declaredOutput ? { outputName: declaredOutput.name } : {}),
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
                criteria: result.criteria,
                changeSetId,
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
          criteria: result.criteria,
          iteration: ctx.iteration ?? 1,
          ...(changeSetId ? { changeSetId } : {}),
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

    // 2. Production gate semantics:
    // Caller-supplied strings in initialContext (whether 'approved', 'rejected', etc.) are untrusted
    // and CANNOT authorize a human decision or cancel the graph.
    // - An attempt number (attempt > 1) is NOT evidence of human approval.
    // - An unrelated project-wide locked decision does NOT satisfy or unblock this gate.
    // - An unauthenticated string in initialContext does NOT unblock or cancel the gate.
    const untrustedSignal =
      ctx.initialContext?.[`${ctx.node.id}.approval`] ??
      ctx.initialContext?.[ctx.node.id] ??
      ctx.initialContext?.approval ??
      ctx.initialContext?.user_decision

    if (untrustedSignal) {
      return {
        status: 'blocked',
        awaitingUser: true,
        resumable: true,
        error: `User gate "${ctx.node.title}" cannot be decided by untrusted context input (requires authenticated human decision)`,
      }
    }

    // 3. Authoritative decision lookup scoped to (graphRunId, nodeId)
    const decisionStore = this.options.decisionStore
    if (!decisionStore) {
      return {
        status: 'blocked',
        awaitingUser: true,
        resumable: true,
        error: `User gate "${ctx.node.title}" awaiting human approval`,
      }
    }

    const decision = decisionStore.findGateDecision(ctx.graphRunId, ctx.node.id, {
      projectId: ctx.projectId,
      workflowId: ctx.workflowId,
    })
    if (!decision) {
      return {
        status: 'blocked',
        awaitingUser: true,
        resumable: true,
        error: `User gate "${ctx.node.title}" awaiting human approval`,
      }
    }

    // 4. Resolve verdict using established lifecycle semantics
    if (decision.gateVerdict === 'approved') {
      const artifact: WorkflowArtifact = {
        id: artifactIdSchema.parse(randomUUID()),
        workflowId: ctx.workflowId,
        nodeId: ctx.node.id,
        kind: 'decision_record',
        format: 'json',
        title: `Gate ${ctx.node.title} Approved`,
        content: JSON.stringify(decision),
        metadata: {},
        createdAt: decision.lockedAt ?? new Date().toISOString(),
      }

      return {
        status: 'completed',
        artifacts: [artifact],
      }
    }

    if (decision.gateVerdict === 'rejected') {
      return {
        status: 'cancelled',
        error: `User gate "${ctx.node.title}" rejected: ${decision.rationale}`,
      }
    }

    return {
      status: 'blocked',
      awaitingUser: true,
      resumable: true,
      error: `User gate "${ctx.node.title}" has invalid decision verdict`,
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
