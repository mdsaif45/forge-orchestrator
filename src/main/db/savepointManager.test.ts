import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { DatabaseSavepointManager } from './savepointManager'

describe('DatabaseSavepointManager (STATE-012)', () => {
  let db: Database.Database
  let manager: DatabaseSavepointManager

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec('CREATE TABLE test_data (id INTEGER PRIMARY KEY, name TEXT);')
    manager = new DatabaseSavepointManager()
  })

  afterEach(() => {
    db.close()
  })

  it('rejects invalid or unsafe savepoint names to prevent SQL injection', () => {
    expect(() => manager.createSavepoint(db, '')).toThrow(/invalid savepoint name/i)
    expect(() => manager.createSavepoint(db, 'sp; DROP TABLE test_data;')).toThrow(
      /invalid savepoint name/i,
    )
    expect(() => manager.createSavepoint(db, 'bad name')).toThrow(/invalid savepoint name/i)
    expect(() => manager.createSavepoint(db, 'name$with@symbols')).toThrow(
      /invalid savepoint name/i,
    )
  })

  it('creates and releases savepoints while updating depth and active stack', () => {
    const sp1 = manager.createSavepoint(db, 'sp_1')
    expect(sp1.action).toBe('create')
    expect(sp1.depth).toBe(1)
    expect(manager.getActiveSavepoints()).toEqual(['sp_1'])
    expect(manager.getDepth()).toBe(1)

    db.exec("INSERT INTO test_data (id, name) VALUES (1, 'initial');")

    const sp2 = manager.createSavepoint(db, 'sp_2')
    expect(sp2.depth).toBe(2)
    expect(manager.getActiveSavepoints()).toEqual(['sp_1', 'sp_2'])

    const rel2 = manager.releaseSavepoint(db, 'sp_2')
    expect(rel2.action).toBe('release')
    expect(rel2.depth).toBe(1)
    expect(manager.getActiveSavepoints()).toEqual(['sp_1'])

    const rel1 = manager.releaseSavepoint(db, 'sp_1')
    expect(rel1.depth).toBe(0)
    expect(manager.getActiveSavepoints()).toEqual([])

    const rows = db.prepare('SELECT count(*) as count FROM test_data').get() as { count: number }
    expect(rows.count).toBe(1)
  })

  it('rolls back inner savepoint without affecting outer savepoint', () => {
    manager.createSavepoint(db, 'outer_sp')
    db.exec("INSERT INTO test_data (id, name) VALUES (1, 'outer');")

    manager.createSavepoint(db, 'inner_sp')
    db.exec("INSERT INTO test_data (id, name) VALUES (2, 'inner');")

    // Rollback inner savepoint with release
    manager.rollbackToSavepoint(db, 'inner_sp', { releaseAfterRollback: true })
    expect(manager.getActiveSavepoints()).toEqual(['outer_sp'])

    const count = db.prepare('SELECT count(*) as count FROM test_data').get() as { count: number }
    expect(count.count).toBe(1)

    const row = db.prepare('SELECT name FROM test_data WHERE id = 1').get() as { name: string }
    expect(row.name).toBe('outer')

    // Commit outer
    manager.releaseSavepoint(db, 'outer_sp')
  })

  it('withSavepoint commits mutations on success', () => {
    const res = manager.withSavepoint(db, 'txn_success', () => {
      db.exec("INSERT INTO test_data (id, name) VALUES (10, 'safe');")
      return 'done'
    })

    expect(res).toBe('done')
    expect(manager.getDepth()).toBe(0)

    const row = db.prepare('SELECT name FROM test_data WHERE id = 10').get() as { name: string }
    expect(row.name).toBe('safe')
  })

  it('withSavepoint rolls back mutations and rethrows on failure', () => {
    expect(() =>
      manager.withSavepoint(db, 'txn_fail', () => {
        db.exec("INSERT INTO test_data (id, name) VALUES (20, 'will_abort');")
        throw new Error('Simulation error')
      }),
    ).toThrow('Simulation error')

    expect(manager.getDepth()).toBe(0)
    const row = db.prepare('SELECT * FROM test_data WHERE id = 20').get()
    expect(row).toBeUndefined()
  })

  it('withSavepointAsync handles async callbacks with rollbacks', async () => {
    await expect(
      manager.withSavepointAsync(db, 'async_fail', async () => {
        db.exec("INSERT INTO test_data (id, name) VALUES (30, 'async_abort');")
        await new Promise((r) => setTimeout(r, 10))
        throw new Error('Async boom')
      }),
    ).rejects.toThrow('Async boom')

    expect(manager.getDepth()).toBe(0)
    const row = db.prepare('SELECT * FROM test_data WHERE id = 30').get()
    expect(row).toBeUndefined()
  })

  it('throws when releasing or rolling back an unknown savepoint', () => {
    expect(() => manager.releaseSavepoint(db, 'nonexistent')).toThrow(
      /savepoint is not active in stack/i,
    )
    expect(() => manager.rollbackToSavepoint(db, 'nonexistent')).toThrow(
      /savepoint is not active in stack/i,
    )
  })
})
