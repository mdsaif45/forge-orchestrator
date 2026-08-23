import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  changeSetIdSchema,
  projectIdSchema,
  repositoryIdSchema,
  shaSchema,
  stepIdSchema,
  taskIdSchema,
  type ChangeSet,
  type ProjectId,
} from '@shared/domain'
import { openDatabase, runMigrations } from '.'
import { ChangeSetStore } from './changeSetStore'
import type { ForgeDatabase } from './connection'
import { EventStore } from './eventStore'
import { MIGRATIONS } from './migrations.generated'
import { ProjectStore } from './projectStore'
import { rebuildProjections } from './projections'

describe('ChangeSetStore', () => {
  let db: ForgeDatabase
  let close: () => void
  let events: EventStore
  let changeSets: ChangeSetStore
  let projects: ProjectStore
  let projectId: ProjectId

  beforeEach(() => {
    const conn = openDatabase({ file: ':memory:' })
    db = conn.db
    close = conn.close
    runMigrations(db, MIGRATIONS)

    events = new EventStore(db)
    changeSets = new ChangeSetStore(db, events)
    projects = new ProjectStore(db, events)

    projectId = projectIdSchema.parse(randomUUID())
    projects.create(
      {
        id: projectId,
        name: 'ChangeSet Test Project',
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: '/repo/changesets',
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

  it('records and retrieves a ChangeSet with discrepancies', () => {
    const csId = changeSetIdSchema.parse(randomUUID())
    const changeSet: ChangeSet = {
      id: csId,
      baseSha: shaSchema.parse('a'.repeat(40)),
      headSha: shaSchema.parse('b'.repeat(40)),
      files: [
        {
          path: 'src/main.ts',
          changeType: 'modified',
          previousPath: null,
          insertions: 10,
          deletions: 2,
        },
      ],
      patch: '--- a/src/main.ts\n+++ b/src/main.ts\n@@ -1,2 +1,10 @@\n',
      authorActor: 'agent:implementer',
      stepId: stepIdSchema.parse(randomUUID()),
      taskId: taskIdSchema.parse(randomUUID()),
      correctsChangeSetId: null,
      reviewVerdict: null,
      discrepancies: [
        {
          kind: 'outside-scope',
          path: 'src/main.ts',
          detail: 'Modified file outside allowedPaths',
        },
      ],
      capturedAt: '2026-08-23T12:00:00.000Z',
    }

    const created = changeSets.record(
      changeSet,
      projectId,
      'agent:implementer',
      '2026-08-23T12:00:00.000Z',
    )
    expect(created.id).toBe(csId)
    expect(created.discrepancies).toHaveLength(1)

    const fetched = changeSets.find(csId)
    expect(fetched).toEqual(created)

    const list = changeSets.listForProject(projectId)
    expect(list).toHaveLength(1)
  })

  it('updates review verdict on changeset.reviewed', () => {
    const csId = changeSetIdSchema.parse(randomUUID())
    const changeSet: ChangeSet = {
      id: csId,
      baseSha: shaSchema.parse('a'.repeat(40)),
      headSha: null,
      files: [
        {
          path: 'src/auth.ts',
          changeType: 'added',
          previousPath: null,
          insertions: 20,
          deletions: 0,
        },
      ],
      patch: '--- /dev/null\n+++ b/src/auth.ts\n',
      authorActor: 'agent:implementer',
      stepId: stepIdSchema.parse(randomUUID()),
      taskId: taskIdSchema.parse(randomUUID()),
      correctsChangeSetId: null,
      reviewVerdict: null,
      discrepancies: [],
      capturedAt: '2026-08-23T12:00:00.000Z',
    }

    changeSets.record(changeSet, projectId, 'agent:implementer', '2026-08-23T12:00:00.000Z')

    changeSets.recordReview(
      {
        changeSetId: csId,
        verdict: 'pass',
        claimedVerdict: 'pass',
        overridden: false,
        reason: 'All checks passed',
        findings: [],
        reviewedBy: 'agent:reviewer',
      },
      projectId,
      'agent:reviewer',
      '2026-08-23T12:05:00.000Z',
    )

    const updated = changeSets.find(csId)
    expect(updated?.reviewVerdict).toBe('pass')
  })

  it('rebuilds changeset projections identically from event log alone', () => {
    const csId = changeSetIdSchema.parse(randomUUID())
    const changeSet: ChangeSet = {
      id: csId,
      baseSha: shaSchema.parse('a'.repeat(40)),
      headSha: null,
      files: [
        {
          path: 'README.md',
          changeType: 'modified',
          previousPath: null,
          insertions: 5,
          deletions: 1,
        },
      ],
      patch: '--- a/README.md\n+++ b/README.md\n',
      authorActor: 'user',
      stepId: stepIdSchema.parse(randomUUID()),
      taskId: taskIdSchema.parse(randomUUID()),
      correctsChangeSetId: null,
      reviewVerdict: 'pass',
      discrepancies: [],
      capturedAt: '2026-08-23T12:00:00.000Z',
    }

    changeSets.record(changeSet, projectId, 'user', '2026-08-23T12:00:00.000Z')

    const before = changeSets.listForProject(projectId)
    const allEvents = events.read(projectId)

    // Rebuild projections
    rebuildProjections(db, projectId, allEvents)

    const after = changeSets.listForProject(projectId)
    expect(after).toEqual(before)
  })
})
