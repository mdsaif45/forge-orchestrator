import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createForgeCore, type ForgeCore } from '../core/forgeCore'
import { projectIdSchema, runIdSchema, taskIdSchema } from '@shared/domain'
import { verifyLedgerReplication } from './ledgerVerifier'

describe('Event Ledger Replication Verifier & Cross-Engine Integrity Auditor (STATE-010)', () => {
  let tempDir: string
  let core: ForgeCore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'ledger-verifier-test-'))
    core = createForgeCore({ dataDir: tempDir })
  })

  afterEach(async () => {
    await core.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('audits a clean database and reports valid replication and zero orphans', () => {
    const report = verifyLedgerReplication(core.sqlite)
    expect(report.valid).toBe(true)
    expect(report.sequenceMonotonic).toBe(true)
    expect(report.hashChainValid).toBe(true)
    expect(report.crossTableConsistent).toBe(true)
    expect(report.totalEventsAudited).toBe(0)
    expect(report.counts.orphanedEvents).toBe(0)
  })

  it('validates a monotonic event stream for a completed run', async () => {
    const project = await core.projects.create({
      name: 'Ledger Test Project',
      repositoryPath: process.cwd(),
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: ['ts'],
      rules: [],
    })
    const runId = runIdSchema.parse(randomUUID())
    const projectId = projectIdSchema.parse(project.id)
    const taskId = taskIdSchema.parse(randomUUID())

    core.runs.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'completed',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: 'Ledger test run',
      error: null,
      metadata: {},
    })

    core.runs.appendEvent(runId, {
      type: 'run:started',
      payload: {},
    })
    core.runs.appendEvent(runId, {
      type: 'step:started',
      payload: { step: 'step-1' },
    })
    core.runs.appendEvent(runId, {
      type: 'step:completed',
      payload: { step: 'step-1', exitCode: 0 },
    })

    const report = verifyLedgerReplication(core.sqlite, runId)
    expect(report.valid).toBe(true)
    expect(report.totalEventsAudited).toBe(3)
    expect(report.sequenceMonotonic).toBe(true)
    expect(report.hashChainValid).toBe(true)
    expect(report.issues).toHaveLength(0)
  })

  it('detects sequence gaps in an event stream', async () => {
    const project = await core.projects.create({
      name: 'Gap Test Project',
      repositoryPath: process.cwd(),
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: ['ts'],
      rules: [],
    })
    const runId = runIdSchema.parse(randomUUID())
    const projectId = projectIdSchema.parse(project.id)
    const taskId = taskIdSchema.parse(randomUUID())

    core.runs.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      summary: 'Gap test run',
      error: null,
      metadata: {},
    })

    // Insert events with a sequence gap directly into run_events
    core.sqlite
      .prepare(
        `INSERT INTO run_events (id, run_id, seq, type, occurred_at, payload)
         VALUES (?, ?, ?, ?, datetime('now'), '{}')`,
      )
      .run(randomUUID(), runId, 1, 'run:started')

    // Skip seq 2 and insert seq 5 directly
    core.sqlite
      .prepare(
        `INSERT INTO run_events (id, run_id, seq, type, occurred_at, payload)
         VALUES (?, ?, ?, ?, datetime('now'), '{}')`,
      )
      .run(randomUUID(), runId, 5, 'run:failed')

    const report = verifyLedgerReplication(core.sqlite, runId)
    expect(report.valid).toBe(false)
    expect(report.sequenceMonotonic).toBe(false)
    expect(report.brokenSeq).toBe(5)
    expect(report.issues.some((i) => i.includes('Sequence gap detected'))).toBe(true)
  })

  it('detects orphaned records when child events have missing parent run', () => {
    const missingRunId = randomUUID()

    // Disable foreign keys to simulate orphaned records
    core.sqlite.pragma('foreign_keys = OFF')

    core.sqlite
      .prepare(
        `INSERT INTO run_events (id, run_id, seq, type, occurred_at, payload)
         VALUES (?, ?, 1, 'run:started', datetime('now'), '{}')`,
      )
      .run(randomUUID(), missingRunId)

    const report = verifyLedgerReplication(core.sqlite)
    expect(report.valid).toBe(false)
    expect(report.crossTableConsistent).toBe(false)
    expect(report.counts.orphanedEvents).toBe(1)
  })
})
