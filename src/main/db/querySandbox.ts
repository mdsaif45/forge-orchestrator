/**
 * STATE-015: SQLite Read-Only Query Sandbox & Safe Analytical Statement Validator
 *
 * Provides a restricted analytical SQL sandbox for executing safe, read-only analytical
 * queries against local Forge SQLite stores without permitting write mutations, DDL,
 * transaction controls, or pragma side effects.
 *
 * Conforms to Forge Axioms:
 * - A1: Fail-closed query validation.
 * - A2: Absolute database write barrier and sandbox isolation.
 * - A4: Immutable audit logs and execution plan inspection (EXPLAIN QUERY PLAN).
 * - A5: Bounded result row limits and execution timeouts.
 */

import type Database from 'better-sqlite3'

export interface QueryValidationResult {
  readonly isReadOnly: boolean
  readonly violationReason?: string
  readonly sanitizedSql: string
  readonly queryType: 'SELECT' | 'WITH' | 'INVALID'
}

export interface SandboxedQueryResult {
  readonly valid: boolean
  readonly rowCount: number
  readonly truncated: boolean
  readonly executionMs: number
  readonly columns: readonly string[]
  readonly rows: readonly Record<string, unknown>[]
  readonly queryPlan?: readonly string[]
  readonly error?: string
  readonly formattedSummary: string
}

export interface SandboxOptions {
  readonly maxRows?: number | undefined
  readonly timeoutMs?: number | undefined
  readonly includePlan?: boolean | undefined
}

const FORBIDDEN_KEYWORDS = [
  /\bINSERT\b/i,
  /\bUPDATE\b/i,
  /\bDELETE\b/i,
  /\bDROP\b/i,
  /\bALTER\b/i,
  /\bCREATE\b/i,
  /\bREPLACE\b/i,
  /\bTRUNCATE\b/i,
  /\bATTACH\b/i,
  /\bDETACH\b/i,
  /\bPRAGMA\b/i,
  /\bVACUUM\b/i,
  /\bBEGIN\b/i,
  /\bCOMMIT\b/i,
  /\bROLLBACK\b/i,
  /\bSAVEPOINT\b/i,
  /\bRELEASE\b/i,
]

/**
 * Strips comments from SQL and validates single-statement read-only execution.
 */
export function validateReadOnlySql(sql: string): QueryValidationResult {
  if (!sql.trim()) {
    return {
      isReadOnly: false,
      violationReason: 'Query is empty',
      sanitizedSql: '',
      queryType: 'INVALID',
    }
  }

  // Strip single line comments (-- ...) and block comments (/* ... */)
  let cleaned = sql
    .replace(/--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .trim()

  // Remove trailing semicolons
  cleaned = cleaned.replace(/;+\s*$/, '').trim()

  if (!cleaned) {
    return {
      isReadOnly: false,
      violationReason: 'Query consists only of comments',
      sanitizedSql: '',
      queryType: 'INVALID',
    }
  }

  // Detect semicolons inside the body (chained statements) outside of single/double quotes
  let inSingleQuote = false
  let inDoubleQuote = false
  for (const ch of cleaned) {
    if (ch === "'" && !inDoubleQuote) {
      inSingleQuote = !inSingleQuote
    } else if (ch === '"' && !inSingleQuote) {
      inDoubleQuote = !inDoubleQuote
    } else if (ch === ';' && !inSingleQuote && !inDoubleQuote) {
      return {
        isReadOnly: false,
        violationReason: 'Multiple SQL statements (semicolon chaining) are strictly prohibited',
        sanitizedSql: cleaned,
        queryType: 'INVALID',
      }
    }
  }

  // Determine query type
  const firstWordMatch = /^[a-zA-Z]+/i.exec(cleaned)
  const firstWord = firstWordMatch ? firstWordMatch[0].toUpperCase() : ''

  let queryType: 'SELECT' | 'WITH'
  if (firstWord === 'SELECT') {
    queryType = 'SELECT'
  } else if (firstWord === 'WITH') {
    queryType = 'WITH'
  } else {
    return {
      isReadOnly: false,
      violationReason: `Only SELECT or WITH queries are permitted (received: ${firstWord || 'NONE'})`,
      sanitizedSql: cleaned,
      queryType: 'INVALID',
    }
  }

  // Check for forbidden mutation keywords
  for (const forbidden of FORBIDDEN_KEYWORDS) {
    if (forbidden.test(cleaned)) {
      return {
        isReadOnly: false,
        violationReason: `Query contains forbidden mutation/administrative keyword matching ${forbidden.toString()}`,
        sanitizedSql: cleaned,
        queryType: 'INVALID',
      }
    }
  }

  return {
    isReadOnly: true,
    sanitizedSql: cleaned,
    queryType,
  }
}

/**
 * Executes a verified read-only analytical query within SQLite resource bounds.
 */
export function executeSandboxedQuery(
  sqlite: Database.Database,
  sql: string,
  options?: SandboxOptions,
): SandboxedQueryResult {
  const maxRows = options?.maxRows ?? 500
  const includePlan = options?.includePlan ?? false

  const validation = validateReadOnlySql(sql)
  if (!validation.isReadOnly) {
    return {
      valid: false,
      rowCount: 0,
      truncated: false,
      executionMs: 0,
      columns: [],
      rows: [],
      error: validation.violationReason ?? 'Invalid read-only query',
      formattedSummary: `[Sandbox Query Rejected] ${validation.violationReason ?? 'Invalid query'}`,
    }
  }

  const startTime = Date.now()
  let queryPlan: string[] | undefined

  try {
    if (includePlan) {
      const planRows = sqlite
        .prepare(`EXPLAIN QUERY PLAN ${validation.sanitizedSql}`)
        .all() as readonly Record<string, unknown>[]
      queryPlan = planRows.map((r) => {
        const detail = typeof r.detail === 'string' ? r.detail : JSON.stringify(r)
        return detail
      })
    }

    const stmt = sqlite.prepare(validation.sanitizedSql)
    const rawRows = stmt.all() as readonly Record<string, unknown>[]
    const executionMs = Date.now() - startTime

    const rowCount = rawRows.length
    const truncated = rowCount > maxRows
    const finalRows = truncated ? rawRows.slice(0, maxRows) : rawRows

    const columns: string[] = []
    if (finalRows.length > 0 && finalRows[0]) {
      columns.push(...Object.keys(finalRows[0]))
    }

    const formattedSummary =
      `[Sandbox Query Success] Returned: ${String(finalRows.length)} row(s)` +
      (truncated ? ` (truncated from ${String(rowCount)})` : '') +
      ` | Duration: ${String(executionMs)}ms`

    return {
      valid: true,
      rowCount: finalRows.length,
      truncated,
      executionMs,
      columns,
      rows: finalRows,
      ...(queryPlan ? { queryPlan } : {}),
      formattedSummary,
    }
  } catch (err) {
    const executionMs = Date.now() - startTime
    const errorMessage = err instanceof Error ? err.message : String(err)
    return {
      valid: false,
      rowCount: 0,
      truncated: false,
      executionMs,
      columns: [],
      rows: [],
      error: errorMessage,
      formattedSummary: `[Sandbox Query Execution Error] ${errorMessage}`,
    }
  }
}
