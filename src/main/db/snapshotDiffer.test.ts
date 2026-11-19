import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { diffDatabaseSnapshots } from './snapshotDiffer'

describe('snapshotDiffer (STATE-011)', () => {
  let tempDir: string
  let pathA: string
  let pathB: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-snapdiff-test-'))
    pathA = join(tempDir, 'base.db')
    pathB = join(tempDir, 'target.db')
  })

  afterEach(async () => {
    if (existsSync(tempDir)) {
      await rm(tempDir, { recursive: true, force: true })
    }
  })

  it('detects row additions, updates, and deletions across SQLite tables', () => {
    // 1. Setup base dbA
    const dbA = new Database(pathA)
    dbA.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT, summary TEXT);
      INSERT INTO runs VALUES ('run-1', 'completed', 'Task 1 summary');
      INSERT INTO runs VALUES ('run-2', 'failed', 'Task 2 error');
    `)
    dbA.close()

    // 2. Setup target dbB:
    // run-1 modified: status changed to running
    // run-2 deleted
    // run-3 added
    const dbB = new Database(pathB)
    dbB.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT, summary TEXT);
      INSERT INTO runs VALUES ('run-1', 'running', 'Task 1 summary');
      INSERT INTO runs VALUES ('run-3', 'completed', 'Task 3 summary');
    `)
    dbB.close()

    const report = diffDatabaseSnapshots(pathA, pathB, { tables: ['runs'] })

    expect(report.valid).toBe(true)
    expect(report.hasDifferences).toBe(true)
    expect(report.totalRowsAdded).toBe(1)
    expect(report.totalRowsModified).toBe(1)
    expect(report.totalRowsRemoved).toBe(1)

    const runsDelta = report.tableDeltas.find((t) => t.tableName === 'runs')
    expect(runsDelta).toBeDefined()
    expect(runsDelta?.rowsAdded).toBe(1)
    expect(runsDelta?.rowsModified).toBe(1)
    expect(runsDelta?.rowsRemoved).toBe(1)
    expect(runsDelta?.sampleDeltas).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'run-3', status: 'added' }),
        expect.objectContaining({ id: 'run-1', status: 'modified' }),
        expect.objectContaining({ id: 'run-2', status: 'removed' }),
      ]),
    )
  })

  it('detects added columns in target schema', () => {
    const dbA = new Database(pathA)
    dbA.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);')
    dbA.close()

    const dbB = new Database(pathB)
    dbB.exec('CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT, git_remote TEXT);')
    dbB.close()

    const report = diffDatabaseSnapshots(pathA, pathB, { tables: ['projects'] })

    expect(report.valid).toBe(true)
    expect(report.hasDifferences).toBe(true)
    const pDelta = report.tableDeltas.find((t) => t.tableName === 'projects')
    expect(pDelta?.columnsAdded).toContain('git_remote')
  })

  it('reports zero differences when snapshots are identical', () => {
    const dbA = new Database(pathA)
    dbA.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT);
      INSERT INTO runs VALUES ('run-1', 'completed');
    `)
    dbA.close()

    const dbB = new Database(pathB)
    dbB.exec(`
      CREATE TABLE runs (id TEXT PRIMARY KEY, status TEXT);
      INSERT INTO runs VALUES ('run-1', 'completed');
    `)
    dbB.close()

    const report = diffDatabaseSnapshots(pathA, pathB, { tables: ['runs'] })

    expect(report.valid).toBe(true)
    expect(report.hasDifferences).toBe(false)
    expect(report.totalRowsAdded).toBe(0)
    expect(report.totalRowsModified).toBe(0)
    expect(report.totalRowsRemoved).toBe(0)
  })

  it('fails closed when snapshot file does not exist', () => {
    const db = new Database(pathA)
    db.close()
    const report = diffDatabaseSnapshots(pathA, join(tempDir, 'non-existent.db'))
    expect(report.valid).toBe(false)
    expect(report.error).toContain('Snapshot B not found')
  })
})
