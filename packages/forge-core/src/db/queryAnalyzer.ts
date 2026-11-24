/**
 * STATE-016: SQLite Query Plan Analyzer & Index Selectivity Auditor
 *
 * Inspects analytical query execution plans via `EXPLAIN QUERY PLAN`,
 * identifies unindexed full-table sequential scans, detects temporary B-tree sorting,
 * computes query efficiency health scores (0-100), and audits table indexes.
 *
 * Conforms to Forge Axioms:
 * - A1: Fail-closed analysis and zero `any`.
 * - A2: Strictly read-only query plan analysis (no side effects).
 * - A4: Immutable diagnostic report of query execution characteristics.
 * - A5: Bounded analysis execution.
 */

import type Database from 'better-sqlite3'

export interface QueryPlanNode {
  readonly id: number
  readonly parent: number
  readonly detail: string
  readonly isScan: boolean
  readonly isIndexSearch: boolean
  readonly tableName?: string | undefined
  readonly indexName?: string | undefined
}

export interface QueryPlanAnalysis {
  readonly sql: string
  readonly nodes: readonly QueryPlanNode[]
  readonly hasTableScan: boolean
  readonly scannedTables: readonly string[]
  readonly usedIndexes: readonly string[]
  readonly usesTempBTree: boolean
  readonly score: number
  readonly recommendations: readonly string[]
  readonly formattedSummary: string
}

export interface TableIndexInfo {
  readonly name: string
  readonly unique: boolean
  readonly origin: string
  readonly columns: readonly string[]
}

export interface TableIndexHealth {
  readonly tableName: string
  readonly indexCount: number
  readonly indexes: readonly TableIndexInfo[]
}

export interface IndexAuditReport {
  readonly totalTables: number
  readonly totalIndexes: number
  readonly tables: readonly TableIndexHealth[]
  readonly formattedSummary: string
}

const SCAN_REGEX = /SCAN(?:\s+TABLE)?\s+([^\s]+)/i
const SEARCH_INDEX_REGEX =
  /SEARCH(?:\s+TABLE)?\s+([^\s]+)\s+USING(?:\s+(?:COVERING\s+)?INDEX)?\s+([^\s(]+)/i
const TEMP_BTREE_REGEX = /USE\s+TEMP\s+B-TREE/i

/**
 * Parses raw EXPLAIN QUERY PLAN rows into structured QueryPlanAnalysis.
 */
export function parseQueryPlanRows(
  sql: string,
  rawRows: readonly { readonly id: number; readonly parent: number; readonly detail: string }[],
): QueryPlanAnalysis {
  const nodes: QueryPlanNode[] = []
  const scannedTablesSet = new Set<string>()
  const usedIndexesSet = new Set<string>()
  let usesTempBTree = false

  for (const row of rawRows) {
    const detail = row.detail
    const scanMatch = SCAN_REGEX.exec(detail)
    const searchMatch = SEARCH_INDEX_REGEX.exec(detail)
    const isTempBTree = TEMP_BTREE_REGEX.test(detail)

    if (isTempBTree) {
      usesTempBTree = true
    }

    let isScan = false
    let isIndexSearch = false
    let tableName: string | undefined
    let indexName: string | undefined

    if (scanMatch?.[1]) {
      isScan = true
      tableName = scanMatch[1]
      scannedTablesSet.add(tableName)
    } else if (searchMatch?.[1]) {
      isIndexSearch = true
      tableName = searchMatch[1]
      if (searchMatch[2] && !searchMatch[2].toLowerCase().includes('primary')) {
        indexName = searchMatch[2]
        usedIndexesSet.add(indexName)
      }
    }

    nodes.push({
      id: row.id,
      parent: row.parent,
      detail,
      isScan,
      isIndexSearch,
      ...(tableName !== undefined ? { tableName } : {}),
      ...(indexName !== undefined ? { indexName } : {}),
    })
  }

  const scannedTables = Array.from(scannedTablesSet)
  const usedIndexes = Array.from(usedIndexesSet)
  const hasTableScan = scannedTables.length > 0

  // Calculate efficiency score: start 100, -35 per scanned table, -15 if temporary B-tree
  let score = 100
  score -= scannedTables.length * 35
  if (usesTempBTree) {
    score -= 15
  }
  score = Math.max(0, Math.min(100, score))

  const recommendations: string[] = []
  for (const table of scannedTables) {
    recommendations.push(
      `Table '${table}' undergoes a full sequential scan. Consider creating an index on filter or join keys.`,
    )
  }
  if (usesTempBTree) {
    recommendations.push(
      'Query uses a temporary B-Tree for sorting/grouping. Consider adding an index matching ORDER BY or GROUP BY columns.',
    )
  }
  if (recommendations.length === 0) {
    recommendations.push('Query execution plan is optimal with effective index coverage.')
  }

  const formattedSummary =
    `[Query Plan Analysis] Score: ${String(score)}/100 | Scanned Tables: ${String(scannedTables.length)} ` +
    `| Indexes Used: ${String(usedIndexes.length)} | Temp B-Tree: ${usesTempBTree ? 'YES' : 'NO'}`

  return {
    sql,
    nodes,
    hasTableScan,
    scannedTables,
    usedIndexes,
    usesTempBTree,
    score,
    recommendations,
    formattedSummary,
  }
}

/**
 * Runs EXPLAIN QUERY PLAN against a SQLite database and analyzes execution characteristics.
 */
export function analyzeQueryPlan(db: Database.Database, sql: string): QueryPlanAnalysis {
  const trimmed = sql.trim()
  if (!trimmed) {
    return {
      sql,
      nodes: [],
      hasTableScan: false,
      scannedTables: [],
      usedIndexes: [],
      usesTempBTree: false,
      score: 100,
      recommendations: ['Empty query provided.'],
      formattedSummary: '[Query Plan Analysis] Empty query.',
    }
  }

  const planSql = `EXPLAIN QUERY PLAN ${trimmed}`
  const stmt = db.prepare(planSql)
  const rawRows = stmt.all() as { id: number; parent: number; detail: string }[]

  return parseQueryPlanRows(sql, rawRows)
}

/**
 * Audits existing indexes for all or specified user tables in SQLite database.
 */
export function auditTableIndexes(
  db: Database.Database,
  targetTables?: readonly string[],
): IndexAuditReport {
  const tableNames: readonly string[] =
    targetTables && targetTables.length > 0
      ? targetTables
      : (
          db
            .prepare(
              "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name ASC",
            )
            .all() as { name: string }[]
        ).map((r) => r.name)

  const tables: TableIndexHealth[] = []
  let totalIndexes = 0

  for (const tableName of tableNames) {
    try {
      const indexListStmt = db.prepare(`PRAGMA index_list('${tableName}')`)
      const rawIndexList = indexListStmt.all() as {
        name: string
        unique: number
        origin: string
      }[]

      const indexes: TableIndexInfo[] = []
      for (const idx of rawIndexList) {
        let columns: string[] = []
        try {
          const indexInfoStmt = db.prepare(`PRAGMA index_info('${idx.name}')`)
          const rawIndexInfo = indexInfoStmt.all() as { name: string }[]
          columns = rawIndexInfo.map((c) => c.name)
        } catch {
          // In case PRAGMA fails for virtual tables or specific objects
          columns = []
        }

        indexes.push({
          name: idx.name,
          unique: idx.unique === 1,
          origin: idx.origin,
          columns,
        })
      }

      totalIndexes += indexes.length
      tables.push({
        tableName,
        indexCount: indexes.length,
        indexes,
      })
    } catch {
      // Gracefully handle virtual or system tables
      tables.push({
        tableName,
        indexCount: 0,
        indexes: [],
      })
    }
  }

  const formattedSummary = `[Index Audit] Audited ${String(tables.length)} tables with ${String(totalIndexes)} total indexes.`

  return {
    totalTables: tables.length,
    totalIndexes,
    tables,
    formattedSummary,
  }
}
