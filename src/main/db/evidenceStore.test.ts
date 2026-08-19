/**
 * What these tests claim: evidence survives the round trip through the event log
 * without changing meaning, and a rebuild from the log alone reproduces it.
 *
 * That property is axiom A1 made checkable. If a projection could hold evidence the
 * log cannot regenerate, the log would no longer be the authority and a replay would
 * quietly disagree with what a reviewer saw.
 *
 * The verdict is deliberately *not* stored. These tests assert it stays computed, so
 * no row can claim a pass that the exit code beside it contradicts.
 */

import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  evidenceArtifactSchema,
  evidenceIdSchema,
  evidencePassed,
  projectIdSchema,
  repositoryIdSchema,
  stepIdSchema,
  taskIdSchema,
  workflowIdSchema,
  type EvidenceArtifact,
  type ProjectId,
  type StepId,
  type TaskId,
  type WorkflowId,
} from '@shared/domain'
import { initialiseDatabase, type ForgeDatabase } from '.'
import { EventStore } from './eventStore'
import { ProjectStore } from './projectStore'
import { rebuildProjections } from './projections'
import { WorkflowStore } from './workflowStore'

const NOW = '2026-08-19T00:00:00.000Z'

let dbFile: string
let db: ForgeDatabase
let closeDb: () => void
let projectId: ProjectId
let taskId: TaskId
let workflowId: WorkflowId
let stepId: StepId

/**
 * Built through the schema rather than cast to it, so a fixture that drifts out of
 * shape fails here instead of producing an artifact the production path would reject.
 */
function artifact(overrides: Partial<EvidenceArtifact> = {}): EvidenceArtifact {
  return evidenceArtifactSchema.parse({
    id: evidenceIdSchema.parse(randomUUID()),
    workflowId,
    stepId,
    kind: 'tests',
    command: 'npm test',
    cwd: 'D:/Projects/Subject',
    outcome: 'completed',
    exitCode: 0,
    durationMs: 1234,
    stdout: 'Tests  19 passed (19)',
    stderr: '',
    truncated: false,
    counts: { total: 19, passed: 19, failed: null, skipped: null },
    failure: null,
    recordedAt: NOW,
    ...overrides,
  })
}

/** Narrows an optional artifact, so a missing row fails as itself. */
function present(value: EvidenceArtifact | undefined): EvidenceArtifact {
  expect(value).toBeDefined()
  if (value === undefined) throw new Error('unreachable: expect above has already failed')
  return value
}

beforeEach(() => {
  dbFile = join(mkdtempSync(join(tmpdir(), 'forge-evidence-')), 'forge.db')
  const opened = initialiseDatabase(dbFile)
  db = opened.db
  closeDb = opened.close

  projectId = projectIdSchema.parse(randomUUID())
  taskId = taskIdSchema.parse(randomUUID())
  workflowId = workflowIdSchema.parse(randomUUID())
  stepId = stepIdSchema.parse(randomUUID())

  new ProjectStore(db).create(
    {
      id: projectId,
      name: 'Subject',
      repository: {
        id: repositoryIdSchema.parse(randomUUID()),
        absolutePath: 'D:/Projects/Subject',
        defaultBranch: 'main',
        buildCommand: 'npm run build',
        testCommand: 'npm test',
        tech: [],
      },
      createdAt: NOW,
      updatedAt: NOW,
    },
    'user',
  )

  const tasksStore = new WorkflowStore(db)
  new EventStore(db).append(
    {
      type: 'task.created',
      payload: {
        task: {
          id: taskId,
          objective: 'Verify the runners',
          constraints: [],
          // A task requires at least one criterion: without one, "done" would be a
          // matter of opinion.
          completionCriteria: [{ kind: 'tests', description: 'the test suite passes', params: {} }],
          scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
          lockedDecisionIds: [],
          correctsTaskId: null,
          createdAt: NOW,
        },
      },
    },
    { projectId, actor: 'user', occurredAt: NOW },
  )
  rebuildProjections(db, projectId, new EventStore(db).read(projectId))

  tasksStore.start({ workflowId, projectId, taskId, templateId: 'feature', startedAt: NOW }, 'user')
})

afterEach(() => {
  closeDb()
  rmSync(dbFile, { recursive: true, force: true })
})

describe('recording evidence', () => {
  it('round-trips an artifact through the log without changing it', () => {
    const store = new WorkflowStore(db)
    const recorded = artifact()

    store.recordEvidence(recorded, 'system', NOW)

    const [loaded] = store.evidenceForStep(stepId)

    // Compared whole rather than field by field: a dropped field is the failure mode
    // that matters, and an equality check catches one that assertions per field miss.
    expect(loaded).toEqual(recorded)
  })

  it('keeps raw output rather than a parsed summary', () => {
    const store = new WorkflowStore(db)
    const noisy = artifact({
      stdout: 'line one\nline two\nline three',
      stderr: 'a warning',
    })

    store.recordEvidence(noisy, 'system', NOW)
    const [loaded] = store.evidenceForStep(stepId)

    // A parser that mis-reads a format must not be able to destroy the only record of
    // what happened.
    expect(loaded?.stdout).toBe('line one\nline two\nline three')
    expect(loaded?.stderr).toBe('a warning')
  })

  it('preserves a null exit code rather than coercing it to a number', () => {
    const store = new WorkflowStore(db)
    store.recordEvidence(
      artifact({
        outcome: 'timeout',
        exitCode: null,
        failure: 'no result within 400ms',
        counts: null,
      }),
      'system',
      NOW,
    )

    const [loaded] = store.evidenceForStep(stepId)

    expect(loaded?.exitCode).toBeNull()
    // Null must not read as zero, which would be a pass.
    expect(evidencePassed(present(loaded))).toBe(false)
  })

  it('returns artifacts for a step oldest first', () => {
    const store = new WorkflowStore(db)
    store.recordEvidence(
      artifact({ kind: 'build', command: 'npm run build', recordedAt: NOW }),
      'system',
      NOW,
    )
    store.recordEvidence(
      artifact({ kind: 'tests', recordedAt: '2026-08-19T00:00:05.000Z' }),
      'system',
      '2026-08-19T00:00:05.000Z',
    )

    const loaded = store.evidenceForStep(stepId)

    expect(loaded.map((entry) => entry.kind)).toEqual(['build', 'tests'])
  })
})

describe('the log as the authority', () => {
  it('reproduces evidence from a rebuild, with no verdict of its own', () => {
    const store = new WorkflowStore(db)
    const failing = artifact({ exitCode: 1, counts: null })
    store.recordEvidence(failing, 'system', NOW)

    const before = store.evidenceForStep(stepId)

    // Drop every read model and rebuild from events alone.
    rebuildProjections(db, projectId, new EventStore(db).read(projectId))

    const after = new WorkflowStore(db).evidenceForStep(stepId)

    expect(after).toEqual(before)
    // The verdict is recomputed on read, never stored, so a rebuild cannot resurrect a
    // stale one.
    expect(evidencePassed(present(after[0]))).toBe(false)
  })

  it('leaves the same row when the same event is applied twice', () => {
    const store = new WorkflowStore(db)
    store.recordEvidence(artifact(), 'system', NOW)

    const events = new EventStore(db).read(projectId)

    // Replaying the tail is how resume works, so applying an event twice has to be
    // indistinguishable from applying it once.
    rebuildProjections(db, projectId, events)
    rebuildProjections(db, projectId, events)

    expect(new WorkflowStore(db).evidenceForStep(stepId)).toHaveLength(1)
  })
})
