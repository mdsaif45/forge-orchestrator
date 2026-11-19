import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  projectIdSchema,
  repositoryIdSchema,
  runIdSchema,
  taskIdSchema,
  type Actor,
  type Project,
} from '@shared/domain'
import { createForgeCore, type ForgeCore } from '../core/forgeCore'
import { ProjectStore } from './projectStore'
import { inspectProjectRegistry, pruneMissingProjects } from './projectRegistry'

const ACTOR: Actor = 'user'

describe('Multi-Project Workspace Registry & Run Indexer (STATE-005)', () => {
  let tempDir: string
  let core: ForgeCore
  let projectStore: ProjectStore
  let activeRepoDir: string
  let missingRepoDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'project-registry-test-'))
    activeRepoDir = join(tempDir, 'active-repo')
    missingRepoDir = join(tempDir, 'missing-repo')

    execFileSync('git', ['init', activeRepoDir], { encoding: 'utf8' })
    core = createForgeCore({ dataDir: join(tempDir, 'data') })
    projectStore = new ProjectStore(core.db)
  })

  afterEach(async () => {
    await core.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('inspects projects across disk and correlates run metrics', async () => {
    const proj1Id = projectIdSchema.parse(randomUUID())
    const proj2Id = projectIdSchema.parse(randomUUID())

    const proj1: Project = {
      id: proj1Id,
      name: 'Active Service',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      repository: {
        id: repositoryIdSchema.parse(randomUUID()),
        absolutePath: activeRepoDir,
        defaultBranch: 'main',
        buildCommand: null,
        testCommand: null,
        tech: ['ts'],
      },
    }

    const proj2: Project = {
      id: proj2Id,
      name: 'Deleted Project',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      repository: {
        id: repositoryIdSchema.parse(randomUUID()),
        absolutePath: missingRepoDir, // does not exist on disk
        defaultBranch: 'main',
        buildCommand: null,
        testCommand: null,
        tech: ['ts'],
      },
    }

    projectStore.create(proj1, ACTOR)
    projectStore.create(proj2, ACTOR)

    // Add a run for project 1
    const runId = runIdSchema.parse(randomUUID())
    const taskId = taskIdSchema.parse(randomUUID())
    core.runs.createRun({
      id: runId,
      projectId: proj1Id,
      taskId,
      type: 'direct-task',
      status: 'completed',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: 'Task done',
      error: null,
      metadata: {},
    })

    const report = await inspectProjectRegistry(projectStore, core.runs)
    expect(report.valid).toBe(true)
    expect(report.totalProjects).toBe(2)
    expect(report.activeProjects).toBe(1)
    expect(report.missingProjects).toBe(1)

    const activeSummary = report.projects.find((p) => p.id === proj1Id)
    expect(activeSummary?.existsOnDisk).toBe(true)
    expect(activeSummary?.totalRuns).toBe(1)
    expect(activeSummary?.lastRunStatus).toBe('completed')

    const missingSummary = report.projects.find((p) => p.id === proj2Id)
    expect(missingSummary?.existsOnDisk).toBe(false)
    expect(missingSummary?.totalRuns).toBe(0)
  })

  it('prunes missing projects while preserving active ones', async () => {
    const proj1Id = projectIdSchema.parse(randomUUID())
    const proj2Id = projectIdSchema.parse(randomUUID())

    projectStore.create(
      {
        id: proj1Id,
        name: 'Keep Me',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: activeRepoDir,
          defaultBranch: 'main',
          buildCommand: null,
          testCommand: null,
          tech: ['ts'],
        },
      },
      ACTOR,
    )

    projectStore.create(
      {
        id: proj2Id,
        name: 'Missing Project',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: missingRepoDir,
          defaultBranch: 'main',
          buildCommand: null,
          testCommand: null,
          tech: ['ts'],
        },
      },
      ACTOR,
    )

    const pruneRes = await pruneMissingProjects(projectStore, core.runs)
    expect(pruneRes.valid).toBe(true)
    expect(pruneRes.prunedCount).toBe(1)
    expect(pruneRes.prunedProjectIds).toEqual([proj2Id])

    const after = await inspectProjectRegistry(projectStore, core.runs)
    expect(after.totalProjects).toBe(1)
    expect(after.projects[0]?.id).toBe(proj1Id)
  })
})
