/* eslint-disable @typescript-eslint/unbound-method */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import {
  decisionIdSchema,
  projectIdSchema,
  repositoryIdSchema,
  runIdSchema,
  shaSchema,
  stepIdSchema,
  taskIdSchema,
  workflowIdSchema,
  type AgentReport,
  type Capability,
  type IAgentRuntime,
  type Repository,
  type RuntimeId,
  type Task,
  type WorkflowNode,
  type WorkflowTemplateV2,
} from '@shared/domain'
import { eq } from 'drizzle-orm'
import { ArtifactService } from '../artifacts/artifactService'
import { initialiseDatabase } from '../db'
import { ArtifactStore } from '../db/artifactStore'
import { DecisionStore } from '../db/decisionStore'
import { EventStore } from '../db/eventStore'
import { ProjectStore } from '../db/projectStore'
import { applyEvent } from '../db/projections'
import { RunStore } from '../db/runStore'
import { graphRuns, workflows } from '../db/schema'
import { WorkflowStore } from '../db/workflowStore'
import { GitService, WorktreeService } from '../git'
import { RuntimeRegistry } from '../runtimes/registry'
import { GraphExecutor } from './graphExecutor'
import { LeafRunner, createLeafRunner } from './leafRunner'
import type { NodeExecutionContext, NodeExecutionResult } from './graphExecutor'

function mockRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    id: 'mock-runtime' as RuntimeId,
    capabilities: [
      'repo-read',
      'file-write',
      'terminal',
      'plan',
      'review',
      'test',
    ] as readonly Capability[],
    simulated: true,
    supportsAccountIsolation: true,
    instructionFilenames: [],
    start: vi.fn().mockResolvedValue({ sessionId: 'test-session-1' }),
    send: vi.fn().mockResolvedValue(undefined),
    events: vi.fn().mockReturnValue(
      (async function* () {
        await Promise.resolve()
        yield* []
      })(),
    ),
    status: vi.fn().mockResolvedValue({ state: 'idle' }),
    cancel: vi.fn().mockResolvedValue(undefined),
    dispose: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

function makeNode(id: string, overrides: Partial<WorkflowNode> = {}): WorkflowNode {
  return {
    id,
    title: `Node ${id}`,
    type: 'agent',
    runtimeType: 'cli-agent',
    config: {
      role: 'implementer',
      skills: [],
      permissionMode: 'developer',
    },
    inputs: [],
    outputs: [],
    ...overrides,
  }
}

function makeContext(
  node: WorkflowNode,
  overrides: Partial<NodeExecutionContext> = {},
): NodeExecutionContext {
  const taskId = taskIdSchema.parse(randomUUID())
  const defaultTask: Task = {
    id: taskId,
    objective: 'Test task objective',
    constraints: [],
    completionCriteria: [{ kind: 'tests', description: 'the test suite passes', params: {} }],
    scope: { allowedPaths: [], forbiddenPaths: [] },
    lockedDecisionIds: [],
    correctsTaskId: null,
    createdAt: new Date().toISOString(),
  }

  const defaultRepository: Repository = {
    id: repositoryIdSchema.parse(randomUUID()),
    absolutePath: 'C:\\fake\\repo',
    defaultBranch: 'main',
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    tech: ['typescript'],
  }

  return {
    graphRunId: randomUUID(),
    workflowId: workflowIdSchema.parse(randomUUID()),
    projectId: projectIdSchema.parse(randomUUID()),
    taskId,
    task: defaultTask,
    repository: defaultRepository,
    node,
    attempt: 1,
    forkSha: shaSchema.parse('a'.repeat(40)),
    signal: new AbortController().signal,
    inputArtifacts: [],
    incomingSlots: new Map(),
    initialContext: {},
    ...overrides,
  }
}

describe('LeafRunner', () => {
  it('1. agent success: starts session, executes exchange, materializes outputs, and disposes session', async () => {
    const runtime = mockRuntime()
    const registry = new RuntimeRegistry()
    registry.register(runtime)

    const report: AgentReport = {
      status: 'completed',
      summary: 'Implemented task successfully',
      filesChanged: ['src/index.ts'],
      commandsRun: ['npm test'],
      testsRun: true,
      openQuestions: [],
      assumptions: [],
    }

    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report,
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
    })

    const node = makeNode('agent-1', {
      outputs: [
        {
          name: 'summary_report',
          kind: 'report',
          format: 'markdown',
          required: true,
          requiredSections: [],
        },
      ],
    })
    const ctx = makeContext(node)

    const result = await runner.execute(ctx)

    expect(result.status).toBe('completed')
    expect(runtime.start).toHaveBeenCalledOnce()
    expect(exchangeFn).toHaveBeenCalledOnce()
    expect(runtime.dispose).toHaveBeenCalledOnce()
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts![0]!.kind).toBe('report')
    expect(result.artifacts![0]!.content).toBe('Implemented task successfully')
  })

  it('2. agent runtime failure: fails closed and cleanly disposes session', async () => {
    const runtime = mockRuntime()
    const registry = new RuntimeRegistry()
    registry.register(runtime)

    const exchangeFn = vi.fn().mockResolvedValue({
      ok: false,
      failure: 'runtime',
      code: null,
      message: 'Process crashed with segmentation fault',
      retried: false,
      providerLimit: false,
      transcript: [],
    })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
    })

    const node = makeNode('agent-1')
    const ctx = makeContext(node)

    const result = await runner.execute(ctx)

    expect(result.status).toBe('failed')
    expect(result.error).toBe('Process crashed with segmentation fault')
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })

  it('3. provider limit failure: marks error with provider-limit prefix', async () => {
    const runtime = mockRuntime()
    const registry = new RuntimeRegistry()
    registry.register(runtime)

    const exchangeFn = vi.fn().mockResolvedValue({
      ok: false,
      failure: 'runtime',
      code: null,
      message: 'Account rate limit exceeded',
      retried: false,
      providerLimit: true,
      transcript: [],
    })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
    })

    const node = makeNode('agent-1')
    const ctx = makeContext(node)

    const result = await runner.execute(ctx)

    expect(result.status).toBe('failed')
    expect(result.error).toBe('provider-limit: Account rate limit exceeded')
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })

  it('4. cooperative cancellation: aborts active session and returns cancelled', async () => {
    const runtime = mockRuntime()
    const registry = new RuntimeRegistry()
    registry.register(runtime)

    const controller = new AbortController()

    const exchangeFn = vi.fn().mockImplementation(() => {
      controller.abort()
      return Promise.resolve({
        ok: false,
        failure: 'runtime',
        code: null,
        message: 'aborted',
        retried: false,
        providerLimit: false,
        transcript: [],
      })
    })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
    })

    const node = makeNode('agent-1')
    const ctx = makeContext(node, { signal: controller.signal })

    const result = await runner.execute(ctx)

    expect(result.status).toBe('cancelled')
    expect(runtime.cancel).toHaveBeenCalledWith(expect.anything(), 'cancelled by signal')
    expect(runtime.dispose).toHaveBeenCalledOnce()
  })

  it('5. immediate cancellation: aborts before starting session', async () => {
    const runtime = mockRuntime()
    const registry = new RuntimeRegistry()
    registry.register(runtime)

    const controller = new AbortController()
    controller.abort()

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
    })

    const node = makeNode('agent-1')
    const ctx = makeContext(node, { signal: controller.signal })

    const result = await runner.execute(ctx)

    expect(result.status).toBe('cancelled')
    expect(runtime.start).not.toHaveBeenCalled()
  })

  it('6. missing required input slot: fails closed without starting runtime session', async () => {
    const runtime = mockRuntime()
    const registry = new RuntimeRegistry()
    registry.register(runtime)

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
    })

    const node = makeNode('agent-1', {
      inputs: [
        {
          name: 'required_spec',
          kind: 'spec',
          required: true,
        },
      ],
    })
    const ctx = makeContext(node, { incomingSlots: new Map() })

    const result = await runner.execute(ctx)

    expect(result.status).toBe('failed')
    expect(result.error).toContain('missing required input slot "required_spec"')
    expect(runtime.start).not.toHaveBeenCalled()
  })

  it('7. incapable runtime for role: fails closed with IncapableRuntimeError message', async () => {
    const readOnlyRuntime = mockRuntime({
      id: 'readonly-runtime' as RuntimeId,
      capabilities: ['repo-read'], // Lacks file-write and terminal
    })
    const registry = new RuntimeRegistry()
    registry.register(readOnlyRuntime)

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'readonly-runtime',
    })

    const node = makeNode('agent-1', {
      config: {
        role: 'implementer', // requires writeFiles
        skills: [],
        permissionMode: 'developer',
      },
    })
    const ctx = makeContext(node)

    const result = await runner.execute(ctx)

    expect(result.status).toBe('failed')
    expect(result.error).toContain('cannot hold role "implementer"')
  })

  it('8. verification node success: runs verification and translates evidence artifacts', async () => {
    const registry = new RuntimeRegistry()
    const verifyFn = vi.fn().mockResolvedValue({
      passed: true,
      findings: [],
      falseClaims: [],
      detail: 'all tests passed',
      criteria: [],
      artifacts: [
        {
          id: 'ev-1',
          workflowId: workflowIdSchema.parse(randomUUID()),
          stepId: stepIdSchema.parse(randomUUID()),
          kind: 'tests',
          command: 'npm test',
          cwd: '/repo',
          outcome: 'completed',
          exitCode: 0,
          durationMs: 120,
          stdout: '3 passed',
          stderr: '',
          truncated: false,
          counts: { passed: 3, failed: 0, skipped: 0 },
          failure: null,
          recordedAt: new Date().toISOString(),
        },
      ],
    })

    const runner = new LeafRunner({
      registry,
      verifyFn,
    })

    const node = makeNode('verify-1', {
      type: 'verification',
      runtimeType: 'forge-engine',
      outputs: [
        {
          name: 'verification_report',
          kind: 'stage-output',
          format: 'text',
          required: true,
          requiredSections: [],
        },
      ],
    })
    const ctx = makeContext(node, { worktreePath: '/mock-worktree' })

    const result = await runner.execute(ctx)

    expect(result.status).toBe('completed')
    expect(verifyFn).toHaveBeenCalledOnce()
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts![0]!.kind).toBe('stage-output')
    expect(result.artifacts![0]!.content).toContain('[Command: npm test]')
    expect(result.artifacts![0]!.content).toContain('[ExitCode: 0]')
    expect(result.evidenceId).toBe('ev-1')
  })

  it('9. verification node failure: returns failed status with error details', async () => {
    const registry = new RuntimeRegistry()
    const verifyFn = vi.fn().mockResolvedValue({
      passed: false,
      findings: ['Test assertion failed in auth.test.ts'],
      falseClaims: [],
      detail: 'test failed',
      criteria: [],
      artifacts: [
        {
          id: 'ev-2',
          workflowId: workflowIdSchema.parse(randomUUID()),
          stepId: stepIdSchema.parse(randomUUID()),
          kind: 'tests',
          command: 'npm test',
          cwd: '/repo',
          outcome: 'completed',
          exitCode: 1,
          durationMs: 90,
          stdout: '',
          stderr: 'FAIL auth.test.ts',
          truncated: false,
          counts: { passed: 0, failed: 1, skipped: 0 },
          failure: null,
          recordedAt: new Date().toISOString(),
        },
      ],
    })

    const runner = new LeafRunner({
      registry,
      verifyFn,
    })

    const node = makeNode('verify-1', {
      type: 'verification',
      runtimeType: 'forge-engine',
      outputs: [
        {
          name: 'verification_report',
          kind: 'stage-output',
          format: 'text',
          required: true,
          requiredSections: [],
        },
      ],
    })
    const ctx = makeContext(node, { worktreePath: '/mock-worktree' })

    const result = await runner.execute(ctx)

    expect(result.status).toBe('failed')
    expect(result.error).toContain('Verification failed: Test assertion failed in auth.test.ts')
    expect(result.artifacts).toHaveLength(1)
  })

  it('9b. verification evidence integrity: zero evidence artifacts does NOT fabricate placeholder artifacts', async () => {
    const registry = new RuntimeRegistry()
    const verifyFn = vi.fn().mockResolvedValue({
      passed: true,
      findings: [],
      falseClaims: [],
      detail: 'all criteria satisfied in abstract',
      criteria: [],
      artifacts: [], // Zero evidence artifacts produced
    })

    const runner = new LeafRunner({
      registry,
      verifyFn,
    })

    const node = makeNode('verify-no-ev', {
      type: 'verification',
      runtimeType: 'forge-engine',
      outputs: [
        {
          name: 'verification_report',
          kind: 'stage-output',
          format: 'text',
          required: true,
          requiredSections: [],
        },
      ],
    })
    const ctx = makeContext(node, { worktreePath: '/mock-worktree' })

    const result = await runner.execute(ctx)

    // Axiom A3: must NOT fabricate synthetic evidence artifact
    expect(result.status).toBe('completed')
    expect(result.artifacts).toEqual([])
    expect(result.evidenceId).toBeUndefined()
  })

  it('9c. verification failure integrity: failed verification without evidence does not emit success-shaped artifacts', async () => {
    const registry = new RuntimeRegistry()
    const verifyFn = vi.fn().mockResolvedValue({
      passed: false,
      findings: ['Build failed to start'],
      falseClaims: [],
      detail: 'no compiler found',
      criteria: [],
      artifacts: [], // Zero evidence
    })

    const runner = new LeafRunner({
      registry,
      verifyFn,
    })

    const node = makeNode('verify-fail-no-ev', {
      type: 'verification',
      runtimeType: 'forge-engine',
      outputs: [
        {
          name: 'verification_report',
          kind: 'stage-output',
          format: 'text',
          required: true,
          requiredSections: [],
        },
      ],
    })
    const ctx = makeContext(node, { worktreePath: '/mock-worktree' })

    const result = await runner.execute(ctx)

    expect(result.status).toBe('failed')
    expect(result.error).toContain('Build failed to start')
    expect(result.artifacts).toEqual([])
  })

  it('9d. verification explicit verdict contract: node declaring verdict output emits structured verdict artifact', async () => {
    const registry = new RuntimeRegistry()
    const verifyFn = vi.fn().mockResolvedValue({
      passed: true,
      verdict: 'pass',
      findings: [],
      falseClaims: [],
      detail: 'all checks clean',
      criteria: [],
      artifacts: [],
    })

    const runner = new LeafRunner({
      registry,
      verifyFn,
    })

    const node = makeNode('verify-verdict-only', {
      type: 'verification',
      runtimeType: 'forge-engine',
      outputs: [
        {
          name: 'verdict',
          kind: 'verdict',
          format: 'json',
          required: true,
          requiredSections: [],
        },
      ],
    })
    const ctx = makeContext(node, { worktreePath: '/mock-worktree' })

    const result = await runner.execute(ctx)

    expect(result.status).toBe('completed')
    expect(result.artifacts).toHaveLength(1)
    expect(result.artifacts![0]!.kind).toBe('verdict')
    const parsed = JSON.parse(result.artifacts![0]!.content) as { passed: boolean; verdict: string }
    expect(parsed.passed).toBe(true)
    expect(parsed.verdict).toBe('pass')
  })

  it('9e. verification artifact separation: verdict is never treated as report, log, or evidence merely because name or kind matches', async () => {
    const registry = new RuntimeRegistry()
    const verifyFn = vi.fn().mockResolvedValue({
      passed: true,
      verdict: 'pass',
      findings: [],
      falseClaims: [],
      detail: 'all checks clean',
      criteria: [],
      artifacts: [], // No evidence artifacts produced
    })

    const runner = new LeafRunner({
      registry,
      verifyFn,
    })

    // Node declares an evidence report output (not a verdict output)
    const node = makeNode('verify-report-only', {
      type: 'verification',
      runtimeType: 'forge-engine',
      outputs: [
        {
          name: 'verification_report',
          kind: 'stage-output',
          format: 'text',
          required: true,
          requiredSections: [],
        },
      ],
    })
    const ctx = makeContext(node, { worktreePath: '/mock-worktree' })

    const result = await runner.execute(ctx)

    // Must NOT emit a verdict artifact disguised as 'verification_report'
    expect(result.status).toBe('completed')
    expect(result.artifacts).toEqual([])
  })

  it('10. user_gate initial execution: deterministically pauses awaiting human approval', async () => {
    const registry = new RuntimeRegistry()
    const runner = new LeafRunner({ registry })

    const node = makeNode('gate-1', {
      type: 'user_gate',
      runtimeType: 'human',
    })
    const ctx = makeContext(node, { attempt: 1 })

    const result = await runner.execute(ctx)

    expect(result.status).toBe('blocked')
    expect(result.awaitingUser).toBe(true)
    expect(result.resumable).toBe(true)
    expect(result.error).toContain('awaiting human approval')
  })

  it('11. user_gate regression: attempt 2 without approval remains blocked (attempt number is not approval)', async () => {
    const registry = new RuntimeRegistry()
    const runner = new LeafRunner({ registry })

    const node = makeNode('gate-1', {
      type: 'user_gate',
      runtimeType: 'human',
      outputs: [
        {
          name: 'approved_plan',
          kind: 'stage-output',
          format: 'json',
          required: true,
          requiredSections: [],
        },
      ],
    })
    // Attempt 2 without approval signal must stay blocked
    const ctx = makeContext(node, { attempt: 2 })

    const result = await runner.execute(ctx)

    expect(result.status).toBe('blocked')
    expect(result.awaitingUser).toBe(true)
    expect(result.resumable).toBe(true)
    expect(result.error).toContain('awaiting human approval')
  })

  it('12. user_gate regression: unrelated locked decision in DecisionStore cannot unblock gate', async () => {
    const { db, close } = initialiseDatabase(':memory:')
    try {
      const eventStore = new EventStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const projectId = projectIdSchema.parse(randomUUID())
      const now = new Date().toISOString()

      new ProjectStore(db).create(
        {
          id: projectId,
          name: 'Test Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: '/dummy/repo',
            defaultBranch: 'main',
            buildCommand: null,
            testCommand: null,
            tech: [],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      // Seed an unrelated locked decision
      const decId = decisionIdSchema.parse(randomUUID())
      decisionStore.propose(
        {
          id: decId,
          statement: 'Unrelated architectural choice: use Postgres for analytics',
          rationale: 'Long-term analytics storage',
          status: 'proposed',
          proposedBy: 'user',
          proposedAt: now,
          lockedAt: null,
          lockedBy: null,
          supersededBy: null,
          originQuestionId: null,
        },
        projectId,
        'user',
        now,
      )
      decisionStore.lock(decId, 'user', now)

      expect(decisionStore.listLocked(projectId)).toHaveLength(1)

      const registry = new RuntimeRegistry()
      const runner = new LeafRunner({ registry, decisionStore })

      const node = makeNode('gate-1', {
        type: 'user_gate',
        runtimeType: 'human',
      })
      const ctx = makeContext(node, {
        projectId,
        attempt: 2, // Even on attempt 2 with a locked decision in the project, it must remain blocked
      })

      const result = await runner.execute(ctx)

      expect(result.status).toBe('blocked')
      expect(result.awaitingUser).toBe(true)
      expect(result.resumable).toBe(true)
      expect(result.error).toContain('awaiting human approval')
    } finally {
      close()
    }
  })

  it('13. user_gate production invariant: caller-supplied approval in initialContext cannot approve gate and remains resumably blocked', async () => {
    const registry = new RuntimeRegistry()
    const runner = new LeafRunner({ registry })

    const node = makeNode('gate-1', {
      type: 'user_gate',
      runtimeType: 'human',
      outputs: [
        {
          name: 'approved_plan',
          kind: 'stage-output',
          format: 'json',
          required: true,
          requiredSections: [],
        },
      ],
    })

    // 1. General explicit approval signal in initialContext
    const ctxGeneral = makeContext(node, {
      attempt: 2,
      initialContext: { approval: 'approved' },
    })

    const resultGeneral = await runner.execute(ctxGeneral)
    expect(resultGeneral.status).toBe('blocked')
    expect(resultGeneral.awaitingUser).toBe(true)
    expect(resultGeneral.resumable).toBe(true)
    expect(resultGeneral.error).toContain('cannot be decided by untrusted context input')
    expect(resultGeneral.artifacts).toBeUndefined()

    // 2. Node-scoped explicit approval signal ('gate-1.approval': 'approved')
    const ctxScoped = makeContext(node, {
      attempt: 2,
      initialContext: { 'gate-1.approval': 'approved' },
    })
    const resultScoped = await runner.execute(ctxScoped)
    expect(resultScoped.status).toBe('blocked')
    expect(resultScoped.awaitingUser).toBe(true)
    expect(resultScoped.resumable).toBe(true)
    expect(resultScoped.error).toContain('cannot be decided by untrusted context input')
    expect(resultScoped.artifacts).toBeUndefined()
  })

  it('13b. user_gate trust boundary: caller-supplied approval in initialContext fails closed and remains blocked', async () => {
    const registry = new RuntimeRegistry()
    const runner = new LeafRunner({ registry })

    const node = makeNode('gate-1', {
      type: 'user_gate',
      runtimeType: 'human',
      outputs: [
        {
          name: 'approved_plan',
          kind: 'stage-output',
          format: 'json',
          required: true,
          requiredSections: [],
        },
      ],
    })

    const ctx = makeContext(node, {
      attempt: 2,
      initialContext: { approval: 'approved', 'gate-1.approval': 'approved' },
    })

    const result = await runner.execute(ctx)
    expect(result.status).toBe('blocked')
    expect(result.awaitingUser).toBe(true)
    expect(result.resumable).toBe(true)
    expect(result.error).toContain('cannot be decided by untrusted context input')
  })

  it('14. user_gate trust boundary: caller-supplied rejection in initialContext fails closed and remains blocked', async () => {
    const registry = new RuntimeRegistry()
    const runner = new LeafRunner({ registry })

    const node = makeNode('gate-1', {
      type: 'user_gate',
      runtimeType: 'human',
    })
    const ctx = makeContext(node, {
      attempt: 2,
      initialContext: { approval: 'rejected' },
    })

    const result = await runner.execute(ctx)

    expect(result.status).toBe('blocked')
    expect(result.awaitingUser).toBe(true)
    expect(result.resumable).toBe(true)
    expect(result.error).toContain('cannot be decided by untrusted context input')

    // Also verify node-scoped rejection ('gate-1.approval': 'rejected') fails closed in production
    const ctxScoped = makeContext(node, {
      attempt: 2,
      initialContext: { 'gate-1.approval': 'rejected' },
    })
    const resultScoped = await runner.execute(ctxScoped)
    expect(resultScoped.status).toBe('blocked')
    expect(resultScoped.awaitingUser).toBe(true)
    expect(resultScoped.resumable).toBe(true)
    expect(resultScoped.error).toContain('cannot be decided by untrusted context input')
  })

  it('14b. user_gate production invariant: diverse untrusted rejection strings in initialContext cannot cancel and remain resumably blocked', async () => {
    const registry = new RuntimeRegistry()
    const runner = new LeafRunner({ registry })

    const node = makeNode('gate-1', {
      type: 'user_gate',
      runtimeType: 'human',
    })

    for (const signal of ['rejected', 'declined', 'denied']) {
      const ctx = makeContext(node, {
        attempt: 2,
        initialContext: { approval: signal },
      })
      const result = await runner.execute(ctx)
      expect(result.status).toBe('blocked')
      expect(result.awaitingUser).toBe(true)
      expect(result.resumable).toBe(true)
      expect(result.error).toContain('cannot be decided by untrusted context input')
    }

    // Node-scoped rejection ('gate-1.approval': 'rejected')
    const ctxScoped = makeContext(node, {
      attempt: 2,
      initialContext: { 'gate-1.approval': 'rejected' },
    })
    const resultScoped = await runner.execute(ctxScoped)
    expect(resultScoped.status).toBe('blocked')
    expect(resultScoped.awaitingUser).toBe(true)
    expect(resultScoped.resumable).toBe(true)
    expect(resultScoped.error).toContain('cannot be decided by untrusted context input')
  })

  it('14c. user_gate legitimate cancellation: AbortSignal cancellation returns cancelled in production without test seam', async () => {
    const registry = new RuntimeRegistry()
    const runner = new LeafRunner({ registry })

    const controller = new AbortController()
    controller.abort()

    const node = makeNode('gate-1', {
      type: 'user_gate',
      runtimeType: 'human',
    })
    const ctx = makeContext(node, { signal: controller.signal })

    const result = await runner.execute(ctx)

    expect(result.status).toBe('cancelled')
    expect(result.error).toContain('Execution cancelled by signal')
  })

  it('14d. user_gate authorization: locked approved decision matching (graphRunId, nodeId) completes gate and emits decision artifact', async () => {
    const { db, close } = initialiseDatabase(':memory:')
    try {
      const eventStore = new EventStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const workflowStore = new WorkflowStore(db)
      const projectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const taskId = taskIdSchema.parse(randomUUID())
      const graphRunId = 'run-gate-test-14d'
      const now = new Date().toISOString()

      new ProjectStore(db).create(
        {
          id: projectId,
          name: 'Test Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: '/dummy/repo',
            defaultBranch: 'main',
            buildCommand: null,
            testCommand: null,
            tech: [],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Test objective',
              constraints: [],
              completionCriteria: [{ kind: 'tests', description: 'test suite passes', params: {} }],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)
      workflowStore.start(
        { workflowId, projectId, taskId, templateId: 'feature', startedAt: now },
        'user',
      )
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: 'compiled-feature', startedAt: now },
        'user',
      )

      const node = makeNode('gate-1', {
        title: 'Architecture Review Gate',
        type: 'user_gate',
        runtimeType: 'human',
      })

      // Record approved gate decision
      const decision = decisionStore.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId: node.id,
        verdict: 'approved',
        rationale: 'Human validated implementation plan and safety criteria',
        actor: 'user',
        occurredAt: now,
      })

      const registry = new RuntimeRegistry()
      const runner = new LeafRunner({ registry, decisionStore })
      const ctx = makeContext(node, { projectId, workflowId, graphRunId, attempt: 1 })

      const result = await runner.execute(ctx)

      expect(result.status).toBe('completed')
      expect(result.artifacts).toHaveLength(1)
      const artifact = result.artifacts?.[0]
      expect(artifact?.kind).toBe('decision_record')
      expect(artifact?.title).toBe('Gate Architecture Review Gate Approved')
      expect(JSON.parse(artifact?.content ?? '{}')).toEqual(decision)
    } finally {
      close()
    }
  })

  it('14e. user_gate human rejection: locked rejected decision cancels gate using established graph cancellation semantics', async () => {
    const { db, close } = initialiseDatabase(':memory:')
    try {
      const eventStore = new EventStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const workflowStore = new WorkflowStore(db)
      const projectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const taskId = taskIdSchema.parse(randomUUID())
      const graphRunId = 'run-gate-test-14e'
      const now = new Date().toISOString()

      new ProjectStore(db).create(
        {
          id: projectId,
          name: 'Test Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: '/dummy/repo',
            defaultBranch: 'main',
            buildCommand: null,
            testCommand: null,
            tech: [],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Test objective',
              constraints: [],
              completionCriteria: [{ kind: 'tests', description: 'test suite passes', params: {} }],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)
      workflowStore.start(
        { workflowId, projectId, taskId, templateId: 'feature', startedAt: now },
        'user',
      )
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: 'compiled-feature', startedAt: now },
        'user',
      )

      const node = makeNode('gate-1', {
        title: 'Architecture Review Gate',
        type: 'user_gate',
        runtimeType: 'human',
      })

      // Record rejected gate decision
      decisionStore.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId: node.id,
        verdict: 'rejected',
        rationale: 'Architecture plan violates required safety invariants',
        actor: 'user',
        occurredAt: now,
      })

      const registry = new RuntimeRegistry()
      const runner = new LeafRunner({ registry, decisionStore })
      const ctx = makeContext(node, { projectId, workflowId, graphRunId, attempt: 1 })

      const result = await runner.execute(ctx)

      expect(result.status).toBe('cancelled')
      expect(result.error).toContain('Architecture plan violates required safety invariants')
    } finally {
      close()
    }
  })

  it('14f. user_gate scope isolation: approved decision for run-1 does not unblock gate for run-2', async () => {
    const { db, close } = initialiseDatabase(':memory:')
    try {
      const eventStore = new EventStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const workflowStore = new WorkflowStore(db)
      const projectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const taskId = taskIdSchema.parse(randomUUID())
      const graphRunId1 = 'run-gate-test-14f-1'
      const graphRunId2 = 'run-gate-test-14f-2'
      const now = new Date().toISOString()

      new ProjectStore(db).create(
        {
          id: projectId,
          name: 'Test Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: '/dummy/repo',
            defaultBranch: 'main',
            buildCommand: null,
            testCommand: null,
            tech: [],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Test objective',
              constraints: [],
              completionCriteria: [{ kind: 'tests', description: 'test suite passes', params: {} }],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)
      workflowStore.start(
        { workflowId, projectId, taskId, templateId: 'feature', startedAt: now },
        'user',
      )
      workflowStore.startGraphRun(
        {
          graphRunId: graphRunId1,
          workflowId,
          projectId,
          templateId: 'compiled-feature',
          startedAt: now,
        },
        'user',
      )
      workflowStore.startGraphRun(
        {
          graphRunId: graphRunId2,
          workflowId,
          projectId,
          templateId: 'compiled-feature',
          startedAt: now,
        },
        'user',
      )

      const node = makeNode('gate-1', {
        title: 'Review Gate',
        type: 'user_gate',
        runtimeType: 'human',
      })

      // Decision is only for run-1
      decisionStore.recordGateDecision({
        projectId,
        workflowId,
        graphRunId: graphRunId1,
        nodeId: node.id,
        verdict: 'approved',
        rationale: 'Approved for run 1',
        actor: 'user',
        occurredAt: now,
      })

      const registry = new RuntimeRegistry()
      const runner = new LeafRunner({ registry, decisionStore })

      // Executing run-2 must remain blocked!
      const ctxRun2 = makeContext(node, {
        projectId,
        workflowId,
        graphRunId: graphRunId2,
        attempt: 1,
      })
      const result2 = await runner.execute(ctxRun2)
      expect(result2.status).toBe('blocked')
      expect(result2.awaitingUser).toBe(true)

      // Executing run-1 succeeds
      const ctxRun1 = makeContext(node, {
        projectId,
        workflowId,
        graphRunId: graphRunId1,
        attempt: 1,
      })
      const result1 = await runner.execute(ctxRun1)
      expect(result1.status).toBe('completed')
    } finally {
      close()
    }
  })

  it('14g. user_gate node isolation: approved decision for node-1 does not unblock node-2', async () => {
    const { db, close } = initialiseDatabase(':memory:')
    try {
      const eventStore = new EventStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const workflowStore = new WorkflowStore(db)
      const projectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const taskId = taskIdSchema.parse(randomUUID())
      const graphRunId = 'run-gate-test-14g'
      const now = new Date().toISOString()

      new ProjectStore(db).create(
        {
          id: projectId,
          name: 'Test Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: '/dummy/repo',
            defaultBranch: 'main',
            buildCommand: null,
            testCommand: null,
            tech: [],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Test objective',
              constraints: [],
              completionCriteria: [{ kind: 'tests', description: 'test suite passes', params: {} }],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)
      workflowStore.start(
        { workflowId, projectId, taskId, templateId: 'feature', startedAt: now },
        'user',
      )
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: 'compiled-feature', startedAt: now },
        'user',
      )

      const node1 = makeNode('gate-step-1', {
        title: 'First Gate',
        type: 'user_gate',
        runtimeType: 'human',
      })
      const node2 = makeNode('gate-step-2', {
        title: 'Second Gate',
        type: 'user_gate',
        runtimeType: 'human',
      })

      // Decision is only for node1
      decisionStore.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId: node1.id,
        verdict: 'approved',
        rationale: 'Approved node 1',
        actor: 'user',
        occurredAt: now,
      })

      const registry = new RuntimeRegistry()
      const runner = new LeafRunner({ registry, decisionStore })

      // Node 2 must remain blocked
      const ctxNode2 = makeContext(node2, { projectId, workflowId, graphRunId, attempt: 1 })
      const result2 = await runner.execute(ctxNode2)
      expect(result2.status).toBe('blocked')

      // Node 1 completes
      const ctxNode1 = makeContext(node1, { projectId, workflowId, graphRunId, attempt: 1 })
      const result1 = await runner.execute(ctxNode1)
      expect(result1.status).toBe('completed')
    } finally {
      close()
    }
  })

  it('14h. user_gate scope revalidation: decision with mismatched project or workflow identity cannot authorize gate', async () => {
    const { db, close } = initialiseDatabase(':memory:')
    try {
      const eventStore = new EventStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const workflowStore = new WorkflowStore(db)
      const projectId = projectIdSchema.parse(randomUUID())
      const otherProjectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const otherWorkflowId = workflowIdSchema.parse(randomUUID())
      const taskId = taskIdSchema.parse(randomUUID())
      const graphRunId = 'run-gate-test-14h'
      const now = new Date().toISOString()

      new ProjectStore(db).create(
        {
          id: projectId,
          name: 'Project 1',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: '/dummy/repo1',
            defaultBranch: 'main',
            buildCommand: null,
            testCommand: null,
            tech: [],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )
      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Test objective 14h',
              constraints: [],
              completionCriteria: [{ kind: 'tests', description: 'test suite passes', params: {} }],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)

      workflowStore.start(
        { workflowId, projectId, taskId, templateId: 'feature', startedAt: now },
        'user',
      )
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: 'compiled-feature', startedAt: now },
        'user',
      )

      const node = makeNode('gate-14h', {
        type: 'user_gate',
        runtimeType: 'human',
      })

      // Decision is recorded for projectId and workflowId
      decisionStore.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId: node.id,
        verdict: 'approved',
        rationale: 'Approved for project 1',
        actor: 'user',
        occurredAt: now,
      })

      const registry = new RuntimeRegistry()
      const runner = new LeafRunner({ registry, decisionStore })

      // Executing under a mismatched execution context projectId must fail closed (remain blocked)
      const ctxWrongProject = makeContext(node, {
        projectId: otherProjectId,
        workflowId,
        graphRunId,
        attempt: 1,
      })
      const resultWrongProject = await runner.execute(ctxWrongProject)
      expect(resultWrongProject.status).toBe('blocked')
      expect(resultWrongProject.awaitingUser).toBe(true)

      // Executing under a mismatched execution context workflowId must fail closed (remain blocked)
      const ctxWrongWorkflow = makeContext(node, {
        projectId,
        workflowId: otherWorkflowId,
        graphRunId,
        attempt: 1,
      })
      const resultWrongWorkflow = await runner.execute(ctxWrongWorkflow)
      expect(resultWrongWorkflow.status).toBe('blocked')
      expect(resultWrongWorkflow.awaitingUser).toBe(true)

      // Executing with matching scope succeeds and emits decision artifact
      const ctxMatching = makeContext(node, {
        projectId,
        workflowId,
        graphRunId,
        attempt: 1,
      })
      const resultMatching = await runner.execute(ctxMatching)
      expect(resultMatching.status).toBe('completed')
      expect(resultMatching.artifacts).toHaveLength(1)
      expect(resultMatching.artifacts?.[0]?.kind).toBe('decision_record')
    } finally {
      close()
    }
  })

  it('14i. GraphExecutor fallback leaf executor: approved user gate completes and emits decision-linked artifact', async () => {
    const { db, close } = initialiseDatabase(':memory:')
    try {
      const eventStore = new EventStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const workflowStore = new WorkflowStore(db)
      const projectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const taskId = taskIdSchema.parse(randomUUID())
      const graphRunId = 'run-gate-test-14i'
      const now = new Date().toISOString()

      new ProjectStore(db).create(
        {
          id: projectId,
          name: 'Project Fallback',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: '/dummy/repo-fallback',
            defaultBranch: 'main',
            buildCommand: null,
            testCommand: null,
            tech: [],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Test objective 14i',
              constraints: [],
              completionCriteria: [{ kind: 'tests', description: 'test suite passes', params: {} }],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)

      workflowStore.start(
        { workflowId, projectId, taskId, templateId: 'feature', startedAt: now },
        'user',
      )
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: 'compiled-feature', startedAt: now },
        'user',
      )

      const node = makeNode('gate-14i', {
        type: 'user_gate',
        runtimeType: 'human',
      })

      decisionStore.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId: node.id,
        verdict: 'approved',
        rationale: 'Approved for fallback executor test',
        actor: 'user',
        occurredAt: now,
      })

      const worktreeService = new WorktreeService({
        repositoryPath: '/dummy/repo-fallback',
        root: '/dummy/wt',
      })

      // GraphExecutor configured without executeLeafNode (exercising the fallback path)
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        decisionStore,
      })

      const ctx = makeContext(node, {
        projectId,
        workflowId,
        graphRunId,
        attempt: 1,
      })

      // Invoke the fallback execution path through dispatchLeaf method
      interface PrivateDispatchLeaf {
        dispatchLeaf(c: NodeExecutionContext): Promise<NodeExecutionResult>
      }
      const result = await (executor as unknown as PrivateDispatchLeaf).dispatchLeaf(ctx)

      expect(result.status).toBe('completed')
      expect(result.artifacts).toHaveLength(1)
      expect(result.artifacts?.[0]?.kind).toBe('decision_record')
      expect(result.artifacts?.[0]?.title).toBe('Gate Node gate-14i Approved')
      const content = result.artifacts?.[0]?.content ?? ''
      const payload = JSON.parse(content) as { gateVerdict: string; rationale: string }
      expect(payload.gateVerdict).toBe('approved')
      expect(payload.rationale).toBe('Approved for fallback executor test')
    } finally {
      close()
    }
  })

  it('14j. user_gate fails closed if authoritative graph run or workflow row is missing in database', async () => {
    const { db, sqlite, close } = initialiseDatabase(':memory:')
    try {
      const eventStore = new EventStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const workflowStore = new WorkflowStore(db)
      const projectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const taskId = taskIdSchema.parse(randomUUID())
      const graphRunId = 'run-gate-test-14j'
      const now = new Date().toISOString()

      new ProjectStore(db).create(
        {
          id: projectId,
          name: 'Project Missing Rows Test',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: '/dummy/repo-14j',
            defaultBranch: 'main',
            buildCommand: null,
            testCommand: null,
            tech: [],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Test objective 14j',
              constraints: [],
              completionCriteria: [{ kind: 'tests', description: 'test suite passes', params: {} }],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)

      workflowStore.start(
        { workflowId, projectId, taskId, templateId: 'feature', startedAt: now },
        'user',
      )
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: 'compiled-feature', startedAt: now },
        'user',
      )

      const node = makeNode('gate-14j', {
        type: 'user_gate',
        runtimeType: 'human',
      })

      decisionStore.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId: node.id,
        verdict: 'approved',
        rationale: 'Approved for gate-14j',
        actor: 'user',
        occurredAt: now,
      })

      const registry = new RuntimeRegistry()
      const runner = new LeafRunner({ registry, decisionStore })

      const ctx = makeContext(node, {
        projectId,
        workflowId,
        graphRunId,
        attempt: 1,
      })

      // 1. Simulate deleted graph run: fails closed
      sqlite.pragma('foreign_keys = OFF')
      try {
        db.delete(graphRuns).where(eq(graphRuns.id, graphRunId)).run()
      } finally {
        sqlite.pragma('foreign_keys = ON')
      }

      const resAfterRunDelete = await runner.execute(ctx)
      expect(resAfterRunDelete.status).toBe('blocked')
      expect(resAfterRunDelete.awaitingUser).toBe(true)

      // 2. Also simulate deleted workflow row: fails closed
      sqlite.pragma('foreign_keys = OFF')
      try {
        db.delete(workflows).where(eq(workflows.id, workflowId)).run()
      } finally {
        sqlite.pragma('foreign_keys = ON')
      }

      const resAfterWfDelete = await runner.execute(ctx)
      expect(resAfterWfDelete.status).toBe('blocked')
      expect(resAfterWfDelete.awaitingUser).toBe(true)
    } finally {
      close()
    }
  })

  it('15. router node dispatch refusal: fails closed because routers belong to GraphExecutor', async () => {
    const registry = new RuntimeRegistry()
    const runner = new LeafRunner({ registry })

    const node = makeNode('router-1', {
      type: 'router',
    })
    const ctx = makeContext(node)

    const result = await runner.execute(ctx)

    expect(result.status).toBe('failed')
    expect(result.error).toContain('Router nodes are graph control-flow nodes')
  })

  it('16. createLeafRunner factory: returns a LeafNodeExecutor function', async () => {
    const registry = new RuntimeRegistry()
    const executor = createLeafRunner({ registry })

    const node = makeNode('gate-1', { type: 'user_gate', runtimeType: 'human' })
    const ctx = makeContext(node, { attempt: 1 })

    const result = await executor(ctx)
    expect(result.status).toBe('blocked')
    expect(result.awaitingUser).toBe(true)
  })

  it('17. GraphExecutor integration: agent -> user_gate pipeline with repeated recovery and fail-closed gate enforcement', async () => {
    const dirsToCleanup: string[] = []
    const tempDbDir = mkdtempSync(join(tmpdir(), 'forge-lr-db-'))
    dirsToCleanup.push(tempDbDir)
    const dbFile = join(tempDbDir, 'forge.db')
    const opened = initialiseDatabase(dbFile)
    const db = opened.db
    const closeDb = opened.close

    try {
      const workflowStore = new WorkflowStore(db)
      const eventStore = new EventStore(db)
      const decisionStore = new DecisionStore(db, eventStore)

      // Make git repo
      const repoDir = mkdtempSync(join(tmpdir(), 'forge-lr-repo-'))
      dirsToCleanup.push(repoDir)
      execFileSync('git', ['init', '-b', 'main', repoDir])
      execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: repoDir })
      writeFileSync(join(repoDir, 'index.ts'), '// initial\n')
      execFileSync('git', ['add', '.'], { cwd: repoDir })
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })

      const worktreeRoot = mkdtempSync(join(tmpdir(), 'forge-lr-wt-'))
      dirsToCleanup.push(worktreeRoot)
      const worktreeService = new WorktreeService({ repositoryPath: repoDir, root: worktreeRoot })

      const artifactsDir = mkdtempSync(join(tmpdir(), 'forge-lr-artifacts-'))
      dirsToCleanup.push(artifactsDir)
      const artifactStore = new ArtifactStore(db)
      const artifactService = new ArtifactService(artifactsDir, artifactStore)

      const forkSha = shaSchema.parse(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim(),
      )

      const projectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())

      const projectStore = new ProjectStore(db)
      projectStore.create(
        {
          id: projectId,
          name: 'Test Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: repoDir,
            defaultBranch: 'main',
            buildCommand: 'npm run build',
            testCommand: 'npm test',
            tech: [],
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        'user',
      )

      const taskId = taskIdSchema.parse(randomUUID())
      const now = new Date().toISOString()
      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Complete leaf runner task',
              constraints: [],
              completionCriteria: [
                { kind: 'tests', description: 'the test suite passes', params: {} },
              ],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)

      workflowStore.start(
        {
          workflowId,
          projectId,
          taskId,
          templateId: 'test-template',
          startedAt: now,
        },
        'user',
      )

      const graphRunId = randomUUID()
      const runStore = new RunStore(db)
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: now,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      // Pre-seed an unrelated locked decision to prove gate does NOT auto-complete
      const unrelatedDecId = decisionIdSchema.parse(randomUUID())
      decisionStore.propose(
        {
          id: unrelatedDecId,
          statement: 'Pre-existing unrelated architecture decision',
          rationale: 'Decided long ago',
          status: 'proposed',
          proposedBy: 'user',
          proposedAt: new Date().toISOString(),
          lockedAt: null,
          lockedBy: null,
          supersededBy: null,
          originQuestionId: null,
        },
        projectId,
        'user',
        new Date().toISOString(),
      )
      decisionStore.lock(unrelatedDecId, 'user', new Date().toISOString())

      // 3-node pipeline: planner -> gate -> verifier
      const plannerNode = makeNode('planner', {
        title: 'Plan Changes',
        type: 'agent',
        runtimeType: 'cli-agent',
        config: { role: 'planner', skills: [], permissionMode: 'read-only' },
        outputs: [
          {
            name: 'plan',
            kind: 'stage-output',
            format: 'markdown',
            required: true,
            requiredSections: [],
          },
        ],
      })

      const gateNode = makeNode('gate', {
        title: 'Approve Plan',
        type: 'user_gate',
        runtimeType: 'human',
        inputs: [{ name: 'plan', kind: 'stage-output', required: true }],
        outputs: [
          {
            name: 'approved_plan',
            kind: 'stage-output',
            format: 'json',
            required: true,
            requiredSections: [],
          },
        ],
      })

      const verifierNode = makeNode('verifier', {
        title: 'Verify Build',
        type: 'verification',
        runtimeType: 'forge-engine',
        inputs: [{ name: 'approved_plan', kind: 'stage-output', required: true }],
        outputs: [
          {
            name: 'verification_report',
            kind: 'stage-output',
            format: 'text',
            required: true,
            requiredSections: [],
          },
        ],
      })

      const template: WorkflowTemplateV2 = {
        id: 'test-template',
        name: 'Test Template',
        description: 'Test template description',
        version: 1,
        status: 'published',
        category: 'Test',
        nodes: [plannerNode, gateNode, verifierNode],
        edges: [
          { id: 'e1', source: 'planner', target: 'gate', isFeedback: false },
          { id: 'e2', source: 'gate', target: 'verifier', isFeedback: false },
        ],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }

      const runtime = mockRuntime({ id: 'test-runtime' as RuntimeId })
      const registry = new RuntimeRegistry()
      registry.register(runtime)

      let plannerExecutions = 0
      const exchangeFn = vi.fn().mockImplementation(() => {
        plannerExecutions++
        return Promise.resolve({
          ok: true,
          report: {
            status: 'completed',
            summary: '# Implementation Plan\nReady for review.',
            filesChanged: [],
            commandsRun: [],
            testsRun: false,
            openQuestions: [],
            assumptions: [],
          },
          assessment: { status: 'completed' },
          retried: false,
          transcript: [],
        })
      })

      const verifyFn = vi.fn().mockResolvedValue({
        passed: true,
        findings: [],
        falseClaims: [],
        detail: 'clean',
        criteria: [],
        artifacts: [
          {
            id: 'ev-v1',
            workflowId,
            stepId: stepIdSchema.parse(randomUUID()),
            kind: 'tests',
            command: 'npm test',
            cwd: repoDir,
            outcome: 'completed',
            exitCode: 0,
            durationMs: 50,
            stdout: 'OK',
            stderr: '',
            truncated: false,
            counts: null,
            failure: null,
            recordedAt: new Date().toISOString(),
          },
        ],
      })

      const leafExecutor = createLeafRunner({
        registry,
        defaultRuntimeId: 'test-runtime',
        exchangeFn,
        verifyFn,
        decisionStore,
      })

      const executor1 = new GraphExecutor({
        workflowStore,
        projectStore,
        worktreeService,
        artifactService,
        decisionStore,
        executeLeafNode: leafExecutor,
      })

      const run1 = await executor1.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run1.error).toBeNull()
      expect(run1.status).toBe('running')
      expect(run1.completedNodeIds).toEqual(['planner'])
      expect(run1.blockedNodeIds).toEqual(['gate'])
      expect(plannerExecutions).toBe(1)

      const attempts = workflowStore.getNodeAttempts(run1.graphRunId, 'gate')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.status).toBe('blocked')

      // Step 2: Reconstruct executor and test repeated recovery
      const executor2 = new GraphExecutor({
        workflowStore,
        projectStore,
        worktreeService,
        artifactService,
        decisionStore,
        executeLeafNode: leafExecutor,
      })

      const rec1 = await executor2.recover(projectId)
      expect(rec1).toHaveLength(0) // Legitimately paused run is preserved

      const rec2 = await executor2.recover(projectId)
      expect(rec2).toHaveLength(0)

      // Recovery must not create duplicate attempts or execute downstream nodes prematurely
      const gateAttemptsAfterRec = workflowStore.getNodeAttempts(run1.graphRunId, 'gate')
      expect(gateAttemptsAfterRec).toHaveLength(1)
      expect(gateAttemptsAfterRec[0]?.status).toBe('blocked')
      const verifierAttemptsAfterRec = workflowStore.getNodeAttempts(run1.graphRunId, 'verifier')
      expect(verifierAttemptsAfterRec).toHaveLength(0)

      // Step 3: Run 2 - Resume WITHOUT approval signal: gate executes attempt 2 and MUST REMAIN BLOCKED
      const run2 = await executor2.run({
        graphRunId: run1.graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        resumeNodeIds: ['gate'],
      })

      expect(run2.status).toBe('running')
      expect(run2.blockedNodeIds).toEqual(['gate'])
      expect(run2.completedNodeIds).toEqual(['planner'])

      const gateAttemptsAfterRun2 = workflowStore.getNodeAttempts(run1.graphRunId, 'gate')
      expect(gateAttemptsAfterRun2).toHaveLength(2)
      expect(gateAttemptsAfterRun2[1]?.status).toBe('blocked')
      expect(workflowStore.getNodeAttempts(run1.graphRunId, 'verifier')).toHaveLength(0)

      // Step 4: Run 3 - Resume WITH caller-supplied approval in initialContext: MUST FAIL CLOSED AND REMAIN BLOCKED
      const run3 = await executor2.run({
        graphRunId: run1.graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        resumeNodeIds: ['gate'],
        initialContext: { approval: 'approved' },
      })

      expect(run3.status).toBe('running')
      expect(run3.completedNodeIds).toEqual(['planner'])
      expect(run3.blockedNodeIds).toEqual(['gate'])
      expect(run3.completedNodeIds).not.toContain('verifier')

      // Invariant check: planner was NOT re-executed (remains 1)
      expect(plannerExecutions).toBe(1)

      const finalGateAttempts = workflowStore.getNodeAttempts(run1.graphRunId, 'gate')
      expect(finalGateAttempts).toHaveLength(3)
      expect(finalGateAttempts[0]?.status).toBe('blocked')
      expect(finalGateAttempts[1]?.status).toBe('blocked')
      expect(finalGateAttempts[2]?.status).toBe('blocked')
      expect(finalGateAttempts[2]?.error).toContain('cannot be decided by untrusted context input')

      // Downstream verifier was NEVER executed prematurely
      const finalVerifierAttempts = workflowStore.getNodeAttempts(run1.graphRunId, 'verifier')
      expect(finalVerifierAttempts).toHaveLength(0)
    } finally {
      closeDb()
      for (const dir of dirsToCleanup) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore cleanup errors
        }
      }
    }
  })

  it('18. GraphExecutor integration: user gate untrusted rejection fails closed, and authoritative AbortSignal cancels run', async () => {
    const dirsToCleanup: string[] = []
    const { db, close: closeDb } = initialiseDatabase(':memory:')

    try {
      const repoDir = mkdtempSync(join(tmpdir(), 'forge-gate-reject-repo-'))
      dirsToCleanup.push(repoDir)
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.email', 'forge@test.local'], { cwd: repoDir })
      writeFileSync(join(repoDir, 'README.md'), '# Test Repo\n')
      execFileSync('git', ['add', '.'], { cwd: repoDir })
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })

      const worktreeParentDir = mkdtempSync(join(tmpdir(), 'forge-gate-reject-wt-'))
      dirsToCleanup.push(worktreeParentDir)
      const artifactsDir = mkdtempSync(join(tmpdir(), 'forge-gate-reject-art-'))
      dirsToCleanup.push(artifactsDir)

      const eventStore = new EventStore(db)
      const workflowStore = new WorkflowStore(db)
      const artifactStore = new ArtifactStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const worktreeService = new WorktreeService({
        repositoryPath: repoDir,
        root: worktreeParentDir,
      })
      const artifactService = new ArtifactService(artifactsDir, artifactStore)

      const forkSha = shaSchema.parse(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim(),
      )

      const projectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())

      new ProjectStore(db).create(
        {
          id: projectId,
          name: 'Test Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: repoDir,
            defaultBranch: 'main',
            buildCommand: null,
            testCommand: null,
            tech: [],
          },
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        'user',
      )

      const taskId = taskIdSchema.parse(randomUUID())
      const now = new Date().toISOString()
      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Plan and verify task',
              constraints: [],
              completionCriteria: [
                { kind: 'tests', description: 'the test suite passes', params: {} },
              ],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)

      workflowStore.start(
        {
          workflowId,
          projectId,
          taskId,
          templateId: 'test-template-reject',
          startedAt: now,
        },
        'user',
      )

      const graphRunId = randomUUID()
      new RunStore(db).createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: now,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const gateNode = makeNode('gate', {
        type: 'user_gate',
        runtimeType: 'human',
      })
      const verifierNode = makeNode('verifier', {
        type: 'verification',
      })

      const template: WorkflowTemplateV2 = {
        id: 'test-template-reject',
        name: 'Reject Template',
        description: 'Test template for user gate rejection',
        version: 1,
        status: 'published',
        category: 'Test',
        nodes: [gateNode, verifierNode],
        edges: [{ id: 'e1', source: 'gate', target: 'verifier', isFeedback: false }],
        createdAt: now,
        updatedAt: now,
      }

      const registry = new RuntimeRegistry()
      const leafExecutor = createLeafRunner({ registry })

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        decisionStore,
        executeLeafNode: leafExecutor,
      })

      // Run 1: Gate starts and blocks awaiting approval
      const run1 = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run1.status).toBe('running')
      expect(run1.blockedNodeIds).toEqual(['gate'])

      // Run 2: Resume with untrusted rejection signal in production (must fail closed and remain blocked)
      const run2 = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        resumeNodeIds: ['gate'],
        initialContext: { approval: 'rejected' },
      })

      expect(run2.status).toBe('running')
      expect(run2.blockedNodeIds).toEqual(['gate'])
      expect(run2.completedNodeIds).not.toContain('verifier')
      expect(workflowStore.getNodeAttempts(graphRunId, 'verifier')).toHaveLength(0)

      const gateAttemptsRun2 = workflowStore.getNodeAttempts(graphRunId, 'gate')
      expect(gateAttemptsRun2).toHaveLength(2)
      expect(gateAttemptsRun2[1]?.status).toBe('blocked')
      expect(gateAttemptsRun2[1]?.error).toContain('cannot be decided by untrusted context input')

      // Run 3: Resume with authoritative AbortSignal cancellation cancels run and halts downstream execution
      const abortController = new AbortController()
      abortController.abort()

      const run3 = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        resumeNodeIds: ['gate'],
        signal: abortController.signal,
      })

      expect(run3.status).toBe('cancelled')
      expect(run3.completedNodeIds).not.toContain('verifier')
      expect(workflowStore.getNodeAttempts(graphRunId, 'verifier')).toHaveLength(0)

      const gateAttemptsRun3 = workflowStore.getNodeAttempts(graphRunId, 'gate')
      expect(gateAttemptsRun3).toHaveLength(2)
      expect(gateAttemptsRun3[1]?.status).toBe('blocked')

      const runInDb = workflowStore.getGraphRun(graphRunId)
      expect(runInDb?.status).toBe('cancelled')
    } finally {
      closeDb()
      for (const dir of dirsToCleanup) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  })

  it('18b. GraphExecutor integration: authoritative AbortSignal cancellation cancels graph run in production', async () => {
    const dirsToCleanup: string[] = []
    const { db, close: closeDb } = initialiseDatabase(':memory:')

    try {
      const repoDir = mkdtempSync(join(tmpdir(), 'forge-gate-abort-repo-'))
      dirsToCleanup.push(repoDir)
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.email', 'forge@test.local'], { cwd: repoDir })
      writeFileSync(join(repoDir, 'README.md'), '# Test Repo\n')
      execFileSync('git', ['add', '.'], { cwd: repoDir })
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })

      const worktreeParentDir = mkdtempSync(join(tmpdir(), 'forge-gate-abort-wt-'))
      dirsToCleanup.push(worktreeParentDir)
      const artifactsDir = mkdtempSync(join(tmpdir(), 'forge-gate-abort-art-'))
      dirsToCleanup.push(artifactsDir)

      const eventStore = new EventStore(db)
      const workflowStore = new WorkflowStore(db)
      const artifactStore = new ArtifactStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const worktreeService = new WorktreeService({
        repositoryPath: repoDir,
        root: worktreeParentDir,
      })
      const artifactService = new ArtifactService(artifactsDir, artifactStore)

      const forkSha = shaSchema.parse(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim(),
      )

      const projectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const now = new Date().toISOString()

      new ProjectStore(db).create(
        {
          id: projectId,
          name: 'Test Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: repoDir,
            defaultBranch: 'main',
            buildCommand: null,
            testCommand: null,
            tech: [],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      const taskId = taskIdSchema.parse(randomUUID())
      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Cancel test task',
              constraints: [],
              completionCriteria: [
                { kind: 'tests', description: 'the test suite passes', params: {} },
              ],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)

      workflowStore.start(
        {
          workflowId,
          projectId,
          taskId,
          templateId: 'test-template-abort',
          startedAt: now,
        },
        'user',
      )

      const graphRunId = randomUUID()
      new RunStore(db).createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: now,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const gateNode = makeNode('gate', {
        type: 'user_gate',
        runtimeType: 'human',
      })

      const template: WorkflowTemplateV2 = {
        id: 'test-template-abort',
        name: 'Abort Template',
        description: 'Test template for AbortSignal cancellation',
        version: 1,
        status: 'published',
        category: 'Test',
        nodes: [gateNode],
        edges: [],
        createdAt: now,
        updatedAt: now,
      }

      const registry = new RuntimeRegistry()
      // Production executor without test seam
      const leafExecutor = createLeafRunner({ registry })

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        decisionStore,
        executeLeafNode: leafExecutor,
      })

      const controller = new AbortController()
      controller.abort()

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        signal: controller.signal,
      })

      expect(run.status).toBe('cancelled')
      const runInDb = workflowStore.getGraphRun(graphRunId)
      expect(runInDb?.status).toBe('cancelled')
    } finally {
      closeDb()
      for (const dir of dirsToCleanup) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  })

  it('19. Provider-neutrality boundary check: LeafRunner source contains no provider literals (Axiom A6)', () => {
    const sourceCode = readFileSync(join(__dirname, 'leafRunner.ts'), 'utf8')
    const forbiddenProviders = ['claude', 'antigravity', 'gemini', 'openai']

    for (const provider of forbiddenProviders) {
      const regex = new RegExp(`\\b${provider}\\b`, 'i')
      expect(regex.test(sourceCode)).toBe(false)
    }
  })

  it('20. GraphExecutor integration: verification node declaring required evidence output fails closed when zero evidence artifacts are produced (no placeholder fabrication)', async () => {
    const dirsToCleanup: string[] = []
    const { db, close: closeDb } = initialiseDatabase(':memory:')

    try {
      const repoDir = mkdtempSync(join(tmpdir(), 'forge-no-ev-repo-'))
      dirsToCleanup.push(repoDir)
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.email', 'forge@test.local'], { cwd: repoDir })
      writeFileSync(join(repoDir, 'README.md'), '# Test Repo\n')
      execFileSync('git', ['add', '.'], { cwd: repoDir })
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })

      const worktreeParentDir = mkdtempSync(join(tmpdir(), 'forge-no-ev-wt-'))
      dirsToCleanup.push(worktreeParentDir)
      const artifactsDir = mkdtempSync(join(tmpdir(), 'forge-no-ev-art-'))
      dirsToCleanup.push(artifactsDir)

      const eventStore = new EventStore(db)
      const workflowStore = new WorkflowStore(db)
      const artifactStore = new ArtifactStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const worktreeService = new WorktreeService({
        repositoryPath: repoDir,
        root: worktreeParentDir,
      })
      const artifactService = new ArtifactService(artifactsDir, artifactStore)

      const forkSha = shaSchema.parse(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim(),
      )

      const projectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const now = new Date().toISOString()

      const projectStore = new ProjectStore(db)
      projectStore.create(
        {
          id: projectId,
          name: 'Test Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: repoDir,
            defaultBranch: 'main',
            buildCommand: 'npm run build',
            testCommand: 'npm test',
            tech: [],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      const taskId = taskIdSchema.parse(randomUUID())
      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Verify task',
              constraints: [],
              completionCriteria: [
                { kind: 'tests', description: 'the test suite passes', params: {} },
              ],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)

      workflowStore.start(
        {
          workflowId,
          projectId,
          taskId,
          templateId: 'test-template-no-ev',
          startedAt: now,
        },
        'user',
      )

      const graphRunId = randomUUID()
      new RunStore(db).createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: now,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      // Verification node declares required 'verification_report'
      const verifierNode = makeNode('verifier', {
        type: 'verification',
        runtimeType: 'forge-engine',
        outputs: [
          {
            name: 'verification_report',
            kind: 'stage-output',
            format: 'text',
            required: true,
            requiredSections: [],
          },
        ],
      })

      const template: WorkflowTemplateV2 = {
        id: 'test-template-no-ev',
        name: 'No Evidence Template',
        description: 'Template with verifier requiring evidence',
        version: 1,
        status: 'published',
        category: 'Test',
        nodes: [verifierNode],
        edges: [],
        createdAt: now,
        updatedAt: now,
      }

      // verifyFn returns passed: true, but artifacts: [] (no evidence produced)
      const verifyFn = vi.fn().mockResolvedValue({
        passed: true,
        findings: [],
        falseClaims: [],
        detail: 'clean',
        criteria: [],
        artifacts: [],
      })

      const registry = new RuntimeRegistry()
      const leafExecutor = createLeafRunner({ registry, verifyFn })

      const executor = new GraphExecutor({
        workflowStore,
        projectStore,
        worktreeService,
        artifactService,
        decisionStore,
        executeLeafNode: leafExecutor,
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      // GraphExecutor detects missing required output and fails the node attempt closed!
      // Axiom A3: No placeholder artifacts are fabricated to bypass required output checks.
      expect(run.status).toBe('failed')
      expect(run.failedNodeIds).toContain('verifier')

      const attempts = workflowStore.getNodeAttempts(graphRunId, 'verifier')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.status).toBe('failed')
      expect(attempts[0]?.error).toContain('missing required output(s): verification_report')
    } finally {
      closeDb()
      for (const dir of dirsToCleanup) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  })

  it('21. GraphExecutor integration: explicit verdict artifact cannot satisfy required evidence report output when evidence is missing', async () => {
    const dirsToCleanup: string[] = []
    const { db, close: closeDb } = initialiseDatabase(':memory:')

    try {
      const repoDir = mkdtempSync(join(tmpdir(), 'forge-verdict-not-ev-repo-'))
      dirsToCleanup.push(repoDir)
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.email', 'forge@test.local'], { cwd: repoDir })
      writeFileSync(join(repoDir, 'README.md'), '# Test Repo\n')
      execFileSync('git', ['add', '.'], { cwd: repoDir })
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })

      const worktreeParentDir = mkdtempSync(join(tmpdir(), 'forge-verdict-not-ev-wt-'))
      dirsToCleanup.push(worktreeParentDir)
      const artifactsDir = mkdtempSync(join(tmpdir(), 'forge-verdict-not-ev-art-'))
      dirsToCleanup.push(artifactsDir)

      const eventStore = new EventStore(db)
      const workflowStore = new WorkflowStore(db)
      const artifactStore = new ArtifactStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const worktreeService = new WorktreeService({
        repositoryPath: repoDir,
        root: worktreeParentDir,
      })
      const artifactService = new ArtifactService(artifactsDir, artifactStore)

      const forkSha = shaSchema.parse(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim(),
      )

      const projectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const now = new Date().toISOString()

      const projectStore = new ProjectStore(db)
      projectStore.create(
        {
          id: projectId,
          name: 'Test Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: repoDir,
            defaultBranch: 'main',
            buildCommand: 'npm run build',
            testCommand: 'npm test',
            tech: [],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      const taskId = taskIdSchema.parse(randomUUID())
      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Verify task',
              constraints: [],
              completionCriteria: [
                { kind: 'tests', description: 'the test suite passes', params: {} },
              ],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)

      workflowStore.start(
        {
          workflowId,
          projectId,
          taskId,
          templateId: 'test-template-verdict-not-ev',
          startedAt: now,
        },
        'user',
      )

      const graphRunId = randomUUID()
      new RunStore(db).createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: now,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      // Verification node declares BOTH an explicit verdict output AND a required evidence report output
      const verifierNode = makeNode('verifier', {
        type: 'verification',
        runtimeType: 'forge-engine',
        outputs: [
          {
            name: 'verdict',
            kind: 'stage-output',
            format: 'json',
            required: true,
            requiredSections: [],
          },
          {
            name: 'verification_report',
            kind: 'stage-output',
            format: 'text',
            required: true,
            requiredSections: [],
          },
        ],
      })

      const template: WorkflowTemplateV2 = {
        id: 'test-template-verdict-not-ev',
        name: 'Verdict Not Evidence Template',
        description: 'Template with verifier requiring both verdict and evidence',
        version: 1,
        status: 'published',
        category: 'Test',
        nodes: [verifierNode],
        edges: [],
        createdAt: now,
        updatedAt: now,
      }

      // verifyFn returns passed: true, verdict: 'pass', but artifacts: [] (no evidence produced)
      const verifyFn = vi.fn().mockResolvedValue({
        passed: true,
        verdict: 'pass',
        findings: [],
        falseClaims: [],
        detail: 'clean',
        criteria: [],
        artifacts: [],
      })

      const registry = new RuntimeRegistry()
      const leafExecutor = createLeafRunner({ registry, verifyFn })

      const executor = new GraphExecutor({
        workflowStore,
        projectStore,
        worktreeService,
        artifactService,
        decisionStore,
        executeLeafNode: leafExecutor,
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      // GraphExecutor detects missing required evidence output 'verification_report' and fails closed!
      // The emitted verdict artifact MUST NOT satisfy the required evidence output.
      expect(run.status).toBe('failed')
      expect(run.failedNodeIds).toContain('verifier')

      const attempts = workflowStore.getNodeAttempts(graphRunId, 'verifier')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.status).toBe('failed')
      expect(attempts[0]?.error).toContain('missing required output(s): verification_report')
    } finally {
      closeDb()
      for (const dir of dirsToCleanup) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  })
  it('22. verification execution: default verifier runs against real repository commands and evaluates task completionCriteria', async () => {
    const dirsToCleanup: string[] = []
    try {
      const repoDir = mkdtempSync(join(tmpdir(), 'forge-verify-real-'))
      dirsToCleanup.push(repoDir)
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.email', 'forge@test.local'], { cwd: repoDir })
      writeFileSync(join(repoDir, 'README.md'), '# Test Repo\n')
      execFileSync('git', ['add', '.'], { cwd: repoDir })
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })

      const registry = new RuntimeRegistry()
      // Default verifier (verifyFn not provided)
      const runner = new LeafRunner({ registry })

      const node = makeNode('verify-node', {
        type: 'verification',
        runtimeType: 'forge-engine',
        outputs: [
          {
            name: 'verification_report',
            kind: 'stage-output',
            format: 'text',
            required: true,
            requiredSections: [],
          },
        ],
      })

      const taskId = taskIdSchema.parse(randomUUID())
      const task: Task = {
        id: taskId,
        objective: 'Pass test verification',
        constraints: [],
        completionCriteria: [{ kind: 'tests', description: 'the test suite passes', params: {} }],
        scope: { allowedPaths: [], forbiddenPaths: [] },
        lockedDecisionIds: [],
        correctsTaskId: null,
        createdAt: new Date().toISOString(),
      }

      writeFileSync(join(repoDir, 'test-pass.js'), 'console.log("tests passed")\nprocess.exit(0)\n')
      writeFileSync(
        join(repoDir, 'test-fail.js'),
        'console.error("tests failed")\nprocess.exit(1)\n',
      )

      // Case 1: command succeeds -> verifier evaluates criterion to pass
      const passRepo: Repository = {
        id: repositoryIdSchema.parse(randomUUID()),
        absolutePath: repoDir,
        defaultBranch: 'main',
        buildCommand: null,
        testCommand: 'node test-pass.js',
        tech: ['node'],
      }

      const passCtx = makeContext(node, {
        worktreePath: repoDir,
        task,
        repository: passRepo,
      })

      const passResult = await runner.execute(passCtx)
      expect(passResult.status).toBe('completed')
      expect(passResult.artifacts).toHaveLength(1)
      expect(passResult.artifacts![0]!.content).toContain('[Command:')
      expect(passResult.artifacts![0]!.content).toContain('[ExitCode: 0]')

      // Case 2: command fails -> verifier evaluates criterion to fail
      const failRepo: Repository = {
        id: repositoryIdSchema.parse(randomUUID()),
        absolutePath: repoDir,
        defaultBranch: 'main',
        buildCommand: null,
        testCommand: 'node test-fail.js',
        tech: ['node'],
      }

      const failCtx = makeContext(node, {
        worktreePath: repoDir,
        task,
        repository: failRepo,
      })

      const failResult = await runner.execute(failCtx)
      expect(failResult.status).toBe('failed')
      expect(failResult.error).toContain('Verification failed')
    } finally {
      for (const dir of dirsToCleanup) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  })

  it('23. verification configuration integrity: fails closed with actionable error when configuration is missing or invalid', async () => {
    const registry = new RuntimeRegistry()
    const runner = new LeafRunner({ registry })
    const node = makeNode('verify-node', {
      type: 'verification',
      runtimeType: 'forge-engine',
    })

    // 23a. Repository configuration unavailable
    const ctxNoRepo = makeContext(node, {
      worktreePath: '/tmp/worktree',
      repository: undefined,
    })
    const resNoRepo = await runner.execute(ctxNoRepo)
    expect(resNoRepo.status).toBe('failed')
    expect(resNoRepo.error).toContain(
      'Verification configuration unavailable: repository configuration for project',
    )

    // 23b. Task configuration unavailable
    const repoWithCommands: Repository = {
      id: repositoryIdSchema.parse(randomUUID()),
      absolutePath: '/tmp/repo',
      defaultBranch: 'main',
      buildCommand: 'npm run build',
      testCommand: 'npm test',
      tech: [],
    }
    const ctxNoTask = makeContext(node, {
      worktreePath: '/tmp/worktree',
      repository: repoWithCommands,
      task: undefined,
      taskId: undefined,
    })
    const resNoTask = await runner.execute(ctxNoTask)
    expect(resNoTask.status).toBe('failed')
    expect(resNoTask.error).toContain('Verification configuration unavailable: task for workflow')

    // 23c. Repository has neither buildCommand nor testCommand configured
    const repoNoCommands: Repository = {
      id: repositoryIdSchema.parse(randomUUID()),
      absolutePath: '/tmp/repo',
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: [],
    }
    const ctxNoCmds = makeContext(node, {
      worktreePath: '/tmp/worktree',
      repository: repoNoCommands,
    })
    const resNoCmds = await runner.execute(ctxNoCmds)
    expect(resNoCmds.status).toBe('failed')
    expect(resNoCmds.error).toContain(
      'Verification configuration error: repository has neither buildCommand nor testCommand configured',
    )
  })

  it('24. agent changeSet: builds ChangeSet with schema-valid UUID task.id and authoritative task scope', async () => {
    const dirsToCleanup: string[] = []
    try {
      const repoDir = mkdtempSync(join(tmpdir(), 'forge-agent-cs-valid-'))
      dirsToCleanup.push(repoDir)
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.email', 'forge@test.local'], { cwd: repoDir })
      mkdirSync(join(repoDir, 'src'), { recursive: true })
      writeFileSync(join(repoDir, 'src', 'index.ts'), '// initial\n')
      execFileSync('git', ['add', '.'], { cwd: repoDir })
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })
      const forkSha = shaSchema.parse(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim(),
      )

      writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const hello = "world"\n')

      const runtime = mockRuntime()
      const registry = new RuntimeRegistry()
      registry.register(runtime)

      const report: AgentReport = {
        status: 'completed',
        summary: 'Updated index.ts',
        filesChanged: ['src/index.ts'],
        commandsRun: [],
        testsRun: false,
        openQuestions: [],
        assumptions: [],
      }
      const exchangeFn = vi.fn().mockResolvedValue({
        ok: true,
        report,
        assessment: { status: 'completed' },
        retried: false,
        transcript: [],
      })

      const runner = new LeafRunner({
        registry,
        defaultRuntimeId: 'mock-runtime',
        exchangeFn,
        gitServiceFactory: (path: string) => new GitService({ repositoryPath: path }),
      })

      const node = makeNode('agent-node', {
        type: 'agent',
        config: { role: 'implementer', skills: [], permissionMode: 'developer' },
      })

      const expectedTaskId = taskIdSchema.parse(randomUUID())
      const task: Task = {
        id: expectedTaskId,
        objective: 'Implement feature',
        constraints: [],
        completionCriteria: [{ kind: 'tests', description: 'tests pass', params: {} }],
        scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
        lockedDecisionIds: [],
        correctsTaskId: null,
        createdAt: new Date().toISOString(),
      }

      const ctx = makeContext(node, {
        worktreePath: repoDir,
        forkSha,
        task,
        taskId: expectedTaskId,
      })

      const result = await runner.execute(ctx)
      expect(result.status).toBe('completed')
      expect(result.changeSet).toBeDefined()
      expect(result.changeSet?.taskId).toBe(expectedTaskId)
      expect(taskIdSchema.safeParse(result.changeSet?.taskId).success).toBe(true)
      expect(result.changeSet?.taskId).not.toBe('default-task')
    } finally {
      for (const dir of dirsToCleanup) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  })

  it('25. agent changeSet: in-scope modification completes successfully with staged changeSet', async () => {
    const dirsToCleanup: string[] = []
    try {
      const repoDir = mkdtempSync(join(tmpdir(), 'forge-agent-cs-inscope-'))
      dirsToCleanup.push(repoDir)
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.email', 'forge@test.local'], { cwd: repoDir })
      mkdirSync(join(repoDir, 'src'), { recursive: true })
      writeFileSync(join(repoDir, 'src', 'feature.ts'), '// feature\n')
      execFileSync('git', ['add', '.'], { cwd: repoDir })
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })
      const forkSha = shaSchema.parse(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim(),
      )

      writeFileSync(join(repoDir, 'src', 'feature.ts'), '// feature implemented\n')

      const runtime = mockRuntime()
      const registry = new RuntimeRegistry()
      registry.register(runtime)

      const report: AgentReport = {
        status: 'completed',
        summary: 'Implemented feature',
        filesChanged: ['src/feature.ts'],
        commandsRun: [],
        testsRun: false,
        openQuestions: [],
        assumptions: [],
      }
      const exchangeFn = vi.fn().mockResolvedValue({
        ok: true,
        report,
        assessment: { status: 'completed' },
        retried: false,
        transcript: [],
      })

      const runner = new LeafRunner({
        registry,
        defaultRuntimeId: 'mock-runtime',
        exchangeFn,
        gitServiceFactory: (path: string) => new GitService({ repositoryPath: path }),
      })

      const node = makeNode('agent-node', {
        type: 'agent',
        config: { role: 'implementer', skills: [], permissionMode: 'developer' },
      })

      const task: Task = {
        id: taskIdSchema.parse(randomUUID()),
        objective: 'In-scope task',
        constraints: [],
        completionCriteria: [{ kind: 'tests', description: 'tests pass', params: {} }],
        scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
        lockedDecisionIds: [],
        correctsTaskId: null,
        createdAt: new Date().toISOString(),
      }

      const ctx = makeContext(node, {
        worktreePath: repoDir,
        forkSha,
        task,
      })

      const result = await runner.execute(ctx)
      expect(result.status).toBe('completed')
      expect(result.changeSet).toBeDefined()
      expect(result.changeSet?.files).toHaveLength(1)
      expect(result.changeSet?.files[0]?.path).toBe('src/feature.ts')
      expect(result.changeSet?.patch).toContain('feature implemented')
    } finally {
      for (const dir of dirsToCleanup) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  })

  it('26. agent changeSet scope enforcement: out-of-scope modification fails closed with policy violation error', async () => {
    const dirsToCleanup: string[] = []
    try {
      const repoDir = mkdtempSync(join(tmpdir(), 'forge-agent-cs-scope-'))
      dirsToCleanup.push(repoDir)
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.email', 'forge@test.local'], { cwd: repoDir })
      mkdirSync(join(repoDir, 'src'), { recursive: true })
      writeFileSync(join(repoDir, 'src', 'index.ts'), '// initial\n')
      writeFileSync(join(repoDir, 'config.json'), '{"auth": true}\n')
      execFileSync('git', ['add', '.'], { cwd: repoDir })
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })
      const forkSha = shaSchema.parse(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim(),
      )

      writeFileSync(join(repoDir, 'config.json'), '{"auth": false}\n')

      const runtime = mockRuntime()
      const registry = new RuntimeRegistry()
      registry.register(runtime)

      const report: AgentReport = {
        status: 'completed',
        summary: 'Modified config',
        filesChanged: ['config.json'],
        commandsRun: [],
        testsRun: false,
        openQuestions: [],
        assumptions: [],
      }
      const exchangeFn = vi.fn().mockResolvedValue({
        ok: true,
        report,
        assessment: { status: 'completed' },
        retried: false,
        transcript: [],
      })

      const runner = new LeafRunner({
        registry,
        defaultRuntimeId: 'mock-runtime',
        exchangeFn,
        gitServiceFactory: (path: string) => new GitService({ repositoryPath: path }),
      })

      const node = makeNode('agent-node', {
        type: 'agent',
        config: { role: 'implementer', skills: [], permissionMode: 'developer' },
      })

      const task: Task = {
        id: taskIdSchema.parse(randomUUID()),
        objective: 'Scoped feature',
        constraints: [],
        completionCriteria: [{ kind: 'tests', description: 'tests pass', params: {} }],
        scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
        lockedDecisionIds: [],
        correctsTaskId: null,
        createdAt: new Date().toISOString(),
      }

      const ctx = makeContext(node, {
        worktreePath: repoDir,
        forkSha,
        task,
      })

      const result = await runner.execute(ctx)
      expect(result.status).toBe('failed')
      expect(result.error).toContain(
        'Policy violation: 1 file(s) modified outside scope (config.json)',
      )
      expect(result.changeSet).toBeDefined()
    } finally {
      for (const dir of dirsToCleanup) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  })

  it('27. agent changeSet discrepancy preservation: claimed-vs-actual discrepancy is preserved on changeSet without failing if in-scope', async () => {
    const dirsToCleanup: string[] = []
    try {
      const repoDir = mkdtempSync(join(tmpdir(), 'forge-agent-cs-discrepancy-'))
      dirsToCleanup.push(repoDir)
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.email', 'forge@test.local'], { cwd: repoDir })
      mkdirSync(join(repoDir, 'src'), { recursive: true })
      writeFileSync(join(repoDir, 'src', 'a.ts'), '// a\n')
      writeFileSync(join(repoDir, 'src', 'b.ts'), '// b\n')
      execFileSync('git', ['add', '.'], { cwd: repoDir })
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })
      const forkSha = shaSchema.parse(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim(),
      )

      writeFileSync(join(repoDir, 'src', 'b.ts'), '// modified b\n')

      const runtime = mockRuntime()
      const registry = new RuntimeRegistry()
      registry.register(runtime)

      const report: AgentReport = {
        status: 'completed',
        summary: 'Claimed to modify a.ts',
        filesChanged: ['src/a.ts'],
        commandsRun: [],
        testsRun: false,
        openQuestions: [],
        assumptions: [],
      }
      const exchangeFn = vi.fn().mockResolvedValue({
        ok: true,
        report,
        assessment: { status: 'completed' },
        retried: false,
        transcript: [],
      })

      const runner = new LeafRunner({
        registry,
        defaultRuntimeId: 'mock-runtime',
        exchangeFn,
        gitServiceFactory: (path: string) => new GitService({ repositoryPath: path }),
      })

      const node = makeNode('agent-node', {
        type: 'agent',
        config: { role: 'implementer', skills: [], permissionMode: 'developer' },
      })

      const task: Task = {
        id: taskIdSchema.parse(randomUUID()),
        objective: 'Scoped task',
        constraints: [],
        completionCriteria: [{ kind: 'tests', description: 'tests pass', params: {} }],
        scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
        lockedDecisionIds: [],
        correctsTaskId: null,
        createdAt: new Date().toISOString(),
      }

      const ctx = makeContext(node, {
        worktreePath: repoDir,
        forkSha,
        task,
      })

      const result = await runner.execute(ctx)
      expect(result.status).toBe('completed')
      expect(result.changeSet).toBeDefined()
      expect(result.changeSet?.discrepancies.length).toBeGreaterThan(0)
    } finally {
      for (const dir of dirsToCleanup) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  })

  it('28. agent changeSet task availability: fails closed when authoritative task is unavailable', async () => {
    const runtime = mockRuntime()
    const registry = new RuntimeRegistry()
    registry.register(runtime)

    const report: AgentReport = {
      status: 'completed',
      summary: 'Done',
      filesChanged: ['src/index.ts'],
      commandsRun: [],
      testsRun: false,
      openQuestions: [],
      assumptions: [],
    }
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report,
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
      gitServiceFactory: (path: string) => new GitService({ repositoryPath: path }),
    })

    const node = makeNode('agent-node', {
      type: 'agent',
      config: { role: 'implementer', skills: [], permissionMode: 'developer' },
    })

    const ctx = makeContext(node, {
      worktreePath: '/mock/path',
      task: undefined,
      taskId: undefined,
    })

    const result = await runner.execute(ctx)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('cannot build changeset: authoritative task is unavailable')
  })

  it('28b. agent changeSet reconciliation availability: writable agent fails closed when gitServiceFactory is missing', async () => {
    const runtime = mockRuntime()
    const registry = new RuntimeRegistry()
    registry.register(runtime)

    const report: AgentReport = {
      status: 'completed',
      summary: 'Done',
      filesChanged: ['src/a.ts'],
      commandsRun: [],
      testsRun: false,
      openQuestions: [],
      assumptions: [],
    }
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report,
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    // gitServiceFactory omitted on purpose
    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
    })

    const node = makeNode('agent-node', {
      type: 'agent',
      config: { role: 'implementer', skills: [], permissionMode: 'developer' },
    })

    const ctx = makeContext(node, {
      worktreePath: '/mock/worktree',
    })

    const result = await runner.execute(ctx)
    expect(result.status).toBe('failed')
    expect(result.error).toContain(
      'cannot build changeset: Git service factory is required for writable execution with worktree',
    )
  })

  it('28c. agent changeSet reconciliation failure: writable agent fails closed when reconciliation throws an error', async () => {
    const runtime = mockRuntime()
    const registry = new RuntimeRegistry()
    registry.register(runtime)

    const report: AgentReport = {
      status: 'completed',
      summary: 'Done',
      filesChanged: ['src/a.ts'],
      commandsRun: [],
      testsRun: false,
      openQuestions: [],
      assumptions: [],
    }
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report,
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const mockGit = {
      diffWorktree: vi.fn().mockRejectedValue(new Error('git diff failed')),
    } as unknown as GitService

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
      gitServiceFactory: () => mockGit,
    })

    const node = makeNode('agent-node', {
      type: 'agent',
      config: { role: 'implementer', skills: [], permissionMode: 'developer' },
    })

    const ctx = makeContext(node, {
      worktreePath: '/mock/worktree',
    })

    const result = await runner.execute(ctx)
    expect(result.status).toBe('failed')
    expect(result.error).toContain('failed to capture or reconcile changeset: git diff failed')
  })

  it('28d. read-only agent execution: read-only agent with worktree fails closed when gitServiceFactory is missing', async () => {
    const runtime = mockRuntime()
    const registry = new RuntimeRegistry()
    registry.register(runtime)

    const report: AgentReport = {
      status: 'completed',
      summary: 'Inspected files',
      filesChanged: [],
      commandsRun: [],
      testsRun: false,
      openQuestions: [],
      assumptions: [],
    }
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report,
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
    })

    const node = makeNode('read-only-agent', {
      type: 'agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
    })

    const ctx = makeContext(node, {
      worktreePath: '/mock/worktree',
      forkSha: '0123456789abcdef0123456789abcdef01234567',
    })

    const result = await runner.execute(ctx)
    expect(result.status).toBe('failed')
    expect(result.error).toContain(
      'cannot enforce read-only policy: Git service factory is required for execution with worktree',
    )
  })

  it('28e. read-only agent execution: read-only agent without worktree completes successfully without gitServiceFactory or changeSet reconciliation', async () => {
    const runtime = mockRuntime()
    const registry = new RuntimeRegistry()
    registry.register(runtime)

    const report: AgentReport = {
      status: 'completed',
      summary: 'Inspected files',
      filesChanged: [],
      commandsRun: [],
      testsRun: false,
      openQuestions: [],
      assumptions: [],
    }
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report,
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
    })

    const node = makeNode('read-only-agent', {
      type: 'agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
    })

    const ctx = makeContext(node, {
      worktreePath: undefined,
    })

    const result = await runner.execute(ctx)
    expect(result.status).toBe('completed')
    expect(result.changeSet).toBeUndefined()
  })

  it('28f. read-only agent execution: read-only agent with worktree and clean diff completes successfully without changeSet reconciliation', async () => {
    const runtime = mockRuntime()
    const registry = new RuntimeRegistry()
    registry.register(runtime)

    const report: AgentReport = {
      status: 'completed',
      summary: 'Inspected files',
      filesChanged: [],
      commandsRun: [],
      testsRun: false,
      openQuestions: [],
      assumptions: [],
    }
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report,
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const mockGit = {
      diffWorktree: vi.fn().mockResolvedValue({ files: [], patch: '' }),
    } as unknown as GitService

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
      gitServiceFactory: () => mockGit,
    })

    const node = makeNode('read-only-agent', {
      type: 'agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
    })

    const ctx = makeContext(node, {
      worktreePath: '/mock/worktree',
      forkSha: '0123456789abcdef0123456789abcdef01234567',
    })

    const result = await runner.execute(ctx)
    expect(result.status).toBe('completed')
    expect(result.changeSet).toBeUndefined()
    expect(mockGit.diffWorktree).toHaveBeenCalledWith('0123456789abcdef0123456789abcdef01234567')
  })

  it('29. test-seam elimination: production LeafRunner contains no approval bypass and strictly fails closed against caller-supplied context', async () => {
    const registry = new RuntimeRegistry()
    const leafExecutor = createLeafRunner({ registry })

    const node = makeNode('gate-node', {
      type: 'user_gate',
      runtimeType: 'human',
      outputs: [
        {
          name: 'approved',
          kind: 'stage-output',
          format: 'json',
          required: true,
          requiredSections: [],
        },
      ],
    })

    // Untrusted approval in initialContext
    const ctxApproval = makeContext(node, {
      initialContext: { approval: 'approved' },
    })
    const resApproval = await leafExecutor(ctxApproval)
    expect(resApproval.status).toBe('blocked')
    expect(resApproval.resumable).toBe(true)
    expect(resApproval.error).toContain('cannot be decided by untrusted context input')

    // Untrusted rejection in initialContext
    const ctxRejection = makeContext(node, {
      initialContext: { approval: 'rejected' },
    })
    const resRejection = await leafExecutor(ctxRejection)
    expect(resRejection.status).toBe('blocked')
    expect(resRejection.resumable).toBe(true)
    expect(resRejection.error).toContain('cannot be decided by untrusted context input')
  })

  it('30. verification evidence mapping: test evidence is never relabeled as an unrelated required output (e.g. lint_report) and fails closed in GraphExecutor', async () => {
    const dirsToCleanup: string[] = []
    const { db, close: closeDb } = initialiseDatabase(':memory:')

    try {
      const repoDir = mkdtempSync(join(tmpdir(), 'forge-verify-lint-mismatch-repo-'))
      dirsToCleanup.push(repoDir)
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.email', 'forge@test.local'], { cwd: repoDir })
      writeFileSync(join(repoDir, 'README.md'), '# Test Repo\n')
      execFileSync('git', ['add', '.'], { cwd: repoDir })
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })

      const worktreeParentDir = mkdtempSync(join(tmpdir(), 'forge-verify-lint-mismatch-wt-'))
      dirsToCleanup.push(worktreeParentDir)
      const artifactsDir = mkdtempSync(join(tmpdir(), 'forge-verify-lint-mismatch-art-'))
      dirsToCleanup.push(artifactsDir)

      const eventStore = new EventStore(db)
      const workflowStore = new WorkflowStore(db)
      const artifactStore = new ArtifactStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const worktreeService = new WorktreeService({
        repositoryPath: repoDir,
        root: worktreeParentDir,
      })
      const artifactService = new ArtifactService(artifactsDir, artifactStore)

      const forkSha = shaSchema.parse(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim(),
      )

      const projectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const now = new Date().toISOString()

      const projectStore = new ProjectStore(db)
      projectStore.create(
        {
          id: projectId,
          name: 'Test Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: repoDir,
            defaultBranch: 'main',
            buildCommand: null,
            testCommand: 'npm test',
            tech: [],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      const taskId = taskIdSchema.parse(randomUUID())
      const task: Task = {
        id: taskId,
        objective: 'Verify strict output mapping',
        constraints: [],
        completionCriteria: [{ kind: 'tests', description: 'tests pass', params: {} }],
        scope: { allowedPaths: [], forbiddenPaths: [] },
        lockedDecisionIds: [],
        correctsTaskId: null,
        createdAt: now,
      }
      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: { task },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)

      workflowStore.start(
        {
          workflowId,
          projectId,
          taskId,
          templateId: 'test-template-mismatch',
          startedAt: now,
        },
        'user',
      )

      const graphRunId = randomUUID()
      new RunStore(db).createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: now,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      // Verifier declares required 'lint_report' output
      const verifierNode = makeNode('verifier', {
        type: 'verification',
        runtimeType: 'forge-engine',
        outputs: [
          {
            name: 'lint_report',
            kind: 'stage-output',
            format: 'text',
            required: true,
            requiredSections: [],
          },
        ],
      })

      const template: WorkflowTemplateV2 = {
        id: 'test-template-mismatch',
        name: 'Mismatch Template',
        description: 'Template with mismatched evidence kind',
        version: 1,
        status: 'published',
        category: 'Test',
        nodes: [verifierNode],
        edges: [],
        createdAt: now,
        updatedAt: now,
      }

      // verifyFn returns only a 'tests' evidence artifact (no lint was executed)
      const verifyFn = vi.fn().mockResolvedValue({
        passed: true,
        verdict: 'pass',
        findings: [],
        falseClaims: [],
        detail: 'tests passed',
        criteria: [],
        artifacts: [
          {
            id: 'ev-test-1',
            workflowId,
            stepId: stepIdSchema.parse(randomUUID()),
            kind: 'tests',
            command: 'npm test',
            cwd: repoDir,
            outcome: 'completed',
            exitCode: 0,
            durationMs: 45,
            stdout: 'PASS all tests',
            stderr: '',
            truncated: false,
            counts: { total: 5, passed: 5, failed: 0, skipped: 0 },
            failure: null,
            recordedAt: now,
          },
        ],
      })

      const registry = new RuntimeRegistry()
      const leafExecutor = createLeafRunner({ registry, verifyFn })

      // First: direct LeafRunner execution test
      const directCtx = makeContext(verifierNode, { worktreePath: repoDir, task, workflowId })
      const directResult = await leafExecutor(directCtx)
      expect(directResult.status).toBe('completed')
      expect(directResult.artifacts).toHaveLength(1)
      // Genuine evidence is preserved with its own kind 'tests', NOT relabeled as 'stage-output' or named 'lint_report'
      expect(directResult.artifacts![0]!.kind).toBe('tests')
      expect(directResult.artifacts![0]!.title).toContain('tests evidence')
      expect(directResult.artifacts![0]!.metadata.outputName).toBeUndefined()

      // Second: GraphExecutor execution test — fails closed because required lint_report was not satisfied
      const executor = new GraphExecutor({
        workflowStore,
        projectStore,
        worktreeService,
        artifactService,
        decisionStore,
        executeLeafNode: leafExecutor,
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('failed')
      expect(run.failedNodeIds).toEqual(['verifier'])
      const attempts = workflowStore.getNodeAttempts(graphRunId, 'verifier')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.status).toBe('failed')
      expect(attempts[0]?.error).toContain('missing required output(s): lint_report')
    } finally {
      closeDb()
      for (const dir of dirsToCleanup) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  })

  it('31. verification evidence mapping: test evidence is never relabeled as build evidence and fails closed when build evidence is missing', async () => {
    const dirsToCleanup: string[] = []
    const { db, close: closeDb } = initialiseDatabase(':memory:')

    try {
      const repoDir = mkdtempSync(join(tmpdir(), 'forge-verify-build-mismatch-repo-'))
      dirsToCleanup.push(repoDir)
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.email', 'forge@test.local'], { cwd: repoDir })
      writeFileSync(join(repoDir, 'README.md'), '# Test Repo\n')
      execFileSync('git', ['add', '.'], { cwd: repoDir })
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })

      const worktreeParentDir = mkdtempSync(join(tmpdir(), 'forge-verify-build-mismatch-wt-'))
      dirsToCleanup.push(worktreeParentDir)
      const artifactsDir = mkdtempSync(join(tmpdir(), 'forge-verify-build-mismatch-art-'))
      dirsToCleanup.push(artifactsDir)

      const eventStore = new EventStore(db)
      const workflowStore = new WorkflowStore(db)
      const artifactStore = new ArtifactStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const worktreeService = new WorktreeService({
        repositoryPath: repoDir,
        root: worktreeParentDir,
      })
      const artifactService = new ArtifactService(artifactsDir, artifactStore)

      const forkSha = shaSchema.parse(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim(),
      )

      const projectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const now = new Date().toISOString()

      const projectStore = new ProjectStore(db)
      projectStore.create(
        {
          id: projectId,
          name: 'Test Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: repoDir,
            defaultBranch: 'main',
            buildCommand: 'npm run build',
            testCommand: 'npm test',
            tech: [],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      const taskId = taskIdSchema.parse(randomUUID())
      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Verify build evidence mismatch',
              constraints: [],
              completionCriteria: [{ kind: 'build', description: 'build succeeds', params: {} }],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)

      workflowStore.start(
        {
          workflowId,
          projectId,
          taskId,
          templateId: 'test-template-build-mismatch',
          startedAt: now,
        },
        'user',
      )

      const graphRunId = randomUUID()
      new RunStore(db).createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: now,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      // Verifier declares required 'build_evidence' output
      const verifierNode = makeNode('verifier', {
        type: 'verification',
        runtimeType: 'forge-engine',
        outputs: [
          {
            name: 'build_evidence',
            kind: 'stage-output',
            format: 'text',
            required: true,
            requiredSections: [],
          },
        ],
      })

      const template: WorkflowTemplateV2 = {
        id: 'test-template-build-mismatch',
        name: 'Build Mismatch Template',
        description: 'Template with verifier requiring build evidence',
        version: 1,
        status: 'published',
        category: 'Test',
        nodes: [verifierNode],
        edges: [],
        createdAt: now,
        updatedAt: now,
      }

      // verifyFn returns only a 'tests' artifact (no build was executed)
      const verifyFn = vi.fn().mockResolvedValue({
        passed: true,
        verdict: 'pass',
        findings: [],
        falseClaims: [],
        detail: 'only tests ran',
        criteria: [],
        artifacts: [
          {
            id: 'ev-test-only',
            workflowId,
            stepId: stepIdSchema.parse(randomUUID()),
            kind: 'tests',
            command: 'npm test',
            cwd: repoDir,
            outcome: 'completed',
            exitCode: 0,
            durationMs: 30,
            stdout: 'PASS tests',
            stderr: '',
            truncated: false,
            counts: { total: 2, passed: 2, failed: 0, skipped: 0 },
            failure: null,
            recordedAt: now,
          },
        ],
      })

      const registry = new RuntimeRegistry()
      const leafExecutor = createLeafRunner({ registry, verifyFn })

      const executor = new GraphExecutor({
        workflowStore,
        projectStore,
        worktreeService,
        artifactService,
        decisionStore,
        executeLeafNode: leafExecutor,
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('failed')
      expect(run.failedNodeIds).toEqual(['verifier'])
      const attempts = workflowStore.getNodeAttempts(graphRunId, 'verifier')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.status).toBe('failed')
      expect(attempts[0]?.error).toContain('missing required output(s): build_evidence')
    } finally {
      closeDb()
      for (const dir of dirsToCleanup) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  })

  it('32. verification evidence mapping: multi-evidence verification cleanly maps distinct artifacts to compatible declared outputs', async () => {
    const dirsToCleanup: string[] = []
    const { db, close: closeDb } = initialiseDatabase(':memory:')

    try {
      const repoDir = mkdtempSync(join(tmpdir(), 'forge-verify-multi-repo-'))
      dirsToCleanup.push(repoDir)
      execFileSync('git', ['init', '-b', 'main'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoDir })
      execFileSync('git', ['config', 'user.email', 'forge@test.local'], { cwd: repoDir })
      writeFileSync(join(repoDir, 'README.md'), '# Test Repo\n')
      execFileSync('git', ['add', '.'], { cwd: repoDir })
      execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })

      const worktreeParentDir = mkdtempSync(join(tmpdir(), 'forge-verify-multi-wt-'))
      dirsToCleanup.push(worktreeParentDir)
      const artifactsDir = mkdtempSync(join(tmpdir(), 'forge-verify-multi-art-'))
      dirsToCleanup.push(artifactsDir)

      const eventStore = new EventStore(db)
      const workflowStore = new WorkflowStore(db)
      const artifactStore = new ArtifactStore(db)
      const decisionStore = new DecisionStore(db, eventStore)
      const worktreeService = new WorktreeService({
        repositoryPath: repoDir,
        root: worktreeParentDir,
      })
      const artifactService = new ArtifactService(artifactsDir, artifactStore)

      const forkSha = shaSchema.parse(
        execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim(),
      )

      const projectId = projectIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const now = new Date().toISOString()

      const projectStore = new ProjectStore(db)
      projectStore.create(
        {
          id: projectId,
          name: 'Test Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: repoDir,
            defaultBranch: 'main',
            buildCommand: 'npm run build',
            testCommand: 'npm test',
            tech: ['typescript'],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      const taskId = taskIdSchema.parse(randomUUID())
      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Verify multi-output contract',
              constraints: [],
              completionCriteria: [
                { kind: 'build', description: 'build passes', params: {} },
                { kind: 'tests', description: 'tests pass', params: {} },
              ],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)

      workflowStore.start(
        {
          workflowId,
          projectId,
          taskId,
          templateId: 'test-template-multi',
          startedAt: now,
        },
        'user',
      )

      const graphRunId = randomUUID()
      new RunStore(db).createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: now,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const verifierNode = makeNode('verifier', {
        type: 'verification',
        runtimeType: 'forge-engine',
        outputs: [
          {
            name: 'build_evidence',
            kind: 'stage-output',
            format: 'text',
            required: true,
            requiredSections: [],
          },
          {
            name: 'test_evidence',
            kind: 'stage-output',
            format: 'text',
            required: true,
            requiredSections: [],
          },
          {
            name: 'verdict',
            kind: 'stage-output',
            format: 'json',
            required: true,
            requiredSections: [],
          },
        ],
      })

      const template: WorkflowTemplateV2 = {
        id: 'test-template-multi',
        name: 'Multi Evidence Template',
        description: 'Template with verifier requiring build, test, and verdict',
        version: 1,
        status: 'published',
        category: 'Test',
        nodes: [verifierNode],
        edges: [],
        createdAt: now,
        updatedAt: now,
      }

      const verifyFn = vi.fn().mockResolvedValue({
        passed: true,
        verdict: 'pass',
        findings: [],
        falseClaims: [],
        detail: 'all build and tests clean',
        criteria: [],
        artifacts: [
          {
            id: 'ev-build-1',
            workflowId,
            stepId: stepIdSchema.parse(randomUUID()),
            kind: 'build',
            command: 'npm run build',
            cwd: repoDir,
            outcome: 'completed',
            exitCode: 0,
            durationMs: 120,
            stdout: 'Build success',
            stderr: '',
            truncated: false,
            counts: null,
            failure: null,
            recordedAt: now,
          },
          {
            id: 'ev-test-1',
            workflowId,
            stepId: stepIdSchema.parse(randomUUID()),
            kind: 'tests',
            command: 'npm test',
            cwd: repoDir,
            outcome: 'completed',
            exitCode: 0,
            durationMs: 80,
            stdout: 'PASS test suite',
            stderr: '',
            truncated: false,
            counts: { total: 10, passed: 10, failed: 0, skipped: 0 },
            failure: null,
            recordedAt: now,
          },
        ],
      })

      const registry = new RuntimeRegistry()
      const leafExecutor = createLeafRunner({ registry, verifyFn })

      const executor = new GraphExecutor({
        workflowStore,
        projectStore,
        worktreeService,
        artifactService,
        decisionStore,
        executeLeafNode: leafExecutor,
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('completed')
      expect(run.completedNodeIds).toContain('verifier')
      expect(run.artifacts).toHaveLength(3)

      const buildArt = run.artifacts.find((a) => a.metadata.outputName === 'build_evidence')
      const testArt = run.artifacts.find((a) => a.metadata.outputName === 'test_evidence')
      const verdictArt = run.artifacts.find((a) => a.metadata.outputName === 'verdict')

      expect(buildArt).toBeDefined()
      expect(buildArt?.content).toContain('Build success')
      expect(testArt).toBeDefined()
      expect(testArt?.content).toContain('PASS test suite')
      expect(verdictArt).toBeDefined()
      expect(verdictArt?.kind).toBe('stage-output')
    } finally {
      closeDb()
      for (const dir of dirsToCleanup) {
        try {
          rmSync(dir, { recursive: true, force: true })
        } catch {
          // ignore
        }
      }
    }
  })
})
