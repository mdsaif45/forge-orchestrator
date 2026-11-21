import { createHash } from 'node:crypto'

export type ShardStatus = 'ACTIVE' | 'DRAINING' | 'COMPACTING' | 'MAINTENANCE'

export interface ShardDescriptor {
  readonly shardId: string
  readonly dbPath: string
  readonly tenantIds: readonly string[]
  readonly recordCount: number
  readonly sizeBytes: number
  readonly status: ShardStatus
  readonly lastCompactedAt?: number
}

export interface TenantMigrationMove {
  readonly tenantId: string
  readonly fromShardId: string
  readonly toShardId: string
  readonly estimatedRecords: number
}

export interface ShardRebalancePlan {
  readonly planId: string
  readonly currentImbalanceRatio: number
  readonly targetImbalanceRatio: number
  readonly moves: readonly TenantMigrationMove[]
  readonly estimatedMigrationCost: number
  readonly isRebalanceNeeded: boolean
}

export interface ShardCompactionReport {
  readonly shardId: string
  readonly pagesFreed: number
  readonly bytesReclaimed: number
  readonly durationMs: number
  readonly completedAt: number
}

export interface ShardCoordinatorConfig {
  readonly maxImbalanceThresholdRatio?: number // default: 0.35 (35% deviation from mean)
  readonly minRecordsForRebalance?: number // default: 50
}

export class SqlitePartitionShardCoordinator {
  private readonly shards = new Map<string, ShardDescriptor>()
  private readonly maxImbalanceThresholdRatio: number
  private readonly minRecordsForRebalance: number

  constructor(config?: ShardCoordinatorConfig) {
    this.maxImbalanceThresholdRatio = config?.maxImbalanceThresholdRatio ?? 0.35
    this.minRecordsForRebalance = config?.minRecordsForRebalance ?? 50
  }

  public registerShard(shard: ShardDescriptor): void {
    this.shards.set(shard.shardId, {
      ...shard,
      tenantIds: [...shard.tenantIds],
    })
  }

  public getShard(shardId: string): ShardDescriptor | undefined {
    return this.shards.get(shardId)
  }

  public listShards(): readonly ShardDescriptor[] {
    return Array.from(this.shards.values())
  }

  public routeTenant(tenantId: string): ShardDescriptor {
    const activeShards = Array.from(this.shards.values()).filter((s) => s.status === 'ACTIVE')
    if (activeShards.length === 0) {
      throw new Error('No active database shards available for routing')
    }

    // First check if tenant is explicitly assigned to an active shard
    for (const shard of activeShards) {
      if (shard.tenantIds.includes(tenantId)) {
        return shard
      }
    }

    // Consistent hash routing using SHA-256
    const hash = createHash('sha256').update(tenantId).digest('hex')
    const hashNum = parseInt(hash.slice(0, 8), 16)
    const sortedShards = [...activeShards].sort((a, b) => a.shardId.localeCompare(b.shardId))
    const index = hashNum % sortedShards.length
    const target = sortedShards[index]
    if (!target) {
      throw new Error(`Failed to route tenant "${tenantId}": empty shard list`)
    }
    return target
  }

  public computeRebalancePlan(): ShardRebalancePlan {
    const activeShards = Array.from(this.shards.values()).filter((s) => s.status === 'ACTIVE')
    if (activeShards.length < 2) {
      return {
        planId: `rebalance-none-${String(Date.now())}`,
        currentImbalanceRatio: 0,
        targetImbalanceRatio: 0,
        moves: [],
        estimatedMigrationCost: 0,
        isRebalanceNeeded: false,
      }
    }

    const totalRecords = activeShards.reduce((acc, s) => acc + s.recordCount, 0)
    if (totalRecords < this.minRecordsForRebalance) {
      return {
        planId: `rebalance-insufficient-records-${String(Date.now())}`,
        currentImbalanceRatio: 0,
        targetImbalanceRatio: 0,
        moves: [],
        estimatedMigrationCost: 0,
        isRebalanceNeeded: false,
      }
    }

    const meanRecords = totalRecords / activeShards.length
    let maxDelta = 0
    for (const s of activeShards) {
      const delta = Math.abs(s.recordCount - meanRecords)
      if (delta > maxDelta) {
        maxDelta = delta
      }
    }

    const currentImbalanceRatio = meanRecords > 0 ? maxDelta / meanRecords : 0
    const isRebalanceNeeded = currentImbalanceRatio >= this.maxImbalanceThresholdRatio

    if (!isRebalanceNeeded) {
      return {
        planId: `rebalance-balanced-${String(Date.now())}`,
        currentImbalanceRatio,
        targetImbalanceRatio: currentImbalanceRatio,
        moves: [],
        estimatedMigrationCost: 0,
        isRebalanceNeeded: false,
      }
    }

    // Plan moves: move tenants from most loaded shards to least loaded shards
    const sortedDesc = [...activeShards].sort((a, b) => b.recordCount - a.recordCount)
    const moves: TenantMigrationMove[] = []
    let estimatedMigrationCost = 0

    const donor = sortedDesc[0]
    const receiver = sortedDesc[sortedDesc.length - 1]

    if (donor && receiver && donor.tenantIds.length > 1) {
      const tenantToMove = donor.tenantIds[donor.tenantIds.length - 1]
      if (tenantToMove) {
        const approxTenantRecords = Math.round(donor.recordCount / donor.tenantIds.length)

        moves.push({
          tenantId: tenantToMove,
          fromShardId: donor.shardId,
          toShardId: receiver.shardId,
          estimatedRecords: approxTenantRecords,
        })
        estimatedMigrationCost += approxTenantRecords * 0.05
      }
    }

    const planHash = createHash('sha256').update(JSON.stringify(moves)).digest('hex').slice(0, 12)

    return {
      planId: `rebalance-${planHash}`,
      currentImbalanceRatio,
      targetImbalanceRatio: currentImbalanceRatio * 0.5,
      moves,
      estimatedMigrationCost,
      isRebalanceNeeded: moves.length > 0,
    }
  }

  public drainShard(shardId: string): readonly TenantMigrationMove[] {
    const shard = this.shards.get(shardId)
    if (!shard) {
      throw new Error(`Shard "${shardId}" not found`)
    }

    this.shards.set(shardId, {
      ...shard,
      status: 'DRAINING',
    })

    const otherActive = Array.from(this.shards.values()).filter(
      (s) => s.shardId !== shardId && s.status === 'ACTIVE',
    )
    if (otherActive.length === 0) {
      throw new Error('Cannot drain shard: no other active shards available')
    }

    const moves: TenantMigrationMove[] = []
    const approxRecordsPerTenant =
      shard.tenantIds.length > 0 ? Math.round(shard.recordCount / shard.tenantIds.length) : 0

    for (let i = 0; i < shard.tenantIds.length; i++) {
      const tenantId = shard.tenantIds[i]
      const targetShard = otherActive[i % otherActive.length]
      if (tenantId && targetShard) {
        moves.push({
          tenantId,
          fromShardId: shardId,
          toShardId: targetShard.shardId,
          estimatedRecords: approxRecordsPerTenant,
        })
      }
    }

    return moves
  }

  public simulateCompaction(shardId: string): ShardCompactionReport {
    const shard = this.shards.get(shardId)
    if (!shard) {
      throw new Error(`Shard "${shardId}" not found`)
    }

    const pagesFreed = Math.max(1, Math.round(shard.recordCount * 0.15))
    const bytesReclaimed = pagesFreed * 4096 // SQLite 4KB page size
    const now = Date.now()

    this.shards.set(shardId, {
      ...shard,
      sizeBytes: Math.max(4096, shard.sizeBytes - bytesReclaimed),
      status: 'ACTIVE',
      lastCompactedAt: now,
    })

    return {
      shardId,
      pagesFreed,
      bytesReclaimed,
      durationMs: 45,
      completedAt: now,
    }
  }
}
