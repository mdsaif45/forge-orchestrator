import { describe, it, expect, beforeEach } from 'vitest'
import Database from 'better-sqlite3'
import {
  ensureMigrationLedgerTable,
  getAppliedMigrations,
  getMigrationStatus,
  verifyMigrationIntegrity,
  applyPendingMigrations,
  computeSqlChecksum,
  type MigrationDefinition,
} from './schemaMigrationRunner'

describe('SchemaMigrationRunner (STATE-014)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
  })

  const migrations: MigrationDefinition[] = [
    {
      version: 1,
      name: 'create_projects',
      upSql: 'CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);',
    },
    {
      version: 2,
      name: 'create_runs',
      upSql:
        'CREATE TABLE test_runs (id TEXT PRIMARY KEY, project_id TEXT NOT NULL, status TEXT NOT NULL);',
    },
    {
      version: 3,
      name: 'add_indexes',
      upSql: 'CREATE INDEX idx_runs_project ON test_runs(project_id);',
    },
  ]

  it('initializes ledger table and reports empty applied list on clean database', () => {
    ensureMigrationLedgerTable(db)
    const applied = getAppliedMigrations(db)
    expect(applied).toEqual([])

    const status = getMigrationStatus(db, migrations)
    expect(status.currentVersion).toBe(0)
    expect(status.appliedCount).toBe(0)
    expect(status.pendingCount).toBe(3)
  })

  it('applies pending migrations sequentially and records ledger entries', () => {
    const res = applyPendingMigrations(db, migrations)
    expect(res.appliedCount).toBe(3)
    expect(res.appliedVersions).toEqual([1, 2, 3])

    const applied = getAppliedMigrations(db)
    expect(applied).toHaveLength(3)
    expect(applied[0]?.name).toBe('create_projects')
    expect(applied[0]?.checksum).toBe(computeSqlChecksum(migrations[0]!.upSql))
    expect(applied[2]?.version).toBe(3)

    // Table was actually created in SQLite
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='projects'")
      .all()
    expect(tables).toHaveLength(1)
  })

  it('is idempotent when re-applying up-to-date migrations', () => {
    applyPendingMigrations(db, migrations)
    const secondRes = applyPendingMigrations(db, migrations)

    expect(secondRes.appliedCount).toBe(0)
    expect(secondRes.formattedSummary).toContain('Schema is already up to date')
  })

  it('verifies checksum integrity and flags tampering of applied migration scripts', () => {
    applyPendingMigrations(db, migrations)

    const initialIntegrity = verifyMigrationIntegrity(db, migrations)
    expect(initialIntegrity.valid).toBe(true)

    // Tampered definition
    const tamperedMigrations: MigrationDefinition[] = [
      {
        version: 1,
        name: 'create_projects',
        upSql: 'CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL);', // modified column
      },
      migrations[1]!,
      migrations[2]!,
    ]

    const tamperedIntegrity = verifyMigrationIntegrity(db, tamperedMigrations)
    expect(tamperedIntegrity.valid).toBe(false)
    expect(tamperedIntegrity.mismatched?.version).toBe(1)
    expect(tamperedIntegrity.formattedSummary).toContain('checksum mismatch')
  })

  it('rolls back transaction if a migration fails partway through', () => {
    const failingMigrations: MigrationDefinition[] = [
      {
        version: 1,
        name: 'valid_table',
        upSql: 'CREATE TABLE t1 (id TEXT PRIMARY KEY);',
      },
      {
        version: 2,
        name: 'syntax_error',
        upSql: 'INVALID SQL STATEMENT THAT FAILS SYNTAX;',
      },
    ]

    expect(() => {
      applyPendingMigrations(db, failingMigrations)
    }).toThrow()

    // Table t1 from version 1 was committed because each migration runs in its own tx, but v2 failed and was not recorded
    const status = getMigrationStatus(db, failingMigrations)
    expect(status.currentVersion).toBe(1)
    expect(status.appliedCount).toBe(1)
    expect(status.pendingCount).toBe(1)
  })
})
