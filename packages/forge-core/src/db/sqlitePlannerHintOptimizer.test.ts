import { describe, expect, it } from 'vitest'
import {
  FullTableScanDetectedError,
  SqlitePlannerHintOptimizer,
} from './sqlitePlannerHintOptimizer'

describe('SqlitePlannerHintOptimizer (STATE-029)', () => {
  const optimizer = new SqlitePlannerHintOptimizer()

  it('injects INDEXED BY hint for single table query with matching predicate column', () => {
    const query = 'SELECT * FROM events WHERE run_id = ?'
    const report = optimizer.optimizeQuery(query)

    expect(report.hintsInjected).toHaveLength(1)
    expect(report.hintsInjected[0]!.tableName).toBe('events')
    expect(report.hintsInjected[0]!.indexName).toBe('idx_events_run_id')
    expect(report.hintsInjected[0]!.hintType).toBe('INDEXED_BY')
    expect(report.optimizedQuery).toBe(
      'SELECT * FROM events INDEXED BY idx_events_run_id WHERE run_id = ?',
    )
    expect(report.fullScanPrevented).toBe(true)
    expect(report.estimatedCostReductionPercent).toBeGreaterThan(0)
  })

  it('prefers multi-column covering index when multiple predicate columns are queried', () => {
    const query = 'SELECT * FROM events WHERE run_id = ? AND seq = ?'
    const report = optimizer.optimizeQuery(query)

    expect(report.hintsInjected).toHaveLength(1)
    expect(report.hintsInjected[0]!.indexName).toBe('idx_events_run_seq')
    expect(report.hintsInjected[0]!.matchedColumns).toEqual(['run_id', 'seq'])
    expect(report.optimizedQuery).toBe(
      'SELECT * FROM events INDEXED BY idx_events_run_seq WHERE run_id = ? AND seq = ?',
    )
  })

  it('preserves table aliases when injecting INDEXED BY into FROM and JOIN clauses', () => {
    const query =
      'SELECT e.id, a.path FROM events e JOIN artifacts a ON a.run_id = e.run_id WHERE e.run_id = ?'
    const report = optimizer.optimizeQuery(query)

    expect(report.targetTables).toContain('events')
    expect(report.targetTables).toContain('artifacts')
    expect(report.optimizedQuery).toContain('FROM events INDEXED BY idx_events_run_id e')
    expect(report.optimizedQuery).toContain('JOIN artifacts INDEXED BY idx_artifacts_run_id a')
  })

  it('respects forceIndex option overriding natural selectivity scoring', () => {
    const query = 'SELECT * FROM events WHERE timestamp > ?'
    const report = optimizer.optimizeQuery(query, {
      forceIndex: 'idx_events_timestamp',
    })

    expect(report.hintsInjected).toHaveLength(1)
    expect(report.hintsInjected[0]!.indexName).toBe('idx_events_timestamp')
    expect(report.optimizedQuery).toContain('INDEXED BY idx_events_timestamp')
  })

  it('throws FullTableScanDetectedError when strictScanRejection is true and no index matches', () => {
    const unindexedQuery = 'SELECT * FROM events WHERE unindexed_custom_col = ?'

    expect(() => {
      optimizer.optimizeQuery(unindexedQuery, {
        preventFullScan: true,
        strictScanRejection: true,
      })
    }).toThrow(FullTableScanDetectedError)
  })

  it('skips hint injection when table clause already contains INDEXED BY', () => {
    const preHintedQuery = 'SELECT * FROM events INDEXED BY idx_events_type WHERE event_type = ?'
    const report = optimizer.optimizeQuery(preHintedQuery)

    expect(report.hintsInjected).toHaveLength(0)
    expect(report.optimizedQuery).toBe(preHintedQuery)
  })

  it('safely handles empty queries or statements without recognizable table clauses', () => {
    expect(optimizer.optimizeQuery('').hintsInjected).toHaveLength(0)
    expect(optimizer.optimizeQuery('SELECT 1 + 1').hintsInjected).toHaveLength(0)
  })

  it('allows registering and utilizing custom table indexes', () => {
    const customOptimizer = new SqlitePlannerHintOptimizer()
    customOptimizer.registerIndex({
      tableName: 'metrics',
      indexName: 'idx_metrics_recorded_at',
      columns: ['recorded_at'],
    })

    const report = customOptimizer.optimizeQuery('SELECT * FROM metrics WHERE recorded_at >= ?')
    expect(report.hintsInjected).toHaveLength(1)
    expect(report.hintsInjected[0]!.tableName).toBe('metrics')
    expect(report.hintsInjected[0]!.indexName).toBe('idx_metrics_recorded_at')
    expect(report.optimizedQuery).toContain('INDEXED BY idx_metrics_recorded_at')
  })
})
