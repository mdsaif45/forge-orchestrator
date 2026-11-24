import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import Database from 'better-sqlite3'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { backupDatabase, restoreDatabase } from './backup'

describe('database backup and restore', () => {
  let tempDir: string

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-db-backup-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('creates an online backup snapshot with verified SHA-256 and schema integrity (A1/A3)', async () => {
    const activeDbPath = join(tempDir, 'active.db')
    const backupPath = join(tempDir, 'backup.db')

    const db = new Database(activeDbPath)
    db.exec(`
      CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT);
      INSERT INTO projects VALUES ('p-1', 'Project Alpha');
      INSERT INTO projects VALUES ('p-2', 'Project Beta');
    `)

    const res = await backupDatabase(db, backupPath)
    db.close()

    expect(res.valid).toBe(true)
    expect(res.tableCount).toBeGreaterThanOrEqual(1)
    expect(res.sizeBytes).toBeGreaterThan(0)
    expect(res.sha256).toBeDefined()
    expect(res.formattedSummary).toContain('Database Backup Snapshot Completed')

    // Read and verify backup contents directly
    const backupDb = new Database(backupPath, { readonly: true })
    const rows = backupDb.prepare('SELECT * FROM projects ORDER BY id ASC').all() as {
      id: string
      name: string
    }[]
    backupDb.close()

    expect(rows).toEqual([
      { id: 'p-1', name: 'Project Alpha' },
      { id: 'p-2', name: 'Project Beta' },
    ])
  })

  it('restores active database from a backup snapshot with pre- and post-flight verification', async () => {
    const sourceDbPath = join(tempDir, 'source.db')
    const backupPath = join(tempDir, 'backup.db')
    const targetDbPath = join(tempDir, 'restored.db')

    // Create source DB and backup
    const srcDb = new Database(sourceDbPath)
    srcDb.exec(`
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT);
      INSERT INTO tasks VALUES ('t-1', 'Task One');
    `)
    await backupDatabase(srcDb, backupPath)
    srcDb.close()

    // Restore to target path
    const restoreRes = await restoreDatabase(targetDbPath, backupPath)
    expect(restoreRes.success).toBe(true)
    expect(restoreRes.restoredPath).toBe(targetDbPath)
    expect(restoreRes.formattedSummary).toContain('Database Restored Successfully')

    // Verify restored database
    const restoredDb = new Database(targetDbPath, { readonly: true })
    const rows = restoredDb.prepare('SELECT * FROM tasks').all() as { id: string; title: string }[]
    restoredDb.close()

    expect(rows).toEqual([{ id: 't-1', title: 'Task One' }])
  })

  it('fails closed when backup file does not exist', async () => {
    const targetDbPath = join(tempDir, 'restored.db')
    const missingBackup = join(tempDir, 'missing.db')

    const res = await restoreDatabase(targetDbPath, missingBackup)
    expect(res.success).toBe(false)
    expect(res.error).toContain('Backup file not found')
  })

  it('fails closed when backup snapshot is corrupted (Fail-closed A2)', async () => {
    const targetDbPath = join(tempDir, 'active.db')
    const corruptBackupPath = join(tempDir, 'corrupt.db')

    // Create a real active database first
    const activeDb = new Database(targetDbPath)
    activeDb.exec('CREATE TABLE intact (val INT); INSERT INTO intact VALUES (99);')
    activeDb.close()

    // Write garbage bytes as corrupted backup
    await writeFile(corruptBackupPath, 'CORRUPTED NOT SQLITE BYTES 12345', 'utf8')

    const res = await restoreDatabase(targetDbPath, corruptBackupPath)
    expect(res.success).toBe(false)
    expect(res.error).toBeDefined()

    // Active database must remain intact!
    const verifyDb = new Database(targetDbPath, { readonly: true })
    const rows = verifyDb.prepare('SELECT * FROM intact').all() as { val: number }[]
    verifyDb.close()

    expect(rows).toEqual([{ val: 99 }])
  })
})
