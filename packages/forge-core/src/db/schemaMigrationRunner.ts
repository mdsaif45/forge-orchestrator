/**
 * STATE-014: SQLite schema migration runner and version ledger supervisor.
 * Ensures deterministic, versioned, checksum-verified database schema migrations with transactional rollback (Axioms A1, A4).
 */

import { createHash } from 'node:crypto'
import type Database from 'better-sqlite3'

export interface MigrationDefinition {
  readonly version: number
  readonly name: string
  readonly upSql: string
  readonly downSql?: string | undefined
}

export interface MigrationRecord {
  readonly version: number
  readonly name: string
  readonly checksum: string
  readonly applied_at: string
  readonly execution_ms: number
}

export interface MigrationStatus {
  readonly currentVersion: number
  readonly appliedCount: number
  readonly pendingCount: number
  readonly applied: readonly MigrationRecord[]
  readonly pending: readonly MigrationDefinition[]
  readonly formattedSummary: string
}

export interface MigrationIntegrityReport {
  readonly valid: boolean
  readonly checkedCount: number
  readonly mismatched?:
    | {
        readonly version: number
        readonly expectedChecksum: string
        readonly recordedChecksum: string
      }
    | undefined
  readonly formattedSummary: string
}

export interface MigrationExecutionResult {
  readonly appliedCount: number
  readonly totalDurationMs: number
  readonly appliedVersions: readonly number[]
  readonly formattedSummary: string
}

/**
 * Computes deterministic SHA-256 hex checksum of SQL string.
 */
export function computeSqlChecksum(sql: string): string {
  return createHash('sha256').update(sql.trim(), 'utf8').digest('hex')
}

/**
 * Ensures the schema_migrations ledger table exists in the target database.
 */
export function ensureMigrationLedgerTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      checksum TEXT NOT NULL,
      applied_at TEXT NOT NULL,
      execution_ms INTEGER NOT NULL
    );
  `)
}

/**
 * Retrieves all applied migration records from the ledger, sorted by version ascending.
 */
export function getAppliedMigrations(db: Database.Database): MigrationRecord[] {
  ensureMigrationLedgerTable(db)

  const rows = db
    .prepare(
      'SELECT version, name, checksum, applied_at, execution_ms FROM schema_migrations ORDER BY version ASC',
    )
    .all() as MigrationRecord[]

  return rows
}

/**
 * Inspects migration status by comparing applied ledger rows against available definitions.
 */
export function getMigrationStatus(
  db: Database.Database,
  definitions: readonly MigrationDefinition[],
): MigrationStatus {
  const applied = getAppliedMigrations(db)
  const appliedVersions = new Set(applied.map((r) => r.version))

  const sortedDefs = [...definitions].sort((a, b) => a.version - b.version)
  const pending = sortedDefs.filter((d) => !appliedVersions.has(d.version))

  const currentVersion = applied.length > 0 ? (applied[applied.length - 1]?.version ?? 0) : 0

  const summary = `Schema at version ${String(currentVersion)} (${String(applied.length)} applied, ${String(pending.length)} pending).`

  return {
    currentVersion,
    appliedCount: applied.length,
    pendingCount: pending.length,
    applied,
    pending,
    formattedSummary: summary,
  }
}

/**
 * Verifies that applied migration checksums match the provided migration definitions.
 */
export function verifyMigrationIntegrity(
  db: Database.Database,
  definitions: readonly MigrationDefinition[],
): MigrationIntegrityReport {
  const applied = getAppliedMigrations(db)
  const defMap = new Map<number, MigrationDefinition>()
  for (const d of definitions) {
    defMap.set(d.version, d)
  }

  for (const record of applied) {
    const def = defMap.get(record.version)
    if (def) {
      const expectedChecksum = computeSqlChecksum(def.upSql)
      if (expectedChecksum !== record.checksum) {
        return {
          valid: false,
          checkedCount: applied.length,
          mismatched: {
            version: record.version,
            expectedChecksum,
            recordedChecksum: record.checksum,
          },
          formattedSummary: `✗ Migration checksum mismatch on version ${String(record.version)} ("${record.name}"). Expected ${expectedChecksum}, found ${record.checksum}.`,
        }
      }
    }
  }

  return {
    valid: true,
    checkedCount: applied.length,
    formattedSummary: `✓ All ${String(applied.length)} applied migration(s) verified against definition checksums.`,
  }
}

/**
 * Executes pending migrations in transactional sequence.
 */
export function applyPendingMigrations(
  db: Database.Database,
  definitions: readonly MigrationDefinition[],
): MigrationExecutionResult {
  ensureMigrationLedgerTable(db)

  const status = getMigrationStatus(db, definitions)
  if (status.pending.length === 0) {
    return {
      appliedCount: 0,
      totalDurationMs: 0,
      appliedVersions: [],
      formattedSummary: '✓ Schema is already up to date. No pending migrations.',
    }
  }

  const startAll = Date.now()
  const appliedVersions: number[] = []

  const insertStmt = db.prepare(`
    INSERT INTO schema_migrations (version, name, checksum, applied_at, execution_ms)
    VALUES (?, ?, ?, ?, ?)
  `)

  for (const mig of status.pending) {
    const startMig = Date.now()
    const checksum = computeSqlChecksum(mig.upSql)
    const appliedAt = new Date().toISOString()

    const applyTx = db.transaction(() => {
      db.exec(mig.upSql)
      const durationMs = Date.now() - startMig
      insertStmt.run(mig.version, mig.name, checksum, appliedAt, durationMs)
    })

    applyTx()
    appliedVersions.push(mig.version)
  }

  const totalDuration = Date.now() - startAll
  const summary = `✓ Successfully applied ${String(appliedVersions.length)} migration(s) up to version ${String(appliedVersions[appliedVersions.length - 1] ?? 0)} in ${String(totalDuration)}ms.`

  return {
    appliedCount: appliedVersions.length,
    totalDurationMs: totalDuration,
    appliedVersions,
    formattedSummary: summary,
  }
}
