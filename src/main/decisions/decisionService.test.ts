import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  projectIdSchema,
  repositoryIdSchema,
  taskIdSchema,
  workflowIdSchema,
  type Decision,
  type ProjectId,
  type WorkflowId,
} from '@shared/domain'
import { initialiseDatabase, type ForgeDatabase } from '../db'
import { DecisionStore } from '../db/decisionStore'
import { EventStore } from '../db/eventStore'
import { ProjectStore } from '../db/projectStore'
import { applyEvent } from '../db/projections'
import { WorkflowStore } from '../db/workflowStore'
import { DecisionService } from './decisionService'

describe('DecisionService', () => {
  let db: ForgeDatabase
  let closeDb: () => void
  let decisionStore: DecisionStore
  let workflowStore: WorkflowStore
  let decisionService: DecisionService
  let projectId: ProjectId
  let workflowId: WorkflowId
  let graphRunId: string
  const nodeId = 'step-2-gate'
  const NOW = new Date().toISOString()

  beforeEach(() => {
    const opened = initialiseDatabase(':memory:')
    db = opened.db
    closeDb = opened.close

    const eventStore = new EventStore(db)
    decisionStore = new DecisionStore(db, eventStore)
    workflowStore = new WorkflowStore(db)

    projectId = projectIdSchema.parse(randomUUID())
    workflowId = workflowIdSchema.parse(randomUUID())
    graphRunId = 'run-service-test-1'

    new ProjectStore(db).create(
      {
        id: projectId,
        name: 'Service Test Project',
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: '/repo/test',
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

    const taskId = taskIdSchema.parse(randomUUID())
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
        templateId: 'feature',
        startedAt: NOW,
      },
      'user',
    )

    workflowStore.startGraphRun(
      {
        graphRunId,
        workflowId,
        projectId,
        templateId: 'compiled-feature',
        startedAt: NOW,
      },
      'user',
    )

    decisionService = new DecisionService({
      decisions: decisionStore,
      workflowStore,
    })
  })

  afterEach(() => {
    closeDb()
  })

  function recordBlockedNodeAttempt(nId: string): void {
    workflowStore.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId: nId,
        attempt: 1,
        iteration: 1,
        status: 'running',
        startedAt: NOW,
      },
      'system',
    )
    workflowStore.updateNodeAttempt(
      {
        projectId,
        graphRunId,
        nodeId: nId,
        attempt: 1,
        status: 'blocked',
        finishedAt: NOW,
        occurredAt: NOW,
      },
      'system',
    )
  }

  it('records a gate decision when preflight checks pass (node is blocked)', () => {
    recordBlockedNodeAttempt(nodeId)

    const view = decisionService.recordGateDecision({
      projectId,
      workflowId,
      graphRunId,
      nodeId,
      verdict: 'approved',
      rationale: 'Human approved gate',
    })

    expect(view.status).toBe('locked')
    expect(view.gateVerdict).toBe('approved')
    expect(view.graphRunId).toBe(graphRunId)
    expect(view.nodeId).toBe(nodeId)
    expect(view.workflowId).toBe(workflowId)
  })

  it('fails if workflow does not belong to projectId', () => {
    const wrongProjectId = projectIdSchema.parse(randomUUID())

    expect(() =>
      decisionService.recordGateDecision({
        projectId: wrongProjectId,
        workflowId,
        graphRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Invalid project scope',
      }),
    ).toThrow(/belongs to project/)
  })

  it('fails if graphRunId does not belong to workflowId', () => {
    const wrongWorkflowId = workflowIdSchema.parse(randomUUID())

    expect(() =>
      decisionService.recordGateDecision({
        projectId,
        workflowId: wrongWorkflowId,
        graphRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Invalid workflow scope',
      }),
    ).toThrow(/Workflow .* not found/)
  })

  it('fails if graphRun is in a terminal status', () => {
    recordBlockedNodeAttempt(nodeId)

    workflowStore.updateGraphRunStatus(
      {
        graphRunId,
        projectId,
        status: 'failed',
        iteration: 1,
        haltReason: 'Execution failed',
        error: 'Execution failed',
        finishedAt: NOW,
        occurredAt: NOW,
      },
      'system',
    )

    expect(() =>
      decisionService.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Cannot decide terminal run',
      }),
    ).toThrow(/already in terminal state/)
  })

  it('fails if node has no recorded attempts', () => {
    expect(() =>
      decisionService.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId: 'unreached-node',
        verdict: 'approved',
        rationale: 'Cannot decide unreached node',
      }),
    ).toThrow(/has no recorded attempts/)
  })

  it('fails if node is not currently blocked', () => {
    workflowStore.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId,
        attempt: 1,
        iteration: 1,
        status: 'running',
        startedAt: NOW,
      },
      'user',
    )

    expect(() =>
      decisionService.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Cannot decide running node',
      }),
    ).toThrow(/currently in status "running", not "blocked"/)
  })

  it('triggers onDecisionChanged callback on gate decision recording', () => {
    const onDecisionChanged = vi.fn<(decision: Decision) => void>()
    const svc = new DecisionService({
      decisions: decisionStore,
      workflowStore,
      onDecisionChanged,
    })

    recordBlockedNodeAttempt(nodeId)

    svc.recordGateDecision({
      projectId,
      workflowId,
      graphRunId,
      nodeId,
      verdict: 'rejected',
      rationale: 'Rejected for design flaw',
    })

    expect(onDecisionChanged).toHaveBeenCalledTimes(1)
    const recorded = onDecisionChanged.mock.calls[0]?.[0]
    expect(recorded?.gateVerdict).toBe('rejected')
  })
})
