import { randomUUID } from 'node:crypto'

export interface ConnectionLeaseAttribution {
  runId: string
  stepId?: string | undefined
  purpose?: string | undefined
}

export interface ConnectionLease {
  leaseId: string
  connectionId: string
  acquiredAt: number
  attribution: ConnectionLeaseAttribution
  released: boolean
}

export interface ConnectionPoolSupervisorOptions {
  maxConnections?: number
  maxLeaseDurationMs?: number
  clock?: () => number
}

export interface PoolTelemetry {
  maxConnections: number
  activeLeases: number
  availableConnections: number
  peakActiveLeases: number
  totalCheckouts: number
  totalReleases: number
  totalTimeouts: number
}

export interface LeakedConnectionReport {
  leaseId: string
  connectionId: string
  acquiredAt: number
  heldDurationMs: number
  maxLeaseDurationMs: number
  attribution: ConnectionLeaseAttribution
}

export class SqliteConnectionPoolSupervisor {
  private readonly maxConnections: number
  private readonly maxLeaseDurationMs: number
  private readonly clock: () => number

  private readonly leases = new Map<string, ConnectionLease>()
  private peakActiveLeases = 0
  private totalCheckouts = 0
  private totalReleases = 0
  private totalTimeouts = 0
  private connectionCounter = 0

  constructor(options: ConnectionPoolSupervisorOptions = {}) {
    this.maxConnections = options.maxConnections ?? 16
    this.maxLeaseDurationMs = options.maxLeaseDurationMs ?? 30000
    this.clock = options.clock ?? (() => Date.now())

    if (this.maxConnections <= 0) {
      throw new Error('maxConnections must be greater than 0')
    }
  }

  checkout(attribution: ConnectionLeaseAttribution): ConnectionLease {
    if (!attribution.runId || typeof attribution.runId !== 'string') {
      throw new Error('Invalid lease attribution: runId is required')
    }

    const activeCount = this.getActiveLeasesCount()
    if (activeCount >= this.maxConnections) {
      throw new Error('POOL_CAPACITY_EXCEEDED: No database connections available in pool')
    }

    this.connectionCounter += 1
    const connectionId = `conn_${String(this.connectionCounter)}`
    const leaseId = `lease_${randomUUID().slice(0, 8)}`
    const now = this.clock()

    const lease: ConnectionLease = {
      leaseId,
      connectionId,
      acquiredAt: now,
      attribution: {
        runId: attribution.runId,
        stepId: attribution.stepId,
        purpose: attribution.purpose,
      },
      released: false,
    }

    this.leases.set(leaseId, lease)
    this.totalCheckouts += 1

    const newActiveCount = activeCount + 1
    if (newActiveCount > this.peakActiveLeases) {
      this.peakActiveLeases = newActiveCount
    }

    return { ...lease }
  }

  release(leaseId: string): boolean {
    const lease = this.leases.get(leaseId)
    if (!lease || lease.released) {
      return false
    }

    lease.released = true
    this.totalReleases += 1
    return true
  }

  detectLeakedConnections(nowMs?: number): LeakedConnectionReport[] {
    const now = nowMs ?? this.clock()
    const leaked: LeakedConnectionReport[] = []

    for (const lease of this.leases.values()) {
      if (!lease.released) {
        const heldDuration = now - lease.acquiredAt
        if (heldDuration > this.maxLeaseDurationMs) {
          leaked.push({
            leaseId: lease.leaseId,
            connectionId: lease.connectionId,
            acquiredAt: lease.acquiredAt,
            heldDurationMs: heldDuration,
            maxLeaseDurationMs: this.maxLeaseDurationMs,
            attribution: { ...lease.attribution },
          })
        }
      }
    }

    return leaked
  }

  forceReclaimLease(leaseId: string): boolean {
    const lease = this.leases.get(leaseId)
    if (!lease || lease.released) {
      return false
    }

    lease.released = true
    this.totalTimeouts += 1
    return true
  }

  reclaimAllLeaked(nowMs?: number): number {
    const leaked = this.detectLeakedConnections(nowMs)
    let reclaimed = 0
    for (const item of leaked) {
      if (this.forceReclaimLease(item.leaseId)) {
        reclaimed += 1
      }
    }
    return reclaimed
  }

  getPoolTelemetry(): PoolTelemetry {
    const activeLeases = this.getActiveLeasesCount()
    return {
      maxConnections: this.maxConnections,
      activeLeases,
      availableConnections: Math.max(0, this.maxConnections - activeLeases),
      peakActiveLeases: this.peakActiveLeases,
      totalCheckouts: this.totalCheckouts,
      totalReleases: this.totalReleases,
      totalTimeouts: this.totalTimeouts,
    }
  }

  formatSummary(): string {
    const telemetry = this.getPoolTelemetry()
    return [
      `=== SQLite Connection Pool Summary ===`,
      `Capacity: ${String(telemetry.activeLeases)}/${String(telemetry.maxConnections)} active (${String(telemetry.availableConnections)} available)`,
      `Peak Concurrency: ${String(telemetry.peakActiveLeases)}`,
      `Total Operations: ${String(telemetry.totalCheckouts)} checkouts, ${String(telemetry.totalReleases)} releases, ${String(telemetry.totalTimeouts)} timed out/reclaimed`,
    ].join('\n')
  }

  private getActiveLeasesCount(): number {
    let count = 0
    for (const lease of this.leases.values()) {
      if (!lease.released) {
        count += 1
      }
    }
    return count
  }
}
