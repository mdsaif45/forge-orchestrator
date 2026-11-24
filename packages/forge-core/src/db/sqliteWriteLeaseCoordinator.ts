/**
 * Copyright (c) 2026 Forge Authors
 * Technology: TypeScript / Node.js
 * Architecture: SQLite Write Lock Lease Coordinator & Transaction Barrier (STATE-023)
 * Axioms Enforced:
 *  - A1: Bugs are bounded & fail-closed (stale leases cannot mutate state).
 *  - A2: Explicit validation of all transactions and fencing tokens.
 *  - A4: Decisions lock (monotonically increasing fencing token guarantees ordering).
 *  - A5: Bounded timeouts, wait queues, and lease durations.
 */

export interface WriteLeaseOptions {
  readonly holderId: string
  readonly purpose: string
  readonly ttlMs?: number
  readonly timeoutMs?: number
  readonly priority?: number
}

export interface WriteLease {
  readonly leaseId: string
  readonly holderId: string
  readonly purpose: string
  readonly fencingToken: number
  readonly acquiredAt: number
  readonly expiresAt: number
  readonly priority: number
}

export interface WriteLeaseMetrics {
  readonly currentActiveLeaseId: string | null
  readonly queuedRequestsCount: number
  readonly totalAcquired: number
  readonly totalRenewed: number
  readonly totalReleased: number
  readonly totalTimedOut: number
  readonly totalContended: number
  readonly averageWaitTimeMs: number
}

interface QueuedLeaseRequest {
  readonly leaseId: string
  readonly options: Required<WriteLeaseOptions>
  readonly requestedAt: number
  readonly resolve: (lease: WriteLease) => void
  readonly reject: (error: Error) => void
  timeoutHandle?: NodeJS.Timeout
}

export interface SqliteWriteLeaseCoordinatorConfig {
  readonly defaultTtlMs?: number
  readonly defaultTimeoutMs?: number
  readonly maxQueueDepth?: number
}

export class SqliteWriteLeaseCoordinator {
  private readonly defaultTtlMs: number
  private readonly defaultTimeoutMs: number
  private readonly maxQueueDepth: number

  private currentLease: WriteLease | null = null
  private nextFencingToken = 1
  private readonly waitQueue: QueuedLeaseRequest[] = []

  private totalAcquired = 0
  private totalRenewed = 0
  private totalReleased = 0
  private totalTimedOut = 0
  private totalContended = 0
  private totalWaitTimeMs = 0

  public constructor(config?: SqliteWriteLeaseCoordinatorConfig) {
    this.defaultTtlMs = Math.max(50, config?.defaultTtlMs ?? 5000)
    this.defaultTimeoutMs = Math.max(100, config?.defaultTimeoutMs ?? 10000)
    this.maxQueueDepth = Math.max(1, config?.maxQueueDepth ?? 100)
  }

  /**
   * Acquire an exclusive write lease. Queues if another lease is active.
   */
  public async acquireWriteLease(options: WriteLeaseOptions): Promise<WriteLease> {
    this.evictExpiredLeases()

    const ttlMs = Math.max(50, options.ttlMs ?? this.defaultTtlMs)
    const timeoutMs = Math.max(10, options.timeoutMs ?? this.defaultTimeoutMs)
    const priority = options.priority ?? 0
    const leaseId = `lease-${String(Date.now())}-${Math.random().toString(36).slice(2, 9)}`

    const resolvedOptions: Required<WriteLeaseOptions> = {
      holderId: options.holderId,
      purpose: options.purpose,
      ttlMs,
      timeoutMs,
      priority,
    }

    // If no active lease, grant immediately
    if (!this.currentLease) {
      return this.grantLease(leaseId, resolvedOptions, 0)
    }

    // Queue contention
    this.totalContended++

    if (this.waitQueue.length >= this.maxQueueDepth) {
      throw new Error(
        `[STATE-023] SQLite write lease queue depth limit (${String(this.maxQueueDepth)}) exceeded. Rejecting request for holder: ${options.holderId}`,
      )
    }

    const requestedAt = Date.now()

    return new Promise<WriteLease>((resolve, reject) => {
      const request: QueuedLeaseRequest = {
        leaseId,
        options: resolvedOptions,
        requestedAt,
        resolve,
        reject,
      }

      const timer = setTimeout(() => {
        this.totalTimedOut++
        const idx = this.waitQueue.indexOf(request)
        if (idx !== -1) {
          this.waitQueue.splice(idx, 1)
        }
        reject(
          new Error(
            `[STATE-023] SQLite write lease acquisition timed out after ${String(timeoutMs)}ms for holder: ${options.holderId}`,
          ),
        )
      }, timeoutMs)

      // Prevent timer from keeping node process alive if unref is available
      if (typeof timer.unref === 'function') {
        timer.unref()
      }

      request.timeoutHandle = timer

      // Priority ordering (higher priority first, FIFO within same priority)
      if (priority > 0) {
        let insertIdx = this.waitQueue.length
        for (let i = 0; i < this.waitQueue.length; i++) {
          const item = this.waitQueue[i]
          if (item && priority > item.options.priority) {
            insertIdx = i
            break
          }
        }
        this.waitQueue.splice(insertIdx, 0, request)
      } else {
        this.waitQueue.push(request)
      }
    })
  }

  /**
   * Renew an existing active lease if not yet expired.
   */
  public renewWriteLease(leaseId: string, extensionMs?: number): boolean {
    this.evictExpiredLeases()
    if (this.currentLease?.leaseId !== leaseId) {
      return false
    }

    const ext = Math.max(50, extensionMs ?? this.defaultTtlMs)
    const newExpiresAt = Date.now() + ext

    this.currentLease = {
      ...this.currentLease,
      expiresAt: newExpiresAt,
    }
    this.totalRenewed++
    return true
  }

  /**
   * Release an active lease and grant to the next queued requester.
   */
  public releaseWriteLease(leaseId: string): boolean {
    if (this.currentLease?.leaseId !== leaseId) {
      return false
    }

    this.currentLease = null
    this.totalReleased++
    this.processQueue()
    return true
  }

  /**
   * Validates whether a given lease is current, unexpired, and matches fencing token.
   */
  public validateWriteLease(leaseId: string, fencingToken: number): boolean {
    this.evictExpiredLeases()
    if (!this.currentLease) {
      return false
    }
    return (
      this.currentLease.leaseId === leaseId &&
      this.currentLease.fencingToken === fencingToken &&
      Date.now() <= this.currentLease.expiresAt
    )
  }

  /**
   * Executes an asynchronous write operation protected by a write lease.
   */
  public async withWriteLease<T>(
    options: WriteLeaseOptions,
    action: (lease: WriteLease) => Promise<T>,
  ): Promise<T> {
    const lease = await this.acquireWriteLease(options)
    try {
      const result = await action(lease)
      if (!this.validateWriteLease(lease.leaseId, lease.fencingToken)) {
        throw new Error(
          `[STATE-023] Write lease ${lease.leaseId} expired or invalidated during execution`,
        )
      }
      return result
    } finally {
      this.releaseWriteLease(lease.leaseId)
    }
  }

  /**
   * Evicts expired leases and processes the queue if the active lease expired.
   */
  public evictExpiredLeases(now = Date.now()): WriteLease[] {
    const evicted: WriteLease[] = []
    if (this.currentLease && now > this.currentLease.expiresAt) {
      evicted.push(this.currentLease)
      this.totalTimedOut++
      this.currentLease = null
      this.processQueue()
    }
    return evicted
  }

  /**
   * Returns telemetry metrics for monitoring.
   */
  public getMetrics(): WriteLeaseMetrics {
    this.evictExpiredLeases()
    return {
      currentActiveLeaseId: this.currentLease ? this.currentLease.leaseId : null,
      queuedRequestsCount: this.waitQueue.length,
      totalAcquired: this.totalAcquired,
      totalRenewed: this.totalRenewed,
      totalReleased: this.totalReleased,
      totalTimedOut: this.totalTimedOut,
      totalContended: this.totalContended,
      averageWaitTimeMs:
        this.totalAcquired > 0 ? Math.round(this.totalWaitTimeMs / this.totalAcquired) : 0,
    }
  }

  /**
   * Resets coordinator state (cancels pending requests).
   */
  public reset(): void {
    if (this.waitQueue.length > 0) {
      for (const req of this.waitQueue) {
        if (req.timeoutHandle) {
          clearTimeout(req.timeoutHandle)
        }
        req.reject(new Error('[STATE-023] SqliteWriteLeaseCoordinator reset'))
      }
      this.waitQueue.length = 0
    }
    this.currentLease = null
  }

  private grantLease(
    leaseId: string,
    options: Required<WriteLeaseOptions>,
    waitTimeMs: number,
  ): WriteLease {
    const now = Date.now()
    const lease: WriteLease = {
      leaseId,
      holderId: options.holderId,
      purpose: options.purpose,
      fencingToken: this.nextFencingToken++,
      acquiredAt: now,
      expiresAt: now + options.ttlMs,
      priority: options.priority,
    }

    this.currentLease = lease
    this.totalAcquired++
    this.totalWaitTimeMs += waitTimeMs
    return lease
  }

  private processQueue(): void {
    if (this.currentLease || this.waitQueue.length === 0) {
      return
    }

    const next = this.waitQueue.shift()
    if (!next) return

    if (next.timeoutHandle) {
      clearTimeout(next.timeoutHandle)
    }

    const waitTime = Math.max(0, Date.now() - next.requestedAt)
    const lease = this.grantLease(next.leaseId, next.options, waitTime)
    next.resolve(lease)
  }
}
