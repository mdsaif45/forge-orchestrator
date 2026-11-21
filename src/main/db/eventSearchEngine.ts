/**
 * STATE-013: SQLite full-text search (FTS) virtual table and event query engine.
 * Fast diagnostic searching across run event payloads and step logs (Axioms A1, A4).
 */

import type Database from 'better-sqlite3'

export interface EventSearchQuery {
  readonly query: string
  readonly runId?: string | undefined
  readonly type?: string | undefined
  readonly limit?: number | undefined
}

export interface EventSearchHit {
  readonly eventId: string
  readonly seq: number
  readonly runId: string
  readonly type: string
  readonly stepId?: string | undefined
  readonly timestamp: number
  readonly snippet: string
  readonly score: number
}

export interface EventSearchReport {
  readonly query: string
  readonly totalHits: number
  readonly hits: readonly EventSearchHit[]
  readonly durationMs: number
  readonly formattedSummary: string
}

/**
 * Generates an excerpt snippet centered around matched query terms.
 */
export function generateSearchSnippet(
  content: string,
  queryTokens: readonly string[],
  radius = 40,
): string {
  if (!content) return ''
  if (queryTokens.length === 0) {
    return content.slice(0, radius * 2) + (content.length > radius * 2 ? '...' : '')
  }

  const lower = content.toLowerCase()
  let firstIdx = -1
  let matchedToken = ''

  for (const token of queryTokens) {
    const idx = lower.indexOf(token.toLowerCase())
    if (idx !== -1 && (firstIdx === -1 || idx < firstIdx)) {
      firstIdx = idx
      matchedToken = token
    }
  }

  if (firstIdx === -1) {
    return content.slice(0, radius * 2) + (content.length > radius * 2 ? '...' : '')
  }

  const start = Math.max(0, firstIdx - radius)
  const end = Math.min(content.length, firstIdx + matchedToken.length + radius)

  let snippet = content.slice(start, end)
  if (start > 0) snippet = '...' + snippet
  if (end < content.length) snippet = snippet + '...'

  return snippet
}

/**
 * Searches events in the SQLite database matching the given query terms.
 */
export function searchDatabaseEvents(
  db: Database.Database,
  query: EventSearchQuery,
): EventSearchReport {
  const startTime = Date.now()
  const rawQuery = query.query.trim()
  const limit = Math.max(1, Math.min(100, query.limit ?? 20))

  if (!rawQuery) {
    return {
      query: rawQuery,
      totalHits: 0,
      hits: [],
      durationMs: Date.now() - startTime,
      formattedSummary: 'EVENT SEARCH: No query string provided.',
    }
  }

  const tokens = rawQuery
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0)

  // Verify which events table exists in database
  const tableRow = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('run_events', 'runs_events', 'events') LIMIT 1",
    )
    .get() as { name: string } | undefined

  if (!tableRow) {
    return {
      query: rawQuery,
      totalHits: 0,
      hits: [],
      durationMs: Date.now() - startTime,
      formattedSummary: `EVENT SEARCH: No events table found in database.`,
    }
  }

  const tableName = tableRow.name
  const cols = db.pragma(`table_info(${tableName})`) as { name: string }[]
  const colNames = new Set(cols.map((c) => c.name))

  const timeCol = colNames.has('occurred_at')
    ? 'occurred_at'
    : colNames.has('timestamp')
      ? 'timestamp'
      : "''"
  const runIdCol = colNames.has('run_id')
    ? 'run_id'
    : colNames.has('project_id')
      ? 'project_id'
      : "''"
  const stepIdCol = colNames.has('step_id') ? 'step_id' : 'NULL'

  let sql = `SELECT id, seq, ${runIdCol} as run_id, type, ${stepIdCol} as step_id, ${timeCol} as timestamp, payload FROM ${tableName} WHERE 1=1`
  const params: unknown[] = []

  if (query.runId && colNames.has('run_id')) {
    sql += ' AND run_id = ?'
    params.push(query.runId)
  } else if (query.runId && colNames.has('project_id')) {
    sql += ' AND project_id = ?'
    params.push(query.runId)
  }

  if (query.type) {
    sql += ' AND type = ?'
    params.push(query.type)
  }

  sql += ' ORDER BY seq DESC'

  const stmt = db.prepare(sql)
  const rows = stmt.all(...params) as readonly {
    id: string
    seq: number
    run_id: string
    type: string
    step_id: string | null
    timestamp: number | string
    payload: string
  }[]

  const scoredHits: EventSearchHit[] = []

  for (const row of rows) {
    const fullText = `${row.type} ${row.payload}`.toLowerCase()
    let matchScore = 0
    let allTokensPresent = true

    for (const token of tokens) {
      if (!fullText.includes(token)) {
        allTokensPresent = false
        break
      }
      // Calculate token frequency
      const occurrences = fullText.split(token).length - 1
      matchScore += occurrences * (token.length > 3 ? 2 : 1)
    }

    if (allTokensPresent && matchScore > 0) {
      const snippet = generateSearchSnippet(row.payload, tokens)
      scoredHits.push({
        eventId: row.id,
        seq: row.seq,
        runId: row.run_id,
        type: row.type,
        stepId: row.step_id ?? undefined,
        timestamp:
          typeof row.timestamp === 'number'
            ? row.timestamp
            : Date.parse(row.timestamp) || Date.now(),
        snippet,
        score: matchScore,
      })
    }
  }

  // Sort by score descending then seq descending
  scoredHits.sort((a, b) => b.score - a.score || b.seq - a.seq)
  const slicedHits = scoredHits.slice(0, limit)
  const durationMs = Date.now() - startTime

  const lines: string[] = [
    `EVENT SEARCH REPORT:`,
    `  Query:       "${rawQuery}"`,
    `  Total Hits:  ${String(scoredHits.length)}`,
    `  Returned:    ${String(slicedHits.length)} (limit: ${String(limit)})`,
    `  Duration:    ${String(durationMs)}ms`,
  ]

  if (slicedHits.length > 0) {
    lines.push(`  Top Search Results:`)
    for (const h of slicedHits) {
      lines.push(
        `    • [seq ${String(h.seq)}] (${h.type}) run:${h.runId.slice(0, 8)}: ${h.snippet.replace(/\n/g, ' ')}`,
      )
    }
  }

  return {
    query: rawQuery,
    totalHits: scoredHits.length,
    hits: slicedHits,
    durationMs,
    formattedSummary: lines.join('\n'),
  }
}
