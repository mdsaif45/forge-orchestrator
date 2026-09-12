import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import {
  projectIdSchema,
  repositoryIdSchema,
  runIdSchema,
  stepIdSchema,
  taskIdSchema,
  type ProjectId,
} from '@shared/domain'
import { MIGRATIONS, openDatabase, runMigrations, type ForgeDatabase } from './index'
import { ProjectStore } from './projectStore'
import { RunStore } from './runStore'

describe('RunStore', () => {
  let db: ForgeDatabase
  let close: () => void
  let runStore: RunStore
  let projectId: ProjectId

  const NOW = '2026-08-23T12:00:00.000Z'

  beforeEach(() => {
    const conn = openDatabase({ file: ':memory:' })
    db = conn.db
    close = conn.close
    runMigrations(db, MIGRATIONS)

    const projects = new ProjectStore(db)
    runStore = new RunStore(db)

    projectId = projectIdSchema.parse(randomUUID())
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
  })

  afterEach(() => {
    close()
  })

  it('creates, retrieves, and finishes an execution run', () => {
    const runId = runIdSchema.parse(randomUUID())
    const taskId = taskIdSchema.parse(randomUUID())

    const created = runStore.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      exitCode: null,
      summary: null,
      error: null,
      metadata: { model: 'qwen2.5-coder:7b' },
    })

    expect(created.id).toBe(runId)

    const retrieved = runStore.getRun(runId)
    expect(retrieved).not.toBeNull()
    expect(retrieved?.status).toBe('running')
    expect(retrieved?.metadata).toEqual({ model: 'qwen2.5-coder:7b' })

    const finished = runStore.finishRun(runId, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: 'Task finished successfully',
    })

    expect(finished.status).toBe('completed')
    expect(finished.exitCode).toBe(0)
    expect(finished.summary).toBe('Task finished successfully')

    const list = runStore.listRunsForProject(projectId)
    expect(list.length).toBe(1)
    expect(list[0]?.id).toBe(runId)
  })

  it('creates, lists, and finishes steps within a run', () => {
    const runId = runIdSchema.parse(randomUUID())
    const taskId = taskIdSchema.parse(randomUUID())

    runStore.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      exitCode: null,
      summary: null,
      error: null,
      metadata: {},
    })

    const stepId = stepIdSchema.parse(randomUUID())
    const step = runStore.createStep({
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

    expect(step.id).toBe(stepId)

    const steps = runStore.listStepsForRun(runId)
    expect(steps.length).toBe(1)
    expect(steps[0]?.role).toBe('implementer')

    const finishedStep = runStore.finishStep(stepId, {
      status: 'completed',
      finishedAt: new Date().toISOString(),
      summary: 'Files modified',
    })

    expect(finishedStep.status).toBe('completed')
    expect(finishedStep.summary).toBe('Files modified')
  })

  it('appends and lists sequential events for a run with auto-incrementing seq', () => {
    const runId = runIdSchema.parse(randomUUID())
    const taskId = taskIdSchema.parse(randomUUID())

    runStore.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      exitCode: null,
      summary: null,
      error: null,
      metadata: {},
    })

    const e1 = runStore.appendEvent(runId, {
      type: 'run.started',
      payload: { instruction: 'Build feature' },
    })
    const e2 = runStore.appendEvent(runId, {
      type: 'status',
      payload: { text: 'Running tests' },
    })

    expect(e1.seq).toBe(1)
    expect(e2.seq).toBe(2)

    const events = runStore.listEventsForRun(runId)
    expect(events.length).toBe(2)
    expect(events[0]?.type).toBe('run.started')
    expect(events[1]?.type).toBe('status')
  })

  it('lists runs globally with limit and status filters (CLI-004)', () => {
    const runId1 = runIdSchema.parse(randomUUID())
    const runId2 = runIdSchema.parse(randomUUID())

    runStore.createRun({
      id: runId1,
      projectId,
      taskId: taskIdSchema.parse(randomUUID()),
      type: 'direct-task',
      status: 'completed',
      startedAt: '2026-08-23T10:00:00.000Z',
      finishedAt: '2026-08-23T10:05:00.000Z',
      exitCode: 0,
      summary: 'Run 1 passed',
      error: null,
      metadata: {},
    })

    runStore.createRun({
      id: runId2,
      projectId,
      taskId: taskIdSchema.parse(randomUUID()),
      type: 'direct-task',
      status: 'failed',
      startedAt: '2026-08-23T11:00:00.000Z',
      finishedAt: '2026-08-23T11:02:00.000Z',
      exitCode: 1,
      summary: 'Run 2 failed',
      error: 'Test failure',
      metadata: {},
    })

    // Global list (ordered newest first)
    const allRuns = runStore.listRuns()
    expect(allRuns.length).toBe(2)
    expect(allRuns[0]?.id).toBe(runId2)
    expect(allRuns[1]?.id).toBe(runId1)

    // Filter by status
    const completedRuns = runStore.listRuns({ status: 'completed' })
    expect(completedRuns.length).toBe(1)
    expect(completedRuns[0]?.id).toBe(runId1)

    const failedRuns = runStore.listRuns({ status: 'failed' })
    expect(failedRuns.length).toBe(1)
    expect(failedRuns[0]?.id).toBe(runId2)

    // Limit filter
    const limitedRuns = runStore.listRuns({ limit: 1 })
    expect(limitedRuns.length).toBe(1)
    expect(limitedRuns[0]?.id).toBe(runId2)
  })
})
