import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  projectIdSchema,
  repositoryIdSchema,
  taskIdSchema,
  workflowIdSchema,
  type ProjectId,
  type TaskId,
  type WorkflowId,
  type WorkflowTemplateV2,
} from '@shared/domain'
import {
  initialiseDatabase,
  openDatabase,
  runMigrations,
  WorkflowStore,
  ConflictingTargetNodeError,
  ConflictingIterationError,
  TargetIterationAlreadyActivatedError,
  CompetingTransitionError,
  TerminalGraphRunError,
  InvalidIterationAdvanceError,
  SourceAttemptNotFoundError,
  SourceAttemptNotCompletedError,
  InconsistentPersistenceStateError,
  type ForgeDatabase,
} from '.'
import { graphNodeRuns, graphRuns, graphTransitions } from './schema'
import { eq, sql } from 'drizzle-orm'
import {
  authorizeLoopTransition,
  UnauthorizedTransitionError,
  GraphExecutor,
} from '../workflows/graphExecutor'
import type { WorktreeService } from '../git'
import { EventStore } from './eventStore'
import { ProjectStore } from './projectStore'
import { applyEvent } from './projections'
import { MIGRATIONS } from './migrations.generated'

describe('WORK-003 Slice 1: Transition Persistence Contract', () => {
  let tempDir: string
  let dbFile: string
  let db: ForgeDatabase
  let closeDb: () => void

  const NOW = '2026-08-19T10:00:00.000Z'
  const FINISHED = '2026-08-19T10:05:00.000Z'
  let projectId: ProjectId
  let taskId: TaskId
  let workflowId: WorkflowId

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'forge-loop-test-'))
    dbFile = join(tempDir, 'test.db')
    const opened = initialiseDatabase(dbFile)
    db = opened.db
    closeDb = opened.close

    projectId = projectIdSchema.parse(randomUUID())
    taskId = taskIdSchema.parse(randomUUID())
    workflowId = workflowIdSchema.parse(randomUUID())

    new ProjectStore(db).create(
      {
        id: projectId,
        name: 'Loop Project',
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: 'D:/Projects/Subject',
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
  })

  afterEach(() => {
    closeDb()
    rmSync(tempDir, { recursive: true, force: true })
  })

  function createTask(database: ForgeDatabase): void {
    const event = new EventStore(database).append(
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
            createdAt: NOW,
          },
        },
      },
      { projectId, actor: 'user', occurredAt: NOW },
    )
    applyEvent(database, event)
  }

  function startWorkflow(database: ForgeDatabase): WorkflowStore {
    createTask(database)
    const store = new WorkflowStore(database)
    store.start(
      {
        workflowId,
        projectId,
        taskId,
        templateId: 'cr-sdlc',
        startedAt: NOW,
      },
      'user',
    )
    return store
  }

  function setupCompletedSourceAttempt(
    store: WorkflowStore,
    graphRunId: string,
    sourceNodeId = 'reviewer',
    attempt = 1,
    iteration = 1,
  ): void {
    store.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId: sourceNodeId,
        attempt,
        iteration,
        status: 'running',
        startedAt: NOW,
      },
      'system',
    )

    store.updateNodeAttempt(
      {
        projectId,
        graphRunId,
        nodeId: sourceNodeId,
        attempt,
        status: 'completed',
        finishedAt: FINISHED,
        occurredAt: FINISHED,
      },
      'system',
    )
  }

  describe('1. Migration through real migration runner against historical rows', () => {
    it('applies migration 0005 to historical 0000-0004 database and preserves iteration = 1', () => {
      // Create a fresh DB file without running automatic migrations
      const histDbFile = join(tempDir, 'historical.db')
      const { db: histDb, close: closeHist } = openDatabase({ file: histDbFile })

      try {
        const histMigrations = MIGRATIONS.slice(0, 5) // 0000 through 0004

        // Apply only 0000 - 0004
        const appliedInitial = runMigrations(histDb, histMigrations)
        expect(appliedInitial).toBe(5)

        // Seed historical Template #001 data under migration 0004
        const hProjectId = randomUUID()
        const hTaskId = randomUUID()
        const hWorkflowId = randomUUID()
        const hRunId = randomUUID()

        histDb.run(
          sql`INSERT INTO projects (id, name, created_at, updated_at) VALUES (${hProjectId}, 'Hist Project', ${NOW}, ${NOW})`,
        )
        histDb.run(
          sql`INSERT INTO tasks (id, project_id, objective, constraints, completion_criteria, scope, locked_decision_ids, created_at)
              VALUES (${hTaskId}, ${hProjectId}, 'Obj', '[]', '[]', '{}', '[]', ${NOW})`,
        )
        histDb.run(
          sql`INSERT INTO workflows (id, project_id, task_id, template_id, state, iteration, limits, started_at)
              VALUES (${hWorkflowId}, ${hProjectId}, ${hTaskId}, 'cr-sdlc', 'DONE', 1, '{}', ${NOW})`,
        )
        histDb.run(
          sql`INSERT INTO graph_runs (id, workflow_id, template_id, status, iteration, started_at)
              VALUES (${hRunId}, ${hWorkflowId}, 'cr-sdlc', 'completed', 1, ${NOW})`,
        )
        // Under 0004, graph_node_runs had NO iteration column
        histDb.run(
          sql`INSERT INTO graph_node_runs (id, graph_run_id, node_id, attempt, status, started_at, finished_at)
              VALUES ('nr-1', ${hRunId}, 'analyst', 1, 'completed', ${NOW}, ${FINISHED})`,
        )
        histDb.run(
          sql`INSERT INTO graph_node_runs (id, graph_run_id, node_id, attempt, status, started_at, finished_at)
              VALUES ('nr-2', ${hRunId}, 'reviewer', 1, 'completed', ${NOW}, ${FINISHED})`,
        )

        // Now run migration 0005 using the real runner
        const applied0005 = runMigrations(histDb, MIGRATIONS)
        expect(applied0005).toBe(1) // Applied migration 0005

        // Verify historical rows in graph_node_runs all received iteration = 1
        const rows = histDb.all<{ id: string; iteration: number }>(
          sql`SELECT id, iteration FROM graph_node_runs WHERE graph_run_id = ${hRunId}`,
        )
        expect(rows).toHaveLength(2)
        expect(rows.every((r) => r.iteration === 1)).toBe(true)

        // Verify graph_transitions table exists and is empty
        const transCount = histDb.all<{ count: number }>(
          sql`SELECT count(*) as count FROM graph_transitions`,
        )
        expect(transCount[0]?.count).toBe(0)
      } finally {
        closeHist()
      }
    })
  })

  describe('2. Exact replay and defined structural conflicts', () => {
    it('executes exact replay idempotently on duplicate invocation', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      // First call: commits new transition
      const result1 = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })

      expect(result1.success).toBe(true)
      expect(result1.replayed).toBe(false)
      expect(result1.targetAttempt).toBe(1)
      expect(result1.targetStatus).toBe('ready')
      expect(result1.transition.fromIteration).toBe(1)
      expect(result1.transition.toIteration).toBe(2)

      // Run iteration was advanced
      const runAfter1 = store.getGraphRun(graphRunId)
      expect(runAfter1?.iteration).toBe(2)

      // Second call: exact duplicate request
      const result2 = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })

      expect(result2.success).toBe(true)
      expect(result2.replayed).toBe(true)
      expect(result2.targetAttempt).toBe(1)
      expect(result2.targetNodeRunId).toBe(result1.targetNodeRunId)
      expect(result2.transition.id).toBe(result1.transition.id)
      expect(result2.targetStatus).toBe('ready')

      // Assert zero duplicate rows created
      const allTransitions = store.getTransitionsForRun(graphRunId)
      expect(allTransitions).toHaveLength(1)
    })

    it('rejects same source attempt requesting a different target node (Case 2)', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })

      // Try branching to a different target node from the same source attempt
      expect(() => {
        store.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'planner',
          fromIteration: 1,
          toIteration: 2,
        })
      }).toThrow(ConflictingTargetNodeError)
    })

    it('rejects same source attempt requesting a conflicting iteration advance (Case 3)', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })

      // Try advancing to iteration 3 from the same source attempt
      expect(() => {
        store.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 2,
          toIteration: 3,
        })
      }).toThrow(ConflictingIterationError)
    })

    it('rejects competing source attempts activating the same target in the same iteration (Case 5)', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer-A', 1, 1)
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer-B', 1, 1)

      // Reviewer A advances iteration 1 -> 2
      store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer-A',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })

      // Reviewer B tries to activate the same implementer in iteration 2
      expect(() => {
        store.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer-B',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
        })
      }).toThrow(TargetIterationAlreadyActivatedError)
    })

    it('rejects non-monotonic iteration jump', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      expect(() => {
        store.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 3, // Jump 1 -> 3 is illegal
        })
      }).toThrow(InvalidIterationAdvanceError)
    })

    it('rejects transition when source attempt does not exist or is not completed', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )

      // Missing source attempt
      expect(() => {
        store.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
        })
      }).toThrow(SourceAttemptNotFoundError)

      // Unfinished source attempt
      store.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'reviewer',
          attempt: 1,
          iteration: 1,
          status: 'running',
          startedAt: NOW,
        },
        'system',
      )

      expect(() => {
        store.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
        })
      }).toThrow(SourceAttemptNotCompletedError)
    })
  })

  describe('3. Checkpoint divergence behavior (Case 4)', () => {
    it('returns committed transition with diagnostic warning on checkpoint mismatch without mutating database', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      // Write two checkpoints
      const chk1Id = randomUUID()
      const chk2Id = randomUUID()
      store.writeGraphCheckpoint(
        {
          id: chk1Id,
          projectId,
          graphRunId,
          nodeId: 'reviewer',
          operation: 'checkpoint.1',
          stateSnapshot: {
            readyNodeIds: [],
            runningNodeIds: [],
            completedNodeIds: ['reviewer'],
            blockedNodeIds: [],
          },
          occurredAt: NOW,
        },
        'system',
      )
      store.writeGraphCheckpoint(
        {
          id: chk2Id,
          projectId,
          graphRunId,
          nodeId: 'reviewer',
          operation: 'checkpoint.2',
          stateSnapshot: {
            readyNodeIds: [],
            runningNodeIds: [],
            completedNodeIds: ['reviewer'],
            blockedNodeIds: [],
          },
          occurredAt: NOW,
        },
        'system',
      )

      // Commit transition with chk1Id
      const outcome1 = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
        checkpointId: chk1Id,
      })
      expect(outcome1.diagnostic).toBeUndefined()
      expect(outcome1.transition.checkpointId).toBe(chk1Id)

      // Replay transition supplying chk2Id
      const replayOutcome = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
        checkpointId: chk2Id,
      })

      expect(replayOutcome.success).toBe(true)
      expect(replayOutcome.replayed).toBe(true)
      // Checkpoint mismatch is surfaced in diagnostic
      expect(replayOutcome.diagnostic).toBeDefined()
      expect(replayOutcome.diagnostic).toContain('CHECKPOINT_MISMATCH')
      // Original persisted checkpoint is preserved
      expect(replayOutcome.transition.checkpointId).toBe(chk1Id)
    })
  })

  describe('4. Existing target activation and legitimate retry behavior', () => {
    it('prevents advanceLoopIteration if target node already has an attempt in toIteration without transition', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      // Direct insertion of an attempt for target in iteration 2 (simulating duplicate activation)
      store.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'implementer',
          attempt: 1,
          iteration: 2,
          status: 'ready',
          startedAt: NOW,
        },
        'system',
      )

      expect(() => {
        store.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
        })
      }).toThrow(TargetIterationAlreadyActivatedError)

      // Verify zero partial mutation
      expect(store.getGraphRun(graphRunId)?.iteration).toBe(1)
      expect(store.getTransitionsForRun(graphRunId)).toHaveLength(0)
      const attempts = store.getNodeAttempts(graphRunId, 'implementer')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.attempt).toBe(1)
      expect(attempts[0]?.iteration).toBe(2)
    })

    it('allows legitimate in-iteration attempt retries without interfering with loop replay', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      // Advance to iteration 2 (allocates implementer attempt 1)
      const adv = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })
      expect(adv.targetAttempt).toBe(1)

      // Implementer attempt 1 fails
      store.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'implementer',
          attempt: 1,
          status: 'failed',
          error: 'Build error',
          finishedAt: FINISHED,
          occurredAt: FINISHED,
        },
        'system',
      )

      // Legitimate retry: implementer attempt 2 in iteration 2 via recordNodeAttempt
      const retryAttempt = store.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'implementer',
          attempt: 2,
          iteration: 2,
          status: 'running',
          startedAt: FINISHED,
        },
        'system',
      )
      expect(retryAttempt.attempt).toBe(2)
      expect(retryAttempt.iteration).toBe(2)

      // Replaying the original loop transition returns the original transition target attempt (1)
      const replay = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })
      expect(replay.replayed).toBe(true)
      expect(replay.targetAttempt).toBe(1) // Still points to attempt 1 (historical anchor)
      expect(replay.targetStatus).toBe('failed')
    })
  })

  describe('5. Concurrency: Identical requests and competing transitions', () => {
    it('handles identical concurrent requests with serialized immediate transactions', () => {
      const store1 = startWorkflow(db)
      const graphRunId = randomUUID()
      store1.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store1, graphRunId, 'reviewer', 1, 1)

      // Simulate connection 2 on same DB
      const { db: db2, close: close2 } = openDatabase({ file: dbFile })
      const store2 = new WorkflowStore(db2)

      try {
        const caller1 = store1.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
        })

        const caller2 = store2.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
        })

        expect(caller1.replayed).toBe(false)
        expect(caller2.replayed).toBe(true)
        expect(caller2.targetAttempt).toBe(caller1.targetAttempt)
        expect(caller2.transition.id).toBe(caller1.transition.id)
      } finally {
        close2()
      }
    })

    it('rejects competing transitions from same iteration via CAS when run iteration was advanced', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer-A', 1, 1)
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer-B', 1, 1)

      // Winner A advances iteration 1 -> 2
      store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer-A',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })

      // Loser B tries to advance iteration 1 -> 2 to planner
      expect(() => {
        store.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer-B',
          sourceAttempt: 1,
          targetNodeId: 'planner',
          fromIteration: 1,
          toIteration: 2,
        })
      }).toThrow(CompetingTransitionError)
    })
  })

  describe('6. Terminal-run race and transaction rollback', () => {
    it('aborts advanceLoopIteration with TerminalGraphRunError if parent run is not running', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      // Concurrently mark run as failed
      store.updateGraphRunStatus(
        {
          projectId,
          graphRunId,
          status: 'failed',
          occurredAt: FINISHED,
        },
        'system',
      )

      expect(() => {
        store.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
        })
      }).toThrow(TerminalGraphRunError)

      // Iteration remains 1
      const run = store.getGraphRun(graphRunId)
      expect(run?.iteration).toBe(1)
    })

    it('rolls back completely if check constraint fails during transaction', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      // Force an SQLite check constraint failure by bypassing method validation
      expect(() => {
        db.transaction((tx) => {
          tx.update(graphRuns).set({ iteration: 3 }).where(eq(graphRuns.id, graphRunId)).run()
          // Violates CHECK (to_iteration = from_iteration + 1)
          tx.insert(graphTransitions)
            .values({
              id: 'violating-id',
              graphRunId,
              sourceNodeId: 'reviewer',
              sourceAttempt: 1,
              targetNodeId: 'implementer',
              targetAttempt: 1,
              fromIteration: 1,
              toIteration: 3,
              occurredAt: NOW,
            })
            .run()
        })
      }).toThrow()

      // Verify clean rollback: iteration is still 1 and 0 transitions exist
      const run = store.getGraphRun(graphRunId)
      expect(run?.iteration).toBe(1)
      expect(store.getTransitionsForRun(graphRunId)).toHaveLength(0)
    })

    it('rolls back atomic transaction completely when advanceLoopIteration encounters SQLite constraint failure', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      // advanceLoopIteration passes preflight, executes CAS (iteration 1 -> 2),
      // inserts target attempt into graph_node_runs, and then fails during graph_transitions insert
      // because checkpointId 'missing-chk' does not exist in graph_checkpoints (FOREIGN KEY constraint failure)
      expect(() => {
        store.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
          checkpointId: 'missing-chk',
        })
      }).toThrow(InconsistentPersistenceStateError)

      // Verify that SQLite rolled back the transaction completely:
      // 1. graph_runs.iteration was rolled back from 2 to 1
      const run = store.getGraphRun(graphRunId)
      expect(run?.iteration).toBe(1)

      // 2. target node attempt was not left behind in graph_node_runs
      const targetAttempts = store.getNodeAttempts(graphRunId, 'implementer')
      expect(targetAttempts).toHaveLength(0)

      // 3. no transition row was persisted
      const transitions = store.getTransitionsForRun(graphRunId)
      expect(transitions).toHaveLength(0)
    })
  })

  describe('7. Foreign key restrictions and parent-run cascade', () => {
    it('blocks deleting referenced attempt with FOREIGN KEY constraint failure', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })

      // Attempting to delete source attempt must be rejected by ON DELETE RESTRICT
      let threw = false
      try {
        db.run(
          sql`DELETE FROM graph_node_runs WHERE graph_run_id = ${graphRunId} AND node_id = 'reviewer'`,
        )
      } catch (err: unknown) {
        threw = true
        const fullMsg =
          err instanceof Error
            ? `${err.message} ${String((err as { cause?: unknown }).cause)}`
            : String(err)
        expect(fullMsg).toMatch(/FOREIGN KEY constraint failed/i)
      }
      expect(threw).toBe(true)
    })

    it('cascades cleanly across transitions and attempts when deleting parent graph run', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })

      // Delete parent graph run
      db.run(sql`DELETE FROM graph_runs WHERE id = ${graphRunId}`)

      // Verify cascade: 0 transitions, 0 node runs
      const transitions = store.getTransitionsForRun(graphRunId)
      expect(transitions).toHaveLength(0)
      const nodeAttempts = store.getNodeAttempts(graphRunId)
      expect(nodeAttempts).toHaveLength(0)
    })

    it('preserves transition and sets checkpoint_id to null when referenced checkpoint is deleted (ON DELETE SET NULL)', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      const chkId = randomUUID()
      store.writeGraphCheckpoint(
        {
          id: chkId,
          projectId,
          graphRunId,
          nodeId: 'reviewer',
          operation: 'checkpoint.audit',
          stateSnapshot: {
            readyNodeIds: [],
            runningNodeIds: [],
            completedNodeIds: ['reviewer'],
            blockedNodeIds: [],
          },
          occurredAt: NOW,
        },
        'system',
      )

      const adv = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
        checkpointId: chkId,
      })
      expect(adv.transition.checkpointId).toBe(chkId)

      // Directly delete the checkpoint row
      db.run(sql`DELETE FROM graph_checkpoints WHERE id = ${chkId}`)

      // Transition is preserved and its checkpoint_id is set to null
      const transition = store.getTransition(adv.transition.id)
      expect(transition).not.toBeNull()
      expect(transition?.checkpointId).toBeNull()

      // getTransitionsForRun returns the transition with null checkpointId
      const transitions = store.getTransitionsForRun(graphRunId)
      expect(transitions).toHaveLength(1)
      expect(transitions[0]?.checkpointId).toBeNull()
    })
  })

  describe('8. Replay across all target statuses and parent run terminal state', () => {
    const statuses = [
      'ready',
      'running',
      'completed',
      'failed',
      'blocked',
      'skipped',
      'cancelled',
    ] as const

    for (const status of statuses) {
      it(`replays successfully preserving target attempt status "${status}"`, () => {
        const store = startWorkflow(db)
        const graphRunId = randomUUID()
        store.startGraphRun(
          { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
          'user',
        )
        setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

        store.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
        })

        // Update target attempt to tested status
        if (status !== 'ready') {
          db.update(graphNodeRuns)
            .set({ status })
            .where(
              sql`${graphNodeRuns.graphRunId} = ${graphRunId} AND ${graphNodeRuns.nodeId} = 'implementer'`,
            )
            .run()
        }

        const replay = store.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
        })

        expect(replay.success).toBe(true)
        expect(replay.replayed).toBe(true)
        expect(replay.targetStatus).toBe(status)
      })
    }

    it('replays historical transition even after parent run is terminal or far advanced', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })

      // Advance run iteration far beyond (e.g. to iteration 5)
      db.update(graphRuns).set({ iteration: 5 }).where(eq(graphRuns.id, graphRunId)).run()

      // Historical replay of 1 -> 2 still succeeds
      const replayAdv = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })
      expect(replayAdv.success).toBe(true)
      expect(replayAdv.replayed).toBe(true)
      // Run iteration was not rewound
      expect(store.getGraphRun(graphRunId)?.iteration).toBe(5)

      // Now complete the run (terminal)
      store.updateGraphRunStatus(
        { projectId, graphRunId, status: 'completed', occurredAt: FINISHED },
        'system',
      )

      // Historical replay on terminal run still succeeds
      const replayTerminal = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })
      expect(replayTerminal.success).toBe(true)
      expect(replayTerminal.replayed).toBe(true)
    })
  })

  describe('9. Orchestration authorization boundary', () => {
    const mockTemplate: WorkflowTemplateV2 = {
      id: 'template-with-loop',
      name: 'Loop Template',
      description: 'Template with a valid feedback edge',
      version: 1,
      status: 'published',
      category: 'Software Engineering',
      createdAt: NOW,
      updatedAt: NOW,
      nodes: [
        {
          id: 'implementer',
          title: 'Implementer',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'developer' },
          inputs: [],
          outputs: [],
        },
        {
          id: 'reviewer',
          title: 'Reviewer',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'read-only' },
          inputs: [],
          outputs: [],
        },
        {
          id: 'other-node',
          title: 'Other',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'read-only' },
          inputs: [],
          outputs: [],
        },
      ],
      edges: [
        {
          id: 'e1',
          source: 'implementer',
          target: 'reviewer',
          isFeedback: false,
        },
        {
          id: 'e2',
          source: 'reviewer',
          target: 'implementer',
          isFeedback: true, // Authorized feedback loop edge
        },
      ],
    }

    it('orchestration caller rejects unauthorized edges before invoking WorkflowStore', () => {
      // 1. Edge does not exist in template
      expect(() => {
        authorizeLoopTransition(mockTemplate, 'reviewer', 'other-node')
      }).toThrow(UnauthorizedTransitionError)

      // 2. Edge exists but is forward edge (not feedback edge)
      expect(() => {
        authorizeLoopTransition(mockTemplate, 'implementer', 'reviewer')
      }).toThrow(UnauthorizedTransitionError)

      // 3. Condition is not met
      expect(() => {
        authorizeLoopTransition(mockTemplate, 'reviewer', 'implementer', false)
      }).toThrow(UnauthorizedTransitionError)

      // 4. Authorized feedback edge with condition true passes
      expect(() => {
        authorizeLoopTransition(mockTemplate, 'reviewer', 'implementer', true)
      }).not.toThrow()
    })

    it('GraphExecutor.advanceLoopIteration enforces authorization before calling store and persists authorized transitions', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      const executor = new GraphExecutor({
        workflowStore: store,
        worktreeService: {} as unknown as WorktreeService,
      })

      // 1. Unauthorized transition rejects before store mutation
      expect(() => {
        executor.advanceLoopIteration({
          template: mockTemplate,
          graphRunId,
          sourceNodeId: 'implementer',
          sourceAttempt: 1,
          targetNodeId: 'reviewer',
          fromIteration: 1,
          toIteration: 2,
        })
      }).toThrow(UnauthorizedTransitionError)

      // 2. Failed condition rejects before store mutation
      expect(() => {
        executor.advanceLoopIteration({
          template: mockTemplate,
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
          conditionMet: false,
        })
      }).toThrow(UnauthorizedTransitionError)

      // Verify no mutation occurred in store
      expect(store.getGraphRun(graphRunId)?.iteration).toBe(1)
      expect(store.getTransitionsForRun(graphRunId)).toHaveLength(0)

      // 3. Authorized feedback transition with conditionMet = true delegates to store
      const outcome = executor.advanceLoopIteration({
        template: mockTemplate,
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
        conditionMet: true,
      })

      expect(outcome.success).toBe(true)
      expect(outcome.replayed).toBe(false)
      expect(outcome.targetAttempt).toBe(1)
      expect(outcome.targetStatus).toBe('ready')

      // Verify store was updated
      expect(store.getGraphRun(graphRunId)?.iteration).toBe(2)
      expect(store.getTransitionsForRun(graphRunId)).toHaveLength(1)
    })
  })

  describe('10. Replay never triggers execution dispatch', () => {
    it('calling advanceLoopIteration repeatedly returns metadata and does not change ready status', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      const first = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })
      expect(first.targetStatus).toBe('ready')

      // Repeated replays
      for (let i = 0; i < 5; i++) {
        const replay = store.advanceLoopIteration({
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
        })
        expect(replay.replayed).toBe(true)
        // Target attempt status remains 'ready' (no worker has claimed it)
        const targetNode = store.getNodeAttempt(graphRunId, 'implementer', 1)
        expect(targetNode?.status).toBe('ready')
      }
    })
  })

  describe('11. Successive loop iterations (1 -> 2 -> 3) and attempt progression', () => {
    it('proves successive iterations 1 -> 2 -> 3 with strictly monotonic attempts and exact historical replays', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )

      // --- Iteration 1 ---
      // Initial attempts created in iteration 1
      setupCompletedSourceAttempt(store, graphRunId, 'implementer', 1, 1)
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      // Advance Iteration 1 -> 2
      const step1to2 = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })

      expect(step1to2.success).toBe(true)
      expect(step1to2.replayed).toBe(false)
      expect(step1to2.targetAttempt).toBe(2) // Monotonic next attempt for implementer
      expect(step1to2.targetStatus).toBe('ready')
      expect(store.getGraphRun(graphRunId)?.iteration).toBe(2)

      // Verify transition 1
      const t1 = store.getTransition(step1to2.transition.id)
      expect(t1).not.toBeNull()
      expect(t1?.fromIteration).toBe(1)
      expect(t1?.toIteration).toBe(2)
      expect(t1?.sourceNodeId).toBe('reviewer')
      expect(t1?.sourceAttempt).toBe(1)
      expect(t1?.targetNodeId).toBe('implementer')
      expect(t1?.targetAttempt).toBe(2)

      // Replay of 1 -> 2 returns identical result
      const replay1 = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })
      expect(replay1.replayed).toBe(true)
      expect(replay1.targetAttempt).toBe(2)
      expect(replay1.transition.id).toBe(step1to2.transition.id)

      // --- Iteration 2 ---
      // Update implementer attempt 2 to running and completed
      store.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'implementer',
          attempt: 2,
          status: 'completed',
          finishedAt: FINISHED,
          occurredAt: FINISHED,
        },
        'system',
      )

      // Record reviewer attempt 2 in iteration 2 and complete it
      store.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'reviewer',
          attempt: 2,
          iteration: 2,
          status: 'running',
          startedAt: NOW,
        },
        'system',
      )
      store.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'reviewer',
          attempt: 2,
          status: 'completed',
          finishedAt: FINISHED,
          occurredAt: FINISHED,
        },
        'system',
      )

      // Advance Iteration 2 -> 3
      const step2to3 = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 2,
        targetNodeId: 'implementer',
        fromIteration: 2,
        toIteration: 3,
      })

      expect(step2to3.success).toBe(true)
      expect(step2to3.replayed).toBe(false)
      expect(step2to3.targetAttempt).toBe(3) // Monotonic next attempt: 1 -> 2 -> 3
      expect(step2to3.targetStatus).toBe('ready')
      expect(store.getGraphRun(graphRunId)?.iteration).toBe(3)

      // Verify transition 2
      const t2 = store.getTransition(step2to3.transition.id)
      expect(t2).not.toBeNull()
      expect(t2?.fromIteration).toBe(2)
      expect(t2?.toIteration).toBe(3)
      expect(t2?.sourceNodeId).toBe('reviewer')
      expect(t2?.sourceAttempt).toBe(2)
      expect(t2?.targetNodeId).toBe('implementer')
      expect(t2?.targetAttempt).toBe(3)

      // --- Historical Replays and Invariant Integrity ---
      // Replay of 2 -> 3
      const replay2 = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 2,
        targetNodeId: 'implementer',
        fromIteration: 2,
        toIteration: 3,
      })
      expect(replay2.replayed).toBe(true)
      expect(replay2.targetAttempt).toBe(3)

      // Historical replay of 1 -> 2 still succeeds and points to implementer@2
      const historicalReplay1 = store.advanceLoopIteration({
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })
      expect(historicalReplay1.replayed).toBe(true)
      expect(historicalReplay1.targetAttempt).toBe(2)
      // Run iteration was not rewound
      expect(store.getGraphRun(graphRunId)?.iteration).toBe(3)

      // Verify exactly 2 transitions exist for the entire run
      const allTransitions = store.getTransitionsForRun(graphRunId)
      expect(allTransitions).toHaveLength(2)
      expect(allTransitions[0]?.toIteration).toBe(2)
      expect(allTransitions[1]?.toIteration).toBe(3)

      // Verify node attempts in graph_node_runs
      const implementerAttempts = store.getNodeAttempts(graphRunId, 'implementer')
      expect(implementerAttempts).toHaveLength(3)
      expect(implementerAttempts.map((a) => a.attempt)).toEqual([1, 2, 3])
      expect(implementerAttempts.map((a) => a.iteration)).toEqual([1, 2, 3])

      const reviewerAttempts = store.getNodeAttempts(graphRunId, 'reviewer')
      expect(reviewerAttempts).toHaveLength(2)
      expect(reviewerAttempts.map((a) => a.attempt)).toEqual([1, 2])
      expect(reviewerAttempts.map((a) => a.iteration)).toEqual([1, 2])
    })
  })

  describe('12. Event-sourcing consistency and projection rebuild from event log alone', () => {
    it('rebuilds multi-iteration graph run, attempts, and transitions identically from event log alone', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )

      // --- Iteration 1 ---
      // Node 1 (implementer) attempt 1
      store.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'implementer',
          attempt: 1,
          iteration: 1,
          status: 'running',
          startedAt: NOW,
        },
        'system',
      )
      store.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'implementer',
          attempt: 1,
          status: 'completed',
          finishedAt: FINISHED,
          occurredAt: FINISHED,
        },
        'system',
      )

      // Node 2 (reviewer) attempt 1
      store.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'reviewer',
          attempt: 1,
          iteration: 1,
          status: 'running',
          startedAt: NOW,
        },
        'system',
      )
      store.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'reviewer',
          attempt: 1,
          status: 'completed',
          finishedAt: FINISHED,
          occurredAt: FINISHED,
        },
        'system',
      )

      // Advance Iteration 1 -> 2 (reviewer#1 -> implementer#2)
      store.advanceLoopIteration({
        projectId,
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })

      // --- Iteration 2 ---
      // Target attempt (implementer#2) completes
      store.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'implementer',
          attempt: 2,
          status: 'completed',
          finishedAt: FINISHED,
          occurredAt: FINISHED,
        },
        'system',
      )

      // Reviewer attempt 2 in iteration 2 completes
      store.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'reviewer',
          attempt: 2,
          iteration: 2,
          status: 'running',
          startedAt: NOW,
        },
        'system',
      )
      store.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'reviewer',
          attempt: 2,
          status: 'completed',
          finishedAt: FINISHED,
          occurredAt: FINISHED,
        },
        'system',
      )

      // Advance Iteration 2 -> 3 (reviewer#2 -> implementer#3)
      store.advanceLoopIteration({
        projectId,
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 2,
        targetNodeId: 'implementer',
        fromIteration: 2,
        toIteration: 3,
      })

      // --- Iteration 3 ---
      // Target attempt (implementer#3) completes
      store.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'implementer',
          attempt: 3,
          status: 'completed',
          finishedAt: FINISHED,
          occurredAt: FINISHED,
        },
        'system',
      )

      // Capture pre-rebuild state
      const runBefore = store.getGraphRun(graphRunId)
      const attemptsBefore = store.getNodeAttempts(graphRunId)
      const transitionsBefore = store.getTransitionsForRun(graphRunId)

      expect(runBefore?.iteration).toBe(3)
      expect(attemptsBefore).toHaveLength(5)
      expect(transitionsBefore).toHaveLength(2)

      // Rebuild read models from the event log alone using the real production path
      const projectStore = new ProjectStore(db)
      projectStore.rebuild(projectId)

      // Capture post-rebuild state
      const runAfter = store.getGraphRun(graphRunId)
      const attemptsAfter = store.getNodeAttempts(graphRunId)
      const transitionsAfter = store.getTransitionsForRun(graphRunId)

      // Assert complete equality between incremental projections and event-rebuilt projections
      expect(runAfter).toEqual(runBefore)
      expect(attemptsAfter).toEqual(attemptsBefore)
      expect(transitionsAfter).toEqual(transitionsBefore)

      // Verify specific lookups reproduce identical objects
      const t1 = store.getTransitionBySource(graphRunId, 'reviewer', 1)
      const t2 = store.getTransitionBySource(graphRunId, 'reviewer', 2)
      expect(t1).toEqual(transitionsBefore[0])
      expect(t2).toEqual(transitionsBefore[1])

      const tTarget2 = store.getTransitionByTarget(graphRunId, 2, 'implementer')
      const tTarget3 = store.getTransitionByTarget(graphRunId, 3, 'implementer')
      expect(tTarget2).toEqual(transitionsBefore[0])
      expect(tTarget3).toEqual(transitionsBefore[1])

      const attemptIter2 = store.getNodeAttemptInIteration(graphRunId, 'implementer', 2)
      const attemptIter3 = store.getNodeAttemptInIteration(graphRunId, 'implementer', 3)
      expect(attemptIter2?.attempt).toBe(2)
      expect(attemptIter2?.iteration).toBe(2)
      expect(attemptIter3?.attempt).toBe(3)
      expect(attemptIter3?.iteration).toBe(3)

      // Rebuilding a second time must remain completely idempotent and not corrupt state
      projectStore.rebuild(projectId)
      expect(store.getGraphRun(graphRunId)).toEqual(runBefore)
      expect(store.getNodeAttempts(graphRunId)).toEqual(attemptsBefore)
      expect(store.getTransitionsForRun(graphRunId)).toEqual(transitionsBefore)
    })

    it('emits strictly ordered events with correct payloads in the event store', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      const result = store.advanceLoopIteration({
        projectId,
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })

      const allEvents = new EventStore(db).read(projectId)
      const graphEvents = allEvents.filter((e) => e.type.startsWith('graph'))

      // Should have: graph.started, graph_node.attempt_started (reviewer), graph_node.attempt_updated (reviewer),
      // graph_node.attempt_started (implementer@2), graph.iteration_advanced
      const types = graphEvents.map((e) => e.type)
      expect(types).toEqual([
        'graph.started',
        'graph_node.attempt_started',
        'graph_node.attempt_updated',
        'graph_node.attempt_started',
        'graph.iteration_advanced',
      ])

      // Verify sequence monotonicity
      for (let i = 1; i < allEvents.length; i += 1) {
        expect(allEvents[i]!.seq).toBe(allEvents[i - 1]!.seq + 1)
      }

      // Check transition event payload
      const transitionEvent = graphEvents.find((e) => e.type === 'graph.iteration_advanced')
      expect(transitionEvent).toBeDefined()
      const payload = transitionEvent!.payload as {
        readonly transitionId: string
        readonly fromIteration: number
        readonly toIteration: number
        readonly sourceNodeId: string
        readonly sourceAttempt: number
        readonly targetNodeId: string
        readonly targetAttempt: number
      }
      expect(payload.transitionId).toBe(result.transition.id)
      expect(payload.fromIteration).toBe(1)
      expect(payload.toIteration).toBe(2)
      expect(payload.sourceNodeId).toBe('reviewer')
      expect(payload.sourceAttempt).toBe(1)
      expect(payload.targetNodeId).toBe('implementer')
      expect(payload.targetAttempt).toBe(result.targetAttempt)
    })
  })

  describe('13. Transaction rollback across event log and projection writes', () => {
    it('rolls back event log writes when advanceLoopIteration encounters TargetIterationAlreadyActivatedError', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      // Advance once
      store.advanceLoopIteration({
        projectId,
        graphRunId,
        sourceNodeId: 'reviewer',
        sourceAttempt: 1,
        targetNodeId: 'implementer',
        fromIteration: 1,
        toIteration: 2,
      })

      // Setup a second completed source attempt in iteration 1
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer-2', 1, 1)
      const eventsAfterSetup = new EventStore(db).read(projectId).length

      // Try to activate implementer in iteration 2 again from reviewer-2
      expect(() => {
        store.advanceLoopIteration({
          projectId,
          graphRunId,
          sourceNodeId: 'reviewer-2',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
        })
      }).toThrow(TargetIterationAlreadyActivatedError)

      // Event log must NOT have appended any events for the failed advancement
      const eventsAfterFailure = new EventStore(db).read(projectId).length
      expect(eventsAfterFailure).toBe(eventsAfterSetup)

      // Only 1 transition exists
      expect(store.getTransitionsForRun(graphRunId)).toHaveLength(1)
    })

    it('rolls back event log writes when advanceLoopIteration encounters CompetingTransitionError', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      // Concurrently advance iteration to 2 behind the store's back
      db.update(graphRuns).set({ iteration: 2 }).where(eq(graphRuns.id, graphRunId)).run()

      const eventsBefore = new EventStore(db).read(projectId).length

      expect(() => {
        store.advanceLoopIteration({
          projectId,
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
        })
      }).toThrow(CompetingTransitionError)

      // Event log was not appended to
      const eventsAfter = new EventStore(db).read(projectId).length
      expect(eventsAfter).toBe(eventsBefore)
      expect(store.getTransitionsForRun(graphRunId)).toHaveLength(0)
    })

    it('rolls back event log writes when advanceLoopIteration encounters TerminalGraphRunError', () => {
      const store = startWorkflow(db)
      const graphRunId = randomUUID()
      store.startGraphRun(
        { graphRunId, projectId, workflowId, templateId: 'cr-sdlc', startedAt: NOW },
        'user',
      )
      setupCompletedSourceAttempt(store, graphRunId, 'reviewer', 1, 1)

      // Mark graph run terminal
      store.updateGraphRunStatus(
        { projectId, graphRunId, status: 'cancelled', occurredAt: FINISHED },
        'user',
      )

      const eventsBefore = new EventStore(db).read(projectId).length

      expect(() => {
        store.advanceLoopIteration({
          projectId,
          graphRunId,
          sourceNodeId: 'reviewer',
          sourceAttempt: 1,
          targetNodeId: 'implementer',
          fromIteration: 1,
          toIteration: 2,
        })
      }).toThrow(TerminalGraphRunError)

      const eventsAfter = new EventStore(db).read(projectId).length
      expect(eventsAfter).toBe(eventsBefore)
      expect(store.getTransitionsForRun(graphRunId)).toHaveLength(0)
    })
  })
})
