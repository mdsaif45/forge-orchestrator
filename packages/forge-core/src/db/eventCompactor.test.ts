import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { compactRunEvents } from './eventCompactor'

describe('eventCompactor (STATE-004)', () => {
  let tempDir: string
  let dbPath: string
  let sqlite: Database.Database

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-compactor-test-'))
    dbPath = join(tempDir, 'test.db')
    sqlite = new Database(dbPath)

    // Setup minimal tables for testing
    sqlite.exec(`
      CREATE TABLE runs (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        finished_at TEXT
      );
      CREATE TABLE run_events (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        occurred_at TEXT NOT NULL
      );
    `)
  })

  afterEach(async () => {
    sqlite.close()
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('prunes intermediate events in completed runs while preserving bounds (A5/A1)', async () => {
    // Insert completed run with 5 events
    sqlite
      .prepare('INSERT INTO runs VALUES (?, ?, ?)')
      .run('run-1', 'completed', '2026-11-18T12:00:00Z')
    const insertEvent = sqlite.prepare('INSERT INTO run_events VALUES (?, ?, ?, ?, ?, ?)')
    insertEvent.run('ev-1', 'run-1', 1, 'run:started', '{}', '2026-11-18T12:00:00Z')
    insertEvent.run('ev-2', 'run-1', 2, 'step:started', '{}', '2026-11-18T12:01:00Z')
    insertEvent.run('ev-3', 'run-1', 3, 'tool:call', '{}', '2026-11-18T12:02:00Z')
    insertEvent.run('ev-4', 'run-1', 4, 'step:finished', '{}', '2026-11-18T12:03:00Z')
    insertEvent.run('ev-5', 'run-1', 5, 'run:completed', '{}', '2026-11-18T12:04:00Z')

    // Live compaction
    const result = await compactRunEvents(sqlite, { dryRun: false })
    expect(result.valid).toBe(true)
    expect(result.runsCompacted).toBe(1)
    expect(result.eventsPruned).toBe(3) // events 2, 3, 4 pruned

    // Check remaining events: only bounds (seq 1 and seq 5) remain
    const remaining = sqlite
      .prepare('SELECT seq, type FROM run_events WHERE run_id = ? ORDER BY seq ASC')
      .all('run-1') as { seq: number; type: string }[]
    expect(remaining.length).toBe(2)
    expect(remaining[0]?.seq).toBe(1)
    expect(remaining[0]?.type).toBe('run:started')
    expect(remaining[1]?.seq).toBe(5)
    expect(remaining[1]?.type).toBe('run:completed')
  })

  it('respects dryRun mode without deleting database rows', async () => {
    sqlite
      .prepare('INSERT INTO runs VALUES (?, ?, ?)')
      .run('run-2', 'completed', '2026-11-18T12:00:00Z')
    const insertEvent = sqlite.prepare('INSERT INTO run_events VALUES (?, ?, ?, ?, ?, ?)')
    insertEvent.run('ev-1', 'run-2', 1, 'run:started', '{}', '2026-11-18T12:00:00Z')
    insertEvent.run('ev-2', 'run-2', 2, 'tool:call', '{}', '2026-11-18T12:01:00Z')
    insertEvent.run('ev-3', 'run-2', 3, 'run:completed', '{}', '2026-11-18T12:02:00Z')

    const result = await compactRunEvents(sqlite, { dryRun: true })
    expect(result.valid).toBe(true)
    expect(result.dryRun).toBe(true)
    expect(result.eventsPruned).toBe(1)

    // Verify all 3 events still present on disk
    const count = (
      sqlite.prepare('SELECT COUNT(*) as cnt FROM run_events WHERE run_id = ?').get('run-2') as {
        cnt: number
      }
    ).cnt
    expect(count).toBe(3)
  })

  it('ignores active non-terminal runs', async () => {
    sqlite.prepare('INSERT INTO runs VALUES (?, ?, ?)').run('run-active', 'running', null)
    sqlite
      .prepare('INSERT INTO run_events VALUES (?, ?, ?, ?, ?, ?)')
      .run('ev-1', 'run-active', 1, 'run:started', '{}', '2026-11-18T12:00:00Z')

    const result = await compactRunEvents(sqlite, { dryRun: false })
    expect(result.runsCompacted).toBe(0)
    expect(result.eventsPruned).toBe(0)
  })
})
