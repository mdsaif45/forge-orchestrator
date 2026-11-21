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
  type WorkflowTemplateV2,
} from '@shared/domain'
import { initialiseDatabase, type ForgeDatabase } from '../db'
import { DecisionStore } from '../db/decisionStore'
import { eq } from 'drizzle-orm'
import { EventStore } from '../db/eventStore'
import { ProjectStore } from '../db/projectStore'
import { applyEvent } from '../db/projections'
import { graphRuns } from '../db/schema'
import { WorkflowStore } from '../db/workflowStore'
import { createDefaultTemplateResolver } from '../templates/templateV2Store'
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

    const mockTemplate: WorkflowTemplateV2 = {
      id: 'compiled-feature',
      name: 'Compiled Feature',
      version: 1,
      status: 'published',
      category: 'feature',
      description: 'Test template',
      createdAt: NOW,
      updatedAt: NOW,
      nodes: [
        {
          id: 'step-1-agent',
          title: 'Planning Agent',
          type: 'agent',
          runtimeType: 'cli-agent',
          config: { skills: [], permissionMode: 'read-only' },
          inputs: [],
          outputs: [],
        },
        {
          id: 'step-2-gate',
          title: 'User Approval Gate',
          type: 'user_gate',
          runtimeType: 'human',
          config: { skills: [], permissionMode: 'read-only' },
          inputs: [],
          outputs: [],
        },
      ],
      edges: [
        {
          id: 'edge-1',
          source: 'step-1-agent',
          target: 'step-2-gate',
        },
      ],
    }

    const templateResolver = (templateId: string): WorkflowTemplateV2 | null => {
      if (templateId === 'compiled-feature') return mockTemplate
      return null
    }

    decisionService = new DecisionService({
      decisions: decisionStore,
      workflowStore,
      templateResolver,
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
      templateResolver: (tId) =>
        tId === 'compiled-feature'
          ? {
              id: 'compiled-feature',
              name: 'Compiled Feature',
              version: 1,
              status: 'published',
              category: 'feature',
              description: 'Test template',
              createdAt: NOW,
              updatedAt: NOW,
              nodes: [
                {
                  id: 'step-2-gate',
                  title: 'User Approval Gate',
                  type: 'user_gate',
                  runtimeType: 'human',
                  config: { skills: [], permissionMode: 'read-only' },
                  inputs: [],
                  outputs: [],
                },
              ],
              edges: [],
            }
          : null,
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

  it('fails closed if workflowStore is missing from DecisionService', () => {
    const svcWithoutWf = new DecisionService({
      decisions: decisionStore,
      templateResolver: () => null,
    })

    expect(() =>
      svcWithoutWf.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Unverified gate decision',
      }),
    ).toThrow(/workflowStore is required for authoritative preflight verification/)
  })

  it('fails closed if templateResolver is missing from DecisionService', () => {
    const svcWithoutTpl = new DecisionService({
      decisions: decisionStore,
      workflowStore,
    })

    recordBlockedNodeAttempt(nodeId)

    expect(() =>
      svcWithoutTpl.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Missing template resolver',
      }),
    ).toThrow(/templateResolver is required to verify node type/)
  })

  it('fails closed if template cannot be resolved', () => {
    const svcUnresolvedTpl = new DecisionService({
      decisions: decisionStore,
      workflowStore,
      templateResolver: () => null,
    })

    recordBlockedNodeAttempt(nodeId)

    expect(() =>
      svcUnresolvedTpl.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Template missing',
      }),
    ).toThrow(/template "compiled-feature" could not be resolved/)
  })

  it('fails closed if requested node does not exist in template', () => {
    recordBlockedNodeAttempt('non-existent-node')

    expect(() =>
      decisionService.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId: 'non-existent-node',
        verdict: 'approved',
        rationale: 'Ghost node',
      }),
    ).toThrow(/node "non-existent-node" not found in template/)
  })

  it('fails closed if blocked node is not a user_gate (A blocked non-gate node cannot receive an authorized gate decision)', () => {
    recordBlockedNodeAttempt('step-1-agent')

    expect(() =>
      decisionService.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId: 'step-1-agent',
        verdict: 'approved',
        rationale: 'Trying to approve an agent node',
      }),
    ).toThrow(
      /node "step-1-agent" in template "compiled-feature" has type "agent", not "user_gate"/,
    )
  })

  it('fails closed if graphRun does not belong to requested projectId (A graph run with mismatched project identity is rejected)', () => {
    const otherProjectId = projectIdSchema.parse(randomUUID())
    new ProjectStore(db).create(
      {
        id: otherProjectId,
        name: 'Other Project',
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: '/repo/other',
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

    // Start a workflow in otherProject
    const otherWorkflowId = workflowIdSchema.parse(randomUUID())
    const otherTaskId = taskIdSchema.parse(randomUUID())
    const otherTaskEvent = new EventStore(db).append(
      {
        type: 'task.created',
        payload: {
          task: {
            id: otherTaskId,
            objective: 'Other objective',
            constraints: [],
            completionCriteria: [{ kind: 'tests', description: 'test suite passes', params: {} }],
            scope: { allowedPaths: [], forbiddenPaths: [] },
            lockedDecisionIds: [],
            correctsTaskId: null,
            createdAt: NOW,
          },
        },
      },
      { projectId: otherProjectId, actor: 'user', occurredAt: NOW },
    )
    applyEvent(db, otherTaskEvent)

    workflowStore.start(
      {
        workflowId: otherWorkflowId,
        projectId: otherProjectId,
        taskId: otherTaskId,
        templateId: 'feature',
        startedAt: NOW,
      },
      'user',
    )

    const otherRunId = 'run-other-project'
    workflowStore.startGraphRun(
      {
        graphRunId: otherRunId,
        workflowId: otherWorkflowId,
        projectId: otherProjectId,
        templateId: 'compiled-feature',
        startedAt: NOW,
      },
      'user',
    )

    recordBlockedNodeAttempt(nodeId)

    // Attempt to record a gate decision targeting graphRun from otherProject under current projectId
    expect(() =>
      decisionService.recordGateDecision({
        projectId,
        workflowId: otherWorkflowId,
        graphRunId: otherRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Mismatched project identity',
      }),
    ).toThrow(/belongs to project/)
  })

  it('fails closed when graph-run stored project identity mismatches requested project even when workflow belongs to requested project', () => {
    const otherProjectId = projectIdSchema.parse(randomUUID())
    new ProjectStore(db).create(
      {
        id: otherProjectId,
        name: 'Other Project Fixture',
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: '/repo/other-fixture',
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

    recordBlockedNodeAttempt(nodeId)

    // Using controlled database fixture: deliberately update graph_runs.projectId to otherProjectId
    // while the workflow itself legitimately belongs to projectId (Project A).
    db.update(graphRuns)
      .set({ projectId: otherProjectId })
      .where(eq(graphRuns.id, graphRunId))
      .run()

    // Request payload uses projectId (Project A) which matches workflow.projectId and run.workflowId,
    // but graph_runs.projectId is otherProjectId (Project B).
    expect(() =>
      decisionService.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Testing stored graph-run project identity verification',
      }),
    ).toThrow(
      new RegExp(`Graph run ${graphRunId} belongs to project ${otherProjectId}, not ${projectId}`),
    )
  })

  it('resolves authentic user_gate using createDefaultTemplateResolver for default linear templates', () => {
    const svcWithDefaultResolver = new DecisionService({
      decisions: decisionStore,
      workflowStore,
      templateResolver: createDefaultTemplateResolver(),
    })
    // In canonical feature template, step-2-user is the user_gate
    recordBlockedNodeAttempt('step-2-user')

    const res = svcWithDefaultResolver.recordGateDecision({
      projectId,
      workflowId,
      graphRunId,
      nodeId: 'step-2-user',
      verdict: 'approved',
      rationale: 'Approved using default resolver',
    })
    expect(res.id).toBeDefined()
    expect(res.gateVerdict).toBe('approved')
  })

  it('fails closed when createDefaultTemplateResolver encounters an unresolvable template', () => {
    const unknownRunId = 'run-unknown-template'
    workflowStore.startGraphRun(
      {
        graphRunId: unknownRunId,
        workflowId,
        projectId,
        templateId: 'completely-unknown-template-xyz',
        startedAt: NOW,
      },
      'user',
    )
    workflowStore.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId: unknownRunId,
        nodeId: 'step-2-user',
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
        graphRunId: unknownRunId,
        nodeId: 'step-2-user',
        attempt: 1,
        status: 'blocked',
        occurredAt: NOW,
      },
      'system',
    )

    const svcWithDefaultResolver = new DecisionService({
      decisions: decisionStore,
      workflowStore,
      templateResolver: createDefaultTemplateResolver(),
    })

    expect(() =>
      svcWithDefaultResolver.recordGateDecision({
        projectId,
        workflowId,
        graphRunId: unknownRunId,
        nodeId: 'step-2-user',
        verdict: 'approved',
        rationale: 'Should fail closed',
      }),
    ).toThrow(/template "completely-unknown-template-xyz" could not be resolved/)
  })
})
