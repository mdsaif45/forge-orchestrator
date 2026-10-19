import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decisionIdSchema,
  projectIdSchema,
  repositoryIdSchema,
  taskIdSchema,
  workflowIdSchema,
  type Decision,
  type ProjectId,
  type WorkflowId,
} from '@shared/domain'
import { openDatabase, runMigrations } from '.'
import type { ForgeDatabase } from './connection'
import { DecisionConflictError, DecisionStore } from './decisionStore'
import { EventStore } from './eventStore'
import { MIGRATIONS } from './migrations.generated'
import { ProjectStore } from './projectStore'
import { applyEvent, rebuildProjections } from './projections'
import { WorkflowStore } from './workflowStore'

describe('DecisionStore', () => {
  let db: ForgeDatabase
  let close: () => void
  let events: EventStore
  let decisions: DecisionStore
  let projects: ProjectStore
  let projectId: ProjectId

  beforeEach(() => {
    const conn = openDatabase({ file: ':memory:' })
    db = conn.db
    close = conn.close
    runMigrations(db, MIGRATIONS)

    events = new EventStore(db)
    decisions = new DecisionStore(db, events)
    projects = new ProjectStore(db)

    projectId = projectIdSchema.parse(randomUUID())
    projects.create(
      {
        id: projectId,
        name: 'Decision Test Project',
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: '/repo/decisions',
          defaultBranch: 'main',
          buildCommand: null,
          testCommand: null,
          tech: [],
        },
        createdAt: '2026-08-23T12:00:00.000Z',
        updatedAt: '2026-08-23T12:00:00.000Z',
      },
      'user',
    )
  })

  afterEach(() => {
    close()
  })

  it('proposes a decision and retrieves it', () => {
    const dId = decisionIdSchema.parse(randomUUID())
    const decision: Decision = {
      id: dId,
      statement: 'Use PostgreSQL for persistent storage',
      rationale: 'Supports required ACID transactions and jsonb queries',
      status: 'proposed',
      proposedBy: 'agent:planner',
      proposedAt: '2026-08-23T12:00:00.000Z',
      lockedAt: null,
      lockedBy: null,
      supersededBy: null,
      originQuestionId: null,
    }

    const created = decisions.propose(
      decision,
      projectId,
      'agent:planner',
      '2026-08-23T12:00:00.000Z',
    )
    expect(created.id).toBe(dId)
    expect(created.status).toBe('proposed')

    const fetched = decisions.find(dId)
    expect(fetched).toEqual(created)

    const list = decisions.listForProject(projectId)
    expect(list).toHaveLength(1)
  })

  it('approves and locks a decision as user (Axiom A4)', () => {
    const dId = decisionIdSchema.parse(randomUUID())
    const decision: Decision = {
      id: dId,
      statement: 'Use JWT for authorization tokens',
      rationale: 'Stateless verification across services',
      status: 'proposed',
      proposedBy: 'agent:implementer',
      proposedAt: '2026-08-23T12:00:00.000Z',
      lockedAt: null,
      lockedBy: null,
      supersededBy: null,
      originQuestionId: null,
    }

    decisions.propose(decision, projectId, 'agent:implementer', '2026-08-23T12:00:00.000Z')
    const approved = decisions.approve(dId, 'user', '2026-08-23T12:01:00.000Z')
    expect(approved.status).toBe('approved')

    const locked = decisions.lock(dId, 'user', '2026-08-23T12:02:00.000Z')
    expect(locked.status).toBe('locked')
    expect(locked.lockedBy).toBe('user')
    expect(locked.lockedAt).toBe('2026-08-23T12:02:00.000Z')

    const lockedList = decisions.listLocked(projectId)
    expect(lockedList).toHaveLength(1)
  })

  it('supersedes a decision with a replacement (user only)', () => {
    const d1 = decisionIdSchema.parse(randomUUID())
    const d2 = decisionIdSchema.parse(randomUUID())

    const orig: Decision = {
      id: d1,
      statement: 'Use Redis for session cache',
      rationale: 'In-memory performance',
      status: 'locked',
      proposedBy: 'user',
      proposedAt: '2026-08-23T12:00:00.000Z',
      lockedAt: '2026-08-23T12:00:00.000Z',
      lockedBy: 'user',
      supersededBy: null,
      originQuestionId: null,
    }

    decisions.propose(orig, projectId, 'user', '2026-08-23T12:00:00.000Z')

    const replacement: Decision = {
      id: d2,
      statement: 'Use Memcached for session cache',
      rationale: 'Simpler protocol and lower memory overhead',
      status: 'locked',
      proposedBy: 'user',
      proposedAt: '2026-08-23T12:10:00.000Z',
      lockedAt: '2026-08-23T12:10:00.000Z',
      lockedBy: 'user',
      supersededBy: null,
      originQuestionId: null,
    }

    const { superseded, replacement: newDec } = decisions.supersede(
      d1,
      replacement,
      'user',
      '2026-08-23T12:10:00.000Z',
    )

    expect(superseded.status).toBe('superseded')
    expect(superseded.supersededBy).toBe(d2)
    expect(newDec.status).toBe('locked')
  })

  it('rebuilds decision projections identically from event log alone', () => {
    const d1 = decisionIdSchema.parse(randomUUID())
    const decision: Decision = {
      id: d1,
      statement: 'Strict null checks enabled',
      rationale: 'Prevents null runtime errors',
      status: 'locked',
      proposedBy: 'user',
      proposedAt: '2026-08-23T12:00:00.000Z',
      lockedAt: '2026-08-23T12:00:00.000Z',
      lockedBy: 'user',
      supersededBy: null,
      originQuestionId: null,
    }

    decisions.propose(decision, projectId, 'user', '2026-08-23T12:00:00.000Z')

    const before = decisions.listForProject(projectId)
    const allEvents = events.read(projectId)

    // Rebuild projections
    rebuildProjections(db, projectId, allEvents)

    const after = decisions.listForProject(projectId)
    expect(after).toEqual(before)
  })

  describe('Gate Decisions (Slice 5B-1C)', () => {
    function setupWorkflowAndGraphRun(
      database: ForgeDatabase,
      wId: WorkflowId,
      gRunId: string,
    ): void {
      const tId = taskIdSchema.parse(randomUUID())
      const wfStore = new WorkflowStore(database)
      const evStore = new EventStore(database)
      const taskEvent = evStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: tId,
              objective: 'Test objective',
              constraints: [],
              completionCriteria: [{ kind: 'tests', description: 'test suite passes', params: {} }],
              scope: { allowedPaths: [], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: '2026-08-23T12:00:00.000Z',
            },
          },
        },
        { projectId, actor: 'user', occurredAt: '2026-08-23T12:00:00.000Z' },
      )
      applyEvent(database, taskEvent)
      wfStore.start(
        {
          workflowId: wId,
          projectId,
          taskId: tId,
          templateId: 'feature',
          startedAt: '2026-08-23T12:00:00.000Z',
        },
        'user',
      )
      wfStore.startGraphRun(
        {
          graphRunId: gRunId,
          workflowId: wId,
          projectId,
          templateId: 'compiled-feature',
          startedAt: '2026-08-23T12:00:00.000Z',
        },
        'user',
      )
    }

    it('records and authoritatively retrieves a locked gate decision', () => {
      const workflowId = workflowIdSchema.parse(randomUUID())
      const graphRunId = 'run-gate-1'
      const nodeId = 'step-2-gate'
      setupWorkflowAndGraphRun(db, workflowId, graphRunId)

      const recorded = decisions.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Human approved implementation plan after reviewing diff',
        actor: 'user',
        occurredAt: '2026-08-23T12:05:00.000Z',
      })

      expect(recorded.status).toBe('locked')
      expect(recorded.gateVerdict).toBe('approved')
      expect(recorded.graphRunId).toBe(graphRunId)
      expect(recorded.nodeId).toBe(nodeId)
      expect(recorded.workflowId).toBe(workflowId)
      expect(recorded.lockedBy).toBe('user')

      const found = decisions.findGateDecision(graphRunId, nodeId)
      expect(found).not.toBeNull()
      expect(found).toEqual(recorded)
    })

    it('returns null when no gate decision exists for scope', () => {
      const found = decisions.findGateDecision('non-existent-run', 'step-2-gate')
      expect(found).toBeNull()
    })

    it('isolates decisions across different graphRunIds and nodeIds (prevents cross-run bleed)', () => {
      const workflowId = workflowIdSchema.parse(randomUUID())
      const graphRunId1 = 'run-gate-iso-1'
      const graphRunId2 = 'run-gate-iso-2'
      setupWorkflowAndGraphRun(db, workflowId, graphRunId1)
      setupWorkflowAndGraphRun(db, workflowId, graphRunId2)

      decisions.recordGateDecision({
        projectId,
        workflowId,
        graphRunId: graphRunId1,
        nodeId: 'step-2-gate',
        verdict: 'approved',
        rationale: 'Approved for run 1 only',
        actor: 'user',
        occurredAt: '2026-08-23T12:05:00.000Z',
      })

      // Run 2's gate must remain null (not authorized by Run 1)
      expect(decisions.findGateDecision(graphRunId2, 'step-2-gate')).toBeNull()
      // Different node in Run 1 must remain null
      expect(decisions.findGateDecision(graphRunId1, 'step-7-final-gate')).toBeNull()
      // Exact match resolves
      expect(decisions.findGateDecision(graphRunId1, 'step-2-gate')).not.toBeNull()
    })

    it('rejects authorization when decision has mismatched project/workflow scope against execution context or authoritative graph run', () => {
      const workflowId = workflowIdSchema.parse(randomUUID())
      const graphRunId = 'run-gate-scope-check'
      const nodeId = 'step-2-gate'
      setupWorkflowAndGraphRun(db, workflowId, graphRunId)

      decisions.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Approved for exact scope',
        actor: 'user',
        occurredAt: '2026-08-23T12:05:00.000Z',
      })

      // Correct scope resolves
      expect(
        decisions.findGateDecision(graphRunId, nodeId, { projectId, workflowId }),
      ).not.toBeNull()

      // Mismatched projectId in execution context returns null (cannot authorize gate)
      const wrongProjectId = projectIdSchema.parse(randomUUID())
      expect(
        decisions.findGateDecision(graphRunId, nodeId, { projectId: wrongProjectId, workflowId }),
      ).toBeNull()

      // Mismatched workflowId in execution context returns null (cannot authorize gate)
      const wrongWorkflowId = workflowIdSchema.parse(randomUUID())
      expect(
        decisions.findGateDecision(graphRunId, nodeId, { projectId, workflowId: wrongWorkflowId }),
      ).toBeNull()
    })

    it('isolates legacy project decisions with null graphRunId from satisfying gates', () => {
      const d1 = decisionIdSchema.parse(randomUUID())
      const legacyDecision: Decision = {
        id: d1,
        statement: 'Project-wide architectural decision',
        rationale: 'Global architecture rule',
        status: 'locked',
        proposedBy: 'user',
        proposedAt: '2026-08-23T12:00:00.000Z',
        lockedAt: '2026-08-23T12:00:00.000Z',
        lockedBy: 'user',
        supersededBy: null,
        originQuestionId: null,
      }
      decisions.propose(legacyDecision, projectId, 'user', '2026-08-23T12:00:00.000Z')

      expect(decisions.listLocked(projectId)).toHaveLength(1)
      expect(decisions.findGateDecision('any-run-id', 'step-2-gate')).toBeNull()
    })

    it('handles duplicate submission with identical verdict idempotently', () => {
      const workflowId = workflowIdSchema.parse(randomUUID())
      const graphRunId = 'run-gate-idem'
      const nodeId = 'step-2-gate'
      setupWorkflowAndGraphRun(db, workflowId, graphRunId)

      const first = decisions.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Approved first time',
        actor: 'user',
        occurredAt: '2026-08-23T12:05:00.000Z',
      })

      const second = decisions.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Approved second time (duplicate)',
        actor: 'user',
        occurredAt: '2026-08-23T12:06:00.000Z',
      })

      expect(second.id).toBe(first.id)
      expect(second.gateVerdict).toBe('approved')
    })

    it('throws DecisionConflictError on contradictory verdict without supersession', () => {
      const workflowId = workflowIdSchema.parse(randomUUID())
      const graphRunId = 'run-gate-conflict'
      const nodeId = 'step-2-gate'
      setupWorkflowAndGraphRun(db, workflowId, graphRunId)

      decisions.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Approved initially',
        actor: 'user',
        occurredAt: '2026-08-23T12:05:00.000Z',
      })

      expect(() =>
        decisions.recordGateDecision({
          projectId,
          workflowId,
          graphRunId,
          nodeId,
          verdict: 'rejected',
          rationale: 'Changed mind without superseding',
          actor: 'user',
          occurredAt: '2026-08-23T12:06:00.000Z',
        }),
      ).toThrow(DecisionConflictError)
    })

    it('rejects non-user actor attempting to record gate decision (Axiom A4)', () => {
      const workflowId = workflowIdSchema.parse(randomUUID())
      const graphRunId = 'run-gate-actor'
      const nodeId = 'step-2-gate'
      setupWorkflowAndGraphRun(db, workflowId, graphRunId)

      expect(() =>
        decisions.recordGateDecision({
          projectId,
          workflowId,
          graphRunId,
          nodeId,
          verdict: 'approved',
          rationale: 'Agent claiming approval',
          actor: 'agent:infiltrator',
          occurredAt: '2026-08-23T12:05:00.000Z',
        }),
      ).toThrow(/Axiom A4 violation/)
    })

    it('supersedes a gate decision and updates authoritative lookup to replacement', () => {
      const workflowId = workflowIdSchema.parse(randomUUID())
      const graphRunId = 'run-gate-supersede'
      const nodeId = 'step-2-gate'
      setupWorkflowAndGraphRun(db, workflowId, graphRunId)

      const initial = decisions.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId,
        verdict: 'rejected',
        rationale: 'Initial rejection',
        actor: 'user',
        occurredAt: '2026-08-23T12:05:00.000Z',
      })

      const { superseded, replacement } = decisions.supersedeGateDecision(
        initial.id,
        {
          projectId,
          workflowId,
          graphRunId,
          nodeId,
          verdict: 'approved',
          rationale: 'Clarification received, approving plan',
        },
        'user',
        '2026-08-23T12:10:00.000Z',
      )

      expect(superseded.status).toBe('superseded')
      expect(superseded.supersededBy).toBe(replacement.id)
      expect(replacement.status).toBe('locked')
      expect(replacement.gateVerdict).toBe('approved')

      const active = decisions.findGateDecision(graphRunId, nodeId)
      expect(active?.id).toBe(replacement.id)
      expect(active?.gateVerdict).toBe('approved')
    })

    it('rebuilds gate decisions identically from event log alone', () => {
      const workflowId = workflowIdSchema.parse(randomUUID())
      const graphRunId = 'run-gate-rebuild'
      const nodeId = 'step-2-gate'
      setupWorkflowAndGraphRun(db, workflowId, graphRunId)

      const created = decisions.recordGateDecision({
        projectId,
        workflowId,
        graphRunId,
        nodeId,
        verdict: 'approved',
        rationale: 'Approval before rebuild',
        actor: 'user',
        occurredAt: '2026-08-23T12:05:00.000Z',
      })

      const before = decisions.findGateDecision(graphRunId, nodeId)
      const allEvents = events.read(projectId)

      rebuildProjections(db, projectId, allEvents)

      const after = decisions.findGateDecision(graphRunId, nodeId)
      expect(after).toEqual(before)
      expect(after?.id).toBe(created.id)
      expect(after?.gateVerdict).toBe('approved')
    })
  })
})
