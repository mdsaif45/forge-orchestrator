import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decisionIdSchema,
  projectIdSchema,
  repositoryIdSchema,
  taskIdSchema,
  workflowIdSchema,
  type ProjectId,
  type Sha,
  type TaskId,
  type WorkflowEdge,
  type WorkflowId,
  type WorkflowNode,
  type WorkflowTemplateV2,
} from '@shared/domain'
import { DecisionStore } from '../db/decisionStore'
import { initialiseDatabase, type ForgeDatabase } from '../db'
import { EventStore } from '../db/eventStore'
import { ProjectStore } from '../db/projectStore'
import { applyEvent } from '../db/projections'
import { WorkflowStore } from '../db/workflowStore'
import { WorktreeService } from '../git'
import { GraphExecutor } from './graphExecutor'

describe('GraphExecutor Lifecycle & Recovery Invariants (M6 Phase 5)', () => {
  const dirsToCleanup: string[] = []
  let dbFile: string
  let db: ForgeDatabase
  let closeDb: () => void
  let workflowStore: WorkflowStore
  let decisionStore: DecisionStore
  let repoDir: string
  let worktreeRoot: string
  let worktreeService: WorktreeService
  let forkSha: Sha
  let projectId: ProjectId
  let taskId: TaskId
  let workflowId: WorkflowId

  const NOW = new Date().toISOString()

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'forge-lc-repo-'))
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
      description: 'Template for GraphExecutor lifecycle tests',
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
    const tempDbDir = mkdtempSync(join(tmpdir(), 'forge-lc-db-'))
    dirsToCleanup.push(tempDbDir)
    dbFile = join(tempDbDir, 'forge.db')
    const opened = initialiseDatabase(dbFile)
    db = opened.db
    closeDb = opened.close

    workflowStore = new WorkflowStore(db)
    const eventStore = new EventStore(db)
    decisionStore = new DecisionStore(db, eventStore)

    repoDir = makeRepo()
    worktreeRoot = mkdtempSync(join(tmpdir(), 'forge-lc-wt-'))
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
            objective: 'Complete lifecycle task',
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

  // 1. Resumable blocked node does not finalize its graph run
  it('invariant 1 & 2: a resumable blocked node does not finalize its graph run and leaves finishedAt null', async () => {
    const userGate = makeNode('gate', { type: 'user_gate' })
    const worker = makeNode('worker')
    const template = makeTemplate([userGate, worker], [{ source: 'gate', target: 'worker' }])

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      decisionStore,
    })

    // Run without locked decisions: gate blocks awaiting user
    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(result.status).toBe('running')
    expect(result.blockedNodeIds).toEqual(['gate'])
    expect(result.completedNodeIds).toEqual([])
    expect(result.failedNodeIds).toEqual([])

    // Verify database invariants
    const runInDb = workflowStore.getGraphRun(result.graphRunId)
    expect(runInDb).not.toBeNull()
    expect(runInDb?.status).toBe('running')
    expect(runInDb?.finishedAt).toBeNull()

    const attempts = workflowStore.getNodeAttempts(result.graphRunId, 'gate')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status).toBe('blocked')
    expect(attempts[0]?.finishedAt).not.toBeNull()

    const latestCheckpoint = workflowStore.getLatestGraphCheckpoint(result.graphRunId)
    expect(latestCheckpoint).not.toBeNull()
    expect(latestCheckpoint?.operation).toBe('node.blocked')
    expect(latestCheckpoint?.stateSnapshot.blockedNodeIds).toContain('gate')
  })

  // 2. Discoverable by findInterruptedGraphRuns and protected from crash recovery
  it('invariant 1 & 2: a run waiting for user input is discoverable by findInterruptedGraphRuns and protected during recovery', async () => {
    const userGate = makeNode('gate', { type: 'user_gate' })
    const template = makeTemplate([userGate])

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      decisionStore,
    })

    const result = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    // Discoverable in interrupted runs
    const interrupted = workflowStore.findInterruptedGraphRuns(projectId)
    expect(interrupted).toHaveLength(1)
    expect(interrupted[0]?.id).toBe(result.graphRunId)

    // Crash recovery invocation: should NOT mark this run failed
    const recovered = await executor.recover(projectId)
    expect(recovered).toHaveLength(0)

    const runAfterRecover = workflowStore.getGraphRun(result.graphRunId)
    expect(runAfterRecover?.status).toBe('running')
    expect(runAfterRecover?.finishedAt).toBeNull()
  })

  // 3. Non-resumable blocked node does not become silently resumable
  it('invariant 3: a non-resumable blocked node (missing required input slot) finalizes as failed with finishedAt', async () => {
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
    expect(result.blockedNodeIds).toEqual(['B'])
    expect(result.failedNodeIds).toEqual([])

    const runInDb = workflowStore.getGraphRun(result.graphRunId)
    expect(runInDb?.status).toBe('failed')
    expect(runInDb?.finishedAt).not.toBeNull()

    // Non-resumable terminal run is excluded from findInterruptedGraphRuns
    const interrupted = workflowStore.findInterruptedGraphRuns(projectId)
    expect(interrupted).toHaveLength(0)
  })

  // 4. Genuinely interrupted running attempt follows established recovery policy
  it('invariant 5 & Axiom A3: a genuinely interrupted running attempt is marked failed during recovery', async () => {
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
        nodeId: 'worker',
        attempt: 1,
        status: 'running',
        startedAt: now,
      },
      'system',
    )

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
    })

    const recovered = await executor.recover(projectId)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.id).toBe(graphRunId)
    expect(recovered[0]?.status).toBe('failed')
    expect(recovered[0]?.error).toContain('interrupted by process termination')
    expect(recovered[0]?.finishedAt).not.toBeNull()

    const attempts = workflowStore.getNodeAttempts(graphRunId, 'worker')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status).toBe('failed')
    expect(attempts[0]?.error).toContain('Process crashed during node execution')
  })

  // 5. Mixed blocked and running attempts are handled according to concurrency contract
  it('invariant 5: mixed blocked and running attempts fail closed per concurrency contract', async () => {
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

    // Node A is already blocked (waiting for user, attempt finished)
    workflowStore.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId: 'nodeA',
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
        nodeId: 'nodeA',
        attempt: 1,
        status: 'blocked',
        error: 'Awaiting user',
        finishedAt: now,
        occurredAt: now,
      },
      'system',
    )

    // Node B was actively running when crash occurred
    workflowStore.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId: 'nodeB',
        attempt: 1,
        status: 'running',
        startedAt: now,
      },
      'system',
    )

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
    })

    const recovered = await executor.recover(projectId)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.status).toBe('failed')

    // Node A remains immutable in blocked status
    const attemptsA = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
    expect(attemptsA[0]?.status).toBe('blocked')

    // Node B is failed due to in-flight crash
    const attemptsB = workflowStore.getNodeAttempts(graphRunId, 'nodeB')
    expect(attemptsB[0]?.status).toBe('failed')
    expect(attemptsB[0]?.error).toContain('Process crashed')
  })

  // 6. Terminal runs remain terminal during recovery and run
  it('invariant 6: terminal runs remain terminal and cannot be resurrected by recovery', async () => {
    const statuses = ['completed', 'failed', 'halted', 'cancelled'] as const
    const executor = new GraphExecutor({ workflowStore, worktreeService })
    const template = makeTemplate([makeNode('worker')])

    for (const status of statuses) {
      const graphRunId = randomUUID()
      const now = new Date().toISOString()
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: template.id, startedAt: now },
        'system',
      )
      workflowStore.updateGraphRunStatus(
        {
          projectId,
          graphRunId,
          status,
          finishedAt: now,
          occurredAt: now,
        },
        'system',
      )

      // Recovery must not touch it
      const recovered = await executor.recover(projectId)
      expect(recovered).toHaveLength(0)

      // Plain run without invalidation must return terminal state idempotently
      const result = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })
      expect(result.status).toBe(status)
    }
  })

  // 7. User rejection produces cancellation rather than failure or success
  it('invariant 4: user rejection produces cancellation rather than failure or success', async () => {
    const userGate = makeNode('gate', { type: 'user_gate' })
    const worker = makeNode('worker')
    const template = makeTemplate([userGate, worker], [{ source: 'gate', target: 'worker' }])

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      executeLeafNode: (ctx) => {
        if (ctx.node.id === 'gate') {
          // Explicit user rejection
          return {
            status: 'cancelled',
            error: 'User declined plan',
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

    expect(result.status).toBe('cancelled')
    expect(result.completedNodeIds).toHaveLength(0)

    const runInDb = workflowStore.getGraphRun(result.graphRunId)
    expect(runInDb?.status).toBe('cancelled')
    expect(runInDb?.finishedAt).not.toBeNull()

    const attempts = workflowStore.getNodeAttempts(result.graphRunId, 'gate')
    expect(attempts).toHaveLength(1)
    expect(attempts[0]?.status).toBe('cancelled')
    expect(attempts[0]?.error).toBe('User declined plan')

    const checkpoint = workflowStore.getLatestGraphCheckpoint(result.graphRunId)
    expect(checkpoint?.operation).toBe('node.cancelled')
  })

  // 8. Resume does not re-execute already completed nodes
  it('invariant 9: resume does not re-execute already completed nodes', async () => {
    const nodeA = makeNode('A')
    const userGate = makeNode('gate', { type: 'user_gate' })
    const nodeB = makeNode('B')
    const template = makeTemplate(
      [nodeA, userGate, nodeB],
      [
        { source: 'A', target: 'gate' },
        { source: 'gate', target: 'B' },
      ],
    )

    let aExecutions = 0
    let bExecutions = 0

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      decisionStore,
      executeLeafNode: (ctx) => {
        if (ctx.node.id === 'A') {
          aExecutions++
          return { status: 'completed' }
        }
        if (ctx.node.id === 'gate') {
          const locked = decisionStore.listLocked(ctx.projectId)
          if (locked.length === 0) {
            return {
              status: 'blocked',
              awaitingUser: true,
              resumable: true,
              error: 'Awaiting decision lock',
            }
          }
          return { status: 'completed' }
        }
        if (ctx.node.id === 'B') {
          bExecutions++
          return { status: 'completed' }
        }
        return { status: 'completed' }
      },
    })

    // Run 1: Node A completes, gate blocks
    const run1 = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(run1.status).toBe('running')
    expect(run1.completedNodeIds).toEqual(['A'])
    expect(run1.blockedNodeIds).toEqual(['gate'])
    expect(aExecutions).toBe(1)
    expect(bExecutions).toBe(0)

    // User locks decision
    const decId = decisionIdSchema.parse(randomUUID())
    decisionStore.propose(
      {
        id: decId,
        statement: 'Proceed with implementation',
        rationale: 'Approved by test',
        status: 'proposed',
        proposedBy: 'user',
        proposedAt: NOW,
        lockedAt: null,
        lockedBy: null,
        supersededBy: null,
        originQuestionId: null,
      },
      projectId,
      'user',
      NOW,
    )
    decisionStore.lock(decId, 'user', new Date().toISOString())

    // Run 2: Resume execution
    const run2 = await executor.run({
      graphRunId: run1.graphRunId,
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(run2.status).toBe('completed')
    expect(run2.completedNodeIds).toContain('A')
    expect(run2.completedNodeIds).toContain('gate')
    expect(run2.completedNodeIds).toContain('B')

    // Invariant 9 verification: Node A was NOT executed again
    expect(aExecutions).toBe(1)
    expect(bExecutions).toBe(1)

    // Attempt count checks
    const aAttempts = workflowStore.getNodeAttempts(run1.graphRunId, 'A')
    expect(aAttempts).toHaveLength(1)
    expect(aAttempts[0]?.status).toBe('completed')

    const gateAttempts = workflowStore.getNodeAttempts(run1.graphRunId, 'gate')
    expect(gateAttempts).toHaveLength(2)
    expect(gateAttempts[0]?.attempt).toBe(1)
    expect(gateAttempts[0]?.status).toBe('blocked')
    expect(gateAttempts[1]?.attempt).toBe(2)
    expect(gateAttempts[1]?.status).toBe('completed')
  })

  // 9. Repeated recovery does not duplicate durable events or attempts
  it('invariant 7 & 8: repeated recovery does not duplicate durable events or attempts', async () => {
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
        nodeId: 'worker',
        attempt: 1,
        status: 'running',
        startedAt: now,
      },
      'system',
    )

    const eventStore = new EventStore(db)
    const executor = new GraphExecutor({ workflowStore, worktreeService })

    // First recovery: handles crash
    const recovered1 = await executor.recover(projectId)
    expect(recovered1).toHaveLength(1)

    const eventsAfterFirst = eventStore.read(projectId)
    const attemptsAfterFirst = workflowStore.getNodeAttempts(graphRunId, 'worker')

    // Second recovery
    const recovered2 = await executor.recover(projectId)
    expect(recovered2).toHaveLength(0)

    const eventsAfterSecond = eventStore.read(projectId)
    const attemptsAfterSecond = workflowStore.getNodeAttempts(graphRunId, 'worker')

    expect(eventsAfterSecond.length).toBe(eventsAfterFirst.length)
    expect(attemptsAfterSecond.length).toBe(attemptsAfterFirst.length)
  })

  // 10. Event-log projection rebuild preserves the resulting state
  it('invariant 8 & 10: projection rebuild reproduces paused and resumed run states identically from events', async () => {
    const userGate = makeNode('gate', { type: 'user_gate' })
    const nodeB = makeNode('B')
    const template = makeTemplate([userGate, nodeB], [{ source: 'gate', target: 'B' }])

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
      decisionStore,
    })

    // Run pauses at gate
    const run = await executor.run({
      workflowId,
      projectId,
      template,
      forkSha,
    })

    expect(run.status).toBe('running')

    const runBefore = workflowStore.getGraphRun(run.graphRunId)
    const attemptsBefore = workflowStore.getNodeAttempts(run.graphRunId)
    const checkpointsBefore = workflowStore.getGraphCheckpoints(run.graphRunId)

    // Rebuild projections from event log alone
    const projectStore = new ProjectStore(db)
    projectStore.rebuild(projectId)

    const runAfter = workflowStore.getGraphRun(run.graphRunId)
    const attemptsAfter = workflowStore.getNodeAttempts(run.graphRunId)
    const checkpointsAfter = workflowStore.getGraphCheckpoints(run.graphRunId)

    expect(runAfter).toEqual(runBefore)
    expect(attemptsAfter).toEqual(attemptsBefore)
    expect(checkpointsAfter).toEqual(checkpointsBefore)
  })

  // 11. Crash immediately after startGraphRun with zero attempts or checkpoints fails closed
  it('invariant 11: crash immediately after startGraphRun with no attempts or checkpoints fails closed upon recovery', async () => {
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

    // Pre-condition: run is running, but 0 attempts and 0 checkpoints exist
    const runBefore = workflowStore.getGraphRun(graphRunId)
    expect(runBefore?.status).toBe('running')
    expect(runBefore?.finishedAt).toBeNull()
    expect(workflowStore.getNodeAttempts(graphRunId)).toHaveLength(0)
    expect(workflowStore.getLatestGraphCheckpoint(graphRunId)).toBeNull()

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
    })

    // Recovery must detect the pre-attempt crash and fail closed
    const recovered = await executor.recover(projectId)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.id).toBe(graphRunId)
    expect(recovered[0]?.status).toBe('failed')
    expect(recovered[0]?.error).toContain('before initial node dispatch')
    expect(recovered[0]?.finishedAt).not.toBeNull()

    // Subsequent discovery returns 0 interrupted runs
    const interrupted = workflowStore.findInterruptedGraphRuns(projectId)
    expect(interrupted).toHaveLength(0)

    // Repeated recovery is idempotent
    const recovered2 = await executor.recover(projectId)
    expect(recovered2).toHaveLength(0)

    // Projection rebuild reproduces the failed run state identically
    const projectStore = new ProjectStore(db)
    projectStore.rebuild(projectId)

    const runRebuilt = workflowStore.getGraphRun(graphRunId)
    expect(runRebuilt?.status).toBe('failed')
    expect(runRebuilt?.finishedAt).not.toBeNull()
    expect(runRebuilt?.error).toContain('before initial node dispatch')
  })

  // 12. Crash between node dispatches fails closed without leaving an orphaned running run
  it('invariant 12: crash between node dispatches fails closed without leaving an orphaned running run', async () => {
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

    // Node A completed successfully
    workflowStore.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId: 'nodeA',
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
        nodeId: 'nodeA',
        attempt: 1,
        status: 'completed',
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
        nodeId: 'nodeA',
        operation: 'node.completed',
        stateSnapshot: {
          readyNodeIds: ['nodeB'],
          runningNodeIds: [],
          completedNodeIds: ['nodeA'],
          blockedNodeIds: [],
          skippedNodeIds: [],
        },
        occurredAt: now,
      },
      'system',
    )

    // Process crashed before nodeB attempt was created.
    // Pre-condition: run is running, 0 running attempts, 0 blocked attempts, latest checkpoint is node.completed
    const runBefore = workflowStore.getGraphRun(graphRunId)
    expect(runBefore?.status).toBe('running')
    expect(runBefore?.finishedAt).toBeNull()

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
    })

    const recovered = await executor.recover(projectId)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.id).toBe(graphRunId)
    expect(recovered[0]?.status).toBe('failed')
    expect(recovered[0]?.error).toContain('between node dispatches')
    expect(recovered[0]?.finishedAt).not.toBeNull()

    // Node A attempt remains completed
    const attemptsA = workflowStore.getNodeAttempts(graphRunId, 'nodeA')
    expect(attemptsA[0]?.status).toBe('completed')

    // Subsequent discovery returns 0 interrupted runs
    expect(workflowStore.findInterruptedGraphRuns(projectId)).toHaveLength(0)
  })

  // 13. A blocked attempt that does not satisfy the resumable-pause contract fails closed
  it('invariant 13: a blocked attempt that does not satisfy the resumable-pause contract fails closed upon recovery', async () => {
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

    // Node B blocked due to missing required input slot (non-resumable failure)
    workflowStore.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId: 'nodeB',
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
        nodeId: 'nodeB',
        attempt: 1,
        status: 'blocked',
        error: 'Missing required input slot: spec',
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
        nodeId: 'nodeB',
        operation: 'node.blocked',
        stateSnapshot: {
          readyNodeIds: [],
          runningNodeIds: [],
          completedNodeIds: [],
          blockedNodeIds: ['nodeB'],
          skippedNodeIds: [],
        },
        occurredAt: now,
      },
      'system',
    )

    // Process crashed before updateGraphRunStatus was called, leaving finishedAt null
    const runBefore = workflowStore.getGraphRun(graphRunId)
    expect(runBefore?.status).toBe('running')
    expect(runBefore?.finishedAt).toBeNull()

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
    })

    // Recovery must recognize this is a non-resumable block and fail the run closed
    const recovered = await executor.recover(projectId)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.id).toBe(graphRunId)
    expect(recovered[0]?.status).toBe('failed')
    expect(recovered[0]?.error).toContain('Missing required input slot: spec')
    expect(recovered[0]?.finishedAt).not.toBeNull()

    // Node B attempt remains blocked (immutable terminal attempt)
    const attemptsB = workflowStore.getNodeAttempts(graphRunId, 'nodeB')
    expect(attemptsB[0]?.status).toBe('blocked')

    expect(workflowStore.findInterruptedGraphRuns(projectId)).toHaveLength(0)
  })

  // 14. Contradictory state with failed attempt fails closed upon recovery
  it('invariant 14: contradictory state with failed attempt fails closed upon recovery', async () => {
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

    // Node A is blocked awaiting user
    workflowStore.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId: 'nodeA',
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
        nodeId: 'nodeA',
        attempt: 1,
        status: 'blocked',
        error: 'Awaiting user decision',
        finishedAt: now,
        occurredAt: now,
      },
      'system',
    )

    // Node B failed
    workflowStore.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId: 'nodeB',
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
        nodeId: 'nodeB',
        attempt: 1,
        status: 'failed',
        error: 'Task execution failed',
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
        nodeId: 'nodeB',
        operation: 'node.failed',
        stateSnapshot: {
          readyNodeIds: [],
          runningNodeIds: [],
          completedNodeIds: [],
          blockedNodeIds: ['nodeA'],
          skippedNodeIds: [],
        },
        occurredAt: now,
      },
      'system',
    )

    const executor = new GraphExecutor({
      workflowStore,
      worktreeService,
    })

    const recovered = await executor.recover(projectId)
    expect(recovered).toHaveLength(1)
    expect(recovered[0]?.status).toBe('failed')
    expect(recovered[0]?.finishedAt).not.toBeNull()
  })
})
