import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Database from 'better-sqlite3'
import { searchDatabaseEvents, generateSearchSnippet } from './eventSearchEngine'

describe('EventSearchEngine (STATE-013)', () => {
  let db: Database.Database

  beforeEach(() => {
    db = new Database(':memory:')
    db.exec(`
      CREATE TABLE runs_events (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        run_id TEXT NOT NULL,
        type TEXT NOT NULL,
        step_id TEXT,
        timestamp INTEGER NOT NULL,
        payload TEXT NOT NULL
      );
    `)

    // Seed events
    const insert = db.prepare(`
      INSERT INTO runs_events (id, seq, run_id, type, step_id, timestamp, payload)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)

    insert.run(
      'ev-1',
      1,
      'run-1',
      'step_start',
      'step-a',
      1000,
      JSON.stringify({ action: 'compile', file: 'main.ts' }),
    )
    insert.run(
      'ev-2',
      2,
      'run-1',
      'step_error',
      'step-a',
      1100,
      JSON.stringify({ error: 'Connection timeout to provider' }),
    )
    insert.run(
      'ev-3',
      3,
      'run-2',
      'step_finish',
      'step-b',
      1200,
      JSON.stringify({ status: 'success', summary: 'All tests passed' }),
    )
    insert.run(
      'ev-4',
      4,
      'run-2',
      'tool_output',
      'step-c',
      1300,
      JSON.stringify({ output: 'timeout occurred during test suite' }),
    )
  })

  afterEach(() => {
    db.close()
  })

  it('generates centered snippet around matching term', () => {
    const text = 'The quick brown fox jumps over the lazy dog near the riverbank.'
    const snippet = generateSearchSnippet(text, ['lazy'], 10)
    expect(snippet).toContain('lazy')
    expect(snippet).toContain('over the')
  })

  it('handles empty search query gracefully', () => {
    const res = searchDatabaseEvents(db, { query: '' })
    expect(res.totalHits).toBe(0)
    expect(res.hits).toHaveLength(0)
    expect(res.formattedSummary).toContain('No query string provided')
  })

  it('searches events by keyword and ranks results by frequency', () => {
    const res = searchDatabaseEvents(db, { query: 'timeout' })
    expect(res.totalHits).toBe(2)
    expect(res.hits[0]?.runId).toBeDefined()
    expect(res.hits.some((h) => h.eventId === 'ev-2')).toBe(true)
    expect(res.hits.some((h) => h.eventId === 'ev-4')).toBe(true)
  })

  it('filters search results by runId', () => {
    const res = searchDatabaseEvents(db, { query: 'timeout', runId: 'run-1' })
    expect(res.totalHits).toBe(1)
    expect(res.hits[0]?.eventId).toBe('ev-2')
    expect(res.hits[0]?.runId).toBe('run-1')
  })

  it('filters search results by event type', () => {
    const res = searchDatabaseEvents(db, { query: 'timeout', type: 'tool_output' })
    expect(res.totalHits).toBe(1)
    expect(res.hits[0]?.eventId).toBe('ev-4')
    expect(res.hits[0]?.type).toBe('tool_output')
  })

  it('respects limit constraints', () => {
    const res = searchDatabaseEvents(db, { query: 'timeout', limit: 1 })
    expect(res.totalHits).toBe(2)
    expect(res.hits).toHaveLength(1)
  })
})
