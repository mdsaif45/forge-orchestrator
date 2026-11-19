import { z } from 'zod'

export const stepTimeoutLeaseSchema = z.strictObject({
  nodeId: z.string().min(1),
  attempt: z.number().int().positive().default(1),
  timeoutMs: z.number().int().positive(),
  startedAt: z.string().min(1),
})

export type StepTimeoutLease = z.infer<typeof stepTimeoutLeaseSchema>

export interface StepTimeoutEvent {
  readonly nodeId: string
  readonly attempt: number
  readonly timeoutMs: number
  readonly elapsedMs: number
  readonly timedOutAt: string
}

export class StepTimeoutError extends Error {
  public readonly nodeId: string
  public readonly attempt: number
  public readonly timeoutMs: number

  constructor(nodeId: string, attempt: number, timeoutMs: number) {
    super(
      `Step "${nodeId}" (attempt ${String(attempt)}) exceeded execution timeout ceiling of ${String(timeoutMs)}ms`,
    )
    this.name = 'StepTimeoutError'
    this.nodeId = nodeId
    this.attempt = attempt
    this.timeoutMs = timeoutMs
  }
}

interface ActiveLeaseInternal {
  readonly lease: StepTimeoutLease
  readonly abortController: AbortController
  readonly timer: NodeJS.Timeout
  readonly startTime: number
}

/**
 * Supervisor tracking active DAG step execution leases and terminating hung/zombie stages (Axioms A2, A5).
 */
export class StepTimeoutSupervisor {
  private readonly leases = new Map<string, ActiveLeaseInternal>()
  private readonly auditLog: StepTimeoutEvent[] = []
  private readonly onTimeout?: ((event: StepTimeoutEvent) => void) | undefined

  constructor(options: { onTimeout?: ((event: StepTimeoutEvent) => void) | undefined } = {}) {
    this.onTimeout = options.onTimeout
  }

  /**
   * Registers a node execution under timeout supervision.
   */
  public register(
    nodeId: string,
    timeoutMs: number,
    abortController: AbortController,
    attempt = 1,
  ): StepTimeoutLease {
    // If lease already exists, deregister prior lease
    this.deregister(nodeId)

    const lease: StepTimeoutLease = {
      nodeId,
      attempt,
      timeoutMs,
      startedAt: new Date().toISOString(),
    }

    const startTime = Date.now()
    const timer = setTimeout(() => {
      this.handleTimeout(nodeId)
    }, timeoutMs)

    this.leases.set(nodeId, {
      lease,
      abortController,
      timer,
      startTime,
    })

    return lease
  }

  private handleTimeout(nodeId: string): void {
    const entry = this.leases.get(nodeId)
    if (!entry) return

    this.leases.delete(nodeId)
    const elapsedMs = Date.now() - entry.startTime

    const event: StepTimeoutEvent = {
      nodeId,
      attempt: entry.lease.attempt,
      timeoutMs: entry.lease.timeoutMs,
      elapsedMs,
      timedOutAt: new Date().toISOString(),
    }

    this.auditLog.push(event)

    try {
      entry.abortController.abort(
        new StepTimeoutError(nodeId, entry.lease.attempt, entry.lease.timeoutMs),
      )
    } catch {
      // Ignore abort handler errors
    }

    if (this.onTimeout) {
      try {
        this.onTimeout(event)
      } catch {
        // Ignore callback errors
      }
    }
  }

  /**
   * Deregisters a step when it completes naturally before timeout.
   */
  public deregister(nodeId: string): boolean {
    const entry = this.leases.get(nodeId)
    if (!entry) return false

    clearTimeout(entry.timer)
    this.leases.delete(nodeId)
    return true
  }

  /**
   * Returns list of currently active execution leases.
   */
  public getActiveLeases(): readonly StepTimeoutLease[] {
    return Array.from(this.leases.values()).map((e) => e.lease)
  }

  /**
   * Returns history of recorded timeout events.
   */
  public getAuditHistory(): readonly StepTimeoutEvent[] {
    return [...this.auditLog]
  }

  /**
   * Cancels all pending timers and clears leases (e.g. on shutdown).
   */
  public dispose(): void {
    for (const entry of this.leases.values()) {
      clearTimeout(entry.timer)
    }
    this.leases.clear()
  }
}
