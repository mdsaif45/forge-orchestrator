import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  decisionIdSchema,
  projectIdSchema,
  repositoryIdSchema,
  type Decision,
  type ProjectId,
} from '@shared/domain'
import { openDatabase, runMigrations } from '.'
import type { ForgeDatabase } from './connection'
import { DecisionStore } from './decisionStore'
import { EventStore } from './eventStore'
import { MIGRATIONS } from './migrations.generated'
import { ProjectStore } from './projectStore'
import { rebuildProjections } from './projections'

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
    projects = new ProjectStore(db, events)

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
      },
      'user',
      '2026-08-23T12:00:00.000Z',
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
})
