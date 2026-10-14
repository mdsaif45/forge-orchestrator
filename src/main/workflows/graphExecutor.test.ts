import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  changeSetIdSchema,
  projectIdSchema,
  repositoryIdSchema,
  runIdSchema,
  stepIdSchema,
  taskIdSchema,
  workflowIdSchema,
  type ChangeSet,
  type ProjectId,
  type Sha,
  type StepId,
  type TaskId,
  type WorkflowEdge,
  type WorkflowId,
  type WorkflowNode,
  type WorkflowTemplateV2,
  type WorkflowArtifact,
} from '@shared/domain'
import { ArtifactService } from '../artifacts/artifactService'
import { ArtifactStore } from '../db/artifactStore'
import { initialiseDatabase, type ForgeDatabase } from '../db'
import { EventStore } from '../db/eventStore'
import { ProjectStore } from '../db/projectStore'
import { applyEvent } from '../db/projections'
import { RunStore } from '../db/runStore'
import { WorkflowStore } from '../db/workflowStore'
import { WorktreeService } from '../git'
import { GraphExecutor } from './graphExecutor'

describe('GraphExecutor', () => {
  const dirsToCleanup: string[] = []
  let dbFile: string
  let db: ForgeDatabase
  let closeDb: () => void
  let workflowStore: WorkflowStore
  let artifactStore: ArtifactStore
  let artifactService: ArtifactService
  let repoDir: string
  let worktreeRoot: string
  let worktreeService: WorktreeService
  let forkSha: Sha
  let projectId: ProjectId
  let taskId: TaskId
  let workflowId: WorkflowId

  const NOW = new Date().toISOString()

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'forge-ge-repo-'))
    dirsToCleanup.push(dir)
    execFileSync('git', ['init', '-b', 'main', dir])
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: dir })
    writeFileSync(join(dir, 'fileA.txt'), 'initial A\n')
    writeFileSync(join(dir, 'fileB.txt'), 'initial B\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir })
    return dir
  }

  function makeTemplate(
    nodes: readonly WorkflowNode[],
    edges: readonly (Partial<WorkflowEdge> & { source: string; target: string })[] = [],
  ): WorkflowTemplateV2 {
    return {
      id: 'test-template',
      name: 'Test Template',
      description: 'Template for GraphExecutor tests',
      version: 1,
      status: 'published',
      category: 'General',
      nodes,
      edges: edges.map((e, idx) => ({
        id: e.id ?? `e-${String(idx)}`,
        source: e.source,
        target: e.target,
        isFeedback: e.isFeedback,
        condition: e.condition,
        isDefault: e.isDefault,
        sourceHandle: e.sourceHandle,
        targetHandle: e.targetHandle,
      })),
      createdAt: NOW,
      updatedAt: NOW,
    }
  }

  function makeNode(id: string, overrides: Partial<WorkflowNode> = {}): WorkflowNode {
    return {
      id,
      title: `Node ${id}`,
      type: 'agent',
      runtimeType: 'cli-agent',
      config: {
        skills: [],
        permissionMode: 'developer',
      },
      inputs: [],
      outputs: [],
      ...overrides,
    }
  }

  beforeEach(() => {
    const tempDbDir = mkdtempSync(join(tmpdir(), 'forge-ge-db-'))
    dirsToCleanup.push(tempDbDir)
    dbFile = join(tempDbDir, 'forge.db')
    const opened = initialiseDatabase(dbFile)
    db = opened.db
    closeDb = opened.close

    workflowStore = new WorkflowStore(db)
    const eventStore = new EventStore(db)
    artifactStore = new ArtifactStore(db)

    const artifactsDir = mkdtempSync(join(tmpdir(), 'forge-ge-artifacts-'))
    dirsToCleanup.push(artifactsDir)
    artifactService = new ArtifactService(artifactsDir, artifactStore)

    repoDir = makeRepo()
    worktreeRoot = mkdtempSync(join(tmpdir(), 'forge-ge-wt-'))
    dirsToCleanup.push(worktreeRoot)
    worktreeService = new WorktreeService({ repositoryPath: repoDir, root: worktreeRoot })

    forkSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim()

    projectId = projectIdSchema.parse(randomUUID())
    taskId = taskIdSchema.parse(randomUUID())
    workflowId = workflowIdSchema.parse(randomUUID())

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
        createdAt: NOW,
        updatedAt: NOW,
      },
      'user',
    )

    const taskEvent = eventStore.append(
      {
        type: 'task.created',
        payload: {
          task: {
            id: taskId,
            objective: 'Complete graph task',
            constraints: [],
            completionCriteria: [
              { kind: 'tests', description: 'the test suite passes', params: {} },
            ],
            scope: { allowedPaths: [], forbiddenPaths: [] },
            lockedDecisionIds: [],
            correctsTaskId: null,
            createdAt: NOW,
          },
        },
      },
      { projectId, actor: 'user', occurredAt: NOW },
    )
    applyEvent(db, taskEvent)

    workflowStore.start(
      {
        workflowId,
        projectId,
        taskId,
        templateId: 'test-template',
        startedAt: NOW,
      },
      'user',
    )
  })

  afterEach(() => {
    closeDb()
    for (const dir of dirsToCleanup) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Best effort
      }
    }
  })

  // 1. Linear DAG completion
  it('executes a linear DAG to completion', async () => {
    const template = makeTemplate(
      [makeNode('node1'), makeNode('node2'), makeNode('node3')],
      [
        { source: 'node1', target: 'node2' },
        { source: 'node2', target: 'node3' },
      ],
    )

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('completed')
    expect(result.completedNodeIds).toEqual(['node1', 'node2', 'node3'])
    expect(result.failedNodeIds).toHaveLength(0)

    const attempts1 = workflowStore.getNodeAttempts(result.graphRunId, 'node1')
    const attempts2 = workflowStore.getNodeAttempts(result.graphRunId, 'node2')
    const attempts3 = workflowStore.getNodeAttempts(result.graphRunId, 'node3')

    expect(attempts1).toHaveLength(1)
    expect(attempts1[0]!.status).toBe('completed')
    expect(attempts2).toHaveLength(1)
    expect(attempts2[0]!.status).toBe('completed')
    expect(attempts3).toHaveLength(1)
    expect(attempts3[0]!.status).toBe('completed')
  })

  // 2. Parallel fan-out
  it('executes parallel fan-out nodes concurrently', async () => {
    const template = makeTemplate(
      [makeNode('root'), makeNode('branchA'), makeNode('branchB')],
      [
        { source: 'root', target: 'branchA' },
        { source: 'root', target: 'branchB' },
      ],
    )

    let maxConcurrent = 0
    let currentConcurrent = 0

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: async (ctx) => {
        if (ctx.node.id === 'branchA' || ctx.node.id === 'branchB') {
          currentConcurrent++
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent)
          await new Promise((r) => setTimeout(r, 400))
          currentConcurrent--
        }
        return { status: 'completed' }
      },
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('completed')
    expect([...result.completedNodeIds].sort()).toEqual(['branchA', 'branchB', 'root'])
    expect(maxConcurrent).toBe(2)
  })

  // 3. Isolated branch worktrees
  it('ensures branch worktrees are isolated and do not bleed edits', async () => {
    const template = makeTemplate([makeNode('branchA'), makeNode('branchB')], [])

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: (ctx) => {
        if (!ctx.worktreePath) throw new Error('Worktree required')
        if (ctx.node.id === 'branchA') {
          writeFileSync(join(ctx.worktreePath, 'fileA.txt'), 'edit by A\n')
          expect(existsSync(join(ctx.worktreePath, 'fileB.txt'))).toBe(true)
          expect(readFileSync(join(ctx.worktreePath, 'fileB.txt'), 'utf8')).toBe('initial B\n')
        } else if (ctx.node.id === 'branchB') {
          writeFileSync(join(ctx.worktreePath, 'fileB.txt'), 'edit by B\n')
          expect(existsSync(join(ctx.worktreePath, 'fileA.txt'))).toBe(true)
          expect(readFileSync(join(ctx.worktreePath, 'fileA.txt'), 'utf8')).toBe('initial A\n')
        }
        return { status: 'completed' }
      },
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('completed')
    // Main repository remains completely untouched
    expect(readFileSync(join(repoDir, 'fileA.txt'), 'utf8')).toBe('initial A\n')
    expect(readFileSync(join(repoDir, 'fileB.txt'), 'utf8')).toBe('initial B\n')
  })

  // 4. Fan-in disjoint merge
  it('merges disjoint parallel branches into downstream node', async () => {
    const template = makeTemplate(
      [makeNode('branchA'), makeNode('branchB'), makeNode('downstream')],
      [
        { source: 'branchA', target: 'downstream' },
        { source: 'branchB', target: 'downstream' },
      ],
    )

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: (ctx) => {
        if (ctx.node.id === 'branchA' && ctx.worktreePath) {
          writeFileSync(join(ctx.worktreePath, 'fileA.txt'), 'modified by A\n')
        } else if (ctx.node.id === 'branchB' && ctx.worktreePath) {
          writeFileSync(join(ctx.worktreePath, 'fileB.txt'), 'modified by B\n')
        }
        return { status: 'completed' }
      },
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('completed')
    expect([...result.completedNodeIds].sort()).toEqual(['branchA', 'branchB', 'downstream'])
  })

  // 5. Fan-in physical materialization & 20. Downstream node actually observing merged filesystem state
  it('physically materializes merged patch on disk so downstream node reads both changes', async () => {
    const template = makeTemplate(
      [makeNode('branchA'), makeNode('branchB'), makeNode('downstream')],
      [
        { source: 'branchA', target: 'downstream' },
        { source: 'branchB', target: 'downstream' },
      ],
    )

    let downstreamObservedA = ''
    let downstreamObservedB = ''

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: (ctx) => {
        if (ctx.node.id === 'branchA' && ctx.worktreePath) {
          writeFileSync(join(ctx.worktreePath, 'fileA.txt'), 'feature A implementation\n')
        } else if (ctx.node.id === 'branchB' && ctx.worktreePath) {
          writeFileSync(join(ctx.worktreePath, 'fileB.txt'), 'feature B implementation\n')
        } else if (ctx.node.id === 'downstream') {
          expect(ctx.worktreePath).toBeDefined()
          downstreamObservedA = readFileSync(join(ctx.worktreePath!, 'fileA.txt'), 'utf8')
          downstreamObservedB = readFileSync(join(ctx.worktreePath!, 'fileB.txt'), 'utf8')
        }
        return { status: 'completed' }
      },
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('completed')
    expect(downstreamObservedA).toBe('feature A implementation\n')
    expect(downstreamObservedB).toBe('feature B implementation\n')
  })

  // 6. Fan-in collision halt
  it('halts with HALTED_POLICY: merge-conflict when parallel branches collide on same path', async () => {
    const template = makeTemplate(
      [makeNode('branchA'), makeNode('branchB'), makeNode('downstream')],
      [
        { source: 'branchA', target: 'downstream' },
        { source: 'branchB', target: 'downstream' },
      ],
    )

    let downstreamExecuted = false

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: (ctx) => {
        if (ctx.node.id === 'branchA' && ctx.worktreePath) {
          writeFileSync(join(ctx.worktreePath, 'fileA.txt'), 'conflict A\n')
        } else if (ctx.node.id === 'branchB' && ctx.worktreePath) {
          writeFileSync(join(ctx.worktreePath, 'fileA.txt'), 'conflict B\n')
        } else if (ctx.node.id === 'downstream') {
          downstreamExecuted = true
        }
        return { status: 'completed' }
      },
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('halted')
    expect(result.haltReason).toContain('HALTED_POLICY: merge-conflict')
    expect(downstreamExecuted).toBe(false)
    expect(result.failedNodeIds).toContain('downstream')
  })

  // 7. Additions and deletions
  it('materializes additions and deletions into downstream worktree', async () => {
    const template = makeTemplate(
      [makeNode('branchA'), makeNode('branchB'), makeNode('downstream')],
      [
        { source: 'branchA', target: 'downstream' },
        { source: 'branchB', target: 'downstream' },
      ],
    )

    let downstreamSawNewService = false
    let downstreamSawDeletedFileB = false

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: (ctx) => {
        if (ctx.node.id === 'branchA' && ctx.worktreePath) {
          writeFileSync(join(ctx.worktreePath, 'new_service.ts'), 'export const service = 1\n')
        } else if (ctx.node.id === 'branchB' && ctx.worktreePath) {
          rmSync(join(ctx.worktreePath, 'fileB.txt'))
        } else if (ctx.node.id === 'downstream') {
          downstreamSawNewService = existsSync(join(ctx.worktreePath!, 'new_service.ts'))
          downstreamSawDeletedFileB = !existsSync(join(ctx.worktreePath!, 'fileB.txt'))
        }
        return { status: 'completed' }
      },
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('completed')
    expect(downstreamSawNewService).toBe(true)
    expect(downstreamSawDeletedFileB).toBe(true)
  })

  // 8. Renames
  it('materializes file renames into downstream worktree', async () => {
    const template = makeTemplate(
      [makeNode('branchA'), makeNode('downstream')],
      [{ source: 'branchA', target: 'downstream' }],
    )

    let downstreamSawOld = true
    let downstreamSawRenamed = false

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: (ctx) => {
        if (ctx.node.id === 'branchA' && ctx.worktreePath) {
          execFileSync('git', ['mv', 'fileA.txt', 'renamedA.txt'], { cwd: ctx.worktreePath })
        } else if (ctx.node.id === 'downstream') {
          downstreamSawOld = existsSync(join(ctx.worktreePath!, 'fileA.txt'))
          downstreamSawRenamed = existsSync(join(ctx.worktreePath!, 'renamedA.txt'))
        }
        return { status: 'completed' }
      },
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('completed')
    expect(downstreamSawOld).toBe(false)
    expect(downstreamSawRenamed).toBe(true)
  })

  // 9. Mode changes
  it('materializes file mode changes into downstream worktree', async () => {
    const template = makeTemplate(
      [makeNode('branchA'), makeNode('downstream')],
      [{ source: 'branchA', target: 'downstream' }],
    )

    let downstreamSawExecutable = false

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: (ctx) => {
        if (ctx.node.id === 'branchA' && ctx.worktreePath) {
          const scriptPath = join(ctx.worktreePath, 'run.sh')
          writeFileSync(scriptPath, '#!/bin/sh\necho "OK"\n')
          chmodSync(scriptPath, 0o755)
          execFileSync('git', ['add', 'run.sh'], { cwd: ctx.worktreePath })
          execFileSync('git', ['update-index', '--chmod=+x', 'run.sh'], { cwd: ctx.worktreePath })
        } else if (ctx.node.id === 'downstream') {
          const script = join(ctx.worktreePath!, 'run.sh')
          downstreamSawExecutable = existsSync(script)
          if (process.platform !== 'win32') {
            const stats = statSync(script)
            expect(stats.mode & 0o111).not.toBe(0)
          }
        }
        return { status: 'completed' }
      },
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('completed')
    expect(downstreamSawExecutable).toBe(true)
  })

  // 10. Binary materialization
  it('materializes binary changes with exact bytes into downstream worktree', async () => {
    const template = makeTemplate(
      [makeNode('branchA'), makeNode('downstream')],
      [{ source: 'branchA', target: 'downstream' }],
    )

    const expectedBinary = Buffer.from([0, 1, 2, 3, 4, 5, 255, 254, 253])
    let downstreamBinaryMatch = false

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: (ctx) => {
        if (ctx.node.id === 'branchA' && ctx.worktreePath) {
          writeFileSync(join(ctx.worktreePath, 'binary.dat'), expectedBinary)
          execFileSync('git', ['add', 'binary.dat'], { cwd: ctx.worktreePath })
        } else if (ctx.node.id === 'downstream') {
          const downstreamBytes = readFileSync(join(ctx.worktreePath!, 'binary.dat'))
          downstreamBinaryMatch = downstreamBytes.equals(expectedBinary)
        }
        return { status: 'completed' }
      },
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('completed')
    expect(downstreamBinaryMatch).toBe(true)
  })

  // 11. Read-only concurrency
  it('executes read-only nodes without allocating branch worktrees', async () => {
    const roNode1 = makeNode('ro1', {
      config: { skills: [], permissionMode: 'read-only' },
    })
    const roNode2 = makeNode('ro2', {
      config: { skills: [], permissionMode: 'read-only' },
    })

    const template = makeTemplate([roNode1, roNode2], [])

    let ro1HadWorktree = true
    let ro2HadWorktree = true

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: (ctx) => {
        if (ctx.node.id === 'ro1') ro1HadWorktree = ctx.worktreePath !== undefined
        if (ctx.node.id === 'ro2') ro2HadWorktree = ctx.worktreePath !== undefined
        return { status: 'completed' }
      },
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('completed')
    expect(ro1HadWorktree).toBe(false)
    expect(ro2HadWorktree).toBe(false)
  })

  // 12. Required slot blocking
  it('blocks execution when a required input slot is missing', async () => {
    const nodeWithRequiredSlot = makeNode('blockedNode', {
      inputs: [
        {
          name: 'spec',
          kind: 'specification',
          required: true,
        },
      ],
    })

    const template = makeTemplate([nodeWithRequiredSlot], [])

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
      initialContext: {}, // Missing required 'spec'
    })

    expect(result.blockedNodeIds).toContain('blockedNode')
    expect(result.completedNodeIds).toHaveLength(0)

    const attempts = workflowStore.getNodeAttempts(result.graphRunId, 'blockedNode')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.status).toBe('blocked')
    expect(attempts[0]!.error).toContain('Missing required input slot: spec')
  })

  // 13. Router execution (WORK-003 Slice 2A)
  it('executes router node and persists routing-decision artifact', async () => {
    const routerNode = makeNode('routerNode', {
      type: 'router',
    })
    const targetNode = makeNode('targetNode')

    const template = makeTemplate(
      [routerNode, targetNode],
      [
        {
          id: 'e-router-target',
          source: 'routerNode',
          target: 'targetNode',
          isDefault: true,
        },
      ],
    )

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: () => ({ status: 'completed' }),
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('completed')
    expect(result.completedNodeIds).toContain('routerNode')
    expect(result.completedNodeIds).toContain('targetNode')

    const attempts = workflowStore.getNodeAttempts(result.graphRunId, 'routerNode')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.status).toBe('completed')
  })

  // 14. Write-ahead checkpoint
  it('persists write-ahead checkpoints prior to node side effects and at completion', async () => {
    const template = makeTemplate([makeNode('node1')], [])

    let checkpointSeenDuringExecution: unknown = null

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: (ctx) => {
        // Query database from inside leaf execution to verify write-ahead checkpoint was committed
        checkpointSeenDuringExecution = workflowStore.getLatestGraphCheckpoint(ctx.graphRunId)
        return { status: 'completed' }
      },
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('completed')
    expect(checkpointSeenDuringExecution).not.toBeNull()
    expect((checkpointSeenDuringExecution as { operation: string }).operation).toBe('node.started')

    const finalCheckpoint = workflowStore.getLatestGraphCheckpoint(result.graphRunId)
    expect(finalCheckpoint).not.toBeNull()
    expect(finalCheckpoint!.operation).toBe('node.completed')
    expect(finalCheckpoint!.stateSnapshot.completedNodeIds).toContain('node1')
  })

  // 15. Monotonic retry
  it('allocates strictly monotonic attempts when a node is retried', () => {
    const graphRunId = randomUUID()
    const now = new Date().toISOString()
    workflowStore.startGraphRun(
      {
        graphRunId,
        workflowId,
        projectId,
        templateId: 'test-template',
        startedAt: now,
      },
      'system',
    )

    // Attempt 1 fails
    const attempt1 = workflowStore.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId: 'node1',
        attempt: 1,
        status: 'running',
        startedAt: now,
      },
      'system',
    )
    expect(attempt1.attempt).toBe(1)

    workflowStore.updateNodeAttempt(
      {
        projectId,
        graphRunId,
        nodeId: 'node1',
        attempt: 1,
        status: 'failed',
        error: 'First attempt failed',
        finishedAt: now,
        occurredAt: now,
      },
      'system',
    )

    // Attempt 2 succeeds
    const attempt2 = workflowStore.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId: 'node1',
        attempt: 2,
        status: 'running',
        startedAt: now,
      },
      'system',
    )
    expect(attempt2.attempt).toBe(2)

    workflowStore.updateNodeAttempt(
      {
        projectId,
        graphRunId,
        nodeId: 'node1',
        attempt: 2,
        status: 'completed',
        finishedAt: now,
        occurredAt: now,
      },
      'system',
    )

    const attempts = workflowStore.getNodeAttempts(graphRunId, 'node1')
    expect(attempts).toHaveLength(2)
    expect(attempts[0]!.attempt).toBe(1)
    expect(attempts[0]!.status).toBe('failed')
    expect(attempts[1]!.attempt).toBe(2)
    expect(attempts[1]!.status).toBe('completed')
  })

  // 16. Terminal attempt immutability
  it('strictly rejects mutations to terminal attempts', () => {
    const graphRunId = randomUUID()
    const now = new Date().toISOString()
    workflowStore.startGraphRun(
      {
        graphRunId,
        workflowId,
        projectId,
        templateId: 'test-template',
        startedAt: now,
      },
      'system',
    )

    workflowStore.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId: 'node1',
        attempt: 1,
        status: 'running',
        startedAt: now,
      },
      'system',
    )

    workflowStore.updateNodeAttempt(
      {
        projectId,
        graphRunId,
        nodeId: 'node1',
        attempt: 1,
        status: 'completed',
        finishedAt: now,
        occurredAt: now,
      },
      'system',
    )

    // Attempting to mutate completed attempt 1 must throw
    expect(() => {
      workflowStore.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'node1',
          attempt: 1,
          status: 'failed',
          error: 'illegal mutation',
          finishedAt: now,
          occurredAt: now,
        },
        'system',
      )
    }).toThrow(/Terminal attempt immutability violation/)
  })

  // 17. Cancellation
  it('cancels execution, preserves partial patch artifact, and disposes worktrees', async () => {
    const template = makeTemplate([makeNode('longRunningNode')], [])
    const controller = new AbortController()

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      artifactService,
      executeLeafNode: async (ctx) => {
        if (ctx.worktreePath) {
          writeFileSync(join(ctx.worktreePath, 'uncommitted.txt'), 'partial work before cancel\n')
        }
        controller.abort()
        await new Promise((r) => setTimeout(r, 20))
        return { status: 'completed' }
      },
    })

    const runStore = new RunStore(db)
    const graphRunId = randomUUID()
    runStore.createRun({
      id: runIdSchema.parse(graphRunId),
      projectId,
      taskId,
      type: 'workflow',
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      exitCode: null,
      summary: null,
      error: null,
      metadata: {},
    })

    const result = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template,
      forkSha,
      signal: controller.signal,
    })

    expect(result.status).toBe('cancelled')
    const attempts = workflowStore.getNodeAttempts(result.graphRunId, 'longRunningNode')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.status).toBe('cancelled')

    // Verify partial patch was preserved as an artifact
    const runArtifacts = artifactStore.listForRun(runIdSchema.parse(result.graphRunId))
    const partialArtifact = runArtifacts.find((a) => a.name === 'cancelled-partial.patch')
    expect(partialArtifact).toBeDefined()
  })

  // 18. Crash recovery
  it('recovers interrupted graph runs and marks in-flight attempts failed', async () => {
    const graphRunId = randomUUID()
    const now = new Date().toISOString()

    workflowStore.startGraphRun(
      {
        graphRunId,
        workflowId,
        projectId,
        templateId: 'test-template',
        startedAt: now,
      },
      'system',
    )

    workflowStore.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId: 'inFlightNode',
        attempt: 1,
        status: 'running',
        startedAt: now,
      },
      'system',
    )

    // Simulate crash recovery invocation
    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
    })

    const recovered = await executor.recover(projectId)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]!.status).toBe('failed')
    expect(recovered[0]!.error).toContain('interrupted by process termination')

    const attempts = workflowStore.getNodeAttempts(graphRunId, 'inFlightNode')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.status).toBe('failed')
    expect(attempts[0]!.error).toBe('Process crashed during node execution')
  })

  // 19. Invalid patch failure
  it('fails node attempt safely when patch application fails and cleans up resources', async () => {
    const template = makeTemplate(
      [makeNode('sourceNode'), makeNode('targetNode')],
      [{ source: 'sourceNode', target: 'targetNode' }],
    )

    const corruptChangeSet: ChangeSet = {
      id: changeSetIdSchema.parse(randomUUID()),
      baseSha: forkSha,
      headSha: null,
      files: [
        {
          path: 'fileA.txt',
          changeType: 'modified',
          previousPath: null,
          insertions: 1,
          deletions: 0,
        },
      ],
      patch: 'corrupt invalid patch header\n@@ not a real hunk @@\n',
      authorActor: 'system',
      stepId: 'sourceNode' as StepId,
      taskId: 'test-template' as TaskId,
      correctsChangeSetId: null,
      reviewVerdict: null,
      discrepancies: [],
      capturedAt: NOW,
    }

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: (ctx) => {
        if (ctx.node.id === 'sourceNode') {
          return {
            status: 'completed',
            changeSet: corruptChangeSet,
          }
        }
        return { status: 'completed' }
      },
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('failed')
    expect(result.failedNodeIds).toContain('targetNode')
    expect(result.completedNodeIds).toEqual(['sourceNode'])

    const targetAttempts = workflowStore.getNodeAttempts(result.graphRunId, 'targetNode')
    expect(targetAttempts).toHaveLength(1)
    expect(targetAttempts[0]!.status).toBe('failed')
  })

  // 20. Downstream node actually observing merged filesystem state
  it('downstream node actually observes merged filesystem state and verifies file contents', async () => {
    const template = makeTemplate(
      [makeNode('featureA'), makeNode('featureB'), makeNode('verifyBoth')],
      [
        { source: 'featureA', target: 'verifyBoth' },
        { source: 'featureB', target: 'verifyBoth' },
      ],
    )

    let verified = false

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: (ctx) => {
        if (ctx.node.id === 'featureA' && ctx.worktreePath) {
          writeFileSync(join(ctx.worktreePath, 'moduleA.ts'), 'export const a = 42\n')
        } else if (ctx.node.id === 'featureB' && ctx.worktreePath) {
          writeFileSync(join(ctx.worktreePath, 'moduleB.ts'), 'export const b = 100\n')
        } else if (ctx.node.id === 'verifyBoth' && ctx.worktreePath) {
          const modA = readFileSync(join(ctx.worktreePath, 'moduleA.ts'), 'utf8')
          const modB = readFileSync(join(ctx.worktreePath, 'moduleB.ts'), 'utf8')
          if (modA === 'export const a = 42\n' && modB === 'export const b = 100\n') {
            verified = true
          }
        }
        return { status: 'completed' }
      },
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('completed')
    expect(verified).toBe(true)
    expect([...result.completedNodeIds].sort()).toEqual(['featureA', 'featureB', 'verifyBoth'])
  })

  describe('WORK-002: Stage Run, Skip, and Rerun Semantics', () => {
    // 1. DOMAIN: skippedNodeIds in checkpoint snapshot round-trip
    it('round-trips skippedNodeIds in checkpoint stateSnapshot', () => {
      const graphRunId = randomUUID()
      workflowStore.startGraphRun(
        {
          graphRunId,
          projectId,
          workflowId,
          templateId: 'test-template',
          startedAt: NOW,
        },
        'user',
      )

      const cpId = randomUUID()
      const cp = workflowStore.writeGraphCheckpoint(
        {
          id: cpId,
          projectId,
          graphRunId,
          nodeId: 'node-A',
          operation: 'node.skipped',
          stateSnapshot: {
            readyNodeIds: ['node-B'],
            runningNodeIds: [],
            completedNodeIds: ['node-root'],
            blockedNodeIds: [],
            skippedNodeIds: ['node-A'],
          },
          occurredAt: NOW,
        },
        'user',
      )

      expect(cp.stateSnapshot.skippedNodeIds).toEqual(['node-A'])
      const retrieved = workflowStore.getLatestGraphCheckpoint(graphRunId)
      expect(retrieved?.stateSnapshot.skippedNodeIds).toEqual(['node-A'])
    })

    // 2. SKIP: ready -> skipped produces zero artifacts, no changeset, and updates snapshot
    it('explicit node skip transitions ready -> skipped with zero artifacts and changesets', async () => {
      const template = makeTemplate([makeNode('A'), makeNode('B')], [{ source: 'A', target: 'B' }])

      let aExecuted = false
      let bExecuted = false

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'A') aExecuted = true
          if (ctx.node.id === 'B') bExecuted = true
          return { status: 'completed' }
        },
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        skipNodeIds: ['A'],
      })

      expect(aExecuted).toBe(false)
      expect(bExecuted).toBe(true)
      expect(result.skippedNodeIds).toEqual(['A'])
      expect(result.completedNodeIds).toEqual(['B'])
      expect(result.status).toBe('completed')

      const aAttempts = workflowStore.getNodeAttempts(result.graphRunId, 'A')
      expect(aAttempts).toHaveLength(1)
      expect(aAttempts[0]!.status).toBe('skipped')
      expect(aAttempts[0]!.changeSetId).toBeNull()
      expect(aAttempts[0]!.evidenceId).toBeNull()
    })

    // 3. OPTIONAL INPUT: skipped predecessor allows downstream execution when slot is optional
    it('optional missing slot allows downstream execution when predecessor is skipped', async () => {
      const nodeA = makeNode('A')
      const nodeB = makeNode('B', {
        inputs: [
          { name: 'optional-plan', kind: 'plan', required: false, description: 'Optional plan' },
        ],
      })
      const template = makeTemplate([nodeA, nodeB], [{ source: 'A', target: 'B' }])

      let bIncomingSlotValue: unknown = 'NOT_SET'

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'B') {
            bIncomingSlotValue = ctx.incomingSlots.get('optional-plan') ?? null
          }
          return { status: 'completed' }
        },
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        skipNodeIds: ['A'],
      })

      expect(result.status).toBe('completed')
      expect(result.skippedNodeIds).toEqual(['A'])
      expect(result.completedNodeIds).toEqual(['B'])
      expect(bIncomingSlotValue).toBeNull()
    })

    // 4. REQUIRED FALLBACK: required slot uses initialContext fallback when predecessor is skipped
    it('required missing slot uses declared initialContext fallback when predecessor is skipped', async () => {
      const nodeA = makeNode('A')
      const nodeB = makeNode('B', {
        inputs: [{ name: 'spec', kind: 'markdown', required: true }],
      })
      const template = makeTemplate([nodeA, nodeB], [{ source: 'A', target: 'B' }])

      let boundFallbackContent: string | null = null

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'B') {
            const artifact = ctx.incomingSlots.get('spec')
            boundFallbackContent = artifact?.content ?? null
          }
          return { status: 'completed' }
        },
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        skipNodeIds: ['A'],
        initialContext: { spec: '# Fallback Specification\n' },
      })

      expect(result.status).toBe('completed')
      expect(result.skippedNodeIds).toEqual(['A'])
      expect(result.completedNodeIds).toEqual(['B'])
      expect(boundFallbackContent).toBe('# Fallback Specification\n')
    })

    // 5. REQUIRED MISSING (NO FALLBACK): transitions node to blocked and graph terminal status to failed
    it('required missing slot without fallback transitions node to blocked and graph status to failed', async () => {
      const nodeA = makeNode('A')
      const nodeB = makeNode('B', {
        inputs: [{ name: 'spec', kind: 'markdown', required: true }],
      })
      const template = makeTemplate([nodeA, nodeB], [{ source: 'A', target: 'B' }])

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        skipNodeIds: ['A'],
      })

      expect(result.status).toBe('failed')
      expect(result.skippedNodeIds).toEqual(['A'])
      expect(result.blockedNodeIds).toEqual(['B'])
      expect(result.completedNodeIds).toEqual([])

      const bAttempts = workflowStore.getNodeAttempts(result.graphRunId, 'B')
      expect(bAttempts).toHaveLength(1)
      expect(bAttempts[0]!.status).toBe('blocked')
      expect(bAttempts[0]!.error).toContain('Missing required input slot: spec')
    })

    // 6. TRANSITIVE CASCADE BLOCKING: A skipped -> B blocked -> C blocked -> D blocked
    it('transitive cascade blocking: A skipped -> B blocked -> C blocked -> D blocked', async () => {
      const nodeA = makeNode('A')
      const nodeB = makeNode('B', { inputs: [{ name: 'slotB', kind: 'k1', required: true }] })
      const nodeC = makeNode('C', { inputs: [{ name: 'slotC', kind: 'k2', required: true }] })
      const nodeD = makeNode('D', { inputs: [{ name: 'slotD', kind: 'k3', required: true }] })

      const template = makeTemplate(
        [nodeA, nodeB, nodeC, nodeD],
        [
          { source: 'A', target: 'B' },
          { source: 'B', target: 'C' },
          { source: 'C', target: 'D' },
        ],
      )

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        skipNodeIds: ['A'],
      })

      expect(result.status).toBe('failed')
      expect(result.skippedNodeIds).toEqual(['A'])
      expect(result.blockedNodeIds).toContain('B')
      expect(result.completedNodeIds).toEqual([])
    })

    // 7. RERUN FAILED: creates attempt 2 and completes, leaving attempt 1 immutable
    it('rerun of failed node creates attempt 2 and completes, preserving attempt 1 immutability', async () => {
      const template = makeTemplate([makeNode('A')])

      let attemptCount = 0
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: () => {
          attemptCount++
          if (attemptCount === 1) {
            return { status: 'failed', error: 'Network timeout' }
          }
          return { status: 'completed' }
        },
      })

      const run1 = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run1.status).toBe('failed')
      expect(run1.failedNodeIds).toEqual(['A'])

      const attemptsAfter1 = workflowStore.getNodeAttempts(run1.graphRunId, 'A')
      expect(attemptsAfter1).toHaveLength(1)
      expect(attemptsAfter1[0]!.attempt).toBe(1)
      expect(attemptsAfter1[0]!.status).toBe('failed')

      // Rerun node A
      const run2 = await executor.rerunNode({
        graphRunId: run1.graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        targetNodeId: 'A',
      })

      expect(run2.status).toBe('completed')
      expect(run2.completedNodeIds).toEqual(['A'])

      const attemptsAfter2 = workflowStore.getNodeAttempts(run1.graphRunId, 'A')
      expect(attemptsAfter2).toHaveLength(2)
      expect(attemptsAfter2[0]!.attempt).toBe(1)
      expect(attemptsAfter2[0]!.status).toBe('failed')
      expect(attemptsAfter2[1]!.attempt).toBe(2)
      expect(attemptsAfter2[1]!.status).toBe('completed')

      // getLatestNodeRuns returns attempt 2
      const latest = workflowStore.getLatestNodeRuns(run1.graphRunId)
      expect(latest.find((n) => n.nodeId === 'A')?.attempt).toBe(2)
      expect(latest.find((n) => n.nodeId === 'A')?.status).toBe('completed')
    })

    // 8. RERUN SKIPPED: creates attempt 2 and completes
    it('rerun of skipped node creates attempt 2 and completes', async () => {
      const template = makeTemplate([makeNode('A')])

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: () => ({ status: 'completed' }),
      })

      const run1 = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        skipNodeIds: ['A'],
      })

      expect(run1.skippedNodeIds).toEqual(['A'])

      const run2 = await executor.rerunNode({
        graphRunId: run1.graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        targetNodeId: 'A',
      })

      expect(run2.status).toBe('completed')
      expect(run2.completedNodeIds).toEqual(['A'])
      expect(run2.skippedNodeIds).toEqual([])

      const attempts = workflowStore.getNodeAttempts(run1.graphRunId, 'A')
      expect(attempts).toHaveLength(2)
      expect(attempts[0]!.attempt).toBe(1)
      expect(attempts[0]!.status).toBe('skipped')
      expect(attempts[1]!.attempt).toBe(2)
      expect(attempts[1]!.status).toBe('completed')
    })

    // 9. RERUN CANCELLED: creates attempt 2 and completes
    it('rerun of cancelled node creates attempt 2 and completes', async () => {
      const template = makeTemplate([makeNode('A')])
      const controller = new AbortController()

      let executedOnce = false
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: () => {
          if (!executedOnce) {
            executedOnce = true
            controller.abort()
          }
          return { status: 'completed' }
        },
      })

      const run1 = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        signal: controller.signal,
      })

      expect(run1.status).toBe('cancelled')

      const run2 = await executor.rerunNode({
        graphRunId: run1.graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        targetNodeId: 'A',
      })

      expect(run2.status).toBe('completed')
      expect(run2.completedNodeIds).toEqual(['A'])

      const attempts = workflowStore.getNodeAttempts(run1.graphRunId, 'A')
      expect(attempts).toHaveLength(2)
      expect(attempts[0]!.status).toBe('cancelled')
      expect(attempts[1]!.status).toBe('completed')
    })

    // 10. RERUN COMPLETED: monotonic attempt advances and produces new artifacts
    it('rerun of completed node advances attempt and produces fresh artifacts without mutating historical ones', async () => {
      const template = makeTemplate([makeNode('A')])

      let attemptCounter = 0
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        testOnlyAllowEphemeralArtifacts: true,
        executeLeafNode: () => {
          attemptCounter++
          return {
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: 'A',
                kind: 'output',
                format: 'markdown',
                title: `Output Attempt ${String(attemptCounter)}`,
                content: `Content from attempt ${String(attemptCounter)}`,
                metadata: { attempt: attemptCounter },
                createdAt: NOW,
              },
            ],
          }
        },
      })

      const run1 = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run1.artifacts).toHaveLength(1)
      expect(run1.artifacts[0]!.title).toBe('Output Attempt 1')

      const run2 = await executor.rerunNode({
        graphRunId: run1.graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        targetNodeId: 'A',
      })

      expect(run2.artifacts).toHaveLength(1)
      expect(run2.artifacts[0]!.title).toBe('Output Attempt 2')

      const attempts = workflowStore.getNodeAttempts(run1.graphRunId, 'A')
      expect(attempts).toHaveLength(2)
      expect(attempts[0]!.attempt).toBe(1)
      expect(attempts[1]!.attempt).toBe(2)
    })

    // 11. CASCADE RERUN A -> B: B re-executes with fresh A2 output, B1 remains immutable
    it('cascade rerun A -> B: B re-executes consuming A2 output and leaves B1 immutable', async () => {
      const nodeA = makeNode('A')
      const nodeB = makeNode('B', { inputs: [{ name: 'plan', kind: 'plan', required: true }] })
      const template = makeTemplate([nodeA, nodeB], [{ source: 'A', target: 'B' }])

      let aCount = 0
      let bReceivedContent: string | null = null

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        testOnlyAllowEphemeralArtifacts: true,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'A') {
            aCount++
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'A',
                  kind: 'plan',
                  format: 'markdown',
                  title: `Plan ${String(aCount)}`,
                  content: `Plan version ${String(aCount)}`,
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'B') {
            bReceivedContent = ctx.incomingSlots.get('plan')?.content ?? null
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run1 = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run1.status).toBe('completed')
      expect(bReceivedContent).toBe('Plan version 1')

      // Rerun node A
      const run2 = await executor.rerunNode({
        graphRunId: run1.graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        targetNodeId: 'A',
      })

      expect(run2.status).toBe('completed')
      expect(bReceivedContent).toBe('Plan version 2')

      const aAttempts = workflowStore.getNodeAttempts(run1.graphRunId, 'A')
      const bAttempts = workflowStore.getNodeAttempts(run1.graphRunId, 'B')

      expect(aAttempts).toHaveLength(2)
      expect(aAttempts[0]!.attempt).toBe(1)
      expect(aAttempts[1]!.attempt).toBe(2)

      expect(bAttempts).toHaveLength(2)
      expect(bAttempts[0]!.attempt).toBe(1)
      expect(bAttempts[1]!.attempt).toBe(2)
    })

    // 12. CASCADE RERUN A -> B -> C: strictly fresh outputs, no stale outputs leak
    it('cascade rerun A -> B -> C: downstream attempts execute with strictly fresh outputs', async () => {
      const nodeA = makeNode('A')
      const nodeB = makeNode('B', { inputs: [{ name: 'dataA', kind: 'dataA', required: true }] })
      const nodeC = makeNode('C', { inputs: [{ name: 'dataB', kind: 'dataB', required: true }] })
      const template = makeTemplate(
        [nodeA, nodeB, nodeC],
        [
          { source: 'A', target: 'B' },
          { source: 'B', target: 'C' },
        ],
      )

      let round = 1
      let cObservedData: string | null = null

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        testOnlyAllowEphemeralArtifacts: true,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'A') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'A',
                  kind: 'dataA',
                  format: 'text',
                  title: 'A Output',
                  content: `A-round-${String(round)}`,
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'B') {
            const incoming = ctx.incomingSlots.get('dataA')?.content ?? ''
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'B',
                  kind: 'dataB',
                  format: 'text',
                  title: 'B Output',
                  content: `B-transformed(${incoming})`,
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'C') {
            cObservedData = ctx.incomingSlots.get('dataB')?.content ?? null
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run1 = await executor.run({ workflowId, projectId, template, forkSha })
      expect(run1.status).toBe('completed')
      expect(cObservedData).toBe('B-transformed(A-round-1)')

      // Trigger rerun on A with round 2
      round = 2
      const run2 = await executor.rerunNode({
        graphRunId: run1.graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        targetNodeId: 'A',
      })

      expect(run2.status).toBe('completed')
      expect(cObservedData).toBe('B-transformed(A-round-2)')

      const aAttempts = workflowStore.getNodeAttempts(run1.graphRunId, 'A')
      const bAttempts = workflowStore.getNodeAttempts(run1.graphRunId, 'B')
      const cAttempts = workflowStore.getNodeAttempts(run1.graphRunId, 'C')

      expect(aAttempts).toHaveLength(2)
      expect(bAttempts).toHaveLength(2)
      expect(cAttempts).toHaveLength(2)
    })

    // 13. RERUN RECOVERY: A skipped, B blocked -> rerun A -> A2 completes -> B2 unblocks and completes
    it('rerun recovery: A skipped, B blocked -> rerun A -> A2 completes -> B2 unblocks and completes', async () => {
      const nodeA = makeNode('A')
      const nodeB = makeNode('B', { inputs: [{ name: 'spec', kind: 'markdown', required: true }] })
      const template = makeTemplate([nodeA, nodeB], [{ source: 'A', target: 'B' }])

      let bRan = false

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        testOnlyAllowEphemeralArtifacts: true,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'A') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'A',
                  kind: 'markdown',
                  format: 'markdown',
                  title: 'Spec',
                  content: '# Specification from A2\n',
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'B') {
            bRan = true
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      // Run 1: A is skipped, B blocks
      const run1 = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        skipNodeIds: ['A'],
      })

      expect(run1.status).toBe('failed')
      expect(run1.skippedNodeIds).toEqual(['A'])
      expect(run1.blockedNodeIds).toEqual(['B'])
      expect(bRan).toBe(false)

      // Rerun A
      const run2 = await executor.rerunNode({
        graphRunId: run1.graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        targetNodeId: 'A',
      })

      expect(run2.status).toBe('completed')
      expect(run2.completedNodeIds).toContain('A')
      expect(run2.completedNodeIds).toContain('B')
      expect(bRan).toBe(true)

      const aAttempts = workflowStore.getNodeAttempts(run1.graphRunId, 'A')
      const bAttempts = workflowStore.getNodeAttempts(run1.graphRunId, 'B')
      expect(aAttempts).toHaveLength(2)
      expect(aAttempts[0]!.status).toBe('skipped')
      expect(aAttempts[1]!.status).toBe('completed')

      expect(bAttempts).toHaveLength(2)
      expect(bAttempts[0]!.status).toBe('blocked')
      expect(bAttempts[1]!.status).toBe('completed')
    })

    // 14. STATE HYDRATION: existing graphRunId does not create duplicate graph_runs row
    it('state hydration: running an existing graphRunId hydrates completed state without duplicate insert', async () => {
      const template = makeTemplate([makeNode('A'), makeNode('B')], [{ source: 'A', target: 'B' }])

      let aExecutionCount = 0
      let bExecutionCount = 0

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'A') {
            aExecutionCount++
            return { status: 'completed' }
          }
          if (ctx.node.id === 'B') {
            bExecutionCount++
            if (bExecutionCount === 1) {
              return { status: 'failed', error: 'Failure 1' }
            }
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run1 = await executor.run({ workflowId, projectId, template, forkSha })
      expect(run1.status).toBe('failed')
      expect(aExecutionCount).toBe(1)
      expect(bExecutionCount).toBe(1)

      // Re-run with the same graphRunId (e.g. rerunning B)
      const run2 = await executor.rerunNode({
        graphRunId: run1.graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        targetNodeId: 'B',
      })

      expect(run2.status).toBe('completed')
      // A was already completed and was NOT downstream of B, so A was NOT re-executed
      expect(aExecutionCount).toBe(1)
      expect(bExecutionCount).toBe(2)
    })

    // 15. WORKTREE ON RERUN: clean branch worktree re-allocated at forkSha without directory collision
    it('worktree isolation on rerun: write node re-prepares clean branch worktree without directory collision', async () => {
      const template = makeTemplate([makeNode('worker')])

      let round = 1
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: (ctx) => {
          if (ctx.worktreePath) {
            writeFileSync(join(ctx.worktreePath, 'output.txt'), `Run round ${String(round)}\n`)
          }
          return { status: 'completed' }
        },
      })

      const run1 = await executor.run({ workflowId, projectId, template, forkSha })
      expect(run1.status).toBe('completed')

      // Rerun worker
      round = 2
      const run2 = await executor.rerunNode({
        graphRunId: run1.graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        targetNodeId: 'worker',
      })

      expect(run2.status).toBe('completed')
      expect(run2.completedNodeIds).toEqual(['worker'])

      const attempts = workflowStore.getNodeAttempts(run1.graphRunId, 'worker')
      expect(attempts).toHaveLength(2)
      expect(attempts[0]!.status).toBe('completed')
      expect(attempts[1]!.status).toBe('completed')
    })

    // 16. EXPLICIT skipNode() METHOD: validates predecessors are finished and transitions ready -> skipped
    it('skipNode() validates predecessor completion and records skipped attempt with checkpoints', async () => {
      const template = makeTemplate([makeNode('A'), makeNode('B')], [{ source: 'A', target: 'B' }])

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
      })

      // Attempting to skip B before run starts should fail because A is not finished
      await expect(
        executor.skipNode({
          graphRunId: 'nonexistent',
          workflowId,
          projectId,
          template,
          nodeId: 'B',
        }),
      ).rejects.toThrow('predecessor "A" is not finished')

      // Run A to completion
      const run = await executor.run({
        workflowId,
        projectId,
        template: makeTemplate([makeNode('A')]),
        forkSha,
      })

      // Now skip B on this run
      const skippedB = await executor.skipNode({
        graphRunId: run.graphRunId,
        workflowId,
        projectId,
        template,
        nodeId: 'B',
      })

      expect(skippedB.nodeId).toBe('B')
      expect(skippedB.status).toBe('skipped')
      expect(skippedB.attempt).toBe(1)

      // Attempting to skip B again throws that it is already in terminal status
      await expect(
        executor.skipNode({
          graphRunId: run.graphRunId,
          workflowId,
          projectId,
          template,
          nodeId: 'B',
        }),
      ).rejects.toThrow('already in terminal status "skipped"')
    })

    // 17. REGRESSION: skipNode() on a running node throws and does not mutate running attempt or state
    it('skipNode() on a running node throws and does not mutate running attempt or state', async () => {
      const graphRunId = randomUUID()
      const template = makeTemplate([makeNode('A')])

      let nodeAStartedResolve: (() => void) | undefined
      const nodeAStarted = new Promise<void>((resolve) => {
        nodeAStartedResolve = resolve
      })
      let nodeAContinueResolve: (() => void) | undefined
      const nodeAContinue = new Promise<void>((resolve) => {
        nodeAContinueResolve = resolve
      })

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: async (ctx) => {
          if (ctx.node.id === 'A') {
            nodeAStartedResolve?.()
            await nodeAContinue
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const runPromise = executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      // Wait for node A to start running
      await nodeAStarted

      // Confirm attempt 1 is currently in status 'running'
      const attemptsBefore = workflowStore.getNodeAttempts(graphRunId, 'A')
      expect(attemptsBefore).toHaveLength(1)
      expect(attemptsBefore[0]!.status).toBe('running')
      expect(attemptsBefore[0]!.attempt).toBe(1)

      const checkpointsBefore = workflowStore.getLatestGraphCheckpoint(graphRunId)
      expect(checkpointsBefore?.operation).toBe('node.started')

      // Attempt to skip node A while running MUST throw/reject
      await expect(
        executor.skipNode({
          graphRunId,
          workflowId,
          projectId,
          template,
          nodeId: 'A',
        }),
      ).rejects.toThrow('Node "A" is currently running and cannot be skipped')

      // Verify attempt 1 was NOT mutated
      const attemptsAfterSkipAttempt = workflowStore.getNodeAttempts(graphRunId, 'A')
      expect(attemptsAfterSkipAttempt).toHaveLength(1)
      expect(attemptsAfterSkipAttempt[0]!.status).toBe('running')
      expect(attemptsAfterSkipAttempt[0]!.attempt).toBe(1)
      expect(attemptsAfterSkipAttempt[0]!.changeSetId).toBeNull()

      // Verify no 'node.skipped' checkpoint was written
      const checkpointsAfterSkip = workflowStore.getLatestGraphCheckpoint(graphRunId)
      expect(checkpointsAfterSkip?.operation).toBe('node.started')

      // Allow node A to finish execution
      nodeAContinueResolve?.()
      const result = await runPromise

      // Confirm node A completes normally
      expect(result.status).toBe('completed')
      expect(result.completedNodeIds).toEqual(['A'])
      expect(result.skippedNodeIds).toEqual([])

      const attemptsFinal = workflowStore.getNodeAttempts(graphRunId, 'A')
      expect(attemptsFinal).toHaveLength(1)
      expect(attemptsFinal[0]!.status).toBe('completed')

      // Also verify direct rejection when latest attempt in DB has status 'running'
      const directRunId = randomUUID()
      workflowStore.startGraphRun(
        {
          graphRunId: directRunId,
          projectId,
          workflowId,
          templateId: template.id,
          startedAt: NOW,
        },
        'user',
      )
      workflowStore.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId: directRunId,
          nodeId: 'A',
          attempt: 1,
          status: 'running',
          startedAt: NOW,
        },
        'user',
      )
      await expect(
        executor.skipNode({
          graphRunId: directRunId,
          workflowId,
          projectId,
          template,
          nodeId: 'A',
        }),
      ).rejects.toThrow('Node "A" is currently running and cannot be skipped')

      const directAttempts = workflowStore.getNodeAttempts(directRunId, 'A')
      expect(directAttempts).toHaveLength(1)
      expect(directAttempts[0]!.status).toBe('running')
    })
  })

  describe('WORK-003 Slice 2A: Router Nodes, Conditional Branching, and Eager Pruning', () => {
    it('TC-2A-01: selects first matching branch in declaration order (XOR routing)', async () => {
      const routerNode = makeNode('router', { type: 'router' })
      const branchA = makeNode('branchA')
      const branchB = makeNode('branchB')

      const template = makeTemplate(
        [routerNode, branchA, branchB],
        [
          {
            id: 'e-router-a',
            source: 'router',
            target: 'branchA',
            condition: {
              mode: 'all',
              predicates: [
                { ref: 'context.priority', operator: 'in', value: ['high', 'critical'] },
              ],
            },
          },
          {
            id: 'e-router-b',
            source: 'router',
            target: 'branchB',
            condition: {
              mode: 'all',
              predicates: [{ ref: 'context.priority', operator: 'eq', value: 'high' }],
            },
          },
        ],
      )

      const executedNodes: string[] = []
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: (ctx) => {
          executedNodes.push(ctx.node.id)
          return { status: 'completed' }
        },
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        initialContext: { priority: 'high' },
      })

      expect(result.status).toBe('completed')
      expect(result.completedNodeIds).toContain('router')
      expect(result.completedNodeIds).toContain('branchA')
      expect(result.skippedNodeIds).toContain('branchB')
      expect(executedNodes).toEqual(['branchA'])

      const attempts = workflowStore.getNodeAttempts(result.graphRunId, 'router')
      expect(attempts[0]!.status).toBe('completed')

      const bAttempts = workflowStore.getNodeAttempts(result.graphRunId, 'branchB')
      expect(bAttempts).toHaveLength(1)
      expect(bAttempts[0]!.status).toBe('skipped')
    })

    it('TC-2A-02: falls back to default branch when no conditions match', async () => {
      const router = makeNode('router', { type: 'router' })
      const prodBranch = makeNode('prodBranch')
      const defaultBranch = makeNode('defaultBranch')

      const template = makeTemplate(
        [router, prodBranch, defaultBranch],
        [
          {
            id: 'e-prod',
            source: 'router',
            target: 'prodBranch',
            condition: {
              mode: 'all',
              predicates: [{ ref: 'context.env', operator: 'eq', value: 'prod' }],
            },
          },
          {
            id: 'e-default',
            source: 'router',
            target: 'defaultBranch',
            isDefault: true,
          },
        ],
      )

      const executedNodes: string[] = []
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: (ctx) => {
          executedNodes.push(ctx.node.id)
          return { status: 'completed' }
        },
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        initialContext: { env: 'staging' },
      })

      expect(result.status).toBe('completed')
      expect(result.completedNodeIds).toContain('router')
      expect(result.completedNodeIds).toContain('defaultBranch')
      expect(result.skippedNodeIds).toContain('prodBranch')
      expect(executedNodes).toEqual(['defaultBranch'])
    })

    it('TC-2A-03: fails when no condition matches and no default branch is declared', async () => {
      const router = makeNode('router', { type: 'router' })
      const branchA = makeNode('branchA')

      const template = makeTemplate(
        [router, branchA],
        [
          {
            id: 'e-a',
            source: 'router',
            target: 'branchA',
            condition: {
              mode: 'all',
              predicates: [{ ref: 'context.env', operator: 'eq', value: 'prod' }],
            },
          },
        ],
      )

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        initialContext: { env: 'dev' },
      })

      expect(result.status).toBe('failed')
      expect(result.failedNodeIds).toContain('router')
      expect(result.error).toContain(
        'No routing condition satisfied and no default branch declared',
      )

      const attempts = workflowStore.getNodeAttempts(result.graphRunId, 'router')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]!.status).toBe('failed')
    })

    it('TC-2A-07: evaluates complex condition predicates and modes correctly', async () => {
      const router = makeNode('router', { type: 'router' })
      const targetNode = makeNode('targetNode')
      const fallbackNode = makeNode('fallbackNode')

      const template = makeTemplate(
        [router, targetNode, fallbackNode],
        [
          {
            id: 'e-target',
            source: 'router',
            target: 'targetNode',
            condition: {
              mode: 'all',
              predicates: [
                { ref: 'context.tag', operator: 'in', value: ['release', 'hotfix'] },
                { ref: 'context.tier', operator: 'neq', value: 'free' },
                { ref: 'run.iteration', operator: 'eq', value: 1 },
              ],
            },
          },
          {
            id: 'e-fallback',
            source: 'router',
            target: 'fallbackNode',
            isDefault: true,
          },
        ],
      )

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: () => ({ status: 'completed' }),
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        initialContext: { tag: 'release', tier: 'premium' },
      })

      expect(result.status).toBe('completed')
      expect(result.completedNodeIds).toContain('targetNode')
      expect(result.skippedNodeIds).toContain('fallbackNode')
    })

    it('TC-2A-08: evaluates condition on incoming artifact JSON payload with fail-closed semantics', async () => {
      const producer = makeNode('producer')
      const router = makeNode('router', { type: 'router' })
      const passBranch = makeNode('passBranch')
      const failBranch = makeNode('failBranch')

      const template = makeTemplate(
        [producer, router, passBranch, failBranch],
        [
          {
            id: 'e-prod-router',
            source: 'producer',
            target: 'router',
            sourceHandle: 'eval_metrics',
            targetHandle: 'metrics',
          },
          {
            id: 'e-router-pass',
            source: 'router',
            target: 'passBranch',
            condition: {
              mode: 'all',
              predicates: [
                { ref: 'artifacts.metrics.quality.score', operator: 'gte', value: 90 },
                { ref: 'artifacts.metrics.missing_prop', operator: 'neq', value: 'foo' },
              ],
            },
          },
          {
            id: 'e-router-fail',
            source: 'router',
            target: 'failBranch',
            isDefault: true,
          },
        ],
      )

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        testOnlyAllowEphemeralArtifacts: true,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'producer') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'producer',
                  kind: 'eval_metrics',
                  format: 'json',
                  title: 'metrics.json',
                  content: JSON.stringify({ quality: { score: 95 } }),
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          }
          return { status: 'completed' }
        },
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(result.status).toBe('completed')
      expect(result.completedNodeIds).toContain('failBranch')
      expect(result.skippedNodeIds).toContain('passBranch')
    })

    it('TC-2A-09: eagerly prunes cascade chains of unselected downstream nodes', async () => {
      const router = makeNode('router', { type: 'router' })
      const selectedNode = makeNode('sel')
      const unselectedA = makeNode('unselA')
      const unselectedB = makeNode('unselB')
      const unselectedC = makeNode('unselC')

      const template = makeTemplate(
        [router, selectedNode, unselectedA, unselectedB, unselectedC],
        [
          {
            id: 'e-sel',
            source: 'router',
            target: 'sel',
            condition: {
              mode: 'all',
              predicates: [{ ref: 'context.flag', operator: 'eq', value: 'yes' }],
            },
          },
          {
            id: 'e-unsel',
            source: 'router',
            target: 'unselA',
            isDefault: true,
          },
          { id: 'e-ab', source: 'unselA', target: 'unselB' },
          { id: 'e-bc', source: 'unselB', target: 'unselC' },
        ],
      )

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: () => ({ status: 'completed' }),
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        initialContext: { flag: 'yes' },
      })

      expect(result.status).toBe('completed')
      expect(result.completedNodeIds).toContain('sel')
      expect(result.skippedNodeIds).toContain('unselA')
      expect(result.skippedNodeIds).toContain('unselB')
      expect(result.skippedNodeIds).toContain('unselC')

      for (const skippedId of ['unselA', 'unselB', 'unselC']) {
        const attempts = workflowStore.getNodeAttempts(result.graphRunId, skippedId)
        expect(attempts).toHaveLength(1)
        expect(attempts[0]!.status).toBe('skipped')
      }
    })

    it('TC-2A-10: preserves diamond convergence when unselected branch converges with selected branch', async () => {
      const router = makeNode('router', { type: 'router' })
      const branchA = makeNode('branchA')
      const branchB = makeNode('branchB')
      const joinNode = makeNode('joinNode')

      const template = makeTemplate(
        [router, branchA, branchB, joinNode],
        [
          {
            id: 'e-router-a',
            source: 'router',
            target: 'branchA',
            condition: {
              mode: 'all',
              predicates: [{ ref: 'context.target', operator: 'eq', value: 'A' }],
            },
          },
          {
            id: 'e-router-b',
            source: 'router',
            target: 'branchB',
            isDefault: true,
          },
          { id: 'e-a-join', source: 'branchA', target: 'joinNode' },
          { id: 'e-b-join', source: 'branchB', target: 'joinNode' },
        ],
      )

      const executedNodes: string[] = []
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: (ctx) => {
          executedNodes.push(ctx.node.id)
          return { status: 'completed' }
        },
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        initialContext: { target: 'A' },
      })

      expect(result.status).toBe('completed')
      expect(result.completedNodeIds).toContain('router')
      expect(result.completedNodeIds).toContain('branchA')
      expect(result.skippedNodeIds).toContain('branchB')
      expect(result.completedNodeIds).toContain('joinNode')
      expect(executedNodes).toEqual(['branchA', 'joinNode'])
    })

    it('TC-2A-11: protects multi-predecessor node from pruning when an active alternate path exists', async () => {
      const rootWorker = makeNode('rootWorker')
      const router = makeNode('router', { type: 'router' })
      const branchA = makeNode('branchA')
      const branchB = makeNode('branchB')
      const multiPredNode = makeNode('multiPred')

      const template = makeTemplate(
        [rootWorker, router, branchA, branchB, multiPredNode],
        [
          {
            id: 'e-router-a',
            source: 'router',
            target: 'branchA',
            condition: {
              mode: 'all',
              predicates: [{ ref: 'context.takeA', operator: 'eq', value: 'true' }],
            },
          },
          {
            id: 'e-router-b',
            source: 'router',
            target: 'branchB',
            isDefault: true,
          },
          { id: 'e-root-multi', source: 'rootWorker', target: 'multiPred' },
          { id: 'e-b-multi', source: 'branchB', target: 'multiPred' },
        ],
      )

      const executedNodes: string[] = []
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: (ctx) => {
          executedNodes.push(ctx.node.id)
          return { status: 'completed' }
        },
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        initialContext: { takeA: 'true' },
      })

      expect(result.status).toBe('completed')
      expect(result.completedNodeIds).toContain('branchA')
      expect(result.skippedNodeIds).toContain('branchB')
      expect(result.completedNodeIds).toContain('rootWorker')
      expect(result.completedNodeIds).toContain('multiPred')
      expect(executedNodes).toContain('multiPred')
    })

    it('TC-2A-12: transitions downstream node to blocked when required input from skipped predecessor is missing', async () => {
      const router = makeNode('router', { type: 'router' })
      const branchA = makeNode('branchA')
      const branchB = makeNode('branchB')
      const joinNode = makeNode('joinNode', {
        inputs: [
          {
            name: 'b_data',
            kind: 'data_b',
            required: true,
          },
        ],
      })

      const template = makeTemplate(
        [router, branchA, branchB, joinNode],
        [
          {
            id: 'e-router-a',
            source: 'router',
            target: 'branchA',
            condition: {
              mode: 'all',
              predicates: [{ ref: 'context.mode', operator: 'eq', value: 'A' }],
            },
          },
          {
            id: 'e-router-b',
            source: 'router',
            target: 'branchB',
            isDefault: true,
          },
          { id: 'e-a-join', source: 'branchA', target: 'joinNode' },
          { id: 'e-b-join', source: 'branchB', target: 'joinNode' },
        ],
      )

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'branchB') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'branchB',
                  kind: 'data_b',
                  format: 'text',
                  title: 'b.txt',
                  content: 'data from B',
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          }
          return { status: 'completed' }
        },
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
        initialContext: { mode: 'A' },
      })

      expect(result.status).toBe('failed')
      expect(result.completedNodeIds).toContain('branchA')
      expect(result.skippedNodeIds).toContain('branchB')
      expect(result.blockedNodeIds).toContain('joinNode')

      const joinAttempts = workflowStore.getNodeAttempts(result.graphRunId, 'joinNode')
      expect(joinAttempts).toHaveLength(1)
      expect(joinAttempts[0]!.status).toBe('blocked')
      expect(joinAttempts[0]!.error).toContain('Missing required input slot: b_data')
    })

    it('TC-2A-13: replaying a completed run with routers is idempotent without duplicate attempts', async () => {
      const router = makeNode('router', { type: 'router' })
      const branchA = makeNode('branchA')

      const template = makeTemplate(
        [router, branchA],
        [
          {
            id: 'e-router-a',
            source: 'router',
            target: 'branchA',
            isDefault: true,
          },
        ],
      )

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: () => ({ status: 'completed' }),
      })

      const run1 = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run1.status).toBe('completed')
      const routerAttempts1 = workflowStore.getNodeAttempts(run1.graphRunId, 'router')
      const aAttempts1 = workflowStore.getNodeAttempts(run1.graphRunId, 'branchA')
      expect(routerAttempts1).toHaveLength(1)
      expect(aAttempts1).toHaveLength(1)

      // Replay
      const run2 = await executor.run({
        graphRunId: run1.graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run2.status).toBe('completed')
      const routerAttempts2 = workflowStore.getNodeAttempts(run1.graphRunId, 'router')
      const aAttempts2 = workflowStore.getNodeAttempts(run1.graphRunId, 'branchA')
      expect(routerAttempts2).toHaveLength(1)
      expect(aAttempts2).toHaveLength(1)
    })

    it('TC-2A-14: non-router parallel fan-out remains unaffected and executes all branches', async () => {
      const workerRoot = makeNode('workerRoot')
      const workerA = makeNode('workerA')
      const workerB = makeNode('workerB')

      const template = makeTemplate(
        [workerRoot, workerA, workerB],
        [
          { id: 'e-root-a', source: 'workerRoot', target: 'workerA' },
          { id: 'e-root-b', source: 'workerRoot', target: 'workerB' },
        ],
      )

      const executedNodes: string[] = []
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        executeLeafNode: (ctx) => {
          executedNodes.push(ctx.node.id)
          return { status: 'completed' }
        },
      })

      const result = await executor.run({
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(result.status).toBe('completed')
      expect(result.completedNodeIds).toContain('workerRoot')
      expect(result.completedNodeIds).toContain('workerA')
      expect(result.completedNodeIds).toContain('workerB')
      expect(result.skippedNodeIds).toHaveLength(0)
      expect(executedNodes).toContain('workerA')
      expect(executedNodes).toContain('workerB')
    })
  })

  describe('WORK-003 Slice 2B: Feedback-Loop Scheduling, Iteration Advancement, and Worktree Patching', () => {
    describe('Scheduling (TC-2B-SCHED)', () => {
      it('TC-2B-SCHED-01: basic iteration advancement resets loop body and executes target in iteration 2', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const exitNode = makeNode('exitNode')

        const template = makeTemplate(
          [worker, router, exitNode],
          [
            { id: 'e-worker-router', source: 'worker', target: 'router' },
            {
              id: 'e-router-worker',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'lt', value: 2 }],
              },
            },
            {
              id: 'e-router-exit',
              source: 'router',
              target: 'exitNode',
              isDefault: true,
            },
          ],
        )

        const iterationsSeen: number[] = []
        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          executeLeafNode: (ctx) => {
            if (ctx.node.id === 'worker') {
              iterationsSeen.push(ctx.iteration ?? 1)
            }
            return { status: 'completed' }
          },
        })

        const result = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(result.status).toBe('completed')
        expect(result.completedNodeIds).toContain('worker')
        expect(result.completedNodeIds).toContain('router')
        expect(result.completedNodeIds).toContain('exitNode')
        expect(iterationsSeen).toEqual([1, 2])

        // Verify iteration.advanced checkpoint exists
        const checkpoints = workflowStore.getGraphCheckpoints(result.graphRunId)
        const advCheckpoint = checkpoints.find((cp) => cp.operation === 'iteration.advanced')
        expect(advCheckpoint).toBeDefined()
        expect(advCheckpoint?.nodeId).toBe('worker')
        const runInDb = workflowStore.getGraphRun(result.graphRunId)
        expect(runInDb?.iteration).toBe(2)
      })

      it('TC-2B-SCHED-02: router feedback then exit records decision artifacts with correct isFeedback lineage', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const exitNode = makeNode('exitNode')

        const template = makeTemplate(
          [worker, router, exitNode],
          [
            { id: 'e-worker-router', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'eq', value: 1 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'exitNode',
              isDefault: true,
            },
          ],
        )

        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          executeLeafNode: () => ({ status: 'completed' }),
        })

        const result = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(result.status).toBe('completed')

        // Router ran in both iterations
        const routerAttempts = workflowStore.getNodeAttempts(result.graphRunId, 'router')
        expect(routerAttempts).toHaveLength(2)
        expect(routerAttempts[0]!.status).toBe('completed')
        expect(routerAttempts[1]!.status).toBe('completed')

        // Inspect routing-decision artifacts
        const decisionArtifacts = result.artifacts.filter((a) => a.kind === 'routing-decision')
        expect(decisionArtifacts).toHaveLength(2)

        const d1 = JSON.parse(decisionArtifacts[0]!.content) as {
          selectedEdgeId: string
          isFeedback: boolean
        }
        expect(d1.selectedEdgeId).toBe('e-feedback')
        expect(d1.isFeedback).toBe(true)

        const d2 = JSON.parse(decisionArtifacts[1]!.content) as {
          selectedEdgeId: string
          isFeedback: boolean
        }
        expect(d2.selectedEdgeId).toBe('e-exit')
        expect(d2.isFeedback).toBe(false)
      })

      it('TC-2B-SCHED-03: monotonic attempts: node attempts strictly increment and historical attempts remain immutable', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const exitNode = makeNode('exitNode')

        const template = makeTemplate(
          [worker, router, exitNode],
          [
            { id: 'e-worker-router', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'lt', value: 3 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'exitNode',
              isDefault: true,
            },
          ],
        )

        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => ({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'data',
                format: 'json',
                title: `worker-iter-${String(ctx.iteration ?? 1)}.json`,
                content: JSON.stringify({ iter: ctx.iteration }),
                metadata: {},
                createdAt: NOW,
              },
            ],
          }),
        })

        const result = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(result.status).toBe('completed')

        const workerAttempts = workflowStore.getNodeAttempts(result.graphRunId, 'worker')
        expect(workerAttempts).toHaveLength(3)
        expect(workerAttempts.map((a) => a.attempt)).toEqual([1, 2, 3])
        expect(workerAttempts.every((a) => a.status === 'completed')).toBe(true)

        // Historical attempt 1 remains unmodified
        expect(workerAttempts[0]!.attempt).toBe(1)
        expect(workerAttempts[0]!.finishedAt).toBeTruthy()
        expect(workerAttempts[1]!.attempt).toBe(2)
        expect(workerAttempts[2]!.attempt).toBe(3)
      })

      it('TC-2B-SCHED-04: Slice 2A pruning reset: iteration 1 selects B and prunes C, iteration 2 selects C, C executes normally', async () => {
        const entry = makeNode('entry')
        const branchRouter = makeNode('branchRouter', { type: 'router' })
        const workerB = makeNode('workerB')
        const workerC = makeNode('workerC')
        const feedbackRouter = makeNode('feedbackRouter', { type: 'router' })
        const doneNode = makeNode('doneNode')

        const template = makeTemplate(
          [entry, branchRouter, workerB, workerC, feedbackRouter, doneNode],
          [
            { id: 'e-entry-router', source: 'entry', target: 'branchRouter' },
            {
              id: 'e-router-b',
              source: 'branchRouter',
              target: 'workerB',
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'eq', value: 1 }],
              },
            },
            {
              id: 'e-router-c',
              source: 'branchRouter',
              target: 'workerC',
              isDefault: true,
            },
            { id: 'e-b-feedback', source: 'workerB', target: 'feedbackRouter' },
            { id: 'e-c-feedback', source: 'workerC', target: 'feedbackRouter' },
            {
              id: 'e-loop',
              source: 'feedbackRouter',
              target: 'entry',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'eq', value: 1 }],
              },
            },
            {
              id: 'e-done',
              source: 'feedbackRouter',
              target: 'doneNode',
              isDefault: true,
            },
          ],
        )

        const executedNodes: { id: string; iteration: number }[] = []
        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          executeLeafNode: (ctx) => {
            executedNodes.push({ id: ctx.node.id, iteration: ctx.iteration ?? 1 })
            return { status: 'completed' }
          },
        })

        const result = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(result.status).toBe('completed')
        expect(result.completedNodeIds).toContain('workerC')
        expect(result.completedNodeIds).toContain('doneNode')

        // workerB executed in iteration 1
        expect(executedNodes).toContainEqual({ id: 'workerB', iteration: 1 })
        // workerC executed in iteration 2
        expect(executedNodes).toContainEqual({ id: 'workerC', iteration: 2 })

        // Check attempts: workerB had attempt 1 completed (in iteration 1), attempt 2 skipped (in iteration 2)
        const bAttempts = workflowStore.getNodeAttempts(result.graphRunId, 'workerB')
        expect(bAttempts).toHaveLength(2)
        expect(bAttempts[0]!.status).toBe('completed')
        expect(bAttempts[1]!.status).toBe('skipped')

        // Check attempts: workerC had attempt 1 skipped (in iteration 1), attempt 2 completed (in iteration 2)
        const cAttempts = workflowStore.getNodeAttempts(result.graphRunId, 'workerC')
        expect(cAttempts).toHaveLength(2)
        expect(cAttempts[0]!.status).toBe('skipped')
        expect(cAttempts[1]!.status).toBe('completed')
      })

      it('TC-2B-SCHED-05: diamond convergence across iterations: parallel paths converge cleanly on each iteration', async () => {
        const entry = makeNode('entry')
        const forkA = makeNode('forkA')
        const forkB = makeNode('forkB')
        const joinNode = makeNode('joinNode')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [entry, forkA, forkB, joinNode, router, done],
          [
            { id: 'e-entry-a', source: 'entry', target: 'forkA' },
            { id: 'e-entry-b', source: 'entry', target: 'forkB' },
            { id: 'e-a-join', source: 'forkA', target: 'joinNode' },
            { id: 'e-b-join', source: 'forkB', target: 'joinNode' },
            { id: 'e-join-router', source: 'joinNode', target: 'router' },
            {
              id: 'e-router-entry',
              source: 'router',
              target: 'entry',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'eq', value: 1 }],
              },
            },
            {
              id: 'e-router-done',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        const runCountByNode = new Map<string, number>()
        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          executeLeafNode: (ctx) => {
            runCountByNode.set(ctx.node.id, (runCountByNode.get(ctx.node.id) ?? 0) + 1)
            return { status: 'completed' }
          },
        })

        const result = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(result.status).toBe('completed')
        expect(runCountByNode.get('entry')).toBe(2)
        expect(runCountByNode.get('forkA')).toBe(2)
        expect(runCountByNode.get('forkB')).toBe(2)
        expect(runCountByNode.get('joinNode')).toBe(2)
        expect(runCountByNode.get('done')).toBe(1)
      })

      it('TC-2B-SCHED-06: three iterations then exit executes loop 3 times and halts/exits cleanly', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-worker-router', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'lt', value: 3 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => ({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'data',
                format: 'json',
                title: 'iter.json',
                content: JSON.stringify({ iter: ctx.iteration }),
                metadata: {},
                createdAt: NOW,
              },
            ],
          }),
        })

        const result = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(result.status).toBe('completed')
        const workerAttempts = workflowStore.getNodeAttempts(result.graphRunId, 'worker')
        expect(workerAttempts).toHaveLength(3)

        const checkpoints = workflowStore.getGraphCheckpoints(result.graphRunId)
        const advCheckpoints = checkpoints.filter((cp) => cp.operation === 'iteration.advanced')
        expect(advCheckpoints).toHaveLength(2)
      })
    })

    describe('Worktree & Patching (TC-2B-WT)', () => {
      it('TC-2B-WT-01: iteration N changes materialized into N+1 worktree on disk', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'eq', value: 1 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        let iter2SawFile = false
        let iter2FileContent = ''

        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => {
            if (ctx.node.id === 'worker') {
              if (ctx.iteration === 1) {
                writeFileSync(join(ctx.worktreePath!, 'step1.txt'), 'iteration 1 file content\n')
              } else if (ctx.iteration === 2) {
                iter2SawFile = existsSync(join(ctx.worktreePath!, 'step1.txt'))
                if (iter2SawFile) {
                  iter2FileContent = readFileSync(join(ctx.worktreePath!, 'step1.txt'), 'utf8')
                }
              }
            }
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: ctx.node.id,
                  kind: 'state',
                  format: 'json',
                  title: 'state.json',
                  content: JSON.stringify({ iter: ctx.iteration }),
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          },
        })

        const result = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(result.status).toBe('completed')
        expect(iter2SawFile).toBe(true)
        expect(iter2FileContent).toBe('iteration 1 file content\n')
      })

      it('TC-2B-WT-02: cumulative code verified across 3 iterations in N+1 worktree', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'lt', value: 3 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        let iter3SawBoth = false

        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => {
            if (ctx.node.id === 'worker') {
              if (ctx.iteration === 1) {
                writeFileSync(join(ctx.worktreePath!, 'file1.txt'), 'file1 data\n')
              } else if (ctx.iteration === 2) {
                writeFileSync(join(ctx.worktreePath!, 'file2.txt'), 'file2 data\n')
              } else if (ctx.iteration === 3) {
                const has1 = existsSync(join(ctx.worktreePath!, 'file1.txt'))
                const has2 = existsSync(join(ctx.worktreePath!, 'file2.txt'))
                iter3SawBoth = has1 && has2
              }
            }
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: ctx.node.id,
                  kind: 'iter-state',
                  format: 'json',
                  title: 'iter-state.json',
                  content: JSON.stringify({ iter: ctx.iteration }),
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          },
        })

        const result = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(result.status).toBe('completed')
        expect(iter3SawBoth).toBe(true)
      })

      it('TC-2B-WT-03: patch application failure halts with HALTED_POLICY: patch-application-failed', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'eq', value: 1 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        const corruptChangeSet: ChangeSet = {
          id: changeSetIdSchema.parse(randomUUID()),
          baseSha: forkSha,
          headSha: null,
          files: [
            {
              path: 'fileA.txt',
              changeType: 'modified',
              previousPath: null,
              insertions: 1,
              deletions: 0,
            },
          ],
          patch: 'corrupt invalid patch header\n@@ not a real hunk @@\n',
          authorActor: 'system',
          stepId: 'worker' as StepId,
          taskId: 'test-template' as TaskId,
          correctsChangeSetId: null,
          reviewVerdict: null,
          discrepancies: [],
          capturedAt: NOW,
        }

        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => {
            if (ctx.node.id === 'worker' && ctx.iteration === 1) {
              return {
                status: 'completed',
                changeSet: corruptChangeSet,
                artifacts: [
                  {
                    id: randomUUID(),
                    workflowId,
                    nodeId: 'worker',
                    kind: 'dummy',
                    format: 'json',
                    title: 'dummy.json',
                    content: JSON.stringify({ iter: 1 }),
                    metadata: {},
                    createdAt: NOW,
                  },
                ],
              }
            }
            return { status: 'completed' }
          },
        })

        const result = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(result.status).toBe('halted')
        expect(result.haltReason).toBe('HALTED_POLICY: patch-application-failed')

        // iteration.halted checkpoint persisted
        const checkpoints = workflowStore.getGraphCheckpoints(result.graphRunId)
        const haltedCp = checkpoints.find((cp) => cp.operation === 'iteration.halted')
        expect(haltedCp).toBeDefined()
      })

      it('TC-2B-WT-04: worktree cleanup/recreation disposes worktrees without directory collision', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'eq', value: 1 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        const worktreePaths: string[] = []
        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => {
            if (ctx.worktreePath) {
              worktreePaths.push(ctx.worktreePath)
              writeFileSync(
                join(ctx.worktreePath, 'temp.txt'),
                `iter ${String(ctx.iteration ?? 1)}\n`,
              )
            }
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: ctx.node.id,
                  kind: 'data',
                  format: 'json',
                  title: 'd.json',
                  content: JSON.stringify({ iter: ctx.iteration }),
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          },
        })

        const result = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(result.status).toBe('completed')
        expect(worktreePaths.length).toBeGreaterThanOrEqual(2)
      })
    })

    describe('Bounds & Progress Detection (TC-2B-BOUND)', () => {
      it('TC-2B-BOUND-01: identical semantic state halts with HALTED_LIMIT: no-progress', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'lt', value: 10 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        // worker produces EXACTLY the same static artifact every iteration and makes no file edits
        const staticArtifact = {
          id: 'static-art-id',
          workflowId,
          nodeId: 'worker',
          kind: 'eval_report',
          format: 'json' as const,
          title: 'eval.json',
          content: JSON.stringify({ score: 42 }),
          metadata: {},
          createdAt: NOW,
        }

        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: () => ({
            status: 'completed',
            artifacts: [staticArtifact],
          }),
        })

        const result = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
          loopPolicy: {
            maxIterations: 5,
            maxRepeatedStates: 1, // First repetition immediately triggers halt
            maxNodeAttempts: 5,
          },
        })

        expect(result.status).toBe('halted')
        expect(result.haltReason).toBe('HALTED_LIMIT: no-progress')

        const checkpoints = workflowStore.getGraphCheckpoints(result.graphRunId)
        const haltedCp = checkpoints.find((cp) => cp.operation === 'iteration.halted')
        expect(haltedCp).toBeDefined()
      })

      it('TC-2B-BOUND-02: unchanged git diff but changed semantic artifact continues without no-progress halt', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'lt', value: 3 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        // Zero git diff, but artifact content changes each iteration
        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => ({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'eval_report',
                format: 'json',
                title: 'eval.json',
                content: JSON.stringify({ iterationProgress: ctx.iteration }),
                metadata: {},
                createdAt: NOW,
              },
            ],
          }),
        })

        const result = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
          loopPolicy: {
            maxIterations: 5,
            maxRepeatedStates: 1,
            maxNodeAttempts: 5,
          },
        })

        expect(result.status).toBe('completed')
        expect(result.completedNodeIds).toContain('done')
      })

      it('TC-2B-BOUND-03: maxIterations halts with HALTED_LIMIT: max-iterations-exceeded', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'lt', value: 100 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => ({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'data',
                format: 'json',
                title: 'data.json',
                content: JSON.stringify({ unique: randomUUID() }),
                metadata: {},
                createdAt: NOW,
              },
            ],
          }),
        })

        const result = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
          loopPolicy: {
            maxIterations: 2,
            maxRepeatedStates: 5,
            maxNodeAttempts: 5,
          },
        })

        expect(result.status).toBe('halted')
        expect(result.haltReason).toBe('HALTED_LIMIT: max-iterations-exceeded')

        // worker should have executed exactly 2 times (iterations 1 and 2)
        const workerAttempts = workflowStore.getNodeAttempts(result.graphRunId, 'worker')
        expect(workerAttempts).toHaveLength(2)
      })

      it('TC-2B-BOUND-04: halted run replay is idempotent without extra attempts or checkpoints', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'lt', value: 10 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => ({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'data',
                format: 'json',
                title: 'data.json',
                content: JSON.stringify({ unique: randomUUID() }),
                metadata: {},
                createdAt: NOW,
              },
            ],
          }),
        })

        const run1 = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
          loopPolicy: {
            maxIterations: 1,
            maxRepeatedStates: 5,
            maxNodeAttempts: 5,
          },
        })

        expect(run1.status).toBe('halted')
        const attemptsBefore = workflowStore.getNodeAttempts(run1.graphRunId, 'worker').length
        const checkpointsBefore = workflowStore.getGraphCheckpoints(run1.graphRunId).length

        // Replay the halted run
        const replay = await executor.run({
          graphRunId: run1.graphRunId,
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(replay.status).toBe('halted')
        const attemptsAfter = workflowStore.getNodeAttempts(run1.graphRunId, 'worker').length
        const checkpointsAfter = workflowStore.getGraphCheckpoints(run1.graphRunId).length

        expect(attemptsAfter).toBe(attemptsBefore)
        expect(checkpointsAfter).toBe(checkpointsBefore)
      })

      it('TC-2B-BOUND-05: default loopPolicy halts with HALTED_LIMIT: no-progress when loopPolicy option is omitted', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'lt', value: 5 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        const staticArtifact: WorkflowArtifact = {
          id: 'static-art-1',
          workflowId,
          nodeId: 'worker',
          kind: 'data',
          format: 'json',
          title: 'data.json',
          content: JSON.stringify({ state: 'constant' }),
          metadata: {},
          createdAt: NOW,
        }

        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: () => ({
            status: 'completed',
            artifacts: [staticArtifact],
          }),
        })

        // loopPolicy explicitly omitted to test default maxRepeatedStates: 1
        const result = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(result.status).toBe('halted')
        expect(result.haltReason).toBe('HALTED_LIMIT: no-progress')
      })
    })

    describe('Replay & Recovery (TC-2B-REC)', () => {
      it('TC-2B-REC-01: completed multi-iteration replay returns completed status idempotently', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'eq', value: 1 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => ({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'data',
                format: 'json',
                title: 'data.json',
                content: JSON.stringify({ iter: ctx.iteration }),
                metadata: {},
                createdAt: NOW,
              },
            ],
          }),
        })

        const run1 = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(run1.status).toBe('completed')
        const workerAttempts1 = workflowStore.getNodeAttempts(run1.graphRunId, 'worker')
        expect(workerAttempts1).toHaveLength(2)

        // Replay
        const run2 = await executor.run({
          graphRunId: run1.graphRunId,
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(run2.status).toBe('completed')
        const workerAttempts2 = workflowStore.getNodeAttempts(run1.graphRunId, 'worker')
        expect(workerAttempts2).toHaveLength(2)
      })

      it('TC-2B-REC-02: crash after iteration transaction before in-memory reset recovers iteration and resumes', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'eq', value: 1 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        const graphRunId = randomUUID()
        const now = new Date().toISOString()

        // 1. Graph run started in store
        workflowStore.startGraphRun(
          {
            graphRunId,
            workflowId,
            projectId,
            templateId: template.id,
            startedAt: now,
          },
          'system',
        )

        // 2. Iteration 1 attempts recorded as completed
        workflowStore.recordNodeAttempt(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: 'worker',
            attempt: 1,
            status: 'ready',
            startedAt: now,
          },
          'system',
        )
        workflowStore.updateNodeAttempt(
          {
            projectId,
            graphRunId,
            nodeId: 'worker',
            attempt: 1,
            status: 'completed',
            finishedAt: now,
            occurredAt: now,
          },
          'system',
        )

        workflowStore.recordNodeAttempt(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: 'router',
            attempt: 1,
            status: 'ready',
            startedAt: now,
          },
          'system',
        )
        workflowStore.updateNodeAttempt(
          {
            projectId,
            graphRunId,
            nodeId: 'router',
            attempt: 1,
            status: 'completed',
            finishedAt: now,
            occurredAt: now,
          },
          'system',
        )

        // 3. Iteration transaction committed in store (advance to iteration 2 + checkpoint written)
        const advExecutor = new GraphExecutor({ workflowStore, worktreeService })
        advExecutor.advanceLoopIteration({
          template,
          graphRunId,
          sourceNodeId: 'router',
          sourceAttempt: 1,
          targetNodeId: 'worker',
          fromIteration: 1,
          toIteration: 2,
          conditionMet: true,
          checkpointId: null,
          occurredAt: now,
          actor: 'system',
        })

        workflowStore.writeGraphCheckpoint(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: 'worker',
            operation: 'iteration.advanced',
            stateSnapshot: {
              readyNodeIds: ['worker'],
              runningNodeIds: [],
              completedNodeIds: [],
              blockedNodeIds: [],
              skippedNodeIds: [],
            },
            occurredAt: now,
          },
          'system',
        )

        // Process resumes execution after crash
        const resumeExecutor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => ({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'data',
                format: 'json',
                title: 'data.json',
                content: JSON.stringify({ iter: ctx.iteration }),
                metadata: {},
                createdAt: NOW,
              },
            ],
          }),
        })

        const resumedRun = await resumeExecutor.run({
          graphRunId,
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(resumedRun.status).toBe('completed')
        expect(resumedRun.completedNodeIds).toContain('done')

        // worker executed attempt 2 in resumed iteration 2
        const workerAttempts = workflowStore.getNodeAttempts(graphRunId, 'worker')
        expect(workerAttempts).toHaveLength(2)
        expect(workerAttempts[1]!.attempt).toBe(2)
        expect(workerAttempts[1]!.status).toBe('completed')
      })

      it('TC-2B-REC-03: duplicate transition idempotency preserves monotonic attempt counters', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'eq', value: 1 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => ({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'data',
                format: 'json',
                title: 'data.json',
                content: JSON.stringify({ iter: ctx.iteration }),
                metadata: {},
                createdAt: NOW,
              },
            ],
          }),
        })

        const run = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(run.status).toBe('completed')
        const attempts = workflowStore.getNodeAttempts(run.graphRunId, 'worker')
        const attemptNumbers = attempts.map((a) => a.attempt)
        expect(attemptNumbers).toEqual([1, 2])
        // Strict uniqueness
        expect(new Set(attemptNumbers).size).toBe(attemptNumbers.length)
      })

      it('TC-2B-REC-04: persisted feedback decision remains authoritative after recovery', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'eq', value: 1 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => ({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'data',
                format: 'json',
                title: 'data.json',
                content: JSON.stringify({ iter: ctx.iteration }),
                metadata: {},
                createdAt: NOW,
              },
            ],
          }),
        })

        const run = await executor.run({
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(run.status).toBe('completed')

        // Verify routing decision artifact for feedback transition
        const decisionArtifact = run.artifacts.find(
          (a) => a.kind === 'routing-decision' && a.content.includes('"isFeedback": true'),
        )
        expect(decisionArtifact).toBeDefined()
        const parsed = JSON.parse(decisionArtifact!.content) as {
          selectedEdgeId: string
          targetNodeId: string
          isFeedback: boolean
        }
        expect(parsed.selectedEdgeId).toBe('e-feedback')
        expect(parsed.targetNodeId).toBe('worker')
        expect(parsed.isFeedback).toBe(true)
      })

      it('TC-2B-REC-05: recovery when router decision artifact persisted but router completion checkpoint missing', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'eq', value: 1 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        const graphRunId = randomUUID()
        const now = new Date().toISOString()

        workflowStore.startGraphRun(
          {
            graphRunId,
            workflowId,
            projectId,
            templateId: template.id,
            startedAt: now,
          },
          'system',
        )

        // Worker completed in iteration 1
        workflowStore.recordNodeAttempt(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: 'worker',
            attempt: 1,
            status: 'ready',
            startedAt: now,
          },
          'system',
        )
        workflowStore.updateNodeAttempt(
          {
            projectId,
            graphRunId,
            nodeId: 'worker',
            attempt: 1,
            status: 'completed',
            finishedAt: now,
            occurredAt: now,
          },
          'system',
        )

        // Router attempt started (running) but crashed before completion checkpoint
        workflowStore.recordNodeAttempt(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: 'router',
            attempt: 1,
            status: 'running',
            startedAt: now,
          },
          'system',
        )

        const executor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => ({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'data',
                format: 'json',
                title: 'data.json',
                content: JSON.stringify({ iter: ctx.iteration }),
                metadata: {},
                createdAt: NOW,
              },
            ],
          }),
        })

        // Crash recovery marks in-flight router attempt failed
        const recovered = await executor.recover(projectId)
        expect(recovered).toHaveLength(1)
        expect(recovered[0]!.status).toBe('failed')

        const routerAttemptsAfterCrash = workflowStore.getNodeAttempts(graphRunId, 'router')
        expect(routerAttemptsAfterCrash[0]!.status).toBe('failed')

        // Graph execution resumes and retries router node
        const resumed = await executor.run({
          graphRunId,
          workflowId,
          projectId,
          template,
          forkSha,
          invalidatedNodeIds: new Set(['router']),
        })

        expect(resumed.status).toBe('completed')
        const finalRouterAttempts = workflowStore.getNodeAttempts(graphRunId, 'router')
        expect(finalRouterAttempts.length).toBeGreaterThanOrEqual(2)
        expect(finalRouterAttempts[1]!.attempt).toBe(2)
        expect(finalRouterAttempts[1]!.status).toBe('completed')
      })

      it('TC-2B-REC-06: recovery when router completion checkpoint persisted but iteration advancement has not committed', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'eq', value: 1 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        const graphRunId = randomUUID()
        const now = new Date().toISOString()

        workflowStore.startGraphRun(
          {
            graphRunId,
            workflowId,
            projectId,
            templateId: template.id,
            startedAt: now,
          },
          'system',
        )

        // Worker completed in iteration 1
        workflowStore.recordNodeAttempt(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: 'worker',
            attempt: 1,
            status: 'ready',
            startedAt: now,
          },
          'system',
        )
        workflowStore.updateNodeAttempt(
          {
            projectId,
            graphRunId,
            nodeId: 'worker',
            attempt: 1,
            status: 'completed',
            finishedAt: now,
            occurredAt: now,
          },
          'system',
        )

        // Router completed in iteration 1 with evidenceId 'e-feedback', but iteration advancement did NOT commit
        workflowStore.recordNodeAttempt(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: 'router',
            attempt: 1,
            status: 'ready',
            startedAt: now,
          },
          'system',
        )
        workflowStore.updateNodeAttempt(
          {
            projectId,
            graphRunId,
            nodeId: 'router',
            attempt: 1,
            status: 'completed',
            evidenceId: 'e-feedback',
            finishedAt: now,
            occurredAt: now,
          },
          'system',
        )
        workflowStore.writeGraphCheckpoint(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: 'router',
            operation: 'node.completed',
            stateSnapshot: {
              readyNodeIds: [],
              runningNodeIds: [],
              completedNodeIds: ['worker', 'router'],
              blockedNodeIds: [],
              skippedNodeIds: [],
            },
            occurredAt: now,
          },
          'system',
        )

        // Assert transition has not yet been recorded
        expect(workflowStore.getTransitionsForRun(graphRunId)).toHaveLength(0)

        // Resuming execution must detect the completed router's feedback decision and advance iteration
        const resumeExecutor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => ({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'data',
                format: 'json',
                title: 'data.json',
                content: JSON.stringify({ iter: ctx.iteration }),
                metadata: {},
                createdAt: NOW,
              },
            ],
          }),
        })

        const resumedRun = await resumeExecutor.run({
          graphRunId,
          workflowId,
          projectId,
          template,
          forkSha,
        })

        expect(resumedRun.status).toBe('completed')
        expect(resumedRun.completedNodeIds).toContain('done')

        // Transition was recorded during recovery
        const transitions = workflowStore.getTransitionsForRun(graphRunId)
        expect(transitions).toHaveLength(1)
        expect(transitions[0]!.fromIteration).toBe(1)
        expect(transitions[0]!.toIteration).toBe(2)

        // Worker executed attempt 2 in iteration 2
        const workerAttempts = workflowStore.getNodeAttempts(graphRunId, 'worker')
        expect(workerAttempts).toHaveLength(2)
        expect(workerAttempts[1]!.attempt).toBe(2)
        expect(workerAttempts[1]!.status).toBe('completed')
      })

      it('TC-2B-REC-07: recovery when process resumes with target attempt started in iteration 2 but interrupted', async () => {
        const worker = makeNode('worker')
        const router = makeNode('router', { type: 'router' })
        const done = makeNode('done')

        const template = makeTemplate(
          [worker, router, done],
          [
            { id: 'e-w-r', source: 'worker', target: 'router' },
            {
              id: 'e-feedback',
              source: 'router',
              target: 'worker',
              isFeedback: true,
              condition: {
                mode: 'all',
                predicates: [{ ref: 'iteration', operator: 'eq', value: 1 }],
              },
            },
            {
              id: 'e-exit',
              source: 'router',
              target: 'done',
              isDefault: true,
            },
          ],
        )

        const graphRunId = randomUUID()
        const now = new Date().toISOString()

        workflowStore.startGraphRun(
          {
            graphRunId,
            workflowId,
            projectId,
            templateId: template.id,
            startedAt: now,
          },
          'system',
        )

        // Iteration 1 worker and router completed
        workflowStore.recordNodeAttempt(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: 'worker',
            attempt: 1,
            status: 'ready',
            startedAt: now,
          },
          'system',
        )
        workflowStore.updateNodeAttempt(
          {
            projectId,
            graphRunId,
            nodeId: 'worker',
            attempt: 1,
            status: 'completed',
            finishedAt: now,
            occurredAt: now,
          },
          'system',
        )

        workflowStore.recordNodeAttempt(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: 'router',
            attempt: 1,
            status: 'ready',
            startedAt: now,
          },
          'system',
        )
        workflowStore.updateNodeAttempt(
          {
            projectId,
            graphRunId,
            nodeId: 'router',
            attempt: 1,
            status: 'completed',
            finishedAt: now,
            occurredAt: now,
          },
          'system',
        )

        // Iteration advanced to 2 in store
        const advExecutor = new GraphExecutor({ workflowStore, worktreeService })
        advExecutor.advanceLoopIteration({
          template,
          graphRunId,
          sourceNodeId: 'router',
          sourceAttempt: 1,
          targetNodeId: 'worker',
          fromIteration: 1,
          toIteration: 2,
          conditionMet: true,
          checkpointId: null,
          occurredAt: now,
          actor: 'system',
        })

        // Worker attempt 2 recorded in iteration 2, but failed due to process crash
        workflowStore.updateNodeAttempt(
          {
            projectId,
            graphRunId,
            nodeId: 'worker',
            attempt: 2,
            status: 'failed',
            error: 'Process crashed during target attempt execution',
            finishedAt: now,
            occurredAt: now,
          },
          'system',
        )

        const resumeExecutor = new GraphExecutor({
          workflowStore,
          worktreeService,
          testOnlyAllowEphemeralArtifacts: true,
          executeLeafNode: (ctx) => ({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'data',
                format: 'json',
                title: 'data.json',
                content: JSON.stringify({ iter: ctx.iteration }),
                metadata: {},
                createdAt: NOW,
              },
            ],
          }),
        })

        // Resumed run retries worker as attempt 3 in iteration 2
        const resumedRun = await resumeExecutor.run({
          graphRunId,
          workflowId,
          projectId,
          template,
          forkSha,
          invalidatedNodeIds: new Set(['worker']),
        })

        expect(resumedRun.status).toBe('completed')
        expect(resumedRun.completedNodeIds).toContain('done')

        // Worker attempts: 1 (completed, iter 1), 2 (failed, iter 2), 3 (completed, iter 2)
        const finalWorkerAttempts = workflowStore.getNodeAttempts(graphRunId, 'worker')
        expect(finalWorkerAttempts).toHaveLength(3)
        expect(finalWorkerAttempts.map((a) => a.attempt)).toEqual([1, 2, 3])
        expect(finalWorkerAttempts[2]!.status).toBe('completed')
        expect(finalWorkerAttempts[2]!.iteration).toBe(2)
      })
    })
  })

  // 20. Slice 2C-1: Durable Artifact Lineage Hydration
  describe('Artifact Lineage Hydration (TC-2C-REC)', () => {
    it('TC-2C-REC-01: Node A completes and records output artifact -> process terminates -> recovery resumes -> Node B resolves slot from A artifact and executes successfully', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'outputA',
                kind: 'stage-output',
                format: 'json',
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [{ name: 'inputA', kind: 'stage-output', required: true }],
          }),
        ],
        [
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'stage-output',
            targetHandle: 'inputA',
          },
        ],
      )

      let nodeBExecuted = false
      let nodeBReceivedPayload: string | null = null

      // Executor 1 simulates crash right after Node A completes
      const executor1 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'nodeA-result',
                  content: JSON.stringify({ message: 'artifact from A' }),
                  metadata: { author: 'nodeA' },
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            throw new Error('Simulated process crash during Node B execution')
          }
          return { status: 'completed' }
        },
      })

      // Run executor 1: Node A completes, Node B crashes
      const initialRun = await executor1.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })
      expect(initialRun.status).toBe('failed')
      expect(initialRun.completedNodeIds).toContain('nodeA')
      expect(initialRun.failedNodeIds).toContain('nodeB')

      // Verify Node A completed in workflow store
      const nodeARuns = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeARuns).toHaveLength(1)
      expect(nodeARuns[0]!.status).toBe('completed')

      // Verify physical artifact was persisted on disk and in artifactStore
      const persistedArtifacts = artifactStore.listForRun(runIdSchema.parse(graphRunId))
      expect(persistedArtifacts.length).toBeGreaterThan(0)
      const aArtifact = persistedArtifacts.find((a) => a.stepId === nodeARuns[0]!.id)
      expect(aArtifact).toBeDefined()

      // Executor 2 simulates restart recovery
      const executor2 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeB') {
            nodeBExecuted = true
            expect(ctx.incomingSlots.has('inputA')).toBe(true)
            const resolvedArtifact = ctx.incomingSlots.get('inputA')!
            expect(resolvedArtifact.nodeId).toBe('nodeA')
            expect(resolvedArtifact.kind).toBe('stage-output')
            nodeBReceivedPayload = resolvedArtifact.content
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const resumeResult = await executor2.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        invalidatedNodeIds: new Set(['nodeB']),
      })

      expect(resumeResult.status).toBe('completed')
      expect(resumeResult.completedNodeIds).toContain('nodeA')
      expect(resumeResult.completedNodeIds).toContain('nodeB')
      expect(nodeBExecuted).toBe(true)
      expect(nodeBReceivedPayload).toBe(JSON.stringify({ message: 'artifact from A' }))
    })

    it('TC-2C-REC-01A: Multiple attempts exist for Node A -> recovery selects only completed attempt artifacts, ignoring failed/stale attempts', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'outputA',
                kind: 'stage-output',
                format: 'json',
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [{ name: 'inputA', kind: 'stage-output', required: true }],
          }),
        ],
        [
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'stage-output',
            targetHandle: 'inputA',
          },
        ],
      )

      workflowStore.startGraphRun(
        {
          graphRunId,
          workflowId,
          projectId,
          templateId: template.id,
          startedAt: NOW,
        },
        'system',
      )

      // Attempt 1 for Node A failed and wrote a stale artifact
      const attempt1Id = randomUUID()
      workflowStore.recordNodeAttempt(
        {
          id: attempt1Id,
          projectId,
          graphRunId,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'ready',
          startedAt: NOW,
        },
        'system',
      )
      workflowStore.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'failed',
          error: 'Transient error in attempt 1',
          finishedAt: NOW,
          occurredAt: NOW,
        },
        'system',
      )
      // Stale artifact for attempt 1
      await artifactService.writeArtifact({
        runId: runIdSchema.parse(graphRunId),
        stepId: stepIdSchema.parse(attempt1Id),
        kind: 'stage-output',
        name: 'stale-artifact.workflow-artifact.json',
        content: JSON.stringify({
          id: randomUUID(),
          workflowId,
          nodeId: 'nodeA',
          kind: 'stage-output',
          format: 'json',
          title: 'stale',
          content: 'STALE_DATA_FROM_ATTEMPT_1',
          metadata: {},
          createdAt: NOW,
        }),
      })

      // Attempt 2 for Node A completed with authoritative artifact
      const attempt2Id = randomUUID()
      workflowStore.recordNodeAttempt(
        {
          id: attempt2Id,
          projectId,
          graphRunId,
          nodeId: 'nodeA',
          attempt: 2,
          status: 'ready',
          startedAt: NOW,
        },
        'system',
      )
      workflowStore.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'nodeA',
          attempt: 2,
          status: 'completed',
          finishedAt: NOW,
          occurredAt: NOW,
        },
        'system',
      )
      // Authoritative artifact for attempt 2
      await artifactService.writeArtifact({
        runId: runIdSchema.parse(graphRunId),
        stepId: stepIdSchema.parse(attempt2Id),
        kind: 'stage-output',
        name: 'authoritative.workflow-artifact.json',
        content: JSON.stringify({
          id: randomUUID(),
          workflowId,
          nodeId: 'nodeA',
          kind: 'stage-output',
          format: 'json',
          title: 'authoritative',
          content: 'AUTHORITATIVE_DATA_FROM_ATTEMPT_2',
          metadata: {},
          createdAt: NOW,
        }),
      })

      let receivedContent: string | null = null

      const resumeExecutor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeB') {
            const slot = ctx.incomingSlots.get('inputA')
            receivedContent = slot?.content ?? null
            // Check that inputArtifacts does not contain the stale artifact
            expect(ctx.inputArtifacts.some((a) => a.content.includes('STALE_DATA'))).toBe(false)
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const result = await resumeExecutor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(result.status).toBe('completed')
      expect(result.completedNodeIds).toContain('nodeB')
      expect(receivedContent).toBe('AUTHORITATIVE_DATA_FROM_ATTEMPT_2')
    })

    it('TC-2C-REC-01B: Missing required artifact causes deterministic blocking/failure, never false success', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'outputA',
                kind: 'stage-output',
                format: 'json',
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [{ name: 'inputA', kind: 'stage-output', required: true }],
          }),
        ],
        [
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'stage-output',
            targetHandle: 'inputA',
          },
        ],
      )

      workflowStore.startGraphRun(
        {
          graphRunId,
          workflowId,
          projectId,
          templateId: template.id,
          startedAt: NOW,
        },
        'system',
      )

      // Node A completed in the store, but NO artifact was ever recorded for it
      const nodeAId = randomUUID()
      workflowStore.recordNodeAttempt(
        {
          id: nodeAId,
          projectId,
          graphRunId,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'ready',
          startedAt: NOW,
        },
        'system',
      )
      workflowStore.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'completed',
          finishedAt: NOW,
          occurredAt: NOW,
        },
        'system',
      )

      let nodeBExecuted = false
      const resumeExecutor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: () => {
          nodeBExecuted = true
          return { status: 'completed' }
        },
      })

      const result = await resumeExecutor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      // Downstream node B must be blocked because required slot is missing
      expect(result.status).toBe('failed')
      expect(result.blockedNodeIds).toContain('nodeB')
      expect(result.completedNodeIds).not.toContain('nodeB')
      expect(nodeBExecuted).toBe(false)

      const nodeBAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeB')
      expect(nodeBAttempts).toHaveLength(1)
      expect(nodeBAttempts[0]!.status).toBe('blocked')
      expect(nodeBAttempts[0]!.error).toContain('Missing required input slot: inputA')

      // Sub-case: Corrupt artifact file on disk fails closed immediately
      const corruptRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(corruptRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })
      workflowStore.startGraphRun(
        {
          graphRunId: corruptRunId,
          workflowId,
          projectId,
          templateId: template.id,
          startedAt: NOW,
        },
        'system',
      )
      const corruptAttemptId = randomUUID()
      workflowStore.recordNodeAttempt(
        {
          id: corruptAttemptId,
          projectId,
          graphRunId: corruptRunId,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'ready',
          startedAt: NOW,
        },
        'system',
      )
      workflowStore.updateNodeAttempt(
        {
          projectId,
          graphRunId: corruptRunId,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'completed',
          finishedAt: NOW,
          occurredAt: NOW,
        },
        'system',
      )
      const validMeta = await artifactService.writeArtifact({
        runId: runIdSchema.parse(corruptRunId),
        stepId: stepIdSchema.parse(corruptAttemptId),
        kind: 'stage-output',
        name: 'corrupt.json',
        content: 'valid initially',
      })
      // Corrupt physical file by overwriting content without updating SQLite hash/size
      const filePath = artifactService.resolvePath(validMeta)
      writeFileSync(filePath, 'corrupted content that does not match sha')

      await expect(
        resumeExecutor.run({
          graphRunId: corruptRunId,
          workflowId,
          projectId,
          template,
          forkSha,
        }),
      ).rejects.toThrow(/Artifact integrity check failed/)
    })

    it('TC-2C-REC-01C: Artifacts from another node or graph run cannot leak into the resumed node inputs', async () => {
      const runStore = new RunStore(db)

      // Run 1: Alien run with an artifact
      const alienRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(alienRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'completed',
        startedAt: NOW,
        finishedAt: NOW,
        exitCode: 0,
        summary: null,
        error: null,
        metadata: {},
      })
      const alienAttemptId = randomUUID()
      await artifactService.writeArtifact({
        runId: runIdSchema.parse(alienRunId),
        stepId: stepIdSchema.parse(alienAttemptId),
        kind: 'stage-output',
        name: 'alien.workflow-artifact.json',
        content: JSON.stringify({
          id: randomUUID(),
          workflowId,
          nodeId: 'alienNode',
          kind: 'stage-output',
          format: 'json',
          title: 'alien',
          content: 'LEAKED_ALIEN_PAYLOAD',
          metadata: {},
          createdAt: NOW,
        }),
      })

      // Run 2: Target run
      const targetRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(targetRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'outputA',
                kind: 'stage-output',
                format: 'json',
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [{ name: 'inputA', kind: 'stage-output', required: true }],
          }),
        ],
        [
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'stage-output',
            targetHandle: 'inputA',
          },
        ],
      )

      workflowStore.startGraphRun(
        {
          graphRunId: targetRunId,
          workflowId,
          projectId,
          templateId: template.id,
          startedAt: NOW,
        },
        'system',
      )

      // Node A in target run completed
      const nodeAAttemptId = randomUUID()
      workflowStore.recordNodeAttempt(
        {
          id: nodeAAttemptId,
          projectId,
          graphRunId: targetRunId,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'ready',
          startedAt: NOW,
        },
        'system',
      )
      workflowStore.updateNodeAttempt(
        {
          projectId,
          graphRunId: targetRunId,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'completed',
          finishedAt: NOW,
          occurredAt: NOW,
        },
        'system',
      )
      await artifactService.writeArtifact({
        runId: runIdSchema.parse(targetRunId),
        stepId: stepIdSchema.parse(nodeAAttemptId),
        kind: 'stage-output',
        name: 'nodeA.workflow-artifact.json',
        content: JSON.stringify({
          id: randomUUID(),
          workflowId,
          nodeId: 'nodeA',
          kind: 'stage-output',
          format: 'json',
          title: 'nodeA',
          content: 'LEGIT_NODE_A_PAYLOAD',
          metadata: {},
          createdAt: NOW,
        }),
      })

      // Also record an unrelated node in target run
      const otherNodeAttemptId = randomUUID()
      await artifactService.writeArtifact({
        runId: runIdSchema.parse(targetRunId),
        stepId: stepIdSchema.parse(otherNodeAttemptId),
        kind: 'stage-output',
        name: 'unrelated.workflow-artifact.json',
        content: JSON.stringify({
          id: randomUUID(),
          workflowId,
          nodeId: 'unrelatedNode',
          kind: 'stage-output',
          format: 'json',
          title: 'unrelated',
          content: 'UNRELATED_NODE_PAYLOAD',
          metadata: {},
          createdAt: NOW,
        }),
      })

      let observedArtifacts: WorkflowArtifact[] = []

      const resumeExecutor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeB') {
            observedArtifacts = [...ctx.inputArtifacts]
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const result = await resumeExecutor.run({
        graphRunId: targetRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(result.status).toBe('completed')
      expect(result.completedNodeIds).toContain('nodeB')
      expect(observedArtifacts).toHaveLength(1)
      expect(observedArtifacts[0]!.content).toBe('LEGIT_NODE_A_PAYLOAD')
      expect(observedArtifacts[0]!.nodeId).toBe('nodeA')
      expect(observedArtifacts.some((a) => a.content.includes('LEAKED_ALIEN_PAYLOAD'))).toBe(false)
      expect(observedArtifacts.some((a) => a.content.includes('UNRELATED_NODE_PAYLOAD'))).toBe(
        false,
      )
    })

    it('TC-2C-REC-01D: Repeated recovery produces identical lineage and does not duplicate artifacts', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'outputA',
                kind: 'stage-output',
                format: 'json',
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [{ name: 'inputA', kind: 'stage-output', required: true }],
          }),
        ],
        [
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'stage-output',
            targetHandle: 'inputA',
          },
        ],
      )

      workflowStore.startGraphRun(
        {
          graphRunId,
          workflowId,
          projectId,
          templateId: template.id,
          startedAt: NOW,
        },
        'system',
      )

      const nodeAAttemptId = randomUUID()
      workflowStore.recordNodeAttempt(
        {
          id: nodeAAttemptId,
          projectId,
          graphRunId,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'ready',
          startedAt: NOW,
        },
        'system',
      )
      workflowStore.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'completed',
          finishedAt: NOW,
          occurredAt: NOW,
        },
        'system',
      )
      await artifactService.writeArtifact({
        runId: runIdSchema.parse(graphRunId),
        stepId: stepIdSchema.parse(nodeAAttemptId),
        kind: 'stage-output',
        name: 'art1.workflow-artifact.json',
        content: JSON.stringify({
          id: randomUUID(),
          workflowId,
          nodeId: 'nodeA',
          kind: 'stage-output',
          format: 'json',
          title: 'art1',
          content: 'PAYLOAD_A',
          metadata: {},
          createdAt: NOW,
          __lineageOrder: 0,
        }),
      })

      const initialArtifactCount = artifactStore.listForRun(runIdSchema.parse(graphRunId)).length
      expect(initialArtifactCount).toBeGreaterThan(0)

      let resumeCount = 0
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: () => {
          resumeCount++
          return { status: 'completed' }
        },
      })

      // Run recovery 1
      const result1 = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(result1.status).toBe('completed')
      expect(result1.completedNodeIds).toEqual(expect.arrayContaining(['nodeA', 'nodeB']))
      const artifactCountAfterRun1 = artifactStore.listForRun(runIdSchema.parse(graphRunId)).length

      // Run recovery 2 (idempotent replay of completed run)
      const result2 = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(result2.status).toBe('completed')
      expect(result2.completedNodeIds).toEqual(result1.completedNodeIds)
      expect(result2.artifacts.map((a) => a.content)).toEqual(
        result1.artifacts.map((a) => a.content),
      )
      const artifactCountAfterRun2 = artifactStore.listForRun(runIdSchema.parse(graphRunId)).length

      // Verify that no extra duplicate artifacts were generated across repeated runs
      expect(artifactCountAfterRun2).toBe(artifactCountAfterRun1)
      expect(resumeCount).toBe(1) // Node B executed only once, not twice
    })

    it('TC-2C-REC-02: Process interruption after attempt completion is recorded but before any artifact is persisted', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'outputA',
                kind: 'stage-output',
                format: 'json',
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [{ name: 'inputA', kind: 'stage-output', required: true }],
          }),
        ],
        [
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'stage-output',
            targetHandle: 'inputA',
          },
        ],
      )

      workflowStore.startGraphRun(
        {
          graphRunId,
          workflowId,
          projectId,
          templateId: template.id,
          startedAt: NOW,
        },
        'system',
      )

      // Simulate interruption: attempt completion recorded in SQLite, but process stopped before any artifact was persisted
      const nodeAAttemptId = randomUUID()
      workflowStore.recordNodeAttempt(
        {
          id: nodeAAttemptId,
          projectId,
          graphRunId,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'ready',
          startedAt: NOW,
        },
        'system',
      )
      workflowStore.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'completed',
          finishedAt: NOW,
          occurredAt: NOW,
        },
        'system',
      )

      // Assert durable state prior to recovery:
      // 1. Attempt status in SQLite is 'completed'
      const attemptsBefore = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(attemptsBefore).toHaveLength(1)
      expect(attemptsBefore[0]!.status).toBe('completed')

      // 2. Artifact rows in SQLite is 0; physical files on disk is 0
      const artifactsBefore = artifactStore.listForStep(stepIdSchema.parse(nodeAAttemptId))
      expect(artifactsBefore).toHaveLength(0)

      // 3. No completion checkpoint was recorded for Node A
      const checkpointsBefore = workflowStore.getGraphCheckpoints(graphRunId)
      expect(
        checkpointsBefore.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.completed'),
      ).toBe(false)

      let nodeBExecuted = false
      const resumeExecutor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeB') {
            nodeBExecuted = true
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      // Execute resume
      const result = await resumeExecutor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      // Downstream node B cannot resolve inputA and deterministically blocks, preventing false workflow success
      expect(result.status).toBe('failed')
      expect(result.blockedNodeIds).toContain('nodeB')
      expect(result.completedNodeIds).not.toContain('nodeB')
      expect(nodeBExecuted).toBe(false)

      // Check node B attempt was blocked with actionable error
      const nodeBAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeB')
      expect(nodeBAttempts).toHaveLength(1)
      expect(nodeBAttempts[0]!.status).toBe('blocked')
      expect(nodeBAttempts[0]!.error).toContain('Missing required input slot: inputA')

      // Resumed lineage for Node A reflects zero artifacts
      expect(result.artifacts.filter((a) => a.nodeId === 'nodeA')).toHaveLength(0)
    })

    it('TC-2C-REC-03: Process interruption during persistence of multiple artifacts leaves a recoverable, deterministic state without false completion', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'out1',
                kind: 'stage-output',
                format: 'json',
                requiredSections: [],
              },
              {
                name: 'out2',
                kind: 'stage-output',
                format: 'json',
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [
              { name: 'in1', kind: 'stage-output', required: true },
              { name: 'in2', kind: 'stage-output', required: true },
            ],
          }),
        ],
        [
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'out1',
            targetHandle: 'in1',
          },
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'out2',
            targetHandle: 'in2',
          },
        ],
      )

      workflowStore.startGraphRun(
        {
          graphRunId,
          workflowId,
          projectId,
          templateId: template.id,
          startedAt: NOW,
        },
        'system',
      )

      // Simulate crash during multi-artifact write:
      // Node A attempt 1 starts and is in 'running' state
      const attempt1Id = randomUUID()
      workflowStore.recordNodeAttempt(
        {
          id: attempt1Id,
          projectId,
          graphRunId,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'running',
          startedAt: NOW,
        },
        'system',
      )

      // Only 1 of 2 artifacts gets written before the crash
      await artifactService.writeArtifact({
        runId: runIdSchema.parse(graphRunId),
        stepId: stepIdSchema.parse(attempt1Id),
        kind: 'stage-output',
        name: 'partial-out1.workflow-artifact.json',
        content: JSON.stringify({
          id: randomUUID(),
          workflowId,
          nodeId: 'nodeA',
          kind: 'stage-output',
          format: 'json',
          title: 'out1',
          content: JSON.stringify({ part: 1 }),
          metadata: {},
          createdAt: NOW,
          __lineageOrder: 0,
          __totalArtifacts: 2,
        }),
      })

      // Assert state right after interruption:
      // Attempt is still 'running' (NEVER falsely marked completed)
      const attempt1Before = workflowStore.getNodeAttempt(graphRunId, 'nodeA', 1)
      expect(attempt1Before?.status).toBe('running')
      expect(artifactStore.listForStep(stepIdSchema.parse(attempt1Id))).toHaveLength(1)
      expect(
        workflowStore.getGraphCheckpoints(graphRunId).some((c) => c.operation === 'node.completed'),
      ).toBe(false)

      // Crash recovery runs
      const recoveryExecutor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
      })
      const recoveredRuns = await recoveryExecutor.recover(projectId)
      expect(recoveredRuns).toHaveLength(1)
      expect(recoveredRuns[0]!.status).toBe('failed')

      const attempt1AfterRecover = workflowStore.getNodeAttempt(graphRunId, 'nodeA', 1)
      expect(attempt1AfterRecover?.status).toBe('failed')
      expect(attempt1AfterRecover?.error).toContain('Process crashed during node execution')

      // Fresh executor simulates restart recovery and retries Node A
      let nodeBReceivedIn1: string | null = null
      let nodeBReceivedIn2: string | null = null
      const resumeExecutor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'out1',
                  content: JSON.stringify({ part: 1, attempt: ctx.attempt }),
                  metadata: {},
                  createdAt: NOW,
                },
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'out2',
                  content: JSON.stringify({ part: 2, attempt: ctx.attempt }),
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            nodeBReceivedIn1 = ctx.incomingSlots.get('in1')?.content ?? null
            nodeBReceivedIn2 = ctx.incomingSlots.get('in2')?.content ?? null
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const resumeResult = await resumeExecutor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        invalidatedNodeIds: new Set(['nodeA']),
      })

      expect(resumeResult.status).toBe('completed')
      expect(resumeResult.completedNodeIds).toEqual(expect.arrayContaining(['nodeA', 'nodeB']))
      expect(nodeBReceivedIn1).toContain('"attempt":2')
      expect(nodeBReceivedIn2).toContain('"attempt":2')

      // Durable attempts: attempt 1 is failed, attempt 2 is completed
      const allAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(allAttempts).toHaveLength(2)
      expect(allAttempts[0]!.attempt).toBe(1)
      expect(allAttempts[0]!.status).toBe('failed')
      expect(allAttempts[1]!.attempt).toBe(2)
      expect(allAttempts[1]!.status).toBe('completed')

      // Attempt 2 has exactly 2 artifacts persisted
      const attempt2Artifacts = artifactStore.listForStep(stepIdSchema.parse(allAttempts[1]!.id))
      expect(attempt2Artifacts).toHaveLength(2)

      // Completion checkpoint was recorded for Node A attempt 2
      const checkpointsAfter = workflowStore.getGraphCheckpoints(graphRunId)
      expect(
        checkpointsAfter.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.completed'),
      ).toBe(true)
    })

    it('TC-2C-REC-04: Artifact persistence throws after the first write; retry/recovery does not duplicate already persisted artifacts', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate([
        makeNode('nodeA', {
          outputs: [
            { name: 'artifact-first', kind: 'stage-output', format: 'json', requiredSections: [] },
            { name: 'artifact-second', kind: 'stage-output', format: 'json', requiredSections: [] },
          ],
        }),
      ])

      const art1Id = randomUUID()
      const art2Id = randomUUID()

      // Spy on writeArtifact to simulate throw after the first write
      let writeCallCount = 0
      const originalWriteArtifact = artifactService.writeArtifact.bind(artifactService)
      vi.spyOn(artifactService, 'writeArtifact').mockImplementation(async (opts) => {
        writeCallCount++
        if (writeCallCount === 2) {
          throw new Error('Simulated disk I/O error during second artifact persistence')
        }
        return originalWriteArtifact(opts)
      })

      const executor1 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: () => ({
          status: 'completed',
          artifacts: [
            {
              id: art1Id,
              workflowId,
              nodeId: 'nodeA',
              kind: 'stage-output',
              format: 'json',
              title: 'artifact-first',
              content: JSON.stringify({ item: 'first' }),
              metadata: {},
              createdAt: NOW,
            },
            {
              id: art2Id,
              workflowId,
              nodeId: 'nodeA',
              kind: 'stage-output',
              format: 'json',
              title: 'artifact-second',
              content: JSON.stringify({ item: 'second' }),
              metadata: {},
              createdAt: NOW,
            },
          ],
        }),
      })

      const run1Result = await executor1.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      // Node A attempt 1 threw during persistence of 2nd artifact
      expect(run1Result.status).toBe('failed')
      expect(run1Result.failedNodeIds).toContain('nodeA')
      expect(run1Result.completedNodeIds).not.toContain('nodeA')

      const nodeAAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeAAttempts).toHaveLength(1)
      expect(nodeAAttempts[0]!.status).toBe('failed')
      expect(nodeAAttempts[0]!.error).toContain(
        'Simulated disk I/O error during second artifact persistence',
      )

      // Exactly 1 artifact was written to SQLite and disk for Attempt 1
      const attempt1StepId = stepIdSchema.parse(nodeAAttempts[0]!.id)
      const attempt1ArtifactsBeforeRetry = artifactStore.listForStep(attempt1StepId)
      expect(attempt1ArtifactsBeforeRetry).toHaveLength(1)
      expect(attempt1ArtifactsBeforeRetry[0]!.name).toBe('artifact-first.workflow-artifact.json')

      // Restore writeArtifact to succeed
      vi.restoreAllMocks()

      // Retry persistence for attempt 1 (e.g. idempotent retry of persistence on the same step)
      const executor2 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
      })

      const artifactsToPersist: WorkflowArtifact[] = [
        {
          id: art1Id,
          workflowId,
          nodeId: 'nodeA',
          kind: 'stage-output',
          format: 'json',
          title: 'artifact-first',
          content: JSON.stringify({ item: 'first' }),
          metadata: {},
          createdAt: NOW,
        },
        {
          id: art2Id,
          workflowId,
          nodeId: 'nodeA',
          kind: 'stage-output',
          format: 'json',
          title: 'artifact-second',
          content: JSON.stringify({ item: 'second' }),
          metadata: {},
          createdAt: NOW,
        },
      ]

      // Call persistNodeArtifacts for the same step
      await (
        executor2 as unknown as {
          persistNodeArtifacts: (
            runId: string,
            stepId: string,
            arts: WorkflowArtifact[],
          ) => Promise<void>
        }
      ).persistNodeArtifacts(graphRunId, nodeAAttempts[0]!.id, artifactsToPersist)

      // Verify that art1 was NOT duplicated:
      // Exactly 2 artifacts exist for Attempt 1 in SQLite
      const attempt1ArtifactsAfterRetry = artifactStore.listForStep(attempt1StepId)
      expect(attempt1ArtifactsAfterRetry).toHaveLength(2)

      const art1Rows = attempt1ArtifactsAfterRetry.filter(
        (a) => a.name === 'artifact-first.workflow-artifact.json',
      )
      expect(art1Rows).toHaveLength(1) // duplicate count is 0

      const art2Rows = attempt1ArtifactsAfterRetry.filter(
        (a) => a.name === 'artifact-second.workflow-artifact.json',
      )
      expect(art2Rows).toHaveLength(1)

      // Total files for this run on disk is exactly 2
      const allRunArtifacts = artifactStore.listForRun(runIdSchema.parse(graphRunId))
      expect(allRunArtifacts).toHaveLength(2)
    })

    it('TC-2C-REC-05: Required artifact service/configuration is unavailable; the executor does not silently claim durable success', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate([
        makeNode('nodeA', {
          outputs: [{ name: 'out1', kind: 'stage-output', format: 'json', requiredSections: [] }],
        }),
      ])

      // GraphExecutor configured WITHOUT artifactService
      const executorWithoutArtifactService = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService: undefined,
        executeLeafNode: () => ({
          status: 'completed',
          artifacts: [
            {
              id: randomUUID(),
              workflowId,
              nodeId: 'nodeA',
              kind: 'stage-output',
              format: 'json',
              title: 'result',
              content: '{"data":123}',
              metadata: {},
              createdAt: NOW,
            },
          ],
        }),
      })

      const result = await executorWithoutArtifactService.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      // Must fail closed with actionable error; never claim success
      expect(result.status).toBe('failed')
      expect(result.failedNodeIds).toContain('nodeA')
      expect(result.completedNodeIds).not.toContain('nodeA')

      const nodeAAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeAAttempts).toHaveLength(1)
      expect(nodeAAttempts[0]!.status).toBe('failed')
      expect(nodeAAttempts[0]!.error).toContain('ArtifactService is required but not configured')

      // Checkpoint state: node.failed was written, never node.completed
      const checkpoints = workflowStore.getGraphCheckpoints(graphRunId)
      expect(
        checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.completed'),
      ).toBe(false)
      expect(checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.failed')).toBe(
        true,
      )

      // Artifact store remains untouched
      expect(artifactStore.listForRun(runIdSchema.parse(graphRunId))).toHaveLength(0)
    })

    it('TC-2C-REC-06: Invalid artifact kind or malformed persisted envelope is rejected or handled according to the established compatibility contract, never silently promoted to authoritative lineage', async () => {
      const runStore = new RunStore(db)

      // Sub-case 1: Invalid artifact kind at persistence boundary fails closed
      const graphRunId1 = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId1),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template1 = makeTemplate([makeNode('nodeA')])
      const executor1 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: () => ({
          status: 'completed',
          artifacts: [
            {
              id: randomUUID(),
              workflowId,
              nodeId: 'nodeA',
              kind: 'completely-invalid-artifact-kind',
              format: 'json',
              title: 'invalid-kind-art',
              content: '{"data":1}',
              metadata: {},
              createdAt: NOW,
            },
          ],
        }),
      })

      const result1 = await executor1.run({
        graphRunId: graphRunId1,
        workflowId,
        projectId,
        template: template1,
        forkSha,
      })

      expect(result1.status).toBe('failed')
      expect(result1.failedNodeIds).toContain('nodeA')
      const attempts1 = workflowStore.getNodeAttempts(graphRunId1, 'nodeA')
      expect(attempts1[0]!.status).toBe('failed')
      expect(attempts1[0]!.error).toContain(
        'Invalid artifact kind "completely-invalid-artifact-kind"',
      )

      // Zero artifacts were persisted under coerced kind
      expect(artifactStore.listForRun(runIdSchema.parse(graphRunId1))).toHaveLength(0)

      // Sub-case 2: Malformed JSON envelope on disk fails closed during hydration, never converted to plain text
      const graphRunId2 = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId2),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })
      workflowStore.startGraphRun(
        {
          graphRunId: graphRunId2,
          workflowId,
          projectId,
          templateId: template1.id,
          startedAt: NOW,
        },
        'system',
      )

      const attempt2Id = randomUUID()
      workflowStore.recordNodeAttempt(
        {
          id: attempt2Id,
          projectId,
          graphRunId: graphRunId2,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'ready',
          startedAt: NOW,
        },
        'system',
      )
      workflowStore.updateNodeAttempt(
        {
          projectId,
          graphRunId: graphRunId2,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'completed',
          finishedAt: NOW,
          occurredAt: NOW,
        },
        'system',
      )

      const validMeta = await artifactService.writeArtifact({
        runId: runIdSchema.parse(graphRunId2),
        stepId: stepIdSchema.parse(attempt2Id),
        kind: 'stage-output',
        name: 'envelope.workflow-artifact.json',
        content: JSON.stringify({
          id: randomUUID(),
          workflowId,
          nodeId: 'nodeA',
          kind: 'stage-output',
          format: 'json',
          title: 'valid-envelope',
          content: 'valid',
          metadata: {},
          createdAt: NOW,
        }),
      })

      // Corrupt the file content to invalid JSON (while leaving sha/size valid in SQLite to test JSON envelope parser boundary)
      const absPath = artifactService.resolvePath(validMeta)
      const malformedJson = '{ "title": "broken", invalid JSON syntax here'
      writeFileSync(absPath, malformedJson, 'utf-8')
      const newSha = (await import('node:crypto'))
        .createHash('sha256')
        .update(malformedJson)
        .digest('hex')
      const { eq } = await import('drizzle-orm')
      const { artifacts } = await import('../db/schema')
      db.update(artifacts)
        .set({ sha256: newSha, sizeBytes: Buffer.byteLength(malformedJson) })
        .where(eq(artifacts.id, validMeta.id))
        .run()

      const resumeExecutor2 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
      })

      await expect(
        resumeExecutor2.run({
          graphRunId: graphRunId2,
          workflowId,
          projectId,
          template: template1,
          forkSha,
        }),
      ).rejects.toThrow(/Malformed artifact envelope: failed to parse JSON/)

      // Sub-case 3: Invalid artifact kind inside persisted envelope on disk is rejected
      const graphRunId3 = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId3),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })
      workflowStore.startGraphRun(
        {
          graphRunId: graphRunId3,
          workflowId,
          projectId,
          templateId: template1.id,
          startedAt: NOW,
        },
        'system',
      )

      const attempt3Id = randomUUID()
      workflowStore.recordNodeAttempt(
        {
          id: attempt3Id,
          projectId,
          graphRunId: graphRunId3,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'ready',
          startedAt: NOW,
        },
        'system',
      )
      workflowStore.updateNodeAttempt(
        {
          projectId,
          graphRunId: graphRunId3,
          nodeId: 'nodeA',
          attempt: 1,
          status: 'completed',
          finishedAt: NOW,
          occurredAt: NOW,
        },
        'system',
      )

      const bogusKindMeta = await artifactService.writeArtifact({
        runId: runIdSchema.parse(graphRunId3),
        stepId: stepIdSchema.parse(attempt3Id),
        kind: 'stage-output',
        name: 'envelope-bogus.workflow-artifact.json',
        content: JSON.stringify({
          id: randomUUID(),
          workflowId,
          nodeId: 'nodeA',
          kind: 'bogus-alien-kind',
          format: 'json',
          title: 'valid-envelope',
          content: 'some payload',
          metadata: {},
          createdAt: NOW,
        }),
      })
      expect(bogusKindMeta).toBeDefined()

      const resumeExecutor3 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
      })

      await expect(
        resumeExecutor3.run({
          graphRunId: graphRunId3,
          workflowId,
          projectId,
          template: template1,
          forkSha,
        }),
      ).rejects.toThrow(/Invalid artifact kind "bogus-alien-kind"/)
    })

    it('TC-2C-REC-07: Recovery after a valid completion checkpoint still hydrates the exact persisted artifact lineage and remains idempotent', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              { name: 'outA', kind: 'stage-output', format: 'json', requiredSections: [] },
              { name: 'diffA', kind: 'diff', format: 'diff', requiredSections: [] },
            ],
          }),
          makeNode('nodeB', {
            inputs: [
              { name: 'inA', kind: 'stage-output', required: true },
              { name: 'inDiff', kind: 'diff', required: true },
            ],
          }),
        ],
        [
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'stage-output',
            targetHandle: 'inA',
          },
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'diff',
            targetHandle: 'inDiff',
          },
        ],
      )

      // Executor 1 executes Node A completely: writes artifacts, updates attempt to completed, writes checkpoint
      // and then process interrupts before Node B executes
      const executor1 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'outA',
                  content: JSON.stringify({ key: 'valA' }),
                  metadata: { version: '1.0' },
                  createdAt: NOW,
                },
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'diff',
                  format: 'diff',
                  title: 'diffA',
                  content: '--- a/file.txt\n+++ b/file.txt\n@@ -1 +1 @@\n-old\n+new\n',
                  metadata: { author: 'nodeA' },
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            throw new Error('Process crash before Node B execution')
          }
          return { status: 'completed' }
        },
      })

      const initialRun = await executor1.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(initialRun.status).toBe('failed')
      expect(initialRun.completedNodeIds).toContain('nodeA')
      expect(initialRun.failedNodeIds).toContain('nodeB')

      // Assert durable state of Node A after initial run:
      const nodeAAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeAAttempts).toHaveLength(1)
      expect(nodeAAttempts[0]!.status).toBe('completed')

      const nodeAArtifacts = artifactStore.listForStep(stepIdSchema.parse(nodeAAttempts[0]!.id))
      expect(nodeAArtifacts).toHaveLength(2)

      const checkpoints = workflowStore.getGraphCheckpoints(graphRunId)
      expect(
        checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.completed'),
      ).toBe(true)

      const artifactCountBeforeResume = artifactStore.listForRun(
        runIdSchema.parse(graphRunId),
      ).length
      expect(artifactCountBeforeResume).toBe(2)

      // Fresh Executor 2 resumes after interruption
      let nodeBReceivedInA: string | null = null
      let nodeBReceivedInDiff: string | null = null
      let nodeBExecutionCount = 0

      const executor2 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeB') {
            nodeBExecutionCount++
            nodeBReceivedInA = ctx.incomingSlots.get('inA')?.content ?? null
            nodeBReceivedInDiff = ctx.incomingSlots.get('inDiff')?.content ?? null
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const recoveryResult1 = await executor2.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        invalidatedNodeIds: new Set(['nodeB']),
      })

      // Node A's artifacts were hydrated and resolved by Node B
      expect(recoveryResult1.status).toBe('completed')
      expect(recoveryResult1.completedNodeIds).toEqual(expect.arrayContaining(['nodeA', 'nodeB']))
      expect(nodeBReceivedInA).toBe(JSON.stringify({ key: 'valA' }))
      expect(nodeBReceivedInDiff).toContain('+new')
      expect(nodeBExecutionCount).toBe(1)

      const artifactCountAfterResume1 = artifactStore.listForRun(
        runIdSchema.parse(graphRunId),
      ).length

      // Fresh Executor 3 runs repeated recovery (idempotent replay)
      const executor3 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: () => ({ status: 'completed' }),
      })

      const recoveryResult2 = await executor3.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(recoveryResult2.status).toBe('completed')
      expect(recoveryResult2.completedNodeIds).toEqual(recoveryResult1.completedNodeIds)
      expect(recoveryResult2.artifacts.map((a) => a.id)).toEqual(
        recoveryResult1.artifacts.map((a) => a.id),
      )
      expect(recoveryResult2.artifacts.map((a) => a.content)).toEqual(
        recoveryResult1.artifacts.map((a) => a.content),
      )

      // Zero duplicate artifact rows created across repeated recovery
      const artifactCountAfterResume2 = artifactStore.listForRun(
        runIdSchema.parse(graphRunId),
      ).length
      expect(artifactCountAfterResume2).toBe(artifactCountAfterResume1)
      expect(nodeBExecutionCount).toBe(1) // Node B was not re-executed in replay
    })

    it('TC-2C-REC-08: Node declares a required output but returns zero artifacts. It must not be marked completed', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'outA',
                kind: 'stage-output',
                format: 'json',
                required: true,
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [{ name: 'inA', kind: 'stage-output', required: true }],
          }),
        ],
        [
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'stage-output',
            targetHandle: 'inA',
          },
        ],
      )

      let nodeBExecuted = false

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            // Unmet required output: returns status completed but zero artifacts
            return {
              status: 'completed',
              artifacts: [],
            }
          }
          if (ctx.node.id === 'nodeB') {
            nodeBExecuted = true
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      // Run must fail, and nodeA must not be marked completed
      expect(run.status).toBe('failed')
      expect(run.failedNodeIds).toContain('nodeA')
      expect(run.completedNodeIds).not.toContain('nodeA')
      expect(run.completedNodeIds).not.toContain('nodeB')
      expect(nodeBExecuted).toBe(false)

      const nodeAAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeAAttempts).toHaveLength(1)
      expect(nodeAAttempts[0]!.status).toBe('failed')
      expect(nodeAAttempts[0]!.error).toMatch(/missing required output\(s\): outA/i)

      const checkpoints = workflowStore.getGraphCheckpoints(graphRunId)
      expect(
        checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.completed'),
      ).toBe(false)
      expect(checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.failed')).toBe(
        true,
      )

      // Zero artifacts persisted in store
      expect(artifactStore.listForRun(runIdSchema.parse(graphRunId))).toHaveLength(0)
    })

    it('TC-2C-REC-09: Node has no declared outputs and returns zero artifacts. Existing valid behavior is preserved', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [makeNode('nodeA', { outputs: [] }), makeNode('nodeB', { inputs: [] })],
        [{ source: 'nodeA', target: 'nodeB' }],
      )

      let nodeBExecuted = false

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [],
            }
          }
          if (ctx.node.id === 'nodeB') {
            nodeBExecuted = true
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('completed')
      expect(run.completedNodeIds).toEqual(expect.arrayContaining(['nodeA', 'nodeB']))
      expect(nodeBExecuted).toBe(true)

      const nodeAAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeAAttempts).toHaveLength(1)
      expect(nodeAAttempts[0]!.status).toBe('completed')

      const checkpoints = workflowStore.getGraphCheckpoints(graphRunId)
      expect(
        checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.completed'),
      ).toBe(true)
      expect(artifactStore.listForRun(runIdSchema.parse(graphRunId))).toHaveLength(0)
    })

    it('TC-2C-REC-10: Optional output is absent. Behavior follows the established contract', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'optOut',
                kind: 'stage-output',
                format: 'json',
                required: false,
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [{ name: 'optIn', kind: 'stage-output', required: false }],
          }),
        ],
        [
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'stage-output',
            targetHandle: 'optIn',
          },
        ],
      )

      let nodeBObservedSlot: unknown = 'not-called'

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            // Optional output absent: returns zero artifacts
            return {
              status: 'completed',
              artifacts: [],
            }
          }
          if (ctx.node.id === 'nodeB') {
            nodeBObservedSlot = ctx.incomingSlots.get('optIn') ?? null
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('completed')
      expect(run.completedNodeIds).toEqual(expect.arrayContaining(['nodeA', 'nodeB']))
      expect(nodeBObservedSlot).toBeNull()

      const nodeAAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeAAttempts).toHaveLength(1)
      expect(nodeAAttempts[0]!.status).toBe('completed')

      const checkpoints = workflowStore.getGraphCheckpoints(graphRunId)
      expect(
        checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.completed'),
      ).toBe(true)
      expect(artifactStore.listForRun(runIdSchema.parse(graphRunId))).toHaveLength(0)
    })

    it('TC-2C-REC-11: Required output is absent while ArtifactService is unavailable. The executor must fail closed without false completion', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate([
        makeNode('nodeA', {
          outputs: [
            {
              name: 'reqOut',
              kind: 'stage-output',
              format: 'json',
              required: true,
              requiredSections: [],
            },
          ],
        }),
      ])

      // ArtifactService is explicitly undefined
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService: undefined,
        executeLeafNode: () => ({
          status: 'completed',
          artifacts: [],
        }),
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('failed')
      expect(run.failedNodeIds).toContain('nodeA')
      expect(run.completedNodeIds).not.toContain('nodeA')

      const nodeAAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeAAttempts).toHaveLength(1)
      expect(nodeAAttempts[0]!.status).toBe('failed')
      expect(nodeAAttempts[0]!.error).toMatch(/ArtifactService is required but not configured/i)

      const checkpoints = workflowStore.getGraphCheckpoints(graphRunId)
      expect(
        checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.completed'),
      ).toBe(false)
      expect(checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.failed')).toBe(
        true,
      )
    })

    it('TC-2C-REC-12: Successful persistence of required outputs still completes the attempt and supports recovery', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'reqOut',
                kind: 'stage-output',
                format: 'json',
                required: true,
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [{ name: 'inSlot', kind: 'stage-output', required: true }],
          }),
        ],
        [
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'stage-output',
            targetHandle: 'inSlot',
          },
        ],
      )

      // Executor 1 executes Node A successfully, writing required output; fails at Node B
      const executor1 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'reqOut',
                  content: JSON.stringify({ verified: true }),
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            throw new Error('Simulated process interruption at Node B')
          }
          return { status: 'completed' }
        },
      })

      const initialRun = await executor1.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(initialRun.status).toBe('failed')
      expect(initialRun.completedNodeIds).toContain('nodeA')
      expect(initialRun.failedNodeIds).toContain('nodeB')

      const nodeAAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeAAttempts).toHaveLength(1)
      expect(nodeAAttempts[0]!.status).toBe('completed')

      const nodeAArtifacts = artifactStore.listForStep(stepIdSchema.parse(nodeAAttempts[0]!.id))
      expect(nodeAArtifacts).toHaveLength(1)

      const checkpoints = workflowStore.getGraphCheckpoints(graphRunId)
      expect(
        checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.completed'),
      ).toBe(true)

      // Fresh Executor 2 resumes and recovers Node A's required output
      let nodeBReceivedContent: string | null = null

      const executor2 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeB') {
            nodeBReceivedContent = ctx.incomingSlots.get('inSlot')?.content ?? null
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const recoveryRun = await executor2.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        invalidatedNodeIds: new Set(['nodeB']),
      })

      expect(recoveryRun.status).toBe('completed')
      expect(recoveryRun.completedNodeIds).toEqual(expect.arrayContaining(['nodeA', 'nodeB']))
      expect(nodeBReceivedContent).toBe(JSON.stringify({ verified: true }))

      // Idempotency: exact artifact preserved without duplication
      const finalArtifacts = artifactStore.listForRun(runIdSchema.parse(graphRunId))
      expect(finalArtifacts).toHaveLength(1)
    })

    it('TC-2C-REC-13: Two required outputs sharing the same kind, with only one actually produced', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'out1',
                kind: 'stage-output',
                format: 'json',
                required: true,
                requiredSections: [],
              },
              {
                name: 'out2',
                kind: 'stage-output',
                format: 'json',
                required: true,
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [{ name: 'in1', kind: 'stage-output', required: true }],
          }),
        ],
        [
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'out1',
            targetHandle: 'in1',
          },
        ],
      )

      let nodeBExecuted = false
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            // Only produces out1; out2 is missing
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'out1',
                  content: JSON.stringify({ part: 1 }),
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            nodeBExecuted = true
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('failed')
      expect(run.failedNodeIds).toContain('nodeA')
      expect(run.completedNodeIds).not.toContain('nodeA')
      expect(nodeBExecuted).toBe(false)

      const nodeAAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeAAttempts).toHaveLength(1)
      expect(nodeAAttempts[0]!.status).toBe('failed')
      expect(nodeAAttempts[0]!.error).toMatch(/missing required output\(s\): out2/i)

      const checkpoints = workflowStore.getGraphCheckpoints(graphRunId)
      expect(
        checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.completed'),
      ).toBe(false)
      expect(checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.failed')).toBe(
        true,
      )
    })

    it('TC-2C-REC-14: Two required outputs sharing the same kind, with both correctly produced', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'out1',
                kind: 'stage-output',
                format: 'json',
                required: true,
                requiredSections: [],
              },
              {
                name: 'out2',
                kind: 'stage-output',
                format: 'json',
                required: true,
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [
              { name: 'in1', kind: 'stage-output', required: true },
              { name: 'in2', kind: 'stage-output', required: true },
            ],
          }),
        ],
        [
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'out1',
            targetHandle: 'in1',
          },
          {
            source: 'nodeA',
            target: 'nodeB',
            sourceHandle: 'out2',
            targetHandle: 'in2',
          },
        ],
      )

      let nodeBReceivedIn1: string | null = null
      let nodeBReceivedIn2: string | null = null

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'out1',
                  content: JSON.stringify({ part: 1 }),
                  metadata: {},
                  createdAt: NOW,
                },
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'out2',
                  content: JSON.stringify({ part: 2 }),
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            nodeBReceivedIn1 = ctx.incomingSlots.get('in1')?.content ?? null
            nodeBReceivedIn2 = ctx.incomingSlots.get('in2')?.content ?? null
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('completed')
      expect(run.completedNodeIds).toEqual(expect.arrayContaining(['nodeA', 'nodeB']))
      expect(nodeBReceivedIn1).toBe(JSON.stringify({ part: 1 }))
      expect(nodeBReceivedIn2).toBe(JSON.stringify({ part: 2 }))

      const nodeAAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeAAttempts).toHaveLength(1)
      expect(nodeAAttempts[0]!.status).toBe('completed')

      const persistedArtifacts = artifactStore.listForStep(stepIdSchema.parse(nodeAAttempts[0]!.id))
      expect(persistedArtifacts).toHaveLength(2)
    })

    it('TC-2C-REC-15: One required output missing while unrelated artifacts are present', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate([
        makeNode('nodeA', {
          outputs: [
            {
              name: 'requiredSpec',
              kind: 'stage-output',
              format: 'json',
              required: true,
              requiredSections: [],
            },
          ],
        }),
      ])

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: () => ({
          status: 'completed',
          artifacts: [
            {
              id: randomUUID(),
              workflowId,
              nodeId: 'nodeA',
              kind: 'review_report',
              format: 'markdown',
              title: 'unrelatedReport',
              content: '# Unrelated Report',
              metadata: {},
              createdAt: NOW,
            },
            {
              id: randomUUID(),
              workflowId,
              nodeId: 'nodeA',
              kind: 'execution_log',
              format: 'text',
              title: 'otherLog',
              content: 'Execution log text',
              metadata: {},
              createdAt: NOW,
            },
          ],
        }),
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('failed')
      expect(run.failedNodeIds).toContain('nodeA')

      const nodeAAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeAAttempts).toHaveLength(1)
      expect(nodeAAttempts[0]!.status).toBe('failed')
      expect(nodeAAttempts[0]!.error).toMatch(/missing required output\(s\): requiredSpec/i)

      const checkpoints = workflowStore.getGraphCheckpoints(graphRunId)
      expect(
        checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.completed'),
      ).toBe(false)
    })

    it('TC-2C-REC-16: An unrelated artifact of the expected kind must not satisfy a missing named output', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate([
        makeNode('nodeA', {
          outputs: [
            {
              name: 'spec',
              kind: 'stage-output',
              format: 'json',
              required: true,
              requiredSections: [],
            },
            {
              name: 'analysis',
              kind: 'stage-output',
              format: 'json',
              required: true,
              requiredSections: [],
            },
          ],
        }),
      ])

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: () => ({
          status: 'completed',
          artifacts: [
            {
              id: randomUUID(),
              workflowId,
              nodeId: 'nodeA',
              kind: 'stage-output',
              format: 'json',
              title: 'unrelated',
              content: JSON.stringify({ random: true }),
              metadata: {},
              createdAt: NOW,
            },
          ],
        }),
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('failed')
      expect(run.failedNodeIds).toContain('nodeA')

      const nodeAAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeAAttempts).toHaveLength(1)
      expect(nodeAAttempts[0]!.status).toBe('failed')
      expect(nodeAAttempts[0]!.error).toMatch(/missing required output\(s\): spec, analysis/i)
    })

    it('TC-2C-REC-17: Multiple required outputs must not be satisfied by reusing one artifact', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate([
        makeNode('nodeA', {
          outputs: [
            {
              name: 'primary',
              kind: 'stage-output',
              format: 'json',
              required: true,
              requiredSections: [],
            },
            {
              name: 'secondary',
              kind: 'stage-output',
              format: 'json',
              required: true,
              requiredSections: [],
            },
          ],
        }),
      ])

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: () => ({
          status: 'completed',
          artifacts: [
            // Only 1 artifact produced matching 'primary'
            {
              id: randomUUID(),
              workflowId,
              nodeId: 'nodeA',
              kind: 'stage-output',
              format: 'json',
              title: 'primary',
              content: JSON.stringify({ item: 'primary' }),
              metadata: {},
              createdAt: NOW,
            },
          ],
        }),
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('failed')
      expect(run.failedNodeIds).toContain('nodeA')

      const nodeAAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeAAttempts).toHaveLength(1)
      expect(nodeAAttempts[0]!.status).toBe('failed')
      expect(nodeAAttempts[0]!.error).toMatch(/missing required output\(s\): secondary/i)
    })

    it('TC-2C-REC-18: Optional artifact is emitted while ArtifactService is unavailable', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate([
        makeNode('nodeA', {
          outputs: [
            {
              name: 'optionalMetric',
              kind: 'stage-output',
              format: 'json',
              required: false,
              requiredSections: [],
            },
          ],
        }),
      ])

      // ArtifactService explicitly unavailable
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService: undefined,
        executeLeafNode: () => ({
          status: 'completed',
          artifacts: [
            {
              id: randomUUID(),
              workflowId,
              nodeId: 'nodeA',
              kind: 'stage-output',
              format: 'json',
              title: 'optionalMetric',
              content: JSON.stringify({ metric: 42 }),
              metadata: {},
              createdAt: NOW,
            },
          ],
        }),
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      // Must fail closed rather than silently dropping emitted optional artifacts
      expect(run.status).toBe('failed')
      expect(run.failedNodeIds).toContain('nodeA')

      const nodeAAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
      expect(nodeAAttempts).toHaveLength(1)
      expect(nodeAAttempts[0]!.status).toBe('failed')
      expect(nodeAAttempts[0]!.error).toMatch(/ArtifactService is required but not configured/i)

      const checkpoints = workflowStore.getGraphCheckpoints(graphRunId)
      expect(
        checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.completed'),
      ).toBe(false)
      expect(checkpoints.some((c) => c.nodeId === 'nodeA' && c.operation === 'node.failed')).toBe(
        true,
      )
    })

    // TC-2C-REC-19: A named output is missing while another artifact of the same kind exists.
    it('TC-2C-REC-19: A named output is missing while another artifact of the same kind exists', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'unrelatedOutput',
                kind: 'stage-output',
                format: 'json',
                required: true,
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [
              {
                name: 'expectedSlot',
                kind: 'stage-output',
                required: true,
              },
            ],
          }),
        ],
        [
          {
            id: 'e-a-b',
            source: 'nodeA',
            sourceHandle: 'missingNamedOutput',
            target: 'nodeB',
            targetHandle: 'expectedSlot',
          },
        ],
      )

      let bRan = false
      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'unrelatedOutput',
                  content: JSON.stringify({ message: 'unrelated' }),
                  metadata: { outputName: 'unrelatedOutput' },
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            bRan = true
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      // Node B must NOT substitute unrelatedOutput into expectedSlot merely because the kind matches
      expect(run.status).toBe('failed')
      expect(run.completedNodeIds).toContain('nodeA')
      expect(run.blockedNodeIds).toContain('nodeB')
      expect(bRan).toBe(false)

      const bAttempts = workflowStore.getNodeAttempts(graphRunId, 'nodeB')
      expect(bAttempts).toHaveLength(1)
      expect(bAttempts[0]!.status).toBe('blocked')
      expect(bAttempts[0]!.error).toMatch(/Missing required input slot: expectedSlot/i)
    })

    // TC-2C-REC-20: Two outputs share a kind and each edge must resolve its own artifact.
    it('TC-2C-REC-20: Two outputs share a kind and each edge must resolve its own artifact', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'artifactAlpha',
                kind: 'stage-output',
                format: 'json',
                required: true,
                requiredSections: [],
              },
              {
                name: 'artifactBeta',
                kind: 'stage-output',
                format: 'json',
                required: true,
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [
              {
                name: 'slotAlpha',
                kind: 'stage-output',
                required: true,
              },
              {
                name: 'slotBeta',
                kind: 'stage-output',
                required: true,
              },
            ],
          }),
        ],
        [
          {
            id: 'e-alpha',
            source: 'nodeA',
            sourceHandle: 'artifactAlpha',
            target: 'nodeB',
            targetHandle: 'slotAlpha',
          },
          {
            id: 'e-beta',
            source: 'nodeA',
            sourceHandle: 'artifactBeta',
            target: 'nodeB',
            targetHandle: 'slotBeta',
          },
        ],
      )

      let receivedSlotAlpha: WorkflowArtifact | undefined
      let receivedSlotBeta: WorkflowArtifact | undefined

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'artifactAlpha',
                  content: JSON.stringify({ identity: 'alpha' }),
                  metadata: { outputName: 'artifactAlpha' },
                  createdAt: NOW,
                },
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'artifactBeta',
                  content: JSON.stringify({ identity: 'beta' }),
                  metadata: { outputName: 'artifactBeta' },
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            receivedSlotAlpha = ctx.incomingSlots.get('slotAlpha')
            receivedSlotBeta = ctx.incomingSlots.get('slotBeta')
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('completed')
      expect(run.completedNodeIds).toEqual(['nodeA', 'nodeB'])

      expect(receivedSlotAlpha).toBeDefined()
      expect(receivedSlotBeta).toBeDefined()
      expect(JSON.parse(receivedSlotAlpha!.content)).toEqual({ identity: 'alpha' })
      expect(JSON.parse(receivedSlotBeta!.content)).toEqual({ identity: 'beta' })
    })

    // TC-2C-REC-21: An optional named output is absent and must not receive an unrelated artifact.
    it('TC-2C-REC-21: An optional named output is absent and must not receive an unrelated artifact', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'requiredReport',
                kind: 'stage-output',
                format: 'json',
                required: true,
                requiredSections: [],
              },
              {
                name: 'optionalDiagnostics',
                kind: 'stage-output',
                format: 'json',
                required: false,
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [
              {
                name: 'boundReport',
                kind: 'stage-output',
                required: true,
              },
              {
                name: 'boundDiagnostics',
                kind: 'stage-output',
                required: false,
              },
            ],
          }),
        ],
        [
          {
            id: 'e-report',
            source: 'nodeA',
            sourceHandle: 'requiredReport',
            target: 'nodeB',
            targetHandle: 'boundReport',
          },
          {
            id: 'e-diag',
            source: 'nodeA',
            sourceHandle: 'optionalDiagnostics',
            target: 'nodeB',
            targetHandle: 'boundDiagnostics',
          },
        ],
      )

      let nodeBIncomingSlots: ReadonlyMap<string, WorkflowArtifact> | undefined

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            // Only produces requiredReport; optionalDiagnostics is legitimately omitted
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'requiredReport',
                  content: JSON.stringify({ type: 'report' }),
                  metadata: { outputName: 'requiredReport' },
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            nodeBIncomingSlots = ctx.incomingSlots
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('completed')
      expect(nodeBIncomingSlots).toBeDefined()
      expect(nodeBIncomingSlots!.has('boundReport')).toBe(true)
      expect(JSON.parse(nodeBIncomingSlots!.get('boundReport')!.content)).toEqual({
        type: 'report',
      })
      // Crucial: optionalDiagnostics was absent, so boundDiagnostics must remain undefined, NOT substituted with requiredReport
      expect(nodeBIncomingSlots!.has('boundDiagnostics')).toBe(false)
    })

    // TC-2C-REC-22: Existing kind-based edge routing remains compatible.
    it('TC-2C-REC-22: Existing kind-based edge routing remains compatible', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      // Template uses sourceHandle: 'stage-output' as an artifact kind rather than a named output
      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'legacyOutput',
                kind: 'stage-output',
                format: 'json',
                required: true,
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [
              {
                name: 'stage-output',
                kind: 'stage-output',
                required: true,
              },
            ],
          }),
        ],
        [
          {
            id: 'e-kind-based',
            source: 'nodeA',
            sourceHandle: 'stage-output',
            target: 'nodeB',
            targetHandle: 'stage-output',
          },
        ],
      )

      let nodeBReceivedArtifact: WorkflowArtifact | undefined

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'legacyOutput',
                  content: JSON.stringify({ legacy: true }),
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            nodeBReceivedArtifact = ctx.incomingSlots.get('stage-output')
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('completed')
      expect(nodeBReceivedArtifact).toBeDefined()
      expect(JSON.parse(nodeBReceivedArtifact!.content)).toEqual({ legacy: true })
    })

    // TC-2C-REC-23: Recovery hydration and normal execution resolve the same output identity.
    it('TC-2C-REC-23: Recovery hydration and normal execution resolve the same output identity', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'configReport',
                kind: 'stage-output',
                format: 'json',
                required: true,
                requiredSections: [],
              },
              {
                name: 'dataReport',
                kind: 'stage-output',
                format: 'json',
                required: true,
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [
              {
                name: 'resolvedConfig',
                kind: 'stage-output',
                required: true,
              },
              {
                name: 'resolvedData',
                kind: 'stage-output',
                required: true,
              },
            ],
          }),
        ],
        [
          {
            id: 'e-cfg',
            source: 'nodeA',
            sourceHandle: 'configReport',
            target: 'nodeB',
            targetHandle: 'resolvedConfig',
          },
          {
            id: 'e-dat',
            source: 'nodeA',
            sourceHandle: 'dataReport',
            target: 'nodeB',
            targetHandle: 'resolvedData',
          },
        ],
      )

      // Step 1: Execute Node A to completion, then simulate process termination before Node B executes
      const executor1 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'configReport',
                  content: JSON.stringify({ cfgVal: 'cfg-101' }),
                  metadata: { outputName: 'configReport' },
                  createdAt: NOW,
                },
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'dataReport',
                  content: JSON.stringify({ datVal: 'dat-202' }),
                  metadata: { outputName: 'dataReport' },
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            throw new Error('Simulated process crash before Node B execution')
          }
          return { status: 'completed' }
        },
      })

      const run1 = await executor1.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })
      expect(run1.status).toBe('failed')
      expect(run1.completedNodeIds).toContain('nodeA')

      // Step 2: Fresh executor simulates process restart and recovery
      let resumedSlotConfig: WorkflowArtifact | undefined
      let resumedSlotData: WorkflowArtifact | undefined

      const executor2 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeB') {
            resumedSlotConfig = ctx.incomingSlots.get('resolvedConfig')
            resumedSlotData = ctx.incomingSlots.get('resolvedData')
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const resumedRun = await executor2.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        invalidatedNodeIds: new Set(['nodeB']),
      })

      expect(resumedRun.status).toBe('completed')
      expect(resumedRun.completedNodeIds).toContain('nodeB')

      // Hydrated slots must resolve exact output identities without swapping or ambiguity
      expect(resumedSlotConfig).toBeDefined()
      expect(resumedSlotData).toBeDefined()
      expect(JSON.parse(resumedSlotConfig!.content)).toEqual({ cfgVal: 'cfg-101' })
      expect(JSON.parse(resumedSlotData!.content)).toEqual({ datVal: 'dat-202' })
    })

    // TC-2C-REC-24: Undeclared output emitted without ArtifactService fails closed in production mode, succeeds with testOnlyAllowEphemeralArtifacts.
    it('TC-2C-REC-24: Undeclared output emitted without ArtifactService follows durability boundary', async () => {
      const runStore = new RunStore(db)

      // Part A: In default/production mode, emitted undeclared artifact requires ArtifactService and fails closed
      const graphRunIdA = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunIdA),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const templateA = makeTemplate([
        makeNode('nodeA', {
          outputs: [], // Undeclared outputs
        }),
      ])

      const executorProduction = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService: undefined, // ArtifactService unavailable
        executeLeafNode: () => ({
          status: 'completed',
          artifacts: [
            {
              id: randomUUID(),
              workflowId,
              nodeId: 'nodeA',
              kind: 'stage-output',
              format: 'json',
              title: 'undeclaredMetric',
              content: JSON.stringify({ undeclared: true }),
              metadata: {},
              createdAt: NOW,
            },
          ],
        }),
      })

      const runA = await executorProduction.run({
        graphRunId: graphRunIdA,
        workflowId,
        projectId,
        template: templateA,
        forkSha,
      })

      expect(runA.status).toBe('failed')
      expect(runA.failedNodeIds).toContain('nodeA')
      const attemptsA = workflowStore.getNodeAttempts(graphRunIdA, 'nodeA')
      expect(attemptsA[0]!.status).toBe('failed')
      expect(attemptsA[0]!.error).toMatch(/ArtifactService is required but not configured/i)

      // Part B: In explicit test mode (testOnlyAllowEphemeralArtifacts: true), in-memory execution succeeds
      const graphRunIdB = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunIdB),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const executorTestMode = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService: undefined,
        testOnlyAllowEphemeralArtifacts: true, // Explicit test opt-in
        executeLeafNode: () => ({
          status: 'completed',
          artifacts: [
            {
              id: randomUUID(),
              workflowId,
              nodeId: 'nodeA',
              kind: 'stage-output',
              format: 'json',
              title: 'ephemeralMetric',
              content: JSON.stringify({ ephemeral: true }),
              metadata: {},
              createdAt: NOW,
            },
          ],
        }),
      })

      const runB = await executorTestMode.run({
        graphRunId: graphRunIdB,
        workflowId,
        projectId,
        template: templateA,
        forkSha,
      })

      expect(runB.status).toBe('completed')
      expect(runB.completedNodeIds).toContain('nodeA')
      const attemptsB = workflowStore.getNodeAttempts(graphRunIdB, 'nodeA')
      expect(attemptsB[0]?.status).toBe('completed')
    })

    // TC-2C-REC-25: Multiple same-kind candidates with a unique target-handle match resolve correctly.
    it('TC-2C-REC-25: Multiple same-kind candidates with a unique target-handle match resolve correctly', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              { name: 'targetSlotA', kind: 'stage-output', format: 'json', requiredSections: [] },
              {
                name: 'otherCandidate',
                kind: 'stage-output',
                format: 'json',
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [{ name: 'targetSlotA', kind: 'stage-output', required: true }],
          }),
        ],
        [
          {
            id: 'e-unique-target',
            source: 'nodeA',
            sourceHandle: 'stage-output',
            target: 'nodeB',
            targetHandle: 'targetSlotA',
          },
        ],
      )

      let receivedContent: string | null = null

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'targetSlotA',
                  content: JSON.stringify({ match: 'targetSlotA' }),
                  metadata: { outputName: 'targetSlotA' },
                  createdAt: NOW,
                },
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'otherCandidate',
                  content: JSON.stringify({ match: 'otherCandidate' }),
                  metadata: { outputName: 'otherCandidate' },
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            receivedContent = ctx.incomingSlots.get('targetSlotA')?.content ?? null
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('completed')
      expect(run.completedNodeIds).toContain('nodeB')
      expect(receivedContent).toBe(JSON.stringify({ match: 'targetSlotA' }))
    })

    // TC-2C-REC-26: Multiple same-kind candidates without a unique identity fail closed with a diagnostic.
    it('TC-2C-REC-26: Multiple same-kind candidates without a unique identity fail closed with a diagnostic', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              { name: 'report1', kind: 'stage-output', format: 'json', requiredSections: [] },
              { name: 'report2', kind: 'stage-output', format: 'json', requiredSections: [] },
            ],
          }),
          makeNode('nodeB', {
            inputs: [{ name: 'unmatchedSlot', kind: 'stage-output', required: true }],
          }),
        ],
        [
          {
            id: 'e-ambiguous',
            source: 'nodeA',
            sourceHandle: 'stage-output',
            target: 'nodeB',
            targetHandle: 'unmatchedSlot',
          },
        ],
      )

      let nodeBExecuted = false

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'report1',
                  content: JSON.stringify({ r: 1 }),
                  metadata: { outputName: 'report1' },
                  createdAt: NOW,
                },
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'report2',
                  content: JSON.stringify({ r: 2 }),
                  metadata: { outputName: 'report2' },
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            nodeBExecuted = true
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('failed')
      expect(run.blockedNodeIds).toContain('nodeB')
      expect(nodeBExecuted).toBe(false)

      const attemptsB = workflowStore.getNodeAttempts(graphRunId, 'nodeB')
      expect(attemptsB).toHaveLength(1)
      const attemptB = attemptsB[0]
      expect(attemptB?.status).toBe('blocked')
      expect(attemptB?.error).toBe(
        'Ambiguous artifact resolution on edge "e-ambiguous" from source "nodeA" to target slot "unmatchedSlot": multiple candidates (2) found of kind "stage-output" without a unique identity match',
      )
    })

    // TC-2C-REC-27: An already-mapped candidate cannot cause an arbitrary fallback to another candidate.
    it('TC-2C-REC-27: An already-mapped candidate cannot cause an arbitrary fallback to another candidate', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              { name: 'outA', kind: 'stage-output', format: 'json', requiredSections: [] },
              { name: 'outB', kind: 'stage-output', format: 'json', requiredSections: [] },
            ],
          }),
          makeNode('nodeB', {
            inputs: [
              { name: 'outA', kind: 'stage-output', required: true },
              { name: 'unmatchedSlot', kind: 'stage-output', required: true },
            ],
          }),
        ],
        [
          {
            id: 'e-mapped-1',
            source: 'nodeA',
            sourceHandle: 'stage-output',
            target: 'nodeB',
            targetHandle: 'outA',
          },
          {
            id: 'e-fallback-2',
            source: 'nodeA',
            sourceHandle: 'stage-output',
            target: 'nodeB',
            targetHandle: 'unmatchedSlot',
          },
        ],
      )

      let nodeBExecuted = false

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'outA',
                  content: JSON.stringify({ item: 'A' }),
                  metadata: { outputName: 'outA' },
                  createdAt: NOW,
                },
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'outB',
                  content: JSON.stringify({ item: 'B' }),
                  metadata: { outputName: 'outB' },
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            nodeBExecuted = true
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('failed')
      expect(run.blockedNodeIds).toContain('nodeB')
      expect(nodeBExecuted).toBe(false)

      const attemptsB = workflowStore.getNodeAttempts(graphRunId, 'nodeB')
      expect(attemptsB).toHaveLength(1)
      const attemptB = attemptsB[0]
      expect(attemptB?.status).toBe('blocked')
      expect(attemptB?.error).toBe(
        'Ambiguous artifact resolution on edge "e-fallback-2" from source "nodeA" to target slot "unmatchedSlot": multiple candidates (2) found of kind "stage-output" without a unique identity match',
      )
    })

    // TC-2C-REC-28: Multiple candidates of the same kind on an edge without handles fail closed when an input slot requires that kind.
    it('TC-2C-REC-28: Multiple candidates of the same kind on an edge without handles fail closed', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              { name: 'data1', kind: 'stage-output', format: 'json', requiredSections: [] },
              { name: 'data2', kind: 'stage-output', format: 'json', requiredSections: [] },
            ],
          }),
          makeNode('nodeB', {
            inputs: [{ name: 'stage-output', kind: 'stage-output', required: true }],
          }),
        ],
        [
          {
            id: 'e-no-handles',
            source: 'nodeA',
            target: 'nodeB',
          },
        ],
      )

      let nodeBExecuted = false

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'data1',
                  content: JSON.stringify({ d: 1 }),
                  metadata: { outputName: 'data1' },
                  createdAt: NOW,
                },
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'data2',
                  content: JSON.stringify({ d: 2 }),
                  metadata: { outputName: 'data2' },
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            nodeBExecuted = true
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('failed')
      expect(run.blockedNodeIds).toContain('nodeB')
      expect(nodeBExecuted).toBe(false)

      const attemptsB = workflowStore.getNodeAttempts(graphRunId, 'nodeB')
      expect(attemptsB).toHaveLength(1)
      const attemptB = attemptsB[0]
      expect(attemptB?.status).toBe('blocked')
      expect(attemptB?.error).toBe(
        'Ambiguous artifact resolution on edge "e-no-handles" from source "nodeA" to target node "nodeB": multiple candidates (2) found of kind "stage-output" on edge without handles',
      )
    })

    // TC-2C-REC-29: Recovery hydration preserves ambiguous resolution failure deterministically without array-order tie-breaking.
    it('TC-2C-REC-29: Recovery hydration preserves ambiguous resolution failure deterministically', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              { name: 'item1', kind: 'stage-output', format: 'json', requiredSections: [] },
              { name: 'item2', kind: 'stage-output', format: 'json', requiredSections: [] },
            ],
          }),
          makeNode('nodeB', {
            inputs: [{ name: 'slotUnmatched', kind: 'stage-output', required: true }],
          }),
        ],
        [
          {
            id: 'e-rec-ambiguous',
            source: 'nodeA',
            sourceHandle: 'stage-output',
            target: 'nodeB',
            targetHandle: 'slotUnmatched',
          },
        ],
      )

      // Step 1: Run Node A to completion, writing both artifacts durably to ArtifactService
      const executor1 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'item1',
                  content: JSON.stringify({ item: 1 }),
                  metadata: { outputName: 'item1' },
                  createdAt: NOW,
                },
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'item2',
                  content: JSON.stringify({ item: 2 }),
                  metadata: { outputName: 'item2' },
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            throw new Error('Process interrupted before Node B runs')
          }
          return { status: 'completed' }
        },
      })

      const run1 = await executor1.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })
      expect(run1.completedNodeIds).toContain('nodeA')

      // Step 2: Simulate process crash, restart with fresh executor, and resume Node B
      let nodeBExecuted = false
      const executor2 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeB') {
            nodeBExecuted = true
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run2 = await executor2.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        invalidatedNodeIds: new Set(['nodeB']),
      })

      expect(run2.status).toBe('failed')
      expect(run2.blockedNodeIds).toContain('nodeB')
      expect(nodeBExecuted).toBe(false)

      const attemptsB = workflowStore.getNodeAttempts(graphRunId, 'nodeB')
      const latestAttemptB = attemptsB.at(-1)
      expect(latestAttemptB?.status).toBe('blocked')
      expect(latestAttemptB?.error).toBe(
        'Ambiguous artifact resolution on edge "e-rec-ambiguous" from source "nodeA" to target slot "slotUnmatched": multiple candidates (2) found of kind "stage-output" without a unique identity match',
      )
    })

    // TC-2C-REC-30: Explicitly referenced declared output is missing while source emits different artifact of same kind; target must be blocked.
    it('TC-2C-REC-30: Explicitly referenced declared output is missing while source emits different artifact of same kind', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'analysis',
                kind: 'stage-output',
                format: 'json',
                required: false,
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [
              {
                name: 'report',
                kind: 'stage-output',
                required: true,
              },
            ],
          }),
        ],
        [
          {
            id: 'e-explicit-analysis',
            source: 'nodeA',
            sourceHandle: 'analysis',
            target: 'nodeB',
            targetHandle: 'report',
          },
        ],
      )

      let nodeBExecuted = false

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            // Emits a different artifact of kind 'stage-output', but does not emit 'analysis'
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'unrelatedReport',
                  content: JSON.stringify({ other: true }),
                  metadata: { outputName: 'unrelatedReport' },
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            nodeBExecuted = true
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('failed')
      expect(run.completedNodeIds).toContain('nodeA')
      expect(run.blockedNodeIds).toContain('nodeB')
      expect(nodeBExecuted).toBe(false)

      const attemptsB = workflowStore.getNodeAttempts(graphRunId, 'nodeB')
      expect(attemptsB).toHaveLength(1)
      expect(attemptsB[0]?.status).toBe('blocked')
      expect(attemptsB[0]?.error).toBe(
        'Explicitly referenced declared output "analysis" from source "nodeA" was not produced for target slot "report" on edge "e-explicit-analysis"',
      )
    })

    // TC-2C-REC-31: Recovery hydration preserves fail-closed blocking when explicitly referenced declared output is missing.
    it('TC-2C-REC-31: Recovery hydration preserves fail-closed blocking when explicitly referenced declared output is missing', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA', {
            outputs: [
              {
                name: 'analysis',
                kind: 'stage-output',
                format: 'json',
                required: false,
                requiredSections: [],
              },
            ],
          }),
          makeNode('nodeB', {
            inputs: [
              {
                name: 'report',
                kind: 'stage-output',
                required: true,
              },
            ],
          }),
        ],
        [
          {
            id: 'e-rec-analysis',
            source: 'nodeA',
            sourceHandle: 'analysis',
            target: 'nodeB',
            targetHandle: 'report',
          },
        ],
      )

      // Step 1: Run Node A to completion, writing unrelatedReport to ArtifactService
      const executor1 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'unrelatedReport',
                  content: JSON.stringify({ other: true }),
                  metadata: { outputName: 'unrelatedReport' },
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            throw new Error('Interrupted before node B')
          }
          return { status: 'completed' }
        },
      })

      const run1 = await executor1.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })
      expect(run1.completedNodeIds).toContain('nodeA')

      // Step 2: Resume with fresh executor after process crash
      let nodeBExecuted = false
      const executor2 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeB') {
            nodeBExecuted = true
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run2 = await executor2.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        invalidatedNodeIds: new Set(['nodeB']),
      })

      expect(run2.status).toBe('failed')
      expect(run2.blockedNodeIds).toContain('nodeB')
      expect(nodeBExecuted).toBe(false)

      const attemptsB = workflowStore.getNodeAttempts(graphRunId, 'nodeB')
      const latestAttemptB = attemptsB.at(-1)
      expect(latestAttemptB?.status).toBe('blocked')
      expect(latestAttemptB?.error).toBe(
        'Explicitly referenced declared output "analysis" from source "nodeA" was not produced for target slot "report" on edge "e-rec-analysis"',
      )
    })

    // TC-2C-REC-32: Matching target-handle name but wrong artifact kind fails closed with diagnostic.
    it('TC-2C-REC-32: Matching target-handle name but wrong artifact kind fails closed with diagnostic', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA'),
          makeNode('nodeB', {
            inputs: [
              {
                name: 'specSlot',
                kind: 'stage-output',
                required: true,
              },
            ],
          }),
        ],
        [
          {
            id: 'e-name-wrong-kind',
            source: 'nodeA',
            target: 'nodeB',
            targetHandle: 'specSlot',
          },
        ],
      )

      let nodeBExecuted = false
      const mismatchArtifactId = randomUUID()

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: mismatchArtifactId,
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'diff', // wrong kind! Expected 'stage-output', but 'diff' is a valid artifactKindSchema
                  format: 'diff',
                  title: 'specSlot',
                  content: 'plain text data',
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            nodeBExecuted = true
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('failed')
      expect(run.blockedNodeIds).toContain('nodeB')
      expect(nodeBExecuted).toBe(false)

      const attemptsB = workflowStore.getNodeAttempts(graphRunId, 'nodeB')
      expect(attemptsB).toHaveLength(1)
      expect(attemptsB[0]?.status).toBe('blocked')
      expect(attemptsB[0]?.error).toBe(
        `Incompatible artifact kind on edge "e-name-wrong-kind" from source "nodeA" for target slot "specSlot": expected kind "stage-output", but resolved artifact "${mismatchArtifactId}" has kind "diff"`,
      )
    })

    // TC-2C-REC-33: Matching target-handle name and correct artifact kind succeeds.
    it('TC-2C-REC-33: Matching target-handle name and correct artifact kind succeeds', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA'),
          makeNode('nodeB', {
            inputs: [
              {
                name: 'specSlot',
                kind: 'stage-output',
                required: true,
              },
            ],
          }),
        ],
        [
          {
            id: 'e-name-correct-kind',
            source: 'nodeA',
            target: 'nodeB',
            targetHandle: 'specSlot',
          },
        ],
      )

      let nodeBReceivedArtifact: WorkflowArtifact | undefined

      const executor = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'stage-output',
                  format: 'json',
                  title: 'specSlot',
                  content: JSON.stringify({ verified: true }),
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            nodeBReceivedArtifact = ctx.incomingSlots.get('specSlot')
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      expect(run.status).toBe('completed')
      expect(run.completedNodeIds).toContain('nodeB')
      expect(nodeBReceivedArtifact).toBeDefined()
      expect(JSON.parse(nodeBReceivedArtifact!.content)).toEqual({ verified: true })
    })

    // TC-2C-REC-34: Recovery hydration preserves fail-closed blocking on incompatible artifact kind for target-handle name match.
    it('TC-2C-REC-34: Recovery hydration preserves fail-closed blocking on incompatible artifact kind for target-handle match', async () => {
      const runStore = new RunStore(db)
      const graphRunId = randomUUID()
      runStore.createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: NOW,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      const template = makeTemplate(
        [
          makeNode('nodeA'),
          makeNode('nodeB', {
            inputs: [
              {
                name: 'specSlot',
                kind: 'stage-output',
                required: true,
              },
            ],
          }),
        ],
        [
          {
            id: 'e-rec-wrong-kind',
            source: 'nodeA',
            target: 'nodeB',
            targetHandle: 'specSlot',
          },
        ],
      )

      const mismatchArtifactId = randomUUID()

      // Step 1: Node A completes and persists incompatible artifact to ArtifactService
      const executor1 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeA') {
            return {
              status: 'completed',
              artifacts: [
                {
                  id: mismatchArtifactId,
                  workflowId,
                  nodeId: 'nodeA',
                  kind: 'diff',
                  format: 'diff',
                  title: 'specSlot',
                  content: 'diff --git ...',
                  metadata: {},
                  createdAt: NOW,
                },
              ],
            }
          }
          if (ctx.node.id === 'nodeB') {
            throw new Error('Interrupted')
          }
          return { status: 'completed' }
        },
      })

      const run1 = await executor1.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })
      expect(run1.completedNodeIds).toContain('nodeA')

      // Step 2: Resume with fresh executor
      let nodeBExecuted = false
      const executor2 = new GraphExecutor({
        workflowStore,
        worktreeService,
        artifactService,
        executeLeafNode: (ctx) => {
          if (ctx.node.id === 'nodeB') {
            nodeBExecuted = true
            return { status: 'completed' }
          }
          return { status: 'completed' }
        },
      })

      const run2 = await executor2.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
        invalidatedNodeIds: new Set(['nodeB']),
      })

      expect(run2.status).toBe('failed')
      expect(run2.blockedNodeIds).toContain('nodeB')
      expect(nodeBExecuted).toBe(false)

      const attemptsB = workflowStore.getNodeAttempts(graphRunId, 'nodeB')
      const latestAttemptB = attemptsB.at(-1)
      expect(latestAttemptB?.status).toBe('blocked')
      expect(latestAttemptB?.error).toBe(
        `Incompatible artifact kind on edge "e-rec-wrong-kind" from source "nodeA" for target slot "specSlot": expected kind "stage-output", but resolved artifact "${mismatchArtifactId}" has kind "diff"`,
      )
    })
  })
})
