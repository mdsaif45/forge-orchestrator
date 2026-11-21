import { describe, it, expect, beforeEach } from 'vitest'
import { SqliteWriteLeaseCoordinator, type WriteLease } from './sqliteWriteLeaseCoordinator'

describe('SqliteWriteLeaseCoordinator (STATE-023)', () => {
  let coordinator: SqliteWriteLeaseCoordinator

  beforeEach(() => {
    coordinator = new SqliteWriteLeaseCoordinator({
      defaultTtlMs: 200,
      defaultTimeoutMs: 500,
      maxQueueDepth: 5,
    })
  })

  it('acquires and releases leases with monotonic fencing tokens', async () => {
    const lease1 = await coordinator.acquireWriteLease({
      holderId: 'agent-1',
      purpose: 'insert-checkpoint',
    })

    expect(lease1.holderId).toBe('agent-1')
    expect(lease1.fencingToken).toBe(1)
    expect(coordinator.validateWriteLease(lease1.leaseId, lease1.fencingToken)).toBe(true)

    const released = coordinator.releaseWriteLease(lease1.leaseId)
    expect(released).toBe(true)
    expect(coordinator.validateWriteLease(lease1.leaseId, lease1.fencingToken)).toBe(false)

    const lease2 = await coordinator.acquireWriteLease({
      holderId: 'agent-2',
      purpose: 'update-state',
    })
    expect(lease2.fencingToken).toBe(2)
    coordinator.releaseWriteLease(lease2.leaseId)
  })

  it('queues concurrent lease requests and serves them in order upon release', async () => {
    const lease1 = await coordinator.acquireWriteLease({
      holderId: 'tx-1',
      purpose: 'write-1',
      ttlMs: 300,
    })

    const executionOrder: string[] = []

    const p2 = coordinator
      .acquireWriteLease({
        holderId: 'tx-2',
        purpose: 'write-2',
      })
      .then((l) => {
        executionOrder.push('tx-2')
        coordinator.releaseWriteLease(l.leaseId)
      })

    const p3 = coordinator
      .acquireWriteLease({
        holderId: 'tx-3',
        purpose: 'write-3',
      })
      .then((l) => {
        executionOrder.push('tx-3')
        coordinator.releaseWriteLease(l.leaseId)
      })

    const metrics = coordinator.getMetrics()
    expect(metrics.queuedRequestsCount).toBe(2)
    expect(metrics.totalContended).toBe(2)

    coordinator.releaseWriteLease(lease1.leaseId)
    await Promise.all([p2, p3])

    expect(executionOrder).toEqual(['tx-2', 'tx-3'])
  })

  it('renews lease extending its expiration time', async () => {
    const lease = await coordinator.acquireWriteLease({
      holderId: 'agent-renew',
      purpose: 'batch-work',
      ttlMs: 100,
    })

    const renewed = coordinator.renewWriteLease(lease.leaseId, 300)
    expect(renewed).toBe(true)

    // Invalid renewal for non-existent lease
    const falseRenew = coordinator.renewWriteLease('fake-lease', 300)
    expect(falseRenew).toBe(false)

    coordinator.releaseWriteLease(lease.leaseId)
  })

  it('evicts expired leases and grants to queued requests automatically', async () => {
    await coordinator.acquireWriteLease({
      holderId: 'abandoned-holder',
      purpose: 'crash-simulation',
      ttlMs: 50,
    })

    let acquiredLease2: WriteLease | null = null
    const p2 = coordinator
      .acquireWriteLease({
        holderId: 'tx-recover',
        purpose: 'takeover',
        ttlMs: 200,
      })
      .then((l) => {
        acquiredLease2 = l
        coordinator.releaseWriteLease(l.leaseId)
      })

    // Wait until lease1 expires
    await new Promise((resolve) => setTimeout(resolve, 80))

    // Manual eviction or polling will trigger queue processing
    coordinator.evictExpiredLeases()

    await p2
    expect(acquiredLease2).not.toBeNull()
    expect((acquiredLease2 as unknown as WriteLease).holderId).toBe('tx-recover')
  })

  it('rejects requests when queue depth capacity is exceeded', async () => {
    const smallCoordinator = new SqliteWriteLeaseCoordinator({
      defaultTtlMs: 500,
      maxQueueDepth: 1,
    })

    const l1 = await smallCoordinator.acquireWriteLease({ holderId: 'h1', purpose: 'p1' })
    const p2 = smallCoordinator.acquireWriteLease({ holderId: 'h2', purpose: 'p2' })

    // Third request exceeds maxQueueDepth of 1
    await expect(
      smallCoordinator.acquireWriteLease({ holderId: 'h3', purpose: 'p3' }),
    ).rejects.toThrow(/SQLite write lease queue depth limit/)

    smallCoordinator.releaseWriteLease(l1.leaseId)
    const l2 = await p2
    smallCoordinator.releaseWriteLease(l2.leaseId)
  })

  it('executes actions via withWriteLease and releases lock automatically', async () => {
    let observedFencingToken = -1
    const result = await coordinator.withWriteLease(
      { holderId: 'scoped-runner', purpose: 'scoped-action' },
      async (lease) => {
        await Promise.resolve()
        observedFencingToken = lease.fencingToken
        return 42
      },
    )

    expect(result).toBe(42)
    expect(observedFencingToken).toBeGreaterThan(0)
    expect(coordinator.getMetrics().currentActiveLeaseId).toBeNull()
  })
})
