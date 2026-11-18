import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectIdSchema, repositoryIdSchema, type ProjectId } from '@shared/domain'
import { AgentInstanceStore } from './agentInstanceStore'
import { EventStore } from './eventStore'
import { initialiseDatabase, type ForgeDatabase } from './index'
import { ProjectStore } from './projectStore'

describe('AgentInstanceStore', () => {
  let db: ForgeDatabase
  let close: () => void
  let events: EventStore
  let agentInstances: AgentInstanceStore
  let projectId: ProjectId

  beforeEach(() => {
    const handle = initialiseDatabase(':memory:')
    db = handle.db
    close = handle.close

    events = new EventStore(db)
    agentInstances = new AgentInstanceStore(db, events)

    const projects = new ProjectStore(db)
    projectId = projectIdSchema.parse(randomUUID())
    projects.create(
      {
        id: projectId,
        name: 'Agent Test Project',
        createdAt: '2026-08-24T00:00:00.000Z',
        updatedAt: '2026-08-24T00:00:00.000Z',
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: 'D:/Projects/Test',
          defaultBranch: 'main',
          buildCommand: null,
          testCommand: null,
          tech: ['typescript'],
        },
      },
      'user',
    )
  })

  afterEach(() => {
    close()
  })

  it('creates an agent instance with generated name and retrieves it', () => {
    const created = agentInstances.create(
      {
        projectId,
        provider: 'claude',
        role: 'planner',
      },
      'user',
      '2026-08-24T00:00:00.000Z',
    )

    expect(created.id).toBeDefined()
    expect(created.name).toMatch(/^[A-Z][a-z]+[A-Z][a-z]+/)
    expect(created.label).toBe(created.name)
    expect(created.provider).toBe('claude')
    expect(created.role).toBe('planner')

    const found = agentInstances.find(created.id)
    expect(found).toEqual(created)

    const list = agentInstances.list(projectId)
    expect(list).toHaveLength(1)
    expect(list[0]).toEqual(created)
  })

  it('generates unique names for multiple agents in the same project', () => {
    const a1 = agentInstances.create(
      { projectId, provider: 'claude', role: 'planner' },
      'user',
      '2026-08-24T00:00:00.000Z',
    )
    const a2 = agentInstances.create(
      { projectId, provider: 'claude', role: 'implementer' },
      'user',
      '2026-08-24T00:00:00.000Z',
    )
    const a3 = agentInstances.create(
      { projectId, provider: 'claude', role: 'reviewer' },
      'user',
      '2026-08-24T00:00:00.000Z',
    )

    expect(a1.id).not.toBe(a2.id)
    expect(a2.id).not.toBe(a3.id)
    expect(a1.name).not.toBe(a2.name)
    expect(a2.name).not.toBe(a3.name)
    expect(a1.name).not.toBe(a3.name)

    const list = agentInstances.list(projectId)
    expect(list).toHaveLength(3)
  })

  it('updates the editable label without altering name or uuid', () => {
    const created = agentInstances.create(
      {
        projectId,
        provider: 'claude',
        label: 'Initial Label',
        role: 'implementer',
      },
      'user',
      '2026-08-24T00:00:00.000Z',
    )

    const updated = agentInstances.updateLabel(
      created.id,
      'Senior Lead Implementer',
      'user',
      '2026-08-24T01:00:00.000Z',
    )

    expect(updated.id).toBe(created.id)
    expect(updated.name).toBe(created.name)
    expect(updated.label).toBe('Senior Lead Implementer')
    expect(updated.updatedAt).toBe('2026-08-24T01:00:00.000Z')

    const found = agentInstances.find(created.id)
    expect(found?.label).toBe('Senior Lead Implementer')
  })

  it('removes an agent instance', () => {
    const created = agentInstances.create(
      {
        projectId,
        provider: 'antigravity',
        role: 'reviewer',
      },
      'user',
      '2026-08-24T00:00:00.000Z',
    )

    expect(agentInstances.list(projectId)).toHaveLength(1)

    agentInstances.remove(created.id, 'user', '2026-08-24T02:00:00.000Z')
    expect(agentInstances.find(created.id)).toBeNull()
    expect(agentInstances.list(projectId)).toHaveLength(0)
  })
})
