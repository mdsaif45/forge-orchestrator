import { randomUUID } from 'node:crypto'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  projectIdSchema,
  repositoryIdSchema,
  runtimeIdSchema,
  taskIdSchema,
  workflowIdSchema,
  type Capability,
  type IAgentRuntime,
  type ProjectId,
  type Repository,
  type Task,
  type TaskId,
  type WorkflowId,
  type WorkflowNode,
  type WorkflowTemplateV2,
} from '@shared/domain'
import { ArtifactService } from '../artifacts/artifactService'
import { ArtifactStore } from '../db/artifactStore'
import { BindingStore } from '../db/bindingStore'
import { initialiseDatabase, type ForgeDatabase } from '../db'
import { EventStore } from '../db/eventStore'
import { ProjectStore } from '../db/projectStore'
import { applyEvent } from '../db/projections'
import { WorkflowStore } from '../db/workflowStore'
import { GitService, WorktreeService } from '../git'
import {
  AmbiguousRoleBindingError,
  BindingSet,
  bindRole,
  UnboundRoleError,
} from '../runtimes/bindings'
import { IncapableRuntimeError, RuntimeRegistry, UnknownRuntimeError } from '../runtimes/registry'
import { MockAgentRuntime } from '../runtimes/mockRuntime'
import { GraphExecutor, type NodeExecutionContext } from './graphExecutor'
import { createGraphExecutorWithLeafRunner } from './graphFactory'
import { LeafRunner } from './leafRunner'
import { resolveRoleRuntime, validateNodeCapabilities } from './roleResolution'

function makeRuntime(id: string, overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
  return {
    id: runtimeIdSchema.parse(id),
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
    start: vi.fn().mockResolvedValue({ sessionId: `session-${id}` }),
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

function setupWorkflow(
  wfStore: WorkflowStore,
  evStore: EventStore,
  database: ForgeDatabase,
  projId: ProjectId,
): { workflowId: WorkflowId; taskId: TaskId; task: Task } {
  const now = new Date().toISOString()
  const taskId = taskIdSchema.parse(randomUUID())
  const task: Task = {
    id: taskId,
    objective: 'Test task objective',
    constraints: [],
    completionCriteria: [{ kind: 'tests', description: 'the test suite passes', params: {} }],
    scope: { allowedPaths: [], forbiddenPaths: [] },
    lockedDecisionIds: [],
    correctsTaskId: null,
    createdAt: now,
  }

  const taskEvent = evStore.append(
    {
      type: 'task.created',
      payload: { task },
    },
    { projectId: projId, actor: 'system', occurredAt: now },
  )
  applyEvent(database, taskEvent)

  const workflowId = workflowIdSchema.parse(randomUUID())
  wfStore.start(
    {
      workflowId,
      projectId: projId,
      taskId,
      templateId: 'test-v2-template',
      startedAt: now,
    },
    'system',
  )

  return { workflowId, taskId, task }
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
    forkSha: '0123456789abcdef0123456789abcdef01234567',
    signal: new AbortController().signal,
    inputArtifacts: [],
    incomingSlots: new Map(),
    initialContext: {},
    iteration: 1,
    ...overrides,
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

describe('BindingSet Role & Capability Resolution (Slice 5B-1B)', () => {
  let tempDirs: string[]
  let db: ForgeDatabase
  let closeDb: () => void
  let eventStore: EventStore
  let bindingStore: BindingStore
  let projectStore: ProjectStore
  let workflowStore: WorkflowStore
  let artifactStore: ArtifactStore
  let artifactService: ArtifactService
  let registry: RuntimeRegistry
  let repoDir: string
  let worktreeRoot: string
  let projectId: ProjectId

  beforeEach(() => {
    tempDirs = []
    const dbDir = mkdtempSync(join(tmpdir(), 'forge-res-db-'))
    tempDirs.push(dbDir)
    const dbFile = join(dbDir, 'forge.db')
    const opened = initialiseDatabase(dbFile)
    db = opened.db
    closeDb = opened.close

    eventStore = new EventStore(db)
    bindingStore = new BindingStore(db, eventStore)
    projectStore = new ProjectStore(db)
    workflowStore = new WorkflowStore(db)

    const artDir = mkdtempSync(join(tmpdir(), 'forge-res-arts-'))
    tempDirs.push(artDir)
    artifactStore = new ArtifactStore(db)
    artifactService = new ArtifactService(artDir, artifactStore)

    registry = new RuntimeRegistry()

    repoDir = mkdtempSync(join(tmpdir(), 'forge-res-repo-'))
    tempDirs.push(repoDir)
    git(repoDir, 'init', '--quiet', '--initial-branch=main')
    git(repoDir, 'config', 'user.email', 'forge-res@local')
    git(repoDir, 'config', 'user.name', 'Forge Resolution Test')
    git(repoDir, 'config', 'commit.gpgsign', 'false')

    mkdirSync(join(repoDir, 'src'), { recursive: true })
    writeFileSync(join(repoDir, 'src', 'index.ts'), 'export const active = true;\n')
    git(repoDir, 'add', '.')
    git(repoDir, 'commit', '-m', 'Initial commit')

    worktreeRoot = mkdtempSync(join(tmpdir(), 'forge-res-wt-'))
    tempDirs.push(worktreeRoot)

    projectId = projectIdSchema.parse(randomUUID())
    const sampleRepo: Repository = {
      id: repositoryIdSchema.parse(randomUUID()),
      absolutePath: repoDir,
      defaultBranch: 'main',
      buildCommand: 'npm run build',
      testCommand: 'npm test',
      tech: ['typescript'],
    }
    projectStore.create(
      {
        id: projectId,
        name: 'Resolution Test Project',
        repository: sampleRepo,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      'system',
    )
  })

  afterEach(() => {
    closeDb()
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        // ignore cleanup
      }
    }
  })

  // ===========================================================================
  // 1. Precedence Suite
  // ===========================================================================
  describe('1. Resolution Precedence', () => {
    it('precedence 1: explicit node.config.providerId overrides all other bindings and defaults', () => {
      const explicitRuntime = makeRuntime('explicit-rt')
      const execRuntime = makeRuntime('exec-rt')
      const compRuntime = makeRuntime('comp-rt')
      const storeRuntime = makeRuntime('store-rt')
      const defaultRuntime = makeRuntime('default-rt')

      registry.register(explicitRuntime)
      registry.register(execRuntime)
      registry.register(compRuntime)
      registry.register(storeRuntime)
      registry.register(defaultRuntime)

      const execBinding = bindRole(registry, { role: 'implementer', runtimeId: 'exec-rt' })
      const compBinding = bindRole(registry, { role: 'implementer', runtimeId: 'comp-rt' })
      const storeBinding = bindRole(registry, { role: 'implementer', runtimeId: 'store-rt' })

      const execBindings = new BindingSet([execBinding])
      const compBindings = new BindingSet([compBinding])
      bindingStore.set(projectId, storeBinding, 'system', new Date().toISOString())

      const node = makeNode('node-1', {
        config: {
          role: 'implementer',
          providerId: 'explicit-rt',
          permissionMode: 'developer',
          skills: [],
        },
      })

      const resolved = resolveRoleRuntime({
        node,
        projectId,
        executionBindings: execBindings,
        compositionBindings: compBindings,
        bindingStore,
        registry,
        defaultRuntimeId: 'default-rt',
      })

      expect(resolved.runtimeId).toBe('explicit-rt')
      expect(resolved.source).toBe('node-explicit')
      expect(resolved.runtime).toBe(explicitRuntime)
    })

    it('precedence 2: executionBindings overrides compositionBindings, store, and defaults', () => {
      const execRuntime = makeRuntime('exec-rt')
      const compRuntime = makeRuntime('comp-rt')
      const storeRuntime = makeRuntime('store-rt')
      const defaultRuntime = makeRuntime('default-rt')

      registry.register(execRuntime)
      registry.register(compRuntime)
      registry.register(storeRuntime)
      registry.register(defaultRuntime)

      const execBinding = bindRole(registry, { role: 'implementer', runtimeId: 'exec-rt' })
      const compBinding = bindRole(registry, { role: 'implementer', runtimeId: 'comp-rt' })
      const storeBinding = bindRole(registry, { role: 'implementer', runtimeId: 'store-rt' })

      const execBindings = new BindingSet([execBinding])
      const compBindings = new BindingSet([compBinding])
      bindingStore.set(projectId, storeBinding, 'system', new Date().toISOString())

      const node = makeNode('node-1', {
        config: {
          role: 'implementer',
          permissionMode: 'developer',
          skills: [],
        },
      })

      const resolved = resolveRoleRuntime({
        node,
        projectId,
        executionBindings: execBindings,
        compositionBindings: compBindings,
        bindingStore,
        registry,
        defaultRuntimeId: 'default-rt',
      })

      expect(resolved.runtimeId).toBe('exec-rt')
      expect(resolved.source).toBe('execution-binding')
    })

    it('precedence 3: compositionBindings overrides store and defaults', () => {
      const compRuntime = makeRuntime('comp-rt')
      const storeRuntime = makeRuntime('store-rt')
      const defaultRuntime = makeRuntime('default-rt')

      registry.register(compRuntime)
      registry.register(storeRuntime)
      registry.register(defaultRuntime)

      const compBinding = bindRole(registry, { role: 'implementer', runtimeId: 'comp-rt' })
      const storeBinding = bindRole(registry, { role: 'implementer', runtimeId: 'store-rt' })

      const compBindings = new BindingSet([compBinding])
      bindingStore.set(projectId, storeBinding, 'system', new Date().toISOString())

      const node = makeNode('node-1', {
        config: {
          role: 'implementer',
          permissionMode: 'developer',
          skills: [],
        },
      })

      const resolved = resolveRoleRuntime({
        node,
        projectId,
        compositionBindings: compBindings,
        bindingStore,
        registry,
        defaultRuntimeId: 'default-rt',
      })

      expect(resolved.runtimeId).toBe('comp-rt')
      expect(resolved.source).toBe('composition-binding')
    })

    it('precedence 4: BindingStore binding overrides defaultRuntimeId', () => {
      const storeRuntime = makeRuntime('store-rt')
      const defaultRuntime = makeRuntime('default-rt')

      registry.register(storeRuntime)
      registry.register(defaultRuntime)

      const storeBinding = bindRole(registry, { role: 'implementer', runtimeId: 'store-rt' })
      bindingStore.set(projectId, storeBinding, 'system', new Date().toISOString())

      const node = makeNode('node-1', {
        config: {
          role: 'implementer',
          permissionMode: 'developer',
          skills: [],
        },
      })

      const resolved = resolveRoleRuntime({
        node,
        projectId,
        bindingStore,
        registry,
        defaultRuntimeId: 'default-rt',
      })

      expect(resolved.runtimeId).toBe('store-rt')
      expect(resolved.source).toBe('project-store')
    })

    it('precedence 5: defaultRuntimeId resolves when capable and no higher binding applies', () => {
      const defaultRuntime = makeRuntime('default-rt')
      registry.register(defaultRuntime)

      const node = makeNode('node-1', {
        config: {
          role: 'implementer',
          permissionMode: 'developer',
          skills: [],
        },
      })

      const resolved = resolveRoleRuntime({
        node,
        projectId,
        registry,
        defaultRuntimeId: 'default-rt',
      })

      expect(resolved.runtimeId).toBe('default-rt')
      expect(resolved.source).toBe('default-runtime')
    })
  })

  // ===========================================================================
  // 2. Fail-Closed Safety Suite
  // ===========================================================================
  describe('2. Fail-Closed Safety', () => {
    it('fails closed with UnboundRoleError when role is not bound and no default exists', () => {
      const node = makeNode('node-1', {
        config: {
          role: 'implementer',
          permissionMode: 'developer',
          skills: [],
        },
      })

      expect(() =>
        resolveRoleRuntime({
          node,
          projectId,
          registry,
        }),
      ).toThrow(UnboundRoleError)
    })

    it('fails closed with AmbiguousRoleBindingError when multiple capable runtimes exist without a binding (no silent candidates[0] fallback)', () => {
      const rt1 = makeRuntime('runtime-1')
      const rt2 = makeRuntime('runtime-2')
      registry.register(rt1)
      registry.register(rt2)

      const node = makeNode('node-1', {
        config: {
          role: 'implementer',
          permissionMode: 'developer',
          skills: [],
        },
      })

      expect(() =>
        resolveRoleRuntime({
          node,
          projectId,
          registry,
        }),
      ).toThrow(AmbiguousRoleBindingError)

      try {
        resolveRoleRuntime({
          node,
          projectId,
          registry,
        })
      } catch (err) {
        expect(err).toBeInstanceOf(AmbiguousRoleBindingError)
        const ambig = err as AmbiguousRoleBindingError
        expect(ambig.candidates).toEqual(['runtime-1', 'runtime-2'])
        expect(ambig.message).toContain('Ambiguous role binding for "implementer"')
        expect(ambig.message).toContain('multiple runtimes (runtime-1, runtime-2) can hold role')
      }
    })

    it('fails closed with UnknownRuntimeError when an explicit runtime is not registered', () => {
      const node = makeNode('node-1', {
        config: {
          role: 'implementer',
          providerId: 'unregistered-runtime',
          permissionMode: 'developer',
          skills: [],
        },
      })

      expect(() =>
        resolveRoleRuntime({
          node,
          projectId,
          registry,
        }),
      ).toThrow(UnknownRuntimeError)
    })

    it('fails closed with IncapableRuntimeError when an explicit runtime lacks required role capabilities', () => {
      const readOnlyRuntime = makeRuntime('readonly-rt', {
        capabilities: ['repo-read'], // lacks file-write and terminal for implementer
      })
      registry.register(readOnlyRuntime)

      const node = makeNode('node-1', {
        config: {
          role: 'implementer',
          providerId: 'readonly-rt',
          permissionMode: 'developer',
          skills: [],
        },
      })

      expect(() =>
        resolveRoleRuntime({
          node,
          projectId,
          registry,
        }),
      ).toThrow(IncapableRuntimeError)
    })

    it('fails closed with IncapableRuntimeError when defaultRuntimeId lacks required role capabilities', () => {
      const readOnlyRuntime = makeRuntime('readonly-default', {
        capabilities: ['repo-read'],
      })
      registry.register(readOnlyRuntime)

      const node = makeNode('node-1', {
        config: {
          role: 'implementer',
          permissionMode: 'developer',
          skills: [],
        },
      })

      expect(() =>
        resolveRoleRuntime({
          node,
          projectId,
          registry,
          defaultRuntimeId: 'readonly-default',
        }),
      ).toThrow(IncapableRuntimeError)
    })
  })

  // ===========================================================================
  // 3. Capability Preflight Suite
  // ===========================================================================
  describe('3. Operational Capability Preflight', () => {
    it('fails closed when developer mode requires file-write but runtime lacks it', () => {
      const plannerRuntime = makeRuntime('planner-rt', {
        capabilities: ['repo-read', 'plan', 'terminal'], // lacks file-write
      })
      registry.register(plannerRuntime)

      const node = makeNode('node-1', {
        config: {
          role: 'planner',
          providerId: 'planner-rt',
          permissionMode: 'developer', // requires file-write
          skills: [],
        },
      })

      expect(() => {
        validateNodeCapabilities(plannerRuntime, node, 'planner')
      }).toThrow(IncapableRuntimeError)

      try {
        validateNodeCapabilities(plannerRuntime, node, 'planner')
      } catch (err) {
        expect(err).toBeInstanceOf(IncapableRuntimeError)
        expect((err as IncapableRuntimeError).missing).toContain('file-write')
      }
    })

    it('fails closed when full-access permissionMode requires file-write but runtime lacks it', () => {
      const plannerRuntime = makeRuntime('planner-rt', {
        capabilities: ['repo-read', 'plan', 'terminal'],
      })
      registry.register(plannerRuntime)

      const node = makeNode('node-1', {
        config: {
          role: 'planner',
          providerId: 'planner-rt',
          permissionMode: 'full-access',
          skills: [],
        },
      })

      expect(() => {
        validateNodeCapabilities(plannerRuntime, node, 'planner')
      }).toThrow(IncapableRuntimeError)
    })

    it('fails closed when node outputs declare kind diff requiring file-write but runtime lacks it', () => {
      const plannerRuntime = makeRuntime('planner-rt', {
        capabilities: ['repo-read', 'plan', 'terminal'],
      })
      registry.register(plannerRuntime)

      const node = makeNode('node-1', {
        config: {
          role: 'planner',
          providerId: 'planner-rt',
          permissionMode: 'read-only',
          skills: [],
        },
        outputs: [
          {
            name: 'patch',
            kind: 'diff',
            format: 'diff',
            required: true,
            requiredSections: [],
          },
        ],
      })

      expect(() => {
        validateNodeCapabilities(plannerRuntime, node, 'planner')
      }).toThrow(IncapableRuntimeError)
    })

    it('fails closed when tester role requires test capability but runtime lacks it', () => {
      const runtimeWithoutTest = makeRuntime('no-test-rt', {
        capabilities: ['repo-read', 'terminal', 'file-write'],
      })
      registry.register(runtimeWithoutTest)

      const node = makeNode('node-1', {
        config: {
          role: 'tester',
          providerId: 'no-test-rt',
          permissionMode: 'read-only',
          skills: [],
        },
      })

      expect(() => {
        validateNodeCapabilities(runtimeWithoutTest, node, 'tester')
      }).toThrow(IncapableRuntimeError)
    })

    it('LeafRunner fails closed before runtime session start or exchange when preflight fails', async () => {
      const startSpy = vi.fn().mockResolvedValue({ sessionId: 'session-incapable' })
      const sendSpy = vi.fn().mockResolvedValue(undefined)
      const incapableRuntime = makeRuntime('incapable-rt', {
        capabilities: ['repo-read'],
        start: startSpy,
        send: sendSpy,
      })
      registry.register(incapableRuntime)

      const runner = new LeafRunner({
        registry,
        defaultRuntimeId: 'incapable-rt',
      })

      const node = makeNode('node-1', {
        config: {
          role: 'implementer',
          permissionMode: 'developer',
          skills: [],
        },
      })

      const ctx = makeContext(node)
      const result = await runner.execute(ctx)

      expect(result.status).toBe('failed')
      expect(result.error).toContain('cannot hold role "implementer"')
      // Verify runtime.start was NEVER called
      expect(startSpy).not.toHaveBeenCalled()
      expect(sendSpy).not.toHaveBeenCalled()
    })
  })

  // ===========================================================================
  // 4. Attempt-Level Durable Runtime Identity & Graph Execution
  // ===========================================================================
  describe('4. Durable Attempt-Level Runtime Identity', () => {
    it('GraphExecutor records resolved runtimeId durably at attempt start before leaf execution', async () => {
      const activeRuntime = makeRuntime('agent-worker-1')
      registry.register(activeRuntime)

      const worktreeService = new WorktreeService({
        repositoryPath: repoDir,
        root: worktreeRoot,
      })
      const gitServiceFactory = (p: string) => new GitService({ repositoryPath: p })

      let capturedAttemptRuntimeIdAtStart: string | null = null

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        gitServiceFactory,
        artifactService,
        registry,
        defaultRuntimeId: 'agent-worker-1',
        executeLeafNode: (ctx) => {
          // Inspect the database synchronously while leaf node is executing!
          const attempts = workflowStore.getNodeAttempts(ctx.graphRunId, ctx.node.id)
          capturedAttemptRuntimeIdAtStart = attempts[0]?.runtimeId ?? null
          return {
            status: 'completed',
            runtimeId: ctx.runtimeId,
          }
        },
      })

      const { workflowId } = setupWorkflow(workflowStore, eventStore, db, projectId)

      const now = new Date().toISOString()
      const template: WorkflowTemplateV2 = {
        id: 'test-rt-template',
        version: 1,
        name: 'Runtime Identity Template',
        description: 'Verifies runtimeId persistence timing',
        status: 'published',
        category: 'Test',
        nodes: [
          makeNode('step-a', {
            config: {
              role: 'implementer',
              permissionMode: 'read-only',
              skills: [],
            },
          }),
        ],
        edges: [],
        createdAt: now,
        updatedAt: now,
      }

      const forkSha = git(repoDir, 'rev-parse', 'HEAD').trim()
      const graphRunId = randomUUID()

      const result = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(result.status).toBe('completed')
      // Authoritative check: runtimeId was already durably recorded at attempt start!
      expect(capturedAttemptRuntimeIdAtStart).toBe('agent-worker-1')

      // Check SQLite table graph_node_runs
      const attempts = workflowStore.getNodeAttempts(graphRunId, 'step-a')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.runtimeId).toBe('agent-worker-1')

      // Check EventStore event graph_node.attempt_started
      const events = eventStore.read(projectId)
      const attemptStarted = events.find(
        (e) =>
          e.type === 'graph_node.attempt_started' &&
          (e.payload as { nodeId: string }).nodeId === 'step-a',
      )
      expect(attemptStarted).toBeDefined()
      expect((attemptStarted?.payload as { runtimeId?: string }).runtimeId).toBe('agent-worker-1')
    })

    it('runtimeId survives projectStore.rebuild from EventStore stream', async () => {
      const activeRuntime = makeRuntime('agent-worker-rebuild')
      registry.register(activeRuntime)

      const worktreeService = new WorktreeService({
        repositoryPath: repoDir,
        root: worktreeRoot,
      })
      const gitServiceFactory = (p: string) => new GitService({ repositoryPath: p })

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        gitServiceFactory,
        artifactService,
        registry,
        defaultRuntimeId: 'agent-worker-rebuild',
        executeLeafNode: (ctx) => ({
          status: 'completed',
          runtimeId: ctx.runtimeId,
        }),
      })

      const { workflowId } = setupWorkflow(workflowStore, eventStore, db, projectId)

      const now = new Date().toISOString()
      const template: WorkflowTemplateV2 = {
        id: 'test-rebuild-template',
        version: 1,
        name: 'Rebuild Template',
        description: 'Verifies projection rebuild preserves runtimeId',
        status: 'published',
        category: 'Test',
        nodes: [
          makeNode('step-reb', {
            config: {
              role: 'implementer',
              permissionMode: 'read-only',
              skills: [],
            },
          }),
        ],
        edges: [],
        createdAt: now,
        updatedAt: now,
      }

      const forkSha = git(repoDir, 'rev-parse', 'HEAD').trim()
      const graphRunId = randomUUID()

      await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      // Ensure attempt was projected
      const beforeRebuild = workflowStore.getNodeAttempts(graphRunId, 'step-reb')
      expect(beforeRebuild[0]?.runtimeId).toBe('agent-worker-rebuild')

      // Rebuild all projections from eventStore
      projectStore.rebuild(projectId)

      // Verify that after rebuild, runtimeId is intact
      const afterRebuild = workflowStore.getNodeAttempts(graphRunId, 'step-reb')
      expect(afterRebuild).toHaveLength(1)
      expect(afterRebuild[0]?.runtimeId).toBe('agent-worker-rebuild')
    })

    it('each attempt across retries and loop iterations records its own runtimeId', async () => {
      const runtime1 = makeRuntime('rt-v1')
      const runtime2 = makeRuntime('rt-v2')
      registry.register(runtime1)
      registry.register(runtime2)

      const worktreeService = new WorktreeService({
        repositoryPath: repoDir,
        root: worktreeRoot,
      })
      const gitServiceFactory = (p: string) => new GitService({ repositoryPath: p })

      let executionCount = 0

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        gitServiceFactory,
        artifactService,
        registry,
        defaultRuntimeId: 'rt-v1',
        executeLeafNode: (ctx) => {
          executionCount++
          if (executionCount === 1) {
            return {
              status: 'failed',
              error: 'First attempt forced failure',
              runtimeId: ctx.runtimeId,
            }
          }
          return {
            status: 'completed',
            runtimeId: ctx.runtimeId,
          }
        },
      })

      const { workflowId } = setupWorkflow(workflowStore, eventStore, db, projectId)

      const now = new Date().toISOString()
      const template: WorkflowTemplateV2 = {
        id: 'retry-template',
        version: 1,
        name: 'Retry Template',
        description: 'Tests retries',
        status: 'published',
        category: 'Test',
        nodes: [
          makeNode('retry-step', {
            config: {
              role: 'implementer',
              permissionMode: 'read-only',
              skills: [],
            },
          }),
        ],
        edges: [],
        createdAt: now,
        updatedAt: now,
      }

      const forkSha = git(repoDir, 'rev-parse', 'HEAD').trim()
      const graphRunId = randomUUID()

      // First run fails
      const res1 = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })
      expect(res1.status).toBe('failed')

      const attemptsAfterFail = workflowStore.getNodeAttempts(graphRunId, 'retry-step')
      expect(attemptsAfterFail).toHaveLength(1)
      expect(attemptsAfterFail[0]?.attempt).toBe(1)
      expect(attemptsAfterFail[0]?.status).toBe('failed')
      expect(attemptsAfterFail[0]?.runtimeId).toBe('rt-v1')

      // Rerun with explicit execution-level binding to rt-v2
      const retryBinding = bindRole(registry, { role: 'implementer', runtimeId: 'rt-v2' })
      const execBindings = new BindingSet([retryBinding])
      const res2 = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        bindings: execBindings,
        invalidatedNodeIds: new Set(['retry-step']),
      })
      expect(res2.status).toBe('completed')

      const attemptsAfterRetry = workflowStore.getNodeAttempts(graphRunId, 'retry-step')
      expect(attemptsAfterRetry).toHaveLength(2)
      expect(attemptsAfterRetry[0]?.attempt).toBe(1)
      expect(attemptsAfterRetry[0]?.runtimeId).toBe('rt-v1')
      expect(attemptsAfterRetry[1]?.attempt).toBe(2)
      expect(attemptsAfterRetry[1]?.status).toBe('completed')
      expect(attemptsAfterRetry[1]?.runtimeId).toBe('rt-v2')
    })

    it('historical node attempts with runtimeId: null remain readable and backward-compatible', () => {
      const graphRunId = randomUUID()
      const { workflowId } = setupWorkflow(workflowStore, eventStore, db, projectId)
      workflowStore.startGraphRun(
        {
          graphRunId,
          projectId,
          workflowId,
          templateId: 'legacy-template',
          startedAt: new Date().toISOString(),
        },
        'system',
      )
      workflowStore.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'legacy-node',
          attempt: 1,
          status: 'running',
          role: 'implementer',
          runtimeId: null, // legacy attempt with null runtimeId
          startedAt: new Date().toISOString(),
        },
        'system',
      )

      const finishedAt = new Date().toISOString()
      workflowStore.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'legacy-node',
          attempt: 1,
          status: 'completed',
          runtimeId: null,
          finishedAt,
          occurredAt: finishedAt,
        },
        'system',
      )

      const attempts = workflowStore.getNodeAttempts(graphRunId, 'legacy-node')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.nodeId).toBe('legacy-node')
      expect(attempts[0]?.runtimeId).toBeNull()
      expect(attempts[0]?.status).toBe('completed')
    })
  })

  // ===========================================================================
  // 5. Factory Composition Integration Suite
  // ===========================================================================
  describe('5. Factory Composition Integration', () => {
    it('createGraphExecutorWithLeafRunner wires real BindingStore and executes DAG with resolved bindings', async () => {
      const boundRuntime = new MockAgentRuntime({
        id: 'factory-bound-rt',
        scenario: {
          name: 'factoryRun',
          description: 'completes agent task',
          capabilities: ['repo-read', 'file-write', 'terminal', 'plan', 'review', 'test'],
          steps: [
            {
              narration: ['Running step'],
              tools: [],
              edits: [],
              report: {
                status: 'completed',
                summary: 'Completed successfully',
                filesChanged: [],
                commandsRun: [],
                testsRun: true,
                openQuestions: [],
                assumptions: [],
              },
              ending: 'report',
              replyText: null,
            },
          ],
        },
      })
      registry.register(boundRuntime)

      const composition = createGraphExecutorWithLeafRunner({
        db,
        eventStore,
        worktreeRoot,
        repositoryPath: repoDir,
        artifactService,
        registry,
      })

      // Verify bindingStore is exposed in stores
      expect(composition.stores.bindingStore).toBeInstanceOf(BindingStore)

      // Bind 'implementer' role to 'factory-bound-rt' in the project store
      const factoryBinding = bindRole(registry, {
        role: 'implementer',
        runtimeId: 'factory-bound-rt',
      })
      composition.stores.bindingStore.set(
        projectId,
        factoryBinding,
        'system',
        new Date().toISOString(),
      )

      const { workflowId } = setupWorkflow(
        composition.stores.workflowStore,
        eventStore,
        db,
        projectId,
      )

      const now = new Date().toISOString()
      const template: WorkflowTemplateV2 = {
        id: 'factory-composition-template',
        version: 1,
        name: 'Factory Composition Template',
        description: 'End to end composition with BindingStore',
        status: 'published',
        category: 'Test',
        nodes: [
          makeNode('comp-agent', {
            config: {
              role: 'implementer',
              permissionMode: 'read-only',
              skills: [],
            },
          }),
        ],
        edges: [],
        createdAt: now,
        updatedAt: now,
      }

      const forkSha = git(repoDir, 'rev-parse', 'HEAD').trim()
      const graphRunId = randomUUID()

      const result = await composition.executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(result.status).toBe('completed')
      expect(result.completedNodeIds).toContain('comp-agent')

      const attempts = composition.stores.workflowStore.getNodeAttempts(graphRunId, 'comp-agent')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.status).toBe('completed')
      expect(attempts[0]?.runtimeId).toBe('factory-bound-rt')
    })

    it('factory composition fails closed when DAG node role is unbound in BindingStore and no default is configured', async () => {
      const runtimeA = makeRuntime('rt-alpha')
      const runtimeB = makeRuntime('rt-beta')
      registry.register(runtimeA)
      registry.register(runtimeB)

      const composition = createGraphExecutorWithLeafRunner({
        db,
        eventStore,
        worktreeRoot,
        repositoryPath: repoDir,
        artifactService,
        registry,
      })

      const { workflowId } = setupWorkflow(
        composition.stores.workflowStore,
        eventStore,
        db,
        projectId,
      )

      const now = new Date().toISOString()
      const template: WorkflowTemplateV2 = {
        id: 'ambig-template',
        version: 1,
        name: 'Ambig Template',
        description: 'Fails closed on ambiguity without silent fallback',
        status: 'published',
        category: 'Test',
        nodes: [
          makeNode('unbound-agent', {
            config: {
              role: 'implementer',
              permissionMode: 'read-only',
              skills: [],
            },
          }),
        ],
        edges: [],
        createdAt: now,
        updatedAt: now,
      }

      const forkSha = git(repoDir, 'rev-parse', 'HEAD').trim()
      const graphRunId = randomUUID()

      const result = await composition.executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(result.status).toBe('failed')
      expect(result.failedNodeIds).toContain('unbound-agent')
      expect(result.error).toContain('Ambiguous role binding for "implementer"')
      expect(result.error).toContain('multiple runtimes (rt-alpha, rt-beta) can hold role')

      const attempts = composition.stores.workflowStore.getNodeAttempts(graphRunId, 'unbound-agent')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.status).toBe('failed')
      expect(attempts[0]?.runtimeId).toBeNull()
    })
  })
})
