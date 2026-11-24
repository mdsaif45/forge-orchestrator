import { randomUUID } from 'node:crypto'

export interface SnapshotBarrier {
  barrierId: string
  purpose: string
  createdAt: number
  activeReadersCount: number
  released: boolean
  metadata?: Record<string, unknown> | undefined
}

export interface SnapshotBarrierOptions {
  staleBarrierTtlMs?: number | undefined
  clock?: (() => number) | undefined
}

export interface SnapshotBarrierStats {
  totalCreated: number
  activeCount: number
  releasedCount: number
  stalePrunedCount: number
  oldestActiveAgeMs?: number | undefined
}

const DEFAULT_STALE_BARRIER_TTL_MS = 60000

export class SqliteSnapshotBarrierManager {
  private readonly staleBarrierTtlMs: number
  private readonly clock: () => number

  private readonly barriers = new Map<string, SnapshotBarrier>()
  private totalCreated = 0
  private releasedCount = 0
  private stalePrunedCount = 0

  constructor(options: SnapshotBarrierOptions = {}) {
    this.staleBarrierTtlMs = options.staleBarrierTtlMs ?? DEFAULT_STALE_BARRIER_TTL_MS
    this.clock = options.clock ?? (() => Date.now())

    if (this.staleBarrierTtlMs <= 0) {
      throw new Error('staleBarrierTtlMs must be greater than 0')
    }
  }

  createBarrier(purpose: string, metadata?: Record<string, unknown>): SnapshotBarrier {
    if (!purpose || typeof purpose !== 'string') {
      throw new Error('Barrier purpose is required')
    }

    const barrierId = `snb_${randomUUID().slice(0, 8)}`
    const now = this.clock()

    const barrier: SnapshotBarrier = {
      barrierId,
      purpose,
      createdAt: now,
      activeReadersCount: 0,
      released: false,
      metadata: metadata ? { ...metadata } : undefined,
    }

    this.barriers.set(barrierId, barrier)
    this.totalCreated += 1

    return { ...barrier }
  }

  acquireReader(barrierId: string): boolean {
    const barrier = this.barriers.get(barrierId)
    if (!barrier || barrier.released) {
      return false
    }

    barrier.activeReadersCount += 1
    return true
  }

  releaseReader(barrierId: string): boolean {
    const barrier = this.barriers.get(barrierId)
    if (!barrier || barrier.released || barrier.activeReadersCount <= 0) {
      return false
    }

    barrier.activeReadersCount -= 1
    return true
  }

  releaseBarrier(barrierId: string): boolean {
    const barrier = this.barriers.get(barrierId)
    if (!barrier || barrier.released) {
      return false
    }

    barrier.released = true
    this.releasedCount += 1
    return true
  }

  pruneStaleBarriers(nowMs?: number): number {
    const now = nowMs ?? this.clock()
    let pruned = 0

    for (const barrier of this.barriers.values()) {
      if (!barrier.released) {
        const age = now - barrier.createdAt
        if (age > this.staleBarrierTtlMs) {
          barrier.released = true
          this.stalePrunedCount += 1
          pruned += 1
        }
      }
    }

    return pruned
  }

  getActiveBarriers(): SnapshotBarrier[] {
    return Array.from(this.barriers.values())
      .filter((b) => !b.released)
      .map((b) => ({ ...b }))
  }

  getBarrierStats(nowMs?: number): SnapshotBarrierStats {
    const now = nowMs ?? this.clock()
    const active = this.getActiveBarriers()
    let oldestActiveAgeMs: number | undefined

    if (active.length > 0) {
      let oldestCreated = Infinity
      for (const b of active) {
        if (b.createdAt < oldestCreated) {
          oldestCreated = b.createdAt
        }
      }
      oldestActiveAgeMs = Math.max(0, now - oldestCreated)
    }

    return {
      totalCreated: this.totalCreated,
      activeCount: active.length,
      releasedCount: this.releasedCount,
      stalePrunedCount: this.stalePrunedCount,
      oldestActiveAgeMs,
    }
  }

  formatSummary(nowMs?: number): string {
    const stats = this.getBarrierStats(nowMs)
    return [
      `=== SQLite Snapshot Barrier Manager ===`,
      `Active Barriers: ${String(stats.activeCount)} (Total Created: ${String(stats.totalCreated)}, Released: ${String(stats.releasedCount)}, Pruned: ${String(stats.stalePrunedCount)})`,
      `Oldest Active Age: ${stats.oldestActiveAgeMs !== undefined ? `${String(stats.oldestActiveAgeMs)}ms` : 'none'}`,
    ].join('\n')
  }
}
