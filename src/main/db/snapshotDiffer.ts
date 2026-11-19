import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import Database from 'better-sqlite3'

/**
 * STATE-011: SQLite database snapshot time-travel diffing and table delta analyzer.
 * Audits structural and row-level state deltas between two database checkpoints or backups (Axioms A1, A3, A4).
 */

export interface TableRowDiff {
  readonly id: string
  readonly status: 'added' | 'removed' | 'modified'
  readonly diffSummary?: string | undefined
}

export interface TableDelta {
  readonly tableName: string
  readonly columnsAdded: readonly string[]
  readonly columnsRemoved: readonly string[]
  readonly rowsAdded: number
  readonly rowsRemoved: number
  readonly rowsModified: number
  readonly unchangedRows: number
  readonly totalRowsA: number
  readonly totalRowsB: number
  readonly sampleDeltas: readonly TableRowDiff[]
}

export interface DatabaseSnapshotDiffReport {
  readonly valid: boolean
  readonly pathA: string
  readonly pathB: string
  readonly tablesAudited: readonly string[]
  readonly hasDifferences: boolean
  readonly hasDivergence: boolean
  readonly tablesWithDifferences: number
  readonly totalRowsAdded: number
  readonly totalRowsRemoved: number
  readonly totalRowsModified: number
  readonly tableDeltas: readonly TableDelta[]
  readonly formattedSummary: string
  readonly error?: string | undefined
}

export interface DatabaseSnapshotDiffOptions {
  readonly tables?: readonly string[] | undefined
  readonly maxSampleDeltas?: number | undefined
}

const DEFAULT_AUDIT_TABLES = ['projects', 'runs', 'steps', 'run_events', 'artifacts'] as const

function hashRowData(row: Record<string, unknown>): string {
  const sortedKeys = Object.keys(row).sort()
  const normalized: Record<string, unknown> = {}
  for (const k of sortedKeys) {
    normalized[k] = row[k]
  }
  return createHash('sha256').update(JSON.stringify(normalized)).digest('hex')
}

function extractRowKey(r: Record<string, unknown>): string {
  const candidate = r.id ?? r.seq ?? r.key
  if (typeof candidate === 'string' || typeof candidate === 'number') {
    return String(candidate)
  }
  return JSON.stringify(r)
}

interface PragmaColumn {
  name: string
  type: string
  pk: number
}

/**
 * Diffs two SQLite database files, identifying schema changes and row mutations (Axioms A1, A3, A4).
 */
export function diffDatabaseSnapshots(
  rawPathA: string,
  rawPathB: string,
  options: DatabaseSnapshotDiffOptions = {},
): DatabaseSnapshotDiffReport {
  const pathA = resolve(rawPathA)
  const pathB = resolve(rawPathB)
  const maxSamples = options.maxSampleDeltas ?? 10

  if (!existsSync(pathA)) {
    return {
      valid: false,
      pathA,
      pathB,
      tablesAudited: [],
      hasDifferences: false,
      hasDivergence: false,
      tablesWithDifferences: 0,
      totalRowsAdded: 0,
      totalRowsRemoved: 0,
      totalRowsModified: 0,
      tableDeltas: [],
      formattedSummary: `ERROR: Base database snapshot at "${pathA}" does not exist.`,
      error: `Snapshot A not found: ${pathA}`,
    }
  }

  if (!existsSync(pathB)) {
    return {
      valid: false,
      pathA,
      pathB,
      tablesAudited: [],
      hasDifferences: false,
      hasDivergence: false,
      tablesWithDifferences: 0,
      totalRowsAdded: 0,
      totalRowsRemoved: 0,
      totalRowsModified: 0,
      tableDeltas: [],
      formattedSummary: `ERROR: Target database snapshot at "${pathB}" does not exist.`,
      error: `Snapshot B not found: ${pathB}`,
    }
  }

  let dbA: Database.Database | null = null
  let dbB: Database.Database | null = null

  try {
    dbA = new Database(pathA, { readonly: true })
    dbB = new Database(pathB, { readonly: true })

    const tableDeltas: TableDelta[] = []
    let totalAdded = 0
    let totalRemoved = 0
    let totalModified = 0

    // Get all tables existing in either database
    const getExistingTables = (db: Database.Database): Set<string> => {
      const rows = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
        .all() as { name: string }[]
      return new Set(rows.map((r) => r.name))
    }

    const tablesA = getExistingTables(dbA)
    const tablesB = getExistingTables(dbB)
    const discoveredTables = Array.from(new Set([...tablesA, ...tablesB]))
    const targetTables =
      options.tables ?? (discoveredTables.length > 0 ? discoveredTables : DEFAULT_AUDIT_TABLES)

    for (const table of targetTables) {
      const inA = tablesA.has(table)
      const inB = tablesB.has(table)

      if (!inA && !inB) {
        continue
      }

      // Column schemas
      const colsA = inA
        ? (dbA.prepare(`PRAGMA table_info("${table}")`).all() as PragmaColumn[])
        : []
      const colsB = inB
        ? (dbB.prepare(`PRAGMA table_info("${table}")`).all() as PragmaColumn[])
        : []

      const colNamesA = new Set(colsA.map((c) => c.name))
      const colNamesB = new Set(colsB.map((c) => c.name))

      const columnsAdded = Array.from(colNamesB).filter((c) => !colNamesA.has(c))
      const columnsRemoved = Array.from(colNamesA).filter((c) => !colNamesB.has(c))

      // Row comparison by primary key 'id'
      const rowsA = inA
        ? (dbA.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[])
        : []
      const rowsB = inB
        ? (dbB.prepare(`SELECT * FROM "${table}"`).all() as Record<string, unknown>[])
        : []

      const mapA = new Map<string, { hash: string; row: Record<string, unknown> }>()
      for (const r of rowsA) {
        const id = extractRowKey(r)
        mapA.set(id, { hash: hashRowData(r), row: r })
      }

      const mapB = new Map<string, { hash: string; row: Record<string, unknown> }>()
      for (const r of rowsB) {
        const id = extractRowKey(r)
        mapB.set(id, { hash: hashRowData(r), row: r })
      }

      const sampleDeltas: TableRowDiff[] = []
      let rowsAdded = 0
      let rowsRemoved = 0
      let rowsModified = 0
      let unchangedRows = 0

      for (const [id, itemB] of mapB.entries()) {
        const itemA = mapA.get(id)
        if (!itemA) {
          rowsAdded++
          if (sampleDeltas.length < maxSamples) {
            sampleDeltas.push({ id, status: 'added' })
          }
        } else if (itemA.hash !== itemB.hash) {
          rowsModified++
          if (sampleDeltas.length < maxSamples) {
            sampleDeltas.push({ id, status: 'modified' })
          }
        } else {
          unchangedRows++
        }
      }

      for (const id of mapA.keys()) {
        if (!mapB.has(id)) {
          rowsRemoved++
          if (sampleDeltas.length < maxSamples) {
            sampleDeltas.push({ id, status: 'removed' })
          }
        }
      }

      totalAdded += rowsAdded
      totalRemoved += rowsRemoved
      totalModified += rowsModified

      tableDeltas.push({
        tableName: table,
        columnsAdded,
        columnsRemoved,
        rowsAdded,
        rowsRemoved,
        rowsModified,
        unchangedRows,
        totalRowsA: rowsA.length,
        totalRowsB: rowsB.length,
        sampleDeltas,
      })
    }

    const hasDifferences =
      totalAdded > 0 ||
      totalRemoved > 0 ||
      totalModified > 0 ||
      tableDeltas.some((t) => t.columnsAdded.length > 0 || t.columnsRemoved.length > 0)

    const tablesWithDiffs = tableDeltas.filter(
      (t) =>
        t.rowsAdded > 0 ||
        t.rowsRemoved > 0 ||
        t.rowsModified > 0 ||
        t.columnsAdded.length > 0 ||
        t.columnsRemoved.length > 0,
    ).length

    const lines: string[] = [
      'DATABASE SNAPSHOT DELTA AUDIT (STATE-011):',
      `  Base Snapshot:   ${pathA}`,
      `  Target Snapshot: ${pathB}`,
      `  Has Deltas:      ${hasDifferences ? 'YES' : 'NO'}`,
      `  Tables Audited:  ${String(tableDeltas.length)}`,
      `  Tables Changed:  ${String(tablesWithDiffs)}`,
      `  Total Added:     ${String(totalAdded)} rows`,
      `  Total Removed:   ${String(totalRemoved)} rows`,
      `  Total Modified:  ${String(totalModified)} rows`,
    ]

    for (const td of tableDeltas) {
      const changed =
        td.rowsAdded > 0 ||
        td.rowsRemoved > 0 ||
        td.rowsModified > 0 ||
        td.columnsAdded.length > 0 ||
        td.columnsRemoved.length > 0
      lines.push(
        `  • [${td.tableName}] ${changed ? 'CHANGED' : 'MATCH'}: +${String(td.rowsAdded)} / -${String(td.rowsRemoved)} / ~${String(td.rowsModified)} (total A: ${String(td.totalRowsA)}, total B: ${String(td.totalRowsB)})`,
      )
      if (td.columnsAdded.length > 0) {
        lines.push(`      + cols: ${td.columnsAdded.join(', ')}`)
      }
      if (td.columnsRemoved.length > 0) {
        lines.push(`      - cols: ${td.columnsRemoved.join(', ')}`)
      }
    }

    return {
      valid: true,
      pathA,
      pathB,
      tablesAudited: tableDeltas.map((t) => t.tableName),
      hasDifferences,
      hasDivergence: hasDifferences,
      tablesWithDifferences: tablesWithDiffs,
      totalRowsAdded: totalAdded,
      totalRowsRemoved: totalRemoved,
      totalRowsModified: totalModified,
      tableDeltas,
      formattedSummary: lines.join('\n'),
    }
  } catch (err) {
    return {
      valid: false,
      pathA,
      pathB,
      tablesAudited: [],
      hasDifferences: false,
      hasDivergence: false,
      tablesWithDifferences: 0,
      totalRowsAdded: 0,
      totalRowsRemoved: 0,
      totalRowsModified: 0,
      tableDeltas: [],
      formattedSummary: `ERROR: Failed to diff database snapshots: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    }
  } finally {
    if (dbA) dbA.close()
    if (dbB) dbB.close()
  }
}
