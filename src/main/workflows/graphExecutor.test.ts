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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  changeSetIdSchema,
  projectIdSchema,
  repositoryIdSchema,
  runIdSchema,
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
})
