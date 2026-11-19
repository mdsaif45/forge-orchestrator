import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { auditDatabaseStorageQuota, executeWalCheckpoint } from './walCheckpointSupervisor'

describe('SQLite WAL Checkpoint Supervisor & Disk Quota Monitor (STATE-007)', () => {
  let tempDir: string
  let db: Database.Database
  let dbFile: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'forge-wal-test-'))
    dbFile = join(tempDir, 'forge.db')
    db = new Database(dbFile)
    db.pragma('journal_mode = WAL')
    db.exec('CREATE TABLE test_data (id INTEGER PRIMARY KEY, content TEXT)')
  })

  afterEach(() => {
    try {
      db.close()
    } catch {
      // Ignore
    }
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('skips checkpoint when WAL file is below threshold unless forced', () => {
    const result = executeWalCheckpoint(db, dbFile, { thresholdBytes: 10_000 })
    expect(result.valid).toBe(true)
    expect(result.checkpointExecuted).toBe(false)
    expect(result.formattedSummary).toContain('below threshold')
  })

  it('truncates WAL file on forced checkpoint execution', () => {
    // Insert rows to generate WAL traffic
    const insert = db.prepare('INSERT INTO test_data (content) VALUES (?)')
    for (let i = 0; i < 50; i++) {
      insert.run(`Test payload item ${String(i)} with extra filler bytes`)
    }

    const result = executeWalCheckpoint(db, dbFile, { force: true })
    expect(result.valid).toBe(true)
    expect(result.checkpointExecuted).toBe(true)
    expect(result.checkpointed).toBeGreaterThanOrEqual(0)
    expect(result.formattedSummary).toContain('WAL CHECKPOINT (TRUNCATE) COMPLETED')
  })

  it('audits total database and artifact tree storage footprint against quota limits', () => {
    const report = auditDatabaseStorageQuota(tempDir, 10_000_000)
    expect(report.totalStorageBytes).toBeGreaterThanOrEqual(0)
    expect(report.quotaExceeded).toBe(false)
    expect(report.formattedSummary).toContain('STORAGE QUOTA AUDIT: HEALTHY')
  })
})
