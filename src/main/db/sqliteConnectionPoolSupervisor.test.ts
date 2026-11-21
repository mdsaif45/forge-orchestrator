import { describe, expect, it } from 'vitest'
import { SqliteConnectionPoolSupervisor } from './sqliteConnectionPoolSupervisor'

describe('SqliteConnectionPoolSupervisor', () => {
  it('checks out and releases connection leases cleanly', () => {
    const simulatedTime = 1000
    const pool = new SqliteConnectionPoolSupervisor({
      maxConnections: 5,
      clock: () => simulatedTime,
    })

    const lease1 = pool.checkout({ runId: 'run-1', stepId: 'step-a', purpose: 'read-ledger' })
    expect(lease1.leaseId).toBeDefined()
    expect(lease1.connectionId).toBe('conn_1')
    expect(lease1.attribution.runId).toBe('run-1')
    expect(lease1.released).toBe(false)

    const telemetry = pool.getPoolTelemetry()
    expect(telemetry.activeLeases).toBe(1)
    expect(telemetry.availableConnections).toBe(4)

    const released = pool.release(lease1.leaseId)
    expect(released).toBe(true)

    const releasedAgain = pool.release(lease1.leaseId)
    expect(releasedAgain).toBe(false)

    const afterTelemetry = pool.getPoolTelemetry()
    expect(afterTelemetry.activeLeases).toBe(0)
    expect(afterTelemetry.availableConnections).toBe(5)
  })

  it('rejects checkouts when pool capacity is exhausted with POOL_CAPACITY_EXCEEDED', () => {
    const pool = new SqliteConnectionPoolSupervisor({
      maxConnections: 2,
    })

    const lease1 = pool.checkout({ runId: 'run-1' })
    const lease2 = pool.checkout({ runId: 'run-2' })
    expect(lease1).toBeDefined()
    expect(lease2).toBeDefined()

    expect(() => pool.checkout({ runId: 'run-3' })).toThrow(/POOL_CAPACITY_EXCEEDED/)
  })

  it('detects expired and leaked leases exceeding maxLeaseDurationMs', () => {
    let now = 10000
    const pool = new SqliteConnectionPoolSupervisor({
      maxConnections: 4,
      maxLeaseDurationMs: 5000,
      clock: () => now,
    })

    const lease1 = pool.checkout({ runId: 'run-1', purpose: 'quick-op' })
    now += 2000
    pool.checkout({ runId: 'run-2', purpose: 'long-op' })

    // advance by 4000 (total elapsed from lease1 = 6000 > 5000; lease2 = 4000 < 5000)
    now += 4000
    const leaks = pool.detectLeakedConnections()
    expect(leaks).toHaveLength(1)
    const firstLeak = leaks[0]
    expect(firstLeak).toBeDefined()
    if (!firstLeak) throw new Error('Expected leak record')
    expect(firstLeak.leaseId).toBe(lease1.leaseId)
    expect(firstLeak.heldDurationMs).toBe(6000)
    expect(firstLeak.attribution.purpose).toBe('quick-op')
  })

  it('force-reclaims leaked leases and restores available capacity', () => {
    let now = 10000
    const pool = new SqliteConnectionPoolSupervisor({
      maxConnections: 2,
      maxLeaseDurationMs: 5000,
      clock: () => now,
    })

    pool.checkout({ runId: 'run-leak' })
    pool.checkout({ runId: 'run-ok' })
    expect(pool.getPoolTelemetry().availableConnections).toBe(0)

    now += 6000
    const reclaimedCount = pool.reclaimAllLeaked()
    expect(reclaimedCount).toBe(2)

    const telemetry = pool.getPoolTelemetry()
    expect(telemetry.activeLeases).toBe(0)
    expect(telemetry.availableConnections).toBe(2)
    expect(telemetry.totalTimeouts).toBe(2)
  })

  it('computes pool telemetry and generates human-readable summary', () => {
    const now = 1000
    const pool = new SqliteConnectionPoolSupervisor({
      maxConnections: 10,
      clock: () => now,
    })

    const l1 = pool.checkout({ runId: 'run-1' })
    const l2 = pool.checkout({ runId: 'run-2' })
    pool.checkout({ runId: 'run-3' })

    pool.release(l1.leaseId)
    pool.release(l2.leaseId)

    const telemetry = pool.getPoolTelemetry()
    expect(telemetry.maxConnections).toBe(10)
    expect(telemetry.activeLeases).toBe(1)
    expect(telemetry.availableConnections).toBe(9)
    expect(telemetry.peakActiveLeases).toBe(3)
    expect(telemetry.totalCheckouts).toBe(3)
    expect(telemetry.totalReleases).toBe(2)

    const summary = pool.formatSummary()
    expect(summary).toContain('SQLite Connection Pool Summary')
    expect(summary).toContain('Capacity: 1/10 active')
    expect(summary).toContain('Peak Concurrency: 3')
  })
})
