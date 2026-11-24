/**
 * WORK-023: Workflow execution step concurrency limiter and resource semaphore.
 * Implements deterministic bounded step execution and resource contention throttling (Axioms A1, A5).
 */

export interface SemaphorePermit {
  readonly permitId: string
  readonly stepId: string
  readonly acquiredAt: number
}

export interface SemaphoreStatus {
  readonly capacity: number
  readonly activeCount: number
  readonly availablePermits: number
  readonly queueLength: number
  readonly activePermits: readonly SemaphorePermit[]
  readonly formattedSummary: string
}

interface QueuedRequest {
  readonly stepId: string
  readonly resolve: (permit: SemaphorePermit) => void
  readonly reject: (error: Error) => void
  readonly timer?: ReturnType<typeof setTimeout> | undefined
}

/**
 * Regulates concurrent execution of workflow steps within a bounded concurrency envelope.
 */
export class StepExecutionConcurrencyLimiter {
  private readonly capacity: number
  private readonly activePermits = new Map<string, SemaphorePermit>()
  private readonly queue: QueuedRequest[] = []
  private permitSequence = 0

  public constructor(capacity = 4) {
    if (capacity <= 0 || !Number.isInteger(capacity)) {
      throw new Error(
        `Invalid concurrency capacity: ${String(capacity)}. Capacity must be a positive integer.`,
      )
    }
    this.capacity = capacity
  }

  public getCapacity(): number {
    return this.capacity
  }

  public getActiveCount(): number {
    return this.activePermits.size
  }

  public getQueueLength(): number {
    return this.queue.length
  }

  public getAvailablePermits(): number {
    return Math.max(0, this.capacity - this.activePermits.size)
  }

  /**
   * Acquires an execution permit. If capacity is exhausted, awaits in FIFO queue until released or timeout.
   */
  public async acquire(stepId: string, timeoutMs = 30000): Promise<SemaphorePermit> {
    if (!stepId || stepId.trim() === '') {
      throw new Error('Step ID must be a non-empty string')
    }

    if (this.activePermits.size < this.capacity) {
      const permit: SemaphorePermit = {
        permitId: `permit-${String(++this.permitSequence)}`,
        stepId,
        acquiredAt: Date.now(),
      }
      this.activePermits.set(permit.permitId, permit)
      return permit
    }

    return new Promise<SemaphorePermit>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined

      if (timeoutMs > 0 && timeoutMs < Infinity) {
        timer = setTimeout(() => {
          const idx = this.queue.findIndex((q) => q.resolve === resolve)
          if (idx !== -1) {
            this.queue.splice(idx, 1)
            reject(
              new Error(
                `Step concurrency permit acquisition timed out after ${String(timeoutMs)}ms for step "${stepId}"`,
              ),
            )
          }
        }, timeoutMs)
      }

      this.queue.push({ stepId, resolve, reject, timer })
    })
  }

  /**
   * Releases an active permit and hands it to the next queued step in FIFO order.
   */
  public release(permitId: string): void {
    if (!this.activePermits.has(permitId)) {
      return
    }

    this.activePermits.delete(permitId)

    if (this.queue.length > 0) {
      const next = this.queue.shift()
      if (next) {
        if (next.timer) {
          clearTimeout(next.timer)
        }
        const newPermit: SemaphorePermit = {
          permitId: `permit-${String(++this.permitSequence)}`,
          stepId: next.stepId,
          acquiredAt: Date.now(),
        }
        this.activePermits.set(newPermit.permitId, newPermit)
        next.resolve(newPermit)
      }
    }
  }

  /**
   * Scoped execution helper that acquires a permit, runs callback, and guarantees permit release.
   */
  public async withPermit<T>(stepId: string, fn: () => Promise<T>, timeoutMs?: number): Promise<T> {
    const permit = await this.acquire(stepId, timeoutMs)
    try {
      return await fn()
    } finally {
      this.release(permit.permitId)
    }
  }

  /**
   * Returns current semaphore diagnostic snapshot.
   */
  public getStatus(): SemaphoreStatus {
    const activePermits = Array.from(this.activePermits.values())
    const availablePermits = this.getAvailablePermits()
    const queueLength = this.getQueueLength()

    const lines: string[] = [
      `STEP CONCURRENCY SEMAPHORE STATUS:`,
      `  Capacity:           ${String(this.capacity)} concurrent slots`,
      `  Active Slots:       ${String(activePermits.length)} (${String(Math.round((activePermits.length / this.capacity) * 100))}% utilization)`,
      `  Available Slots:    ${String(availablePermits)}`,
      `  Queued Steps:       ${String(queueLength)}`,
    ]

    if (activePermits.length > 0) {
      lines.push(`  Active Step Permits:`)
      for (const p of activePermits) {
        lines.push(`    • ${p.stepId} [${p.permitId}]`)
      }
    }

    return {
      capacity: this.capacity,
      activeCount: activePermits.length,
      availablePermits,
      queueLength,
      activePermits,
      formattedSummary: lines.join('\n'),
    }
  }

  /**
   * Drains the queue and clears active tracking (for teardown/reset).
   */
  public drain(): void {
    while (this.queue.length > 0) {
      const q = this.queue.shift()
      if (q) {
        if (q.timer) clearTimeout(q.timer)
        q.reject(new Error('Step execution concurrency limiter drained'))
      }
    }
    this.activePermits.clear()
  }
}
