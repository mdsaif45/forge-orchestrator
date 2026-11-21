/**
 * Copyright (c) 2026 Forge Authors
 * Technology: TypeScript / Node.js
 * Architecture: SQLite Query Plan Cost Estimator & Index Advisory Engine (STATE-024)
 * Axioms Enforced:
 *  - A1: Bugs are bounded & fail-closed (identifies table scans and plan bottlenecks).
 *  - A4: Decisions lock (idempotent, safe index DDL suggestions).
 *  - A5: Bounded processing loops and query analysis time.
 */

export interface IndexAdvisorPlanNode {
  readonly id?: number | undefined
  readonly parent?: number | undefined
  readonly notused?: number | undefined
  readonly detail: string
}

export interface IndexRecommendation {
  readonly tableName: string
  readonly columns: readonly string[]
  readonly suggestedIndexName: string
  readonly ddlStatement: string
  readonly estimatedCostReductionPercent: number
  readonly reason: string
}

export interface QueryPlanAuditReport {
  readonly totalPlanNodes: number
  readonly hasTableScan: boolean
  readonly hasTempBTree: boolean
  readonly scannedTables: readonly string[]
  readonly overallCostScore: number
  readonly recommendations: readonly IndexRecommendation[]
  readonly summary: string
}

function extractPredicatesForTable(sql: string, tableName: string): string[] {
  const columns = new Set<string>()

  // Matches WHERE ... or AND ... col = ? or col IN (...)
  const whereMatch = /(?:WHERE|AND|OR)\s+([a-zA-Z0-9_]+)\s*(?:=|IN|LIKE|<|>|<=|>=)/gi
  let match = whereMatch.exec(sql)
  while (match) {
    const col = match[1]?.toLowerCase()
    if (col && col !== 'select' && col !== 'where' && col !== 'and' && col !== 'or') {
      columns.add(col)
    }
    match = whereMatch.exec(sql)
  }

  // Matches ORDER BY col1, col2
  const orderMatch = /ORDER\s+BY\s+([a-zA-Z0-9_,\s]+)(?:ASC|DESC|LIMIT|;|$)/i.exec(sql)
  if (orderMatch?.[1]) {
    const orderCols = orderMatch[1].split(',')
    for (const c of orderCols) {
      const clean = c.trim().split(/\s+/)[0]?.toLowerCase()
      if (clean && clean.length > 0) {
        columns.add(clean)
      }
    }
  }

  if (columns.size === 0) {
    // Default fallback index column for table based on common patterns
    if (tableName === 'events') {
      return ['run_id', 'event_type']
    }
    if (tableName === 'artifacts') {
      return ['run_id', 'kind']
    }
    return ['id']
  }

  return Array.from(columns).slice(0, 3)
}

export class SqliteIndexAdvisoryEngine {
  /**
   * Evaluates query plan nodes and generates indexing recommendations.
   */
  public evaluateQueryPlan(
    nodes: readonly IndexAdvisorPlanNode[],
    sqlQuery = '',
  ): QueryPlanAuditReport {
    const scannedTables: string[] = []
    let hasTempBTree = false
    let costScore = 0

    for (const node of nodes) {
      const detail = node.detail.trim()

      if (/SCAN\s+TABLE/i.test(detail)) {
        // e.g., "SCAN TABLE events" or "SCAN TABLE artifacts USING INDEX ..."
        const match = /SCAN\s+TABLE\s+([a-zA-Z0-9_]+)/i.exec(detail)
        if (match?.[1]) {
          const tbl = match[1].toLowerCase()
          if (!scannedTables.includes(tbl)) {
            scannedTables.push(tbl)
          }
        }
        costScore += 500
      } else if (/SEARCH\s+TABLE/i.test(detail)) {
        costScore += 20
      }

      if (/USE\s+TEMP\s+B-TREE/i.test(detail)) {
        hasTempBTree = true
        costScore += 200
      }
    }

    const hasTableScan = scannedTables.length > 0
    const recommendations: IndexRecommendation[] = []

    for (const tbl of scannedTables) {
      const cols = extractPredicatesForTable(sqlQuery, tbl)
      const indexName = `idx_${tbl}_${cols.join('_')}`
      const ddlStatement = `CREATE INDEX IF NOT EXISTS ${indexName} ON ${tbl} (${cols.join(', ')});`

      recommendations.push({
        tableName: tbl,
        columns: cols,
        suggestedIndexName: indexName,
        ddlStatement,
        estimatedCostReductionPercent: 90,
        reason: `Full table scan detected on '${tbl}'. An index covering (${cols.join(', ')}) eliminates sequential table scans.`,
      })
    }

    const summary = hasTableScan
      ? `Query plan contains ${String(scannedTables.length)} full table scan(s) (Tables: ${scannedTables.join(', ')}). Suggested ${String(recommendations.length)} index(es) to reduce cost score from ${String(costScore)}.`
      : `Query plan is optimized (Cost score: ${String(costScore)}, 0 table scans detected).`

    return {
      totalPlanNodes: nodes.length,
      hasTableScan,
      hasTempBTree,
      scannedTables,
      overallCostScore: costScore,
      recommendations,
      summary,
    }
  }
}
