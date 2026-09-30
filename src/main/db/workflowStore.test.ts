import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  projectIdSchema,
  repositoryIdSchema,
  stepIdSchema,
  taskIdSchema,
  workflowIdSchema,
  type ProjectId,
  type TaskId,
  type WorkflowId,
  type WorkflowStep,
} from '@shared/domain'
import { initialiseDatabase, type ForgeDatabase } from '.'
import { EventStore } from './eventStore'
import { ProjectStore } from './projectStore'
import { applyEvent } from './projections'
import { planResume, WorkflowStore } from './workflowStore'

/**
 * Checkpointing and crash resume.
 *
 * The interesting tests are the ones that kill the process at a specific point and check
 * what survives. A real database file rather than `:memory:`, because "survives a restart"
 * is the whole claim and an in-memory database cannot demonstrate it.
 */

let dbFile: string
let db: ForgeDatabase
let closeDb: () => void

const NOW = '2026-08-19T10:00:00.000Z'
let projectId: ProjectId
let taskId: TaskId
let workflowId: WorkflowId

function reopen(): void {
  closeDb()
  const opened = initialiseDatabase(dbFile)
  db = opened.db
  closeDb = opened.close
}

/**
 * Creates the task a workflow's foreign key requires, through the event log.
 *
 * Through the log rather than by inserting the row, because `rebuildProjections` deletes
 * the project and `tasks` cascades from it. A directly-inserted row would vanish on replay
 * and the workflow's foreign key would fail — which is exactly the bug this test found in
 * `applyEvent`, where `task.created` had no projection.
 */
function createTask(): void {
  const event = new EventStore(db).append(
    {
      type: 'task.created',
      payload: {
        task: {
          id: taskId,
          objective: 'Correct the constant',
          constraints: [],
          completionCriteria: [{ kind: 'tests', description: 'the test suite passes', params: {} }],
          scope: { allowedPaths: [], forbiddenPaths: [] },
          lockedDecisionIds: [],
          correctsTaskId: null,
          createdAt: NOW,
        },
      },
    },
    { projectId, actor: 'user', occurredAt: NOW },
  )

  applyEvent(db, event)
}

function step(index: number, overrides: Partial<WorkflowStep> = {}): WorkflowStep {
  return {
    id: stepIdSchema.parse(randomUUID()),
    index,
    role: 'implementer',
    runtimeId: 'mock:happy',
    state: 'IMPLEMENTING',
    contextRef: `packet-${String(index)}`,
    reportStatus: null,
    verdict: null,
    changeSetId: null,
    startedAt: NOW,
    finishedAt: null,
    ...overrides,
  }
}

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), 'forge-wf-')), 'forge.db')
  const opened = initialiseDatabase(dbFile)
  db = opened.db
  closeDb = opened.close

  projectId = projectIdSchema.parse(randomUUID())
  taskId = taskIdSchema.parse(randomUUID())
  workflowId = workflowIdSchema.parse(randomUUID())

  new ProjectStore(db).create(
    {
      id: projectId,
      name: 'Subject',
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

  createTask()
})

afterEach(() => {
  closeDb()
  rmSync(dbFile, { recursive: true, force: true })
})

function startWorkflow(): WorkflowStore {
  const store = new WorkflowStore(db)
  store.start({ workflowId, projectId, taskId, templateId: 'feature', startedAt: NOW }, 'user')
  return store
}

describe('starting a workflow', () => {
  it('begins in DISCOVERY with the default limits', () => {
    const store = startWorkflow()
    const workflow = store.find(workflowId)

    expect(workflow?.state).toBe('DISCOVERY')
    expect(workflow?.iteration).toBe(0)
    expect(workflow?.limits.maxIterations).toBe(5)
    expect(workflow?.checkpoint).toBeNull()
  })

  it('survives a restart', () => {
    startWorkflow()
    reopen()

    expect(new WorkflowStore(db).find(workflowId)?.state).toBe('DISCOVERY')
  })
})

describe('transitions', () => {
  it('records each move in the log and the read model', () => {
    const store = startWorkflow()

    store.apply(workflowId, 'start', 'system', NOW)
    expect(store.find(workflowId)?.state).toBe('PLANNING')

    store.apply(workflowId, 'planProduced', 'agent:mock', NOW)
    expect(store.find(workflowId)?.state).toBe('PLAN_READY')
  })

  it('refuses an illegal move without recording anything', () => {
    // A rejected trigger must leave no trace: a log that recorded state changes which did
    // not happen would be worse than no log.
    const store = startWorkflow()
    const before = new EventStore(db).read(projectId).length

    expect(() => store.apply(workflowId, 'reviewPassed', 'system', NOW)).toThrow(
      /not a legal transition/,
    )

    expect(new EventStore(db).read(projectId)).toHaveLength(before)
    expect(store.find(workflowId)?.state).toBe('DISCOVERY')
  })

  it('records the halt reason alongside the state', () => {
    const store = startWorkflow()
    store.apply(workflowId, 'start', 'system', NOW)

    store.apply(workflowId, 'policyViolated', 'system', NOW, {
      reason: 'The agent modified a migration',
    })

    const workflow = store.find(workflowId)
    expect(workflow?.state).toBe('HALTED_POLICY')
    // `workflowSchema` refuses a halted workflow with no reason, so this parsing at all
    // proves the reason was written.
    expect(workflow?.haltReason).toBe('The agent modified a migration')
  })

  it('halts at the iteration cap with a reason naming the limit', () => {
    const store = startWorkflow()
    for (const trigger of [
      'start',
      'planProduced',
      'userApproved',
      'implementationStarted',
    ] as const) {
      store.apply(workflowId, trigger, 'user', NOW)
    }

    // Five corrections is the default cap; the sixth must halt.
    for (let cycle = 0; cycle < 5; cycle += 1) {
      store.apply(workflowId, 'implemented', 'agent:mock', NOW)
      store.apply(workflowId, 'verified', 'system', NOW)
      store.apply(workflowId, 'reviewFailed', 'agent:mock', NOW)
      store.apply(workflowId, 'correctionStarted', 'system', NOW)
    }

    store.apply(workflowId, 'implemented', 'agent:mock', NOW)
    store.apply(workflowId, 'verified', 'system', NOW)
    store.apply(workflowId, 'reviewFailed', 'agent:mock', NOW)
    const halted = store.apply(workflowId, 'correctionStarted', 'system', NOW)

    expect(halted.state).toBe('HALTED_LIMIT')
    expect(halted.haltReason).toMatch(/maximum of 5 iterations/)
  })

  it('records a resume state on the way into AWAITING_USER and clears it on the way out', () => {
    const store = startWorkflow()
    store.apply(workflowId, 'start', 'system', NOW)

    const paused = store.apply(workflowId, 'questionRaised', 'agent:mock', NOW)
    expect(paused.state).toBe('AWAITING_USER')
    expect(paused.resumeState).toBe('PLANNING')

    const resumed = store.apply(workflowId, 'questionAnswered', 'user', NOW)
    expect(resumed.state).toBe('PLANNING')
    expect(resumed.resumeState).toBeNull()
  })

  it('finishes a workflow, clearing the checkpoint', () => {
    const store = startWorkflow()
    for (const trigger of [
      'start',
      'planProduced',
      'userApproved',
      'implementationStarted',
      'implemented',
      'verified',
    ] as const) {
      store.apply(workflowId, trigger, 'user', NOW)
    }

    store.checkpoint(
      workflowId,
      {
        stepIndex: 0,
        state: 'REVIEWING',
        startedAt: NOW,
        lastOperation: 'reviewing',
        inputRef: null,
      },
      'system',
      NOW,
    )

    const done = store.apply(workflowId, 'reviewPassed', 'agent:mock', NOW)

    expect(done.state).toBe('DONE')
    expect(done.finishedAt).toBe(NOW)
    // Cleared, which is exactly what makes "interrupted" mean "checkpoint on an
    // unfinished workflow".
    expect(done.checkpoint).toBeNull()
  })
})

describe('crash recovery', () => {
  /** Drives a workflow to IMPLEMENTING with a step checkpointed but not finished. */
  function crashMidImplementation(): WorkflowStep {
    const store = startWorkflow()
    for (const trigger of [
      'start',
      'planProduced',
      'userApproved',
      'implementationStarted',
    ] as const) {
      store.apply(workflowId, trigger, 'user', NOW)
    }

    const pending = step(0)

    // The write-ahead ordering under test: the checkpoint and the step's start are
    // persisted *before* the side effect (spawning the agent) would run.
    store.checkpoint(
      workflowId,
      {
        stepIndex: 0,
        state: 'IMPLEMENTING',
        startedAt: NOW,
        lastOperation: 'spawning the implementer',
        inputRef: pending.contextRef,
      },
      'system',
      NOW,
    )
    store.startStep(workflowId, pending, 'system', NOW)

    // ...and here the process dies. Nothing finishes the step.
    return pending
  }

  it('detects the interrupted workflow after a restart', () => {
    // The definition of done: killed mid-implementation, then resumed correctly.
    crashMidImplementation()
    reopen()

    const store = new WorkflowStore(db)
    const interrupted = store.findInterrupted()

    expect(interrupted).toHaveLength(1)
    expect(interrupted.at(0)?.id).toBe(workflowId)
    expect(interrupted.at(0)?.state).toBe('IMPLEMENTING')
  })

  it('describes what a resume would do, so the offer is concrete', () => {
    crashMidImplementation()
    reopen()

    const workflow = new WorkflowStore(db).findInterrupted().at(0)
    expect(workflow).toBeDefined()
    if (workflow === undefined) return

    const plan = planResume(workflow)

    expect(plan?.state).toBe('IMPLEMENTING')
    expect(plan?.stepIndex).toBe(0)
    expect(plan?.totalSteps).toBe(1)
    // What the resume banner shows. A step index alone would not tell the user what was
    // happening.
    expect(plan?.lastOperation).toBe('spawning the implementer')
    // The snapshotted packet the step replays, so context cannot drift.
    expect(plan?.inputRef).toBe('packet-0')
  })

  it('replays the same prompt packet rather than recompiling one', () => {
    // A resumed step must send what it was originally sending. Recompiling would use
    // project state that has moved on since the crash, so the resumed run would not be
    // the interrupted one.
    const pending = crashMidImplementation()
    reopen()

    const store = new WorkflowStore(db)
    const workflow = store.find(workflowId)
    const resumedStep = workflow?.steps.at(0)

    expect(resumedStep?.contextRef).toBe(pending.contextRef)
    expect(planResume(workflow ?? ({} as never))?.inputRef).toBe(pending.contextRef)
  })

  it('does not treat a finished workflow as interrupted', () => {
    const store = startWorkflow()
    store.apply(workflowId, 'start', 'system', NOW)
    store.apply(workflowId, 'cancelled', 'user', NOW)

    reopen()
    expect(new WorkflowStore(db).findInterrupted()).toEqual([])
  })

  it('does not treat a workflow with no checkpoint as interrupted', () => {
    // A workflow that never started a step has nothing in flight to redo.
    startWorkflow()
    reopen()

    expect(new WorkflowStore(db).findInterrupted()).toEqual([])
  })

  it('re-running the interrupted step adds no duplicate row', () => {
    // The other half of the definition of done: no double-applied changes after a resume.
    // The step is keyed on its id, so replaying it updates the row rather than colliding
    // with the unique (workflow, index) constraint.
    const pending = crashMidImplementation()
    reopen()

    const store = new WorkflowStore(db)
    store.startStep(
      workflowId,
      { ...pending, startedAt: '2026-08-19T10:05:00.000Z' },
      'system',
      NOW,
    )

    const workflow = store.find(workflowId)
    expect(workflow?.steps).toHaveLength(1)
    expect(workflow?.steps.at(0)?.startedAt).toBe('2026-08-19T10:05:00.000Z')
  })

  it('completes correctly after resuming', () => {
    const pending = crashMidImplementation()
    reopen()

    const store = new WorkflowStore(db)

    // Redo the interrupted step, then carry on to the end.
    store.startStep(workflowId, pending, 'system', NOW)
    store.finishStep(workflowId, pending.id, { verdict: 'pass', changeSetId: null }, 'system', NOW)
    store.apply(workflowId, 'implemented', 'agent:mock', NOW)
    store.apply(workflowId, 'verified', 'system', NOW)
    const done = store.apply(workflowId, 'reviewPassed', 'agent:mock', NOW)

    expect(done.state).toBe('DONE')
    expect(done.steps.at(0)?.verdict).toBe('pass')
    expect(done.checkpoint).toBeNull()
  })
})

describe('replay', () => {
  it('rebuilds the same state from the event log alone', () => {
    // The projections are a cache; this is the proof. Dropping and replaying must
    // reproduce exactly what was read before — the property that makes a resume safe,
    // since resume re-applies the tail of the log.
    const store = startWorkflow()
    store.apply(workflowId, 'start', 'system', NOW)
    store.apply(workflowId, 'planProduced', 'agent:mock', NOW)
    store.apply(workflowId, 'userApproved', 'user', NOW)
    store.apply(workflowId, 'implementationStarted', 'system', NOW)

    const pending = step(0)
    store.checkpoint(
      workflowId,
      {
        stepIndex: 0,
        state: 'IMPLEMENTING',
        startedAt: NOW,
        lastOperation: 'working',
        inputRef: 'packet-0',
      },
      'system',
      NOW,
    )
    store.startStep(workflowId, pending, 'system', NOW)

    const before = store.find(workflowId)

    new ProjectStore(db).rebuild(projectId)

    expect(store.find(workflowId)).toEqual(before)
  })

  it('applying the same events twice leaves the same state', () => {
    // Idempotency stated directly: every projection writer is an upsert or an absolute
    // set, so re-applying the tail of the log cannot double-count. An
    // `iteration = iteration + 1` would fail this.
    const store = startWorkflow()
    store.apply(workflowId, 'start', 'system', NOW)
    store.apply(workflowId, 'planProduced', 'agent:mock', NOW)
    store.apply(workflowId, 'userApproved', 'user', NOW)
    store.apply(workflowId, 'implementationStarted', 'system', NOW)
    store.apply(workflowId, 'implemented', 'agent:mock', NOW)
    store.apply(workflowId, 'verified', 'system', NOW)
    store.apply(workflowId, 'reviewFailed', 'agent:mock', NOW)
    store.apply(workflowId, 'correctionStarted', 'system', NOW)

    const once = store.find(workflowId)
    expect(once?.iteration).toBe(1)

    const projectStore = new ProjectStore(db)
    projectStore.rebuild(projectId)
    projectStore.rebuild(projectId)

    const twice = store.find(workflowId)
    expect(twice?.iteration).toBe(1)
    expect(twice).toEqual(once)
  })

  it('appends no duplicate events across a restart', () => {
    const store = startWorkflow()
    store.apply(workflowId, 'start', 'system', NOW)
    const before = new EventStore(db).read(projectId).length

    reopen()

    // Reopening reads; it must not write.
    expect(new EventStore(db).read(projectId)).toHaveLength(before)
  })

  it('retrieves and deserializes a persisted task via getTask', () => {
    const store = new WorkflowStore(db)
    const task = store.getTask(taskId)
    expect(task).not.toBeNull()
    expect(task?.id).toBe(taskId)
    expect(task?.objective).toBe('Correct the constant')
    expect(task?.constraints).toEqual([])
    expect(task?.completionCriteria).toHaveLength(1)
    expect(task?.completionCriteria[0]?.kind).toBe('tests')
    expect(task?.scope.allowedPaths).toEqual([])
    expect(task?.scope.forbiddenPaths).toEqual([])
    expect(task?.lockedDecisionIds).toEqual([])
    expect(task?.correctsTaskId).toBeNull()
    expect(task?.createdAt).toBe(NOW)

    const nonExistent = store.getTask(taskIdSchema.parse(randomUUID()))
    expect(nonExistent).toBeNull()
  })

  describe('graph persistence', () => {
    it('starts and retrieves a graph run', () => {
      const store = startWorkflow()
      const graphRunId = randomUUID()

      const created = store.startGraphRun(
        {
          graphRunId,
          projectId,
          workflowId,
          templateId: 'feature_implementation_v2',
          startedAt: NOW,
        },
        'user',
      )

      expect(created.id).toBe(graphRunId)
      expect(created.workflowId).toBe(workflowId)
      expect(created.templateId).toBe('feature_implementation_v2')
      expect(created.status).toBe('running')
      expect(created.iteration).toBe(1)
      expect(created.startedAt).toBe(NOW)
      expect(created.finishedAt).toBeNull()
      expect(created.haltReason).toBeNull()
      expect(created.error).toBeNull()

      const retrieved = store.getGraphRun(graphRunId)
      expect(retrieved).toEqual(created)

      expect(store.getGraphRun(randomUUID())).toBeNull()
    })

    it('updates graph run status with completion, failure, and halt details', () => {
      const store = startWorkflow()
      const graphRunId = randomUUID()
      store.startGraphRun(
        {
          graphRunId,
          projectId,
          workflowId,
          templateId: 'feature_implementation_v2',
          startedAt: NOW,
        },
        'user',
      )

      const FINISHED = '2026-08-19T10:15:00.000Z'
      const updated = store.updateGraphRunStatus(
        {
          projectId,
          graphRunId,
          status: 'completed',
          finishedAt: FINISHED,
          occurredAt: FINISHED,
        },
        'system',
      )

      expect(updated.status).toBe('completed')
      expect(updated.finishedAt).toBe(FINISHED)

      // Test failure and halt reason
      const graphRunId2 = randomUUID()
      store.startGraphRun(
        {
          graphRunId: graphRunId2,
          projectId,
          workflowId,
          templateId: 'bug_fix_v2',
          startedAt: NOW,
        },
        'user',
      )

      const failed = store.updateGraphRunStatus(
        {
          projectId,
          graphRunId: graphRunId2,
          status: 'failed',
          error: 'Verification suite exited with code 1',
          finishedAt: FINISHED,
          occurredAt: FINISHED,
        },
        'system',
      )
      expect(failed.status).toBe('failed')
      expect(failed.error).toBe('Verification suite exited with code 1')
    })

    it('enforces attempt monotonicity when recording node attempts', () => {
      const store = startWorkflow()
      const graphRunId = randomUUID()
      store.startGraphRun(
        {
          graphRunId,
          projectId,
          workflowId,
          templateId: 'feature_implementation_v2',
          startedAt: NOW,
        },
        'user',
      )

      // Initial attempt must be 1
      expect(() =>
        store.recordNodeAttempt(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: 'node-implement',
            attempt: 2, // violation
            status: 'running',
            role: 'implementer',
            startedAt: NOW,
          },
          'system',
        ),
      ).toThrow(/Attempt monotonicity violation: initial attempt.*must be 1/i)

      // Record valid initial attempt
      const attempt1Id = randomUUID()
      const attempt1 = store.recordNodeAttempt(
        {
          id: attempt1Id,
          projectId,
          graphRunId,
          nodeId: 'node-implement',
          attempt: 1,
          status: 'running',
          role: 'implementer',
          startedAt: NOW,
        },
        'system',
      )
      expect(attempt1.attempt).toBe(1)
      expect(attempt1.status).toBe('running')

      // Cannot record duplicate attempt 1
      expect(() =>
        store.recordNodeAttempt(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: 'node-implement',
            attempt: 1, // duplicate violation
            status: 'running',
            role: 'implementer',
            startedAt: NOW,
          },
          'system',
        ),
      ).toThrow(/Attempt monotonicity violation: next attempt.*must be 2/i)

      // Cannot skip to attempt 3
      expect(() =>
        store.recordNodeAttempt(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: 'node-implement',
            attempt: 3, // skipped violation
            status: 'running',
            role: 'implementer',
            startedAt: NOW,
          },
          'system',
        ),
      ).toThrow(/Attempt monotonicity violation: next attempt.*must be 2/i)

      // Monotonic attempt 2 succeeds
      const attempt2 = store.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'node-implement',
          attempt: 2,
          status: 'running',
          role: 'implementer',
          startedAt: NOW,
        },
        'system',
      )
      expect(attempt2.attempt).toBe(2)
    })

    it('enforces terminal attempt immutability', () => {
      const store = startWorkflow()
      const graphRunId = randomUUID()
      store.startGraphRun(
        {
          graphRunId,
          projectId,
          workflowId,
          templateId: 'feature_implementation_v2',
          startedAt: NOW,
        },
        'user',
      )

      store.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'node-plan',
          attempt: 1,
          status: 'running',
          role: 'planner',
          startedAt: NOW,
        },
        'system',
      )

      // Transition attempt 1 to terminal state 'completed'
      const completed = store.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'node-plan',
          attempt: 1,
          status: 'completed',
          finishedAt: NOW,
          occurredAt: NOW,
        },
        'system',
      )
      expect(completed.status).toBe('completed')

      // Attempting to mutate terminal attempt throws
      expect(() =>
        store.updateNodeAttempt(
          {
            projectId,
            graphRunId,
            nodeId: 'node-plan',
            attempt: 1,
            status: 'failed',
            occurredAt: NOW,
          },
          'system',
        ),
      ).toThrow(
        /Terminal attempt immutability violation: node "node-plan" attempt 1 is in terminal status "completed" and cannot be updated/i,
      )
    })

    it('derives latest NodeRun state (Option A) and preserves attempt history', () => {
      const store = startWorkflow()
      const graphRunId = randomUUID()
      store.startGraphRun(
        {
          graphRunId,
          projectId,
          workflowId,
          templateId: 'feature_implementation_v2',
          startedAt: NOW,
        },
        'user',
      )

      // Node A attempt 1 -> failed
      store.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'node-A',
          attempt: 1,
          status: 'running',
          role: 'implementer',
          startedAt: NOW,
        },
        'system',
      )
      store.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'node-A',
          attempt: 1,
          status: 'failed',
          error: 'Syntax error',
          occurredAt: NOW,
        },
        'system',
      )

      // Node A attempt 2 -> completed (after rerun)
      store.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'node-A',
          attempt: 2,
          status: 'running',
          role: 'implementer',
          startedAt: NOW,
        },
        'system',
      )
      store.updateNodeAttempt(
        {
          projectId,
          graphRunId,
          nodeId: 'node-A',
          attempt: 2,
          status: 'completed',
          occurredAt: NOW,
        },
        'system',
      )

      // Node B attempt 1 -> running
      store.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'node-B',
          attempt: 1,
          status: 'running',
          role: 'reviewer',
          startedAt: NOW,
        },
        'system',
      )

      // getLatestNodeRuns returns Option A logical NodeRuns (latest attempt for each node)
      const latestRuns = store.getLatestNodeRuns(graphRunId)
      expect(latestRuns).toHaveLength(2)

      const nodeARun = latestRuns.find((n) => n.nodeId === 'node-A')
      expect(nodeARun?.attempt).toBe(2)
      expect(nodeARun?.status).toBe('completed')

      const nodeBRun = latestRuns.find((n) => n.nodeId === 'node-B')
      expect(nodeBRun?.attempt).toBe(1)
      expect(nodeBRun?.status).toBe('running')

      // getNodeAttempts returns complete historical audit log
      const allAttempts = store.getNodeAttempts(graphRunId)
      expect(allAttempts).toHaveLength(3)

      const nodeAAttempts = store.getNodeAttempts(graphRunId, 'node-A')
      expect(nodeAAttempts).toHaveLength(2)
      expect(nodeAAttempts[0]?.attempt).toBe(1)
      expect(nodeAAttempts[0]?.status).toBe('failed')
      expect(nodeAAttempts[1]?.attempt).toBe(2)
      expect(nodeAAttempts[1]?.status).toBe('completed')
    })

    it('persists write-ahead checkpoints and retrieves the latest checkpoint', () => {
      const store = startWorkflow()
      const graphRunId = randomUUID()
      store.startGraphRun(
        {
          graphRunId,
          projectId,
          workflowId,
          templateId: 'feature_implementation_v2',
          startedAt: NOW,
        },
        'user',
      )

      expect(store.getLatestGraphCheckpoint(graphRunId)).toBeNull()

      const cp1Id = randomUUID()
      const cp1 = store.writeGraphCheckpoint(
        {
          id: cp1Id,
          projectId,
          graphRunId,
          nodeId: 'node-plan',
          operation: 'dispatch_agent',
          stateSnapshot: {
            readyNodeIds: ['node-plan'],
            runningNodeIds: [],
            completedNodeIds: [],
            blockedNodeIds: [],
          },
          occurredAt: '2026-08-19T10:01:00.000Z',
        },
        'system',
      )

      expect(cp1.id).toBe(cp1Id)
      expect(cp1.operation).toBe('dispatch_agent')
      expect(cp1.stateSnapshot.readyNodeIds).toEqual(['node-plan'])

      const latest1 = store.getLatestGraphCheckpoint(graphRunId)
      expect(latest1).toEqual(cp1)

      const cp2Id = randomUUID()
      const cp2 = store.writeGraphCheckpoint(
        {
          id: cp2Id,
          projectId,
          graphRunId,
          nodeId: 'node-implement',
          operation: 'dispatch_agent',
          stateSnapshot: {
            readyNodeIds: ['node-implement'],
            runningNodeIds: [],
            completedNodeIds: ['node-plan'],
            blockedNodeIds: [],
          },
          occurredAt: '2026-08-19T10:05:00.000Z',
        },
        'system',
      )

      const latest2 = store.getLatestGraphCheckpoint(graphRunId)
      expect(latest2).toEqual(cp2)
      expect(latest2?.stateSnapshot.completedNodeIds).toEqual(['node-plan'])
    })

    it('discovers interrupted graph runs across process restarts', () => {
      const store = startWorkflow()
      const graphRunId = randomUUID()
      store.startGraphRun(
        {
          graphRunId,
          projectId,
          workflowId,
          templateId: 'feature_implementation_v2',
          startedAt: NOW,
        },
        'user',
      )

      // Graph run is currently 'running' with finishedAt = null
      let interrupted = store.findInterruptedGraphRuns(projectId)
      expect(interrupted).toHaveLength(1)
      expect(interrupted[0]?.id).toBe(graphRunId)

      // Simulate crash and restart
      reopen()
      const reopenedStore = new WorkflowStore(db)
      interrupted = reopenedStore.findInterruptedGraphRuns(projectId)
      expect(interrupted).toHaveLength(1)
      expect(interrupted[0]?.id).toBe(graphRunId)

      // Complete the run
      reopenedStore.updateGraphRunStatus(
        {
          projectId,
          graphRunId,
          status: 'completed',
          finishedAt: '2026-08-19T10:30:00.000Z',
          occurredAt: '2026-08-19T10:30:00.000Z',
        },
        'system',
      )

      expect(reopenedStore.findInterruptedGraphRuns(projectId)).toHaveLength(0)
    })

    it('rebuilds graph read models deterministically from the event log', () => {
      const store = startWorkflow()
      const graphRunId = randomUUID()
      store.startGraphRun(
        {
          graphRunId,
          projectId,
          workflowId,
          templateId: 'feature_implementation_v2',
          startedAt: NOW,
        },
        'user',
      )

      store.recordNodeAttempt(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'node-1',
          attempt: 1,
          status: 'running',
          role: 'implementer',
          startedAt: NOW,
        },
        'system',
      )

      store.writeGraphCheckpoint(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: 'node-1',
          operation: 'dispatch',
          stateSnapshot: {
            readyNodeIds: [],
            runningNodeIds: ['node-1'],
            completedNodeIds: [],
            blockedNodeIds: [],
          },
          occurredAt: NOW,
        },
        'system',
      )

      const runBefore = store.getGraphRun(graphRunId)
      const attemptsBefore = store.getNodeAttempts(graphRunId)
      const checkpointBefore = store.getLatestGraphCheckpoint(graphRunId)

      // Rebuild from events
      const projectStore = new ProjectStore(db)
      projectStore.rebuild(projectId)

      const runAfter = store.getGraphRun(graphRunId)
      const attemptsAfter = store.getNodeAttempts(graphRunId)
      const checkpointAfter = store.getLatestGraphCheckpoint(graphRunId)

      expect(runAfter).toEqual(runBefore)
      expect(attemptsAfter).toEqual(attemptsBefore)
      expect(checkpointAfter).toEqual(checkpointBefore)
    })
  })
})
