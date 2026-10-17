/* eslint-disable @typescript-eslint/unbound-method */
import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
  type RuntimeId,
  type WorkflowNode,
  type WorkflowTemplateV2,
} from '@shared/domain'
import { ArtifactService } from '../artifacts/artifactService'
import { initialiseDatabase } from '../db'
import { ArtifactStore } from '../db/artifactStore'
import { DecisionStore } from '../db/decisionStore'
import { EventStore } from '../db/eventStore'
import { ProjectStore } from '../db/projectStore'
import { applyEvent } from '../db/projections'
import { RunStore } from '../db/runStore'
import { WorkflowStore } from '../db/workflowStore'
import { WorktreeService } from '../git'
import { RuntimeRegistry } from '../runtimes/registry'
import { GraphExecutor } from './graphExecutor'
import { LeafRunner, createLeafRunner } from './leafRunner'
import type { NodeExecutionContext } from './graphExecutor'

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
  return {
    graphRunId: randomUUID(),
    workflowId: workflowIdSchema.parse(randomUUID()),
    projectId: projectIdSchema.parse(randomUUID()),
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

  it('13. user_gate regression: explicit approval in initialContext unblocks and emits declared output artifacts', async () => {
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

    // 1. General explicit approval signal
    const ctxGeneral = makeContext(node, {
      attempt: 2,
      initialContext: { approval: 'approved' },
    })

    const resultGeneral = await runner.execute(ctxGeneral)
    expect(resultGeneral.status).toBe('completed')
    expect(resultGeneral.artifacts).toHaveLength(1)
    expect(resultGeneral.artifacts?.[0]?.kind).toBe('stage-output')
    const parsedGeneral = JSON.parse(resultGeneral.artifacts?.[0]?.content ?? '{}') as {
      approved: boolean
    }
    expect(parsedGeneral.approved).toBe(true)

    // 2. Node-scoped explicit approval signal ('gate-1.approval': 'approved')
    const ctxScoped = makeContext(node, {
      attempt: 2,
      initialContext: { 'gate-1.approval': 'approved' },
    })
    const resultScoped = await runner.execute(ctxScoped)
    expect(resultScoped.status).toBe('completed')
  })

  it('14. user_gate regression: explicit rejection in initialContext returns cancelled', async () => {
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

    expect(result.status).toBe('cancelled')
    expect(result.error).toBe('User declined approval')

    // Also verify node-scoped rejection ('gate-1.approval': 'rejected')
    const ctxScoped = makeContext(node, {
      attempt: 2,
      initialContext: { 'gate-1.approval': 'rejected' },
    })
    const resultScoped = await runner.execute(ctxScoped)
    expect(resultScoped.status).toBe('cancelled')
    expect(resultScoped.error).toBe('User declined approval')
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

  it('17. GraphExecutor integration: agent -> user_gate -> verification pipeline with repeated recovery and explicit approval', async () => {
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

      // Step 4: Run 3 - Resume WITH explicit approval signal: gate completes, verifier completes
      const run3 = await executor2.run({
        graphRunId: run1.graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        resumeNodeIds: ['gate'],
        initialContext: { approval: 'approved' },
      })

      expect(run3.status).toBe('completed')
      expect(run3.completedNodeIds).toContain('planner')
      expect(run3.completedNodeIds).toContain('gate')
      expect(run3.completedNodeIds).toContain('verifier')
      expect(run3.blockedNodeIds).toHaveLength(0)

      // Invariant 9 check: planner was NOT re-executed (remains 1)
      expect(plannerExecutions).toBe(1)

      const finalGateAttempts = workflowStore.getNodeAttempts(run1.graphRunId, 'gate')
      expect(finalGateAttempts).toHaveLength(3)
      expect(finalGateAttempts[0]?.status).toBe('blocked')
      expect(finalGateAttempts[1]?.status).toBe('blocked')
      expect(finalGateAttempts[2]?.status).toBe('completed')

      const finalVerifierAttempts = workflowStore.getNodeAttempts(run1.graphRunId, 'verifier')
      expect(finalVerifierAttempts).toHaveLength(1)
      expect(finalVerifierAttempts[0]?.status).toBe('completed')
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

  it('18. GraphExecutor integration: user gate explicit rejection cancels run and prevents downstream execution', async () => {
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

      // Run 2: Resume with explicit rejection signal
      const run2 = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        resumeNodeIds: ['gate'],
        initialContext: { approval: 'rejected' },
      })

      expect(run2.status).toBe('cancelled')
      expect(run2.completedNodeIds).not.toContain('verifier')
      expect(workflowStore.getNodeAttempts(graphRunId, 'verifier')).toHaveLength(0)

      const gateAttempts = workflowStore.getNodeAttempts(graphRunId, 'gate')
      expect(gateAttempts).toHaveLength(2)
      expect(gateAttempts[1]?.status).toBe('cancelled')
      expect(gateAttempts[1]?.error).toBe('User declined approval')

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
})
