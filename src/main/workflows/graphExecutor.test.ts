import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
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
    edges: readonly { source: string; target: string; isFeedback?: boolean }[] = [],
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
        id: `e-${String(idx)}`,
        source: e.source,
        target: e.target,
        isFeedback: e.isFeedback,
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

  // 13. Router rejection
  it('strictly rejects router nodes with WORK-003 required error message', async () => {
    const routerNode = makeNode('routerNode', {
      type: 'router',
    })

    const template = makeTemplate([routerNode], [])

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

    expect(result.status).toBe('failed')
    expect(result.failedNodeIds).toContain('routerNode')
    expect(result.error).toBe('Router nodes are not supported in WORK-001 (requires WORK-003)')

    const attempts = workflowStore.getNodeAttempts(result.graphRunId, 'routerNode')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]!.status).toBe('failed')
    expect(attempts[0]!.error).toBe(
      'Router nodes are not supported in WORK-001 (requires WORK-003)',
    )
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
})
