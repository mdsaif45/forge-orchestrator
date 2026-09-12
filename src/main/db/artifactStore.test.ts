import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  artifactIdSchema,
  projectIdSchema,
  repositoryIdSchema,
  runIdSchema,
  stepIdSchema,
  taskIdSchema,
} from '@shared/domain'
import { MIGRATIONS, openDatabase, runMigrations, type ForgeDatabase } from './index'
import { ProjectStore } from './projectStore'
import { RunStore } from './runStore'
import { ArtifactStore } from './artifactStore'

describe('ArtifactStore', () => {
  let db: ForgeDatabase
  let close: () => void
  let artifactStore: ArtifactStore
  let runStore: RunStore
  let runId: ReturnType<typeof runIdSchema.parse>
  let stepId: ReturnType<typeof stepIdSchema.parse>

  const NOW = '2026-08-23T12:00:00.000Z'

  beforeEach(() => {
    const conn = openDatabase({ file: ':memory:' })
    db = conn.db
    close = conn.close
    runMigrations(db, MIGRATIONS)

    artifactStore = new ArtifactStore(db)
    runStore = new RunStore(db)

    const projects = new ProjectStore(db)
    const projectId = projectIdSchema.parse(randomUUID())
    projects.create(
      {
        id: projectId,
        name: 'Test Project',
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: 'D:/Projects/Test',
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

    runId = runIdSchema.parse(randomUUID())
    runStore.createRun({
      id: runId,
      projectId,
      taskId: taskIdSchema.parse(randomUUID()),
      type: 'direct-task',
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      exitCode: null,
      summary: null,
      error: null,
      metadata: {},
    })

    stepId = stepIdSchema.parse(randomUUID())
    runStore.createStep({
      id: stepId,
      runId,
      index: 0,
      role: 'implementer',
      runtimeId: null,
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      summary: null,
      changeSetId: null,
      evidenceId: null,
    })
  })

  afterEach(() => {
    close()
  })

  it('records, retrieves, and lists artifact metadata', () => {
    const artifactId = artifactIdSchema.parse(randomUUID())
    const metadata = artifactStore.record({
      id: artifactId,
      runId,
      stepId,
      kind: 'stdout',
      name: 'build.log',
      mimeType: 'text/plain',
      sizeBytes: 2048,
      sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
      relativePath: `artifacts/${runId}/${artifactId}-build.log`,
      createdAt: NOW,
    })

    expect(metadata.id).toBe(artifactId)

    const fetched = artifactStore.get(artifactId)
    expect(fetched).not.toBeNull()
    expect(fetched?.name).toBe('build.log')
    expect(fetched?.sizeBytes).toBe(2048)

    const runList = artifactStore.listForRun(runId)
    expect(runList.length).toBe(1)
    expect(runList[0]?.id).toBe(artifactId)

    const stepList = artifactStore.listForStep(stepId)
    expect(stepList.length).toBe(1)
    expect(stepList[0]?.id).toBe(artifactId)
  })
})
