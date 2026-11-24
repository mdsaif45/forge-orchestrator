/**
 * STATE-029: SQLite query optimizer planner hint injector and index forced-selection advisor.
 *
 * Analyzes query patterns over high-volume event logs and artifact ledgers,
 * injects SQLite query planner hints (INDEXED BY / NOT INDEXED), prevents full-table
 * scan regressions, and benchmarks index selection efficiency (Axioms A1, A4, A5).
 */

export type HintMode = 'INDEXED_BY' | 'NOT_INDEXED' | 'AUTO'

export interface TableIndexDefinition {
  readonly tableName: string
  readonly indexName: string
  readonly columns: readonly string[]
  readonly isUnique?: boolean | undefined
  readonly isCovering?: boolean | undefined
}

export interface QueryPlanHint {
  readonly tableName: string
  readonly indexName: string
  readonly hintType: HintMode
  readonly matchedColumns: readonly string[]
  readonly selectivityScore: number
  readonly reason: string
}

export interface OptimizationOptions {
  readonly forceIndex?: string | undefined
  readonly preventFullScan?: boolean | undefined
  readonly preferredTables?: readonly string[] | undefined
  readonly maxHints?: number | undefined
  readonly strictScanRejection?: boolean | undefined
}

export interface IndexAdvisoryReport {
  readonly originalQuery: string
  readonly optimizedQuery: string
  readonly hintsInjected: readonly QueryPlanHint[]
  readonly fullScanPrevented: boolean
  readonly estimatedCostReductionPercent: number
  readonly targetTables: readonly string[]
  readonly explanation: string
}

export class FullTableScanDetectedError extends Error {
  constructor(
    public readonly tableName: string,
    public readonly query: string,
  ) {
    super(
      `Full table scan detected on table "${tableName}" and rejected under strict optimization policy.`,
    )
    this.name = 'FullTableScanDetectedError'
  }
}

interface TableReference {
  readonly tableName: string
  readonly alias?: string | undefined
  readonly rawMatch: string
  readonly clauseType: 'FROM' | 'JOIN'
}

export class SqlitePlannerHintOptimizer {
  private readonly indexes = new Map<string, TableIndexDefinition[]>()

  constructor() {
    this.seedDefaultSchemaIndexes()
  }

  /**
   * Registers a single table index definition.
   */
  registerIndex(index: TableIndexDefinition): void {
    const tableKey = index.tableName.toLowerCase()
    let list = this.indexes.get(tableKey)
    if (!list) {
      list = []
      this.indexes.set(tableKey, list)
    }
    // Replace if exists, else append
    const existingIndex = list.findIndex(
      (i) => i.indexName.toLowerCase() === index.indexName.toLowerCase(),
    )
    if (existingIndex >= 0) {
      list[existingIndex] = { ...index }
    } else {
      list.push({ ...index })
    }
  }

  /**
   * Registers multiple table index definitions.
   */
  registerIndexes(indexes: readonly TableIndexDefinition[]): void {
    for (const index of indexes) {
      this.registerIndex(index)
    }
  }

  /**
   * Returns all registered index definitions for a given table.
   */
  getIndexesForTable(tableName: string): readonly TableIndexDefinition[] {
    return this.indexes.get(tableName.toLowerCase()) ?? []
  }

  /**
   * Analyzes an input SQL query, identifies optimal indexes, and injects SQLite planner hints.
   */
  optimizeQuery(sql: string, options: OptimizationOptions = {}): IndexAdvisoryReport {
    if (!sql || sql.trim().length === 0) {
      return {
        originalQuery: sql,
        optimizedQuery: sql,
        hintsInjected: [],
        fullScanPrevented: false,
        estimatedCostReductionPercent: 0,
        targetTables: [],
        explanation: 'Empty query; no optimization performed.',
      }
    }

    const trimmedSql = sql.trim()
    const tableRefs = this.extractTableReferences(trimmedSql)

    if (tableRefs.length === 0) {
      return {
        originalQuery: trimmedSql,
        optimizedQuery: trimmedSql,
        hintsInjected: [],
        fullScanPrevented: false,
        estimatedCostReductionPercent: 0,
        targetTables: [],
        explanation: 'No recognizable FROM or JOIN table clauses found.',
      }
    }

    const predicatesByTable = this.extractPredicates(trimmedSql, tableRefs)
    const hintsInjected: QueryPlanHint[] = []
    let modifiedSql = trimmedSql
    let fullScanPrevented = false

    const targetTables: string[] = []

    for (const ref of tableRefs) {
      targetTables.push(ref.tableName)

      // Check if table is filtered by options
      if (
        options.preferredTables &&
        !options.preferredTables.some((t) => t.toLowerCase() === ref.tableName.toLowerCase())
      ) {
        continue
      }

      // Check if already has INDEXED BY or NOT INDEXED
      const tableWithHintRegex = new RegExp(
        `\\b${ref.tableName}\\s+(INDEXED\\s+BY|NOT\\s+INDEXED)\\b`,
        'i',
      )
      if (tableWithHintRegex.test(modifiedSql)) {
        continue
      }

      const availableIndexes = this.getIndexesForTable(ref.tableName)
      const tablePredicates = predicatesByTable.get(ref.tableName) ?? []

      // If user forced index
      if (options.forceIndex) {
        const forced = availableIndexes.find(
          (i) => i.indexName.toLowerCase() === options.forceIndex?.toLowerCase(),
        )
        if (forced) {
          const hint: QueryPlanHint = {
            tableName: ref.tableName,
            indexName: forced.indexName,
            hintType: 'INDEXED_BY',
            matchedColumns: forced.columns,
            selectivityScore: 1.0,
            reason: `Forced index override requested by options.`,
          }
          hintsInjected.push(hint)
          modifiedSql = this.injectHintIntoClause(modifiedSql, ref, forced.indexName)
          continue
        }
      }

      // Evaluate best candidate index
      const bestCandidate = this.evaluateBestIndex(availableIndexes, tablePredicates)

      if (bestCandidate) {
        hintsInjected.push(bestCandidate)
        modifiedSql = this.injectHintIntoClause(modifiedSql, ref, bestCandidate.indexName)
        fullScanPrevented = true
      } else if (options.preventFullScan) {
        if (options.strictScanRejection) {
          throw new FullTableScanDetectedError(ref.tableName, trimmedSql)
        }
      }
    }

    const estimatedCostReductionPercent =
      hintsInjected.length > 0
        ? Math.min(
            90,
            Math.round(
              hintsInjected.reduce((acc, h) => acc + h.selectivityScore * 65, 0) /
                hintsInjected.length,
            ),
          )
        : 0

    const explanation =
      hintsInjected.length > 0
        ? `Injected ${String(hintsInjected.length)} planner hint(s) forcing selective index usage across ${hintsInjected.map((h) => h.tableName).join(', ')}.`
        : 'Query analyzed; no beneficial index hints injected.'

    return {
      originalQuery: trimmedSql,
      optimizedQuery: modifiedSql,
      hintsInjected,
      fullScanPrevented,
      estimatedCostReductionPercent,
      targetTables,
      explanation,
    }
  }

  private seedDefaultSchemaIndexes(): void {
    const defaults: TableIndexDefinition[] = [
      {
        tableName: 'events',
        indexName: 'idx_events_run_id',
        columns: ['run_id'],
      },
      {
        tableName: 'events',
        indexName: 'idx_events_run_seq',
        columns: ['run_id', 'seq'],
        isCovering: true,
      },
      {
        tableName: 'events',
        indexName: 'idx_events_type',
        columns: ['event_type'],
      },
      {
        tableName: 'events',
        indexName: 'idx_events_timestamp',
        columns: ['timestamp'],
      },
      {
        tableName: 'artifacts',
        indexName: 'idx_artifacts_run_id',
        columns: ['run_id'],
      },
      {
        tableName: 'artifacts',
        indexName: 'idx_artifacts_kind',
        columns: ['kind'],
      },
      {
        tableName: 'artifacts',
        indexName: 'idx_artifacts_path',
        columns: ['path'],
      },
      {
        tableName: 'runs',
        indexName: 'idx_runs_project',
        columns: ['project_id'],
      },
      {
        tableName: 'runs',
        indexName: 'idx_runs_status',
        columns: ['status'],
      },
      {
        tableName: 'steps',
        indexName: 'idx_steps_run_id',
        columns: ['run_id'],
      },
      {
        tableName: 'steps',
        indexName: 'idx_steps_state',
        columns: ['state'],
      },
    ]

    this.registerIndexes(defaults)
  }

  private extractTableReferences(sql: string): TableReference[] {
    const refs: TableReference[] = []
    const seen = new Set<string>()

    // Matches FROM <table> [AS <alias> | <alias>]
    const fromRegex =
      /\bFROM\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?(?=\s|$|,|\bWHERE\b|\bJOIN\b|\bLEFT\b|\bINNER\b|\bORDER\b|\bGROUP\b|\bLIMIT\b)/gi
    let match = fromRegex.exec(sql)
    while (match) {
      const tableName = match[1]
      const potentialAlias = match[2]
      if (tableName && !this.isSqlKeyword(tableName)) {
        const alias =
          potentialAlias && !this.isSqlKeyword(potentialAlias) ? potentialAlias : undefined
        const key = `${tableName.toLowerCase()}:${alias?.toLowerCase() ?? ''}`
        if (!seen.has(key)) {
          seen.add(key)
          refs.push({
            tableName,
            alias,
            rawMatch: match[0],
            clauseType: 'FROM',
          })
        }
      }
      match = fromRegex.exec(sql)
    }

    // Matches [LEFT|RIGHT|INNER|OUTER|CROSS]? JOIN <table> [AS <alias> | <alias>]
    const joinRegex =
      /\bJOIN\s+([a-zA-Z0-9_]+)(?:\s+(?:AS\s+)?([a-zA-Z0-9_]+))?(?=\s|$|\bON\b|\bUSING\b|\bWHERE\b)/gi
    match = joinRegex.exec(sql)
    while (match) {
      const tableName = match[1]
      const potentialAlias = match[2]
      if (tableName && !this.isSqlKeyword(tableName)) {
        const alias =
          potentialAlias && !this.isSqlKeyword(potentialAlias) ? potentialAlias : undefined
        const key = `${tableName.toLowerCase()}:${alias?.toLowerCase() ?? ''}`
        if (!seen.has(key)) {
          seen.add(key)
          refs.push({
            tableName,
            alias,
            rawMatch: match[0],
            clauseType: 'JOIN',
          })
        }
      }
      match = joinRegex.exec(sql)
    }

    return refs
  }

  private extractPredicates(sql: string, tables: TableReference[]): Map<string, string[]> {
    const map = new Map<string, string[]>()
    for (const t of tables) {
      map.set(t.tableName, [])
    }

    // Matches (table_or_alias.)column = ? / IN / > / <
    const predicateRegex =
      /(?:(?:([a-zA-Z0-9_]+)\.)?([a-zA-Z0-9_]+))\s*(?:=|IN|LIKE|IS|<|>|<=|>=|BETWEEN)/gi
    let match = predicateRegex.exec(sql)
    while (match) {
      const qualifier = match[1]?.toLowerCase()
      const column = match[2]?.toLowerCase()

      if (column && !this.isSqlKeyword(column)) {
        if (qualifier) {
          // Find matching table by table name or alias
          const matchedRef = tables.find(
            (t) => t.tableName.toLowerCase() === qualifier || t.alias?.toLowerCase() === qualifier,
          )
          if (matchedRef) {
            const list = map.get(matchedRef.tableName)
            if (list && !list.includes(column)) {
              list.push(column)
            }
          }
        } else {
          // Unqualified column: assign to all tables that might have it
          for (const list of map.values()) {
            if (!list.includes(column)) {
              list.push(column)
            }
          }
        }
      }
      match = predicateRegex.exec(sql)
    }

    return map
  }

  private evaluateBestIndex(
    availableIndexes: readonly TableIndexDefinition[],
    predicates: readonly string[],
  ): QueryPlanHint | undefined {
    if (availableIndexes.length === 0 || predicates.length === 0) {
      return undefined
    }

    let bestScore = 0
    let bestIndex: TableIndexDefinition | undefined
    let bestMatchedCols: string[] = []

    for (const idx of availableIndexes) {
      const matchedCols: string[] = []
      let leadingMatched = false

      // Check leading column match
      const firstCol = idx.columns[0]?.toLowerCase()
      if (firstCol && predicates.includes(firstCol)) {
        leadingMatched = true
        matchedCols.push(firstCol)
      }

      if (!leadingMatched) {
        continue
      }

      // Check secondary columns
      for (let i = 1; i < idx.columns.length; i++) {
        const col = idx.columns[i]?.toLowerCase()
        if (col && predicates.includes(col)) {
          matchedCols.push(col)
        } else {
          break
        }
      }

      let score = 0.5 + (matchedCols.length / idx.columns.length) * 0.4
      if (idx.isCovering) score += 0.08
      if (idx.isUnique) score += 0.05

      score = Math.min(1.0, score)

      if (score > bestScore) {
        bestScore = score
        bestIndex = idx
        bestMatchedCols = matchedCols
      }
    }

    if (!bestIndex || bestScore < 0.5) {
      return undefined
    }

    return {
      tableName: bestIndex.tableName,
      indexName: bestIndex.indexName,
      hintType: 'INDEXED_BY',
      matchedColumns: bestMatchedCols,
      selectivityScore: Math.round(bestScore * 100) / 100,
      reason: `Matches leading predicate columns (${bestMatchedCols.join(', ')}).`,
    }
  }

  private injectHintIntoClause(sql: string, ref: TableReference, indexName: string): string {
    // Construct target replacement:
    // "FROM table" -> "FROM table INDEXED BY index"
    // "FROM table alias" -> "FROM table INDEXED BY index alias"
    // "FROM table AS alias" -> "FROM table INDEXED BY index AS alias"
    // "JOIN table" -> "JOIN table INDEXED BY index"
    // "JOIN table alias" -> "JOIN table INDEXED BY index alias"

    const pattern = new RegExp(
      `\\b(${ref.clauseType}\\s+${ref.tableName})\\b(\\s+(?:AS\\s+)?[a-zA-Z0-9_]+)?`,
      'i',
    )

    return sql.replace(pattern, (_match, prefix: string, aliasPart: string | undefined) => {
      const aliasStr = aliasPart ?? ''
      return `${prefix} INDEXED BY ${indexName}${aliasStr}`
    })
  }

  private isSqlKeyword(str: string): boolean {
    const keywords = new Set([
      'select',
      'from',
      'where',
      'and',
      'or',
      'join',
      'inner',
      'left',
      'right',
      'outer',
      'cross',
      'on',
      'using',
      'order',
      'by',
      'group',
      'limit',
      'offset',
      'as',
      'asc',
      'desc',
      'is',
      'null',
      'not',
      'in',
      'like',
      'between',
    ])
    return keywords.has(str.toLowerCase())
  }
}
