import { describe, expect, it } from 'vitest'
import { SqliteSnapshotBarrierManager } from './sqliteSnapshotBarrierManager'

describe('SqliteSnapshotBarrierManager', () => {
  it('creates and releases read barriers cleanly', () => {
    const mgr = new SqliteSnapshotBarrierManager()
    const barrier = mgr.createBarrier('audit-run-1', { runId: 'run-1' })
    expect(barrier.barrierId).toBeDefined()
    expect(barrier.purpose).toBe('audit-run-1')
    expect(barrier.released).toBe(false)
    expect(barrier.activeReadersCount).toBe(0)

    const active = mgr.getActiveBarriers()
    expect(active).toHaveLength(1)
    expect(active[0]?.barrierId).toBe(barrier.barrierId)

    const released = mgr.releaseBarrier(barrier.barrierId)
    expect(released).toBe(true)

    const activeAfter = mgr.getActiveBarriers()
    expect(activeAfter).toHaveLength(0)
  })

  it('acquires and releases active readers on a barrier', () => {
    const mgr = new SqliteSnapshotBarrierManager()
    const barrier = mgr.createBarrier('query-search')

    const acquired = mgr.acquireReader(barrier.barrierId)
    expect(acquired).toBe(true)

    const active = mgr.getActiveBarriers()
    expect(active[0]?.activeReadersCount).toBe(1)

    const releasedReader = mgr.releaseReader(barrier.barrierId)
    expect(releasedReader).toBe(true)

    const activeAfter = mgr.getActiveBarriers()
    expect(activeAfter[0]?.activeReadersCount).toBe(0)
  })

  it('prunes stale barriers exceeding TTL', () => {
    let now = 10000
    const mgr = new SqliteSnapshotBarrierManager({
      staleBarrierTtlMs: 5000,
      clock: () => now,
    })

    const b1 = mgr.createBarrier('short-lived')
    now += 2000
    const b2 = mgr.createBarrier('newer')

    now += 4000 // now = 16000. b1 age = 6000 > 5000. b2 age = 4000 < 5000.
    const pruned = mgr.pruneStaleBarriers()
    expect(pruned).toBe(1)

    const remaining = mgr.getActiveBarriers()
    expect(remaining).toHaveLength(1)
    expect(remaining[0]?.barrierId).toBe(b2.barrierId)
    expect(b1.barrierId).not.toBe(b2.barrierId)
  })

  it('computes barrier statistics and oldest active age', () => {
    let now = 1000
    const mgr = new SqliteSnapshotBarrierManager({
      clock: () => now,
    })

    mgr.createBarrier('b1')
    now += 500
    mgr.createBarrier('b2')

    const stats = mgr.getBarrierStats()
    expect(stats.totalCreated).toBe(2)
    expect(stats.activeCount).toBe(2)
    expect(stats.oldestActiveAgeMs).toBe(500)

    const summary = mgr.formatSummary()
    expect(summary).toContain('SQLite Snapshot Barrier Manager')
    expect(summary).toContain('Active Barriers: 2')
  })

  it('throws error on invalid parameters', () => {
    expect(() => new SqliteSnapshotBarrierManager({ staleBarrierTtlMs: 0 })).toThrow(
      'staleBarrierTtlMs must be greater than 0',
    )
    const mgr = new SqliteSnapshotBarrierManager()
    expect(() => mgr.createBarrier('')).toThrow('Barrier purpose is required')
  })
})
