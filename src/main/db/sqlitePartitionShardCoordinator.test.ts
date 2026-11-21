import { describe, expect, it } from 'vitest'
import {
  SqlitePartitionShardCoordinator,
  type ShardDescriptor,
} from './sqlitePartitionShardCoordinator'

describe('SqlitePartitionShardCoordinator', () => {
  const shardA: ShardDescriptor = {
    shardId: 'shard-01',
    dbPath: '/db/shard-01.sqlite',
    tenantIds: ['tenant-alpha', 'tenant-beta'],
    recordCount: 1000,
    sizeBytes: 1024 * 1024 * 10,
    status: 'ACTIVE',
  }

  const shardB: ShardDescriptor = {
    shardId: 'shard-02',
    dbPath: '/db/shard-02.sqlite',
    tenantIds: ['tenant-gamma'],
    recordCount: 150,
    sizeBytes: 1024 * 1024 * 2,
    status: 'ACTIVE',
  }

  it('registers and retrieves shard descriptors', () => {
    const coordinator = new SqlitePartitionShardCoordinator()
    coordinator.registerShard(shardA)
    coordinator.registerShard(shardB)

    expect(coordinator.listShards()).toHaveLength(2)
    expect(coordinator.getShard('shard-01')?.recordCount).toBe(1000)
  })

  it('routes explicit tenants to their assigned shard and unknown tenants deterministically', () => {
    const coordinator = new SqlitePartitionShardCoordinator()
    coordinator.registerShard(shardA)
    coordinator.registerShard(shardB)

    // Explicit tenant
    expect(coordinator.routeTenant('tenant-alpha').shardId).toBe('shard-01')
    expect(coordinator.routeTenant('tenant-gamma').shardId).toBe('shard-02')

    // Deterministic hash routing
    const routed1 = coordinator.routeTenant('new-tenant-999')
    const routed2 = coordinator.routeTenant('new-tenant-999')
    expect(routed1.shardId).toBe(routed2.shardId)
  })

  it('generates a rebalance plan when imbalance ratio exceeds threshold', () => {
    const coordinator = new SqlitePartitionShardCoordinator({
      maxImbalanceThresholdRatio: 0.35,
      minRecordsForRebalance: 50,
    })
    coordinator.registerShard(shardA) // 1000 records
    coordinator.registerShard(shardB) // 150 records
    // Mean: 575 records. Max delta: |1000 - 575| = 425. Imbalance ratio: 425 / 575 ~= 0.74 > 0.35

    const plan = coordinator.computeRebalancePlan()
    expect(plan.isRebalanceNeeded).toBe(true)
    expect(plan.moves.length).toBeGreaterThan(0)
    expect(plan.moves[0]?.fromShardId).toBe('shard-01')
    expect(plan.moves[0]?.toShardId).toBe('shard-02')
    expect(plan.estimatedMigrationCost).toBeGreaterThan(0)
  })

  it('does not rebalance when load is well balanced or record count is low', () => {
    const coordinator = new SqlitePartitionShardCoordinator()
    const balanced1: ShardDescriptor = {
      ...shardA,
      shardId: 's1',
      recordCount: 500,
    }
    const balanced2: ShardDescriptor = {
      ...shardB,
      shardId: 's2',
      recordCount: 520,
    }
    coordinator.registerShard(balanced1)
    coordinator.registerShard(balanced2)

    const plan = coordinator.computeRebalancePlan()
    expect(plan.isRebalanceNeeded).toBe(false)
    expect(plan.moves).toHaveLength(0)
  })

  it('drains a shard and safely migrates all its tenants to active survivors', () => {
    const coordinator = new SqlitePartitionShardCoordinator()
    coordinator.registerShard(shardA)
    coordinator.registerShard(shardB)

    const moves = coordinator.drainShard('shard-01')
    expect(moves).toHaveLength(2)
    expect(moves[0]?.fromShardId).toBe('shard-01')
    expect(moves[0]?.toShardId).toBe('shard-02')
    expect(coordinator.getShard('shard-01')?.status).toBe('DRAINING')
  })

  it('simulates compaction and reclaims storage pages', () => {
    const coordinator = new SqlitePartitionShardCoordinator()
    coordinator.registerShard(shardA)

    const report = coordinator.simulateCompaction('shard-01')
    expect(report.shardId).toBe('shard-01')
    expect(report.pagesFreed).toBeGreaterThan(0)
    expect(report.bytesReclaimed).toBe(report.pagesFreed * 4096)
    expect(coordinator.getShard('shard-01')?.lastCompactedAt).toBeDefined()
  })
})
