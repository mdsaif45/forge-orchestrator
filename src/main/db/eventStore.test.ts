import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import { EVENT_TYPES, type Project, type ProjectId, type Rule, type RuleId } from '@shared/domain'
import { openDatabase, runMigrations } from '.'
import { EventStore } from './eventStore'
import { MIGRATIONS } from './migrations.generated'
import { applyEvent } from './projections'
import { ProjectStore } from './projectStore'
import { events, projects, repositories, rules } from './schema'

const NOW = '2026-08-18T12:00:00.000Z'
const LATER = '2026-08-19T12:00:00.000Z'
const PROJECT_A = '550e8400-e29b-41d4-a716-446655440000' as ProjectId
const PROJECT_B = '7c9e6679-7425-40de-944b-e07fc1f90ae7' as ProjectId
const REPO_ID_A = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'
const REPO_ID_B = '9d2c1a6e-4f5b-4e3a-9c7d-1a2b3c4d5e6f'
const RULE_ID = '3f333df6-90a4-4fda-8dd3-9485d27cee36' as RuleId

// Each project needs its own repository id: `repositories.id` is the primary
// key, so two projects sharing one would make the second project's
// `repository.bound` event silently reparent the first project's row.
function sampleProject(id: ProjectId = PROJECT_A, name = 'InTime'): Project {
  return {
    id,
    name,
    repository: {
      id: (id === PROJECT_A ? REPO_ID_A : REPO_ID_B) as Project['repository']['id'],
      absolutePath: 'D:/Projects/InTime',
      defaultBranch: 'develop',
      buildCommand: 'dotnet build',
      testCommand: 'dotnet test',
      tech: ['.NET 9', 'React'],
    },
    createdAt: NOW,
    updatedAt: NOW,
  }
}

function sampleRule(): Rule {
  return {
    id: RULE_ID,
    scope: 'project',
    key: 'migrations',
    statement: 'Do not modify migrations without approval',
    source: 'project settings',
    createdAt: NOW,
  }
}

describe('EventStore', () => {
  let database: ReturnType<typeof openDatabase>
  let store: EventStore
  let projectStore: ProjectStore

  beforeEach(() => {
    database = openDatabase({ file: ':memory:' })
    runMigrations(database.db, MIGRATIONS)
    store = new EventStore(database.db)
    projectStore = new ProjectStore(database.db)
    // A project row must exist before events can reference it.
    projectStore.create(sampleProject(), 'user')
  })

  afterEach(() => {
    database.close()
  })

  it('assigns consecutive sequence numbers', () => {
    // Two events came from create(); the next must continue from there.
    const event = store.append(
      { type: 'project.updated', payload: { name: 'Renamed', updatedAt: LATER } },
      { projectId: PROJECT_A, actor: 'user', occurredAt: LATER },
    )

    expect(event.seq).toBe(3)
    expect(store.latestSeq(PROJECT_A)).toBe(3)
  })

  it('numbers each project independently', () => {
    projectStore.create(sampleProject(PROJECT_B, 'SFS'), 'user')

    // Per-project sequences mean one project's activity cannot advance another's,
    // which keeps a replay of one project self-contained.
    expect(store.latestSeq(PROJECT_A)).toBe(2)
    expect(store.latestSeq(PROJECT_B)).toBe(2)
  })

  it('appends several events atomically with consecutive numbers', () => {
    const appended = store.appendMany(
      [
        { type: 'project.updated', payload: { name: 'One', updatedAt: LATER } },
        { type: 'project.updated', payload: { name: 'Two', updatedAt: LATER } },
      ],
      { projectId: PROJECT_A, actor: 'user', occurredAt: LATER },
    )

    expect(appended.map((event) => event.seq)).toEqual([3, 4])
  })

  it('writes nothing when one event in a batch is invalid', () => {
    const before = store.latestSeq(PROJECT_A)

    expect(() =>
      store.appendMany(
        [
          { type: 'project.updated', payload: { name: 'Valid', updatedAt: LATER } },
          // Invalid: an empty name. The batch must not half-apply.
          { type: 'project.updated', payload: { name: '', updatedAt: LATER } },
        ],
        { projectId: PROJECT_A, actor: 'user', occurredAt: LATER },
      ),
    ).toThrow(/project.updated/)

    expect(store.latestSeq(PROJECT_A)).toBe(before)
  })

  it('rejects a payload that does not match its event type', () => {
    expect(() =>
      store.append(
        // @ts-expect-error deliberately wrong payload for this type
        { type: 'project.updated', payload: { unexpected: true } },
        { projectId: PROJECT_A, actor: 'user', occurredAt: LATER },
      ),
    ).toThrow(/Invalid payload for project.updated/)
  })

  it('records the actor, including a specific agent', () => {
    const event = store.append(
      { type: 'project.updated', payload: { name: 'By agent', updatedAt: LATER } },
      { projectId: PROJECT_A, actor: 'agent:implementer-1', occurredAt: LATER },
    )

    expect(event.actor).toBe('agent:implementer-1')
  })

  it('records an optional reason', () => {
    const event = store.append(
      { type: 'project.updated', payload: { name: 'Fixed', updatedAt: LATER } },
      {
        projectId: PROJECT_A,
        actor: 'user',
        occurredAt: LATER,
        reason: 'corrected a typo in the project name',
      },
    )

    expect(event.reason).toBe('corrected a typo in the project name')
  })

  it('reads events in sequence order', () => {
    const read = store.read(PROJECT_A)

    expect(read.map((event) => event.type)).toEqual(['project.created', 'repository.bound'])
    expect(read.map((event) => event.seq)).toEqual([1, 2])
  })

  it('reads only events after a given sequence number', () => {
    const since = store.readSince(PROJECT_A, 1)

    expect(since.map((event) => event.seq)).toEqual([2])
  })

  it('lists projects that have events', () => {
    projectStore.create(sampleProject(PROJECT_B, 'SFS'), 'user')

    expect([...store.projectIds()].sort()).toEqual([PROJECT_A, PROJECT_B].sort())
  })

  it('rejects a duplicate sequence number at the storage layer', () => {
    // The (project_id, seq) primary key is the backstop if application logic ever
    // computes a colliding value.
    expect(() =>
      database.db
        .insert(events)
        .values({
          projectId: PROJECT_A,
          seq: 1,
          id: 'd1e2f3a4-b5c6-4d7e-8f90-123456789abc',
          type: 'project.updated',
          payload: '{}',
          actor: 'user',
          reason: null,
          occurredAt: LATER,
        })
        .run(),
    ).toThrow(/UNIQUE|PRIMARY/i)
  })

  it('fails loudly on a stored payload that no longer validates', () => {
    database.db.run(sql`UPDATE events SET payload = '{"name":""}' WHERE seq = 1`)

    expect(() => store.read(PROJECT_A)).toThrow(/Invalid payload/)
  })

  it('fails loudly on a stored payload that is not JSON', () => {
    database.db.run(sql`UPDATE events SET payload = 'not json' WHERE seq = 1`)

    expect(() => store.read(PROJECT_A)).toThrow(/not valid JSON/)
  })
})

describe('payload coverage', () => {
  it('has a payload schema for every declared event type', async () => {
    const { EVENT_PAYLOADS } = await import('@shared/domain')

    // The compile-time guard in eventPayloads.ts enforces this too; this asserts it
    // at runtime so a future refactor cannot quietly weaken the type-level check.
    expect(Object.keys(EVENT_PAYLOADS).sort()).toEqual([...EVENT_TYPES].sort())
  })
})

describe('projections', () => {
  let database: ReturnType<typeof openDatabase>
  let store: ProjectStore

  beforeEach(() => {
    database = openDatabase({ file: ':memory:' })
    runMigrations(database.db, MIGRATIONS)
    store = new ProjectStore(database.db)
  })

  afterEach(() => {
    database.close()
  })

  it('projects a created project into the read model', () => {
    store.create(sampleProject(), 'user')

    expect(store.findById(PROJECT_A)).toEqual(sampleProject())
  })

  it('projects a rename', () => {
    store.create(sampleProject(), 'user')
    store.rename(PROJECT_A, 'Renamed', 'user', LATER)

    const loaded = store.findById(PROJECT_A)

    expect(loaded?.name).toBe('Renamed')
    expect(loaded?.updatedAt).toBe(LATER)
  })

  it('projects a rule and its removal', () => {
    store.create(sampleProject(), 'user')
    store.setRule(PROJECT_A, sampleRule(), 'user')

    expect(database.db.select().from(rules).all()).toHaveLength(1)

    store.removeRule(PROJECT_A, RULE_ID, 'user', LATER)

    expect(database.db.select().from(rules).all()).toHaveLength(0)
  })

  it('throws on an event type it does not know how to project', () => {
    // A silently skipped event would mean a projection that disagrees with the log.
    expect(() => {
      applyEvent(database.db, {
        id: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee' as never,
        projectId: PROJECT_A,
        seq: 99,
        type: 'not.a.real.type' as never,
        payload: {},
        actor: 'user',
        reason: null,
        occurredAt: NOW,
      })
    }).toThrow(/No projection for event type/)
  })

  it('is idempotent, so replaying an event twice is harmless', () => {
    store.create(sampleProject(), 'user')
    const before = store.findById(PROJECT_A)

    // Resume after a crash may re-apply the last event; that must not double up.
    store.rebuild(PROJECT_A)
    store.rebuild(PROJECT_A)

    expect(store.findById(PROJECT_A)).toEqual(before)
  })
})

describe('replay', () => {
  let database: ReturnType<typeof openDatabase>
  let store: ProjectStore

  beforeEach(() => {
    database = openDatabase({ file: ':memory:' })
    runMigrations(database.db, MIGRATIONS)
    store = new ProjectStore(database.db)
  })

  afterEach(() => {
    database.close()
  })

  /** Every projected row, ordered, so two states can be compared exactly. */
  function snapshot(): string {
    return JSON.stringify({
      projects: database.db.select().from(projects).orderBy(projects.id).all(),
      repositories: database.db.select().from(repositories).orderBy(repositories.id).all(),
      rules: database.db.select().from(rules).orderBy(rules.id).all(),
    })
  }

  it('reproduces the read models exactly from the events alone', () => {
    // A representative history: create, rename, add a rule, remove it, rename again.
    store.create(sampleProject(), 'user')
    store.rename(PROJECT_A, 'InTime v2', 'user', LATER)
    store.setRule(PROJECT_A, sampleRule(), 'agent:planner-1', 'proposed during planning')
    store.rename(PROJECT_A, 'InTime v3', 'user', LATER)

    const incremental = snapshot()

    // Drop the read models and rebuild from the log.
    store.rebuild(PROJECT_A)

    expect(snapshot()).toBe(incremental)
  })

  it('reproduces the read models after a removal, not just additions', () => {
    store.create(sampleProject(), 'user')
    store.setRule(PROJECT_A, sampleRule(), 'user')
    store.removeRule(PROJECT_A, RULE_ID, 'user', LATER)

    const incremental = snapshot()
    store.rebuild(PROJECT_A)

    expect(snapshot()).toBe(incremental)
  })

  it('rebuilds every project at once', () => {
    store.create(sampleProject(PROJECT_A, 'InTime'), 'user')
    store.create(sampleProject(PROJECT_B, 'SFS'), 'user')

    const incremental = snapshot()
    store.rebuildAll()

    expect(snapshot()).toBe(incremental)
  })

  it('rebuilds correctly even if the read model was corrupted', () => {
    store.create(sampleProject(), 'user')
    store.rename(PROJECT_A, 'Correct', 'user', LATER)

    const expected = snapshot()

    // Simulates a projection bug or a hand edit: the log is still right.
    database.db.run(sql`UPDATE projects SET name = 'Corrupted'`)
    expect(snapshot()).not.toBe(expected)

    store.rebuild(PROJECT_A)

    expect(snapshot()).toBe(expected)
  })

  it('leaves other projects untouched when rebuilding one', () => {
    store.create(sampleProject(PROJECT_A, 'InTime'), 'user')
    store.create(sampleProject(PROJECT_B, 'SFS'), 'user')

    const expected = snapshot()
    store.rebuild(PROJECT_A)

    expect(snapshot()).toBe(expected)
    expect(store.findById(PROJECT_B)?.name).toBe('SFS')
  })
})
