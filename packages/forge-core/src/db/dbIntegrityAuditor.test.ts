import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createForgeCore, type ForgeCore } from '../core/forgeCore'
import { auditDatabaseIntegrity, pruneOrphanedDatabaseRecords } from './dbIntegrityAuditor'

describe('Database Integrity Checker & Foreign Key Orphan Auditor (STATE-006)', () => {
  let tempDir: string
  let core: ForgeCore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'db-integrity-test-'))
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

  it('audits a clean database and reports valid integrity with zero orphans', () => {
    const report = auditDatabaseIntegrity(core.sqlite)

    expect(report.valid).toBe(true)
    expect(report.integrityCheckPassed).toBe(true)
    expect(report.foreignKeyErrors).toHaveLength(0)
    expect(report.totalOrphans).toBe(0)
    expect(report.formattedSummary).toContain('DATABASE INTEGRITY & ORPHAN AUDIT: PASSED')
  })

  it('detects orphaned child records and safely prunes them', () => {
    const missingRunId = randomUUID()
    const stepId = randomUUID()

    // Disable foreign keys temporarily to simulate corruption / orphaned data
    core.sqlite.pragma('foreign_keys = OFF')

    core.sqlite
      .prepare(
        `INSERT INTO run_steps (id, run_id, step_index, role, status, started_at)
         VALUES (?, ?, 1, 'implementer', 'completed', datetime('now'))`,
      )
      .run(stepId, missingRunId)

    core.sqlite.pragma('foreign_keys = ON')

    const reportBefore = auditDatabaseIntegrity(core.sqlite)
    expect(reportBefore.valid).toBe(false)
    expect(reportBefore.orphanedRunSteps).toBe(1)
    expect(reportBefore.totalOrphans).toBe(1)
    expect(reportBefore.formattedSummary).toContain('DATABASE INTEGRITY & ORPHAN AUDIT: FAILED')

    // Prune orphans
    const pruneResult = pruneOrphanedDatabaseRecords(core.sqlite)
    expect(pruneResult.valid).toBe(true)
    expect(pruneResult.prunedSteps).toBe(1)
    expect(pruneResult.totalPruned).toBe(1)

    // Audit after prune
    const reportAfter = auditDatabaseIntegrity(core.sqlite)
    expect(reportAfter.valid).toBe(true)
    expect(reportAfter.totalOrphans).toBe(0)
  })
})
