import type Database from 'better-sqlite3'
import { existsSync, statSync } from 'node:fs'

export interface TableRowStat {
  readonly tableName: string
  readonly rowCount: number
}

export interface DatabaseStats {
  readonly pageCount: number
  readonly pageSize: number
  readonly freelistCount: number
  readonly totalSizeBytes: number
  readonly walSizeBytes: number | null
  readonly diskSizeBytes: number | null
  readonly tables: readonly TableRowStat[]
}

export interface VacuumResult {
  readonly sizeBeforeBytes: number | null
  readonly sizeAfterBytes: number | null
  readonly reclaimedBytes: number
  readonly durationMs: number
}

/**
 * Gathers storage and row statistics for an open SQLite database.
 */
export function getDatabaseStats(sqlite: Database.Database, dbFilePath?: string): DatabaseStats {
  const pageCount = Number(sqlite.pragma('page_count', { simple: true }) ?? 0)
  const pageSize = Number(sqlite.pragma('page_size', { simple: true }) ?? 4096)
  const freelistCount = Number(sqlite.pragma('freelist_count', { simple: true }) ?? 0)
  const totalSizeBytes = pageCount * pageSize

  let diskSizeBytes: number | null = null
  let walSizeBytes: number | null = null

  if (dbFilePath && dbFilePath !== ':memory:' && existsSync(dbFilePath)) {
    try {
      diskSizeBytes = statSync(dbFilePath).size
      const walPath = `${dbFilePath}-wal`
      if (existsSync(walPath)) {
        walSizeBytes = statSync(walPath).size
      }
    } catch {
      // Ignore file stat errors if filesystem permissions prevent it
    }
  }

  // Enumerate user tables (excluding internal sqlite tables)
  const tableRows = sqlite
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
    )
    .all() as { name: string }[]

  const tables: TableRowStat[] = []
  for (const row of tableRows) {
    const tableName = row.name
    try {
      // Direct count per table
      const countResult = sqlite.prepare(`SELECT COUNT(*) as count FROM "${tableName}"`).get() as
        { count: number } | undefined
      tables.push({
        tableName,
        rowCount: countResult?.count ?? 0,
      })
    } catch {
      // Skip if table cannot be queried
    }
  }

  return {
    pageCount,
    pageSize,
    freelistCount,
    totalSizeBytes,
    walSizeBytes,
    diskSizeBytes,
    tables,
  }
}

/**
 * Compacts the database using VACUUM and runs PRAGMA optimize.
 * Reports before/after sizes and space reclaimed.
 */
export function vacuumDatabase(sqlite: Database.Database, dbFilePath?: string): VacuumResult {
  const startTime = Date.now()

  let sizeBeforeBytes: number | null = null
  if (dbFilePath && dbFilePath !== ':memory:' && existsSync(dbFilePath)) {
    try {
      sizeBeforeBytes = statSync(dbFilePath).size
    } catch {
      // Non-fatal
    }
  }

  // Execute SQLite VACUUM
  sqlite.exec('VACUUM')

  // Optimize indexes and analyze statistics
  sqlite.pragma('optimize')

  let sizeAfterBytes: number | null = null
  if (dbFilePath && dbFilePath !== ':memory:' && existsSync(dbFilePath)) {
    try {
      sizeAfterBytes = statSync(dbFilePath).size
    } catch {
      // Non-fatal
    }
  }

  const reclaimedBytes =
    sizeBeforeBytes !== null && sizeAfterBytes !== null && sizeBeforeBytes > sizeAfterBytes
      ? sizeBeforeBytes - sizeAfterBytes
      : 0

  const durationMs = Date.now() - startTime

  return {
    sizeBeforeBytes,
    sizeAfterBytes,
    reclaimedBytes,
    durationMs,
  }
}
