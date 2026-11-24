import { describe, it, expect } from 'vitest'
import { SqliteIndexAdvisoryEngine, type IndexAdvisorPlanNode } from './sqliteIndexAdvisoryEngine'

describe('SqliteIndexAdvisoryEngine (STATE-024)', () => {
  const engine = new SqliteIndexAdvisoryEngine()

  it('detects SCAN TABLE and generates index recommendation with high cost score', () => {
    const nodes: IndexAdvisorPlanNode[] = [{ id: 2, parent: 0, detail: 'SCAN TABLE events' }]
    const sql = 'SELECT * FROM events WHERE run_id = ? AND event_type = ?;'

    const report = engine.evaluateQueryPlan(nodes, sql)

    expect(report.hasTableScan).toBe(true)
    expect(report.scannedTables).toContain('events')
    expect(report.overallCostScore).toBeGreaterThanOrEqual(500)
    expect(report.recommendations).toHaveLength(1)

    const rec = report.recommendations[0]
    expect(rec?.tableName).toBe('events')
    expect(rec?.columns).toContain('run_id')
    expect(rec?.columns).toContain('event_type')
    expect(rec?.ddlStatement).toContain('CREATE INDEX IF NOT EXISTS idx_events_')
    expect(rec?.estimatedCostReductionPercent).toBe(90)
  })

  it('identifies USE TEMP B-TREE in query plan', () => {
    const nodes: IndexAdvisorPlanNode[] = [
      {
        id: 1,
        parent: 0,
        detail: 'SEARCH TABLE artifacts USING INDEX idx_artifacts_run (run_id=?)',
      },
      { id: 2, parent: 0, detail: 'USE TEMP B-TREE FOR ORDER BY' },
    ]
    const report = engine.evaluateQueryPlan(nodes)

    expect(report.hasTempBTree).toBe(true)
    expect(report.hasTableScan).toBe(false)
    expect(report.overallCostScore).toBe(220)
  })

  it('reports optimized query when only SEARCH TABLE is present', () => {
    const nodes: IndexAdvisorPlanNode[] = [
      { id: 1, parent: 0, detail: 'SEARCH TABLE runs USING COVERING INDEX idx_runs_id (id=?)' },
    ]
    const report = engine.evaluateQueryPlan(nodes)

    expect(report.hasTableScan).toBe(false)
    expect(report.hasTempBTree).toBe(false)
    expect(report.overallCostScore).toBe(20)
    expect(report.recommendations).toHaveLength(0)
    expect(report.summary).toContain('Query plan is optimized')
  })

  it('provides safe fallback columns when SQL query text is omitted', () => {
    const nodes: IndexAdvisorPlanNode[] = [{ id: 1, parent: 0, detail: 'SCAN TABLE events' }]
    const report = engine.evaluateQueryPlan(nodes, '')

    expect(report.recommendations).toHaveLength(1)
    expect(report.recommendations[0]?.columns).toEqual(['run_id', 'event_type'])
  })
})
