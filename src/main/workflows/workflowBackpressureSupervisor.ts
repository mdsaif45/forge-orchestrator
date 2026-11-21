export type BackpressureState = 'NORMAL' | 'THROTTLED' | 'SATURATED' | 'REJECTING'

export interface BackpressureConfig {
  maxQueueCapacity?: number | undefined
  throttleThresholdRatio?: number | undefined
  saturatedThresholdRatio?: number | undefined
  baseThrottleDelayMs?: number | undefined
  maxThrottleDelayMs?: number | undefined
}

export interface IngestionDecision {
  state: BackpressureState
  allowSubmission: boolean
  delayMs: number
  currentQueueDepth: number
  maxCapacity: number
  reason?: string | undefined
}

export interface BackpressureMetrics {
  state: BackpressureState
  pendingQueueDepth: number
  inflightTasks: number
  completedTasks: number
  totalRejected: number
  throttleDelayMs: number
}

export class WorkflowBackpressureSupervisor {
  private readonly maxQueueCapacity: number
  private readonly throttleThresholdRatio: number
  private readonly saturatedThresholdRatio: number
  private readonly baseThrottleDelayMs: number
  private readonly maxThrottleDelayMs: number

  private pendingQueueDepth = 0
  private inflightTasks = 0
  private completedTasks = 0
  private totalRejected = 0

  constructor(config?: BackpressureConfig) {
    this.maxQueueCapacity = Math.max(1, config?.maxQueueCapacity ?? 50)
    this.throttleThresholdRatio = Math.max(
      0.1,
      Math.min(0.9, config?.throttleThresholdRatio ?? 0.6),
    )
    this.saturatedThresholdRatio = Math.max(
      this.throttleThresholdRatio,
      Math.min(0.99, config?.saturatedThresholdRatio ?? 0.85),
    )
    this.baseThrottleDelayMs = Math.max(10, config?.baseThrottleDelayMs ?? 200)
    this.maxThrottleDelayMs = Math.max(this.baseThrottleDelayMs, config?.maxThrottleDelayMs ?? 5000)
  }

  public getState(): BackpressureState {
    const ratio = this.pendingQueueDepth / this.maxQueueCapacity
    if (this.pendingQueueDepth >= this.maxQueueCapacity) {
      return 'REJECTING'
    }
    if (ratio >= this.saturatedThresholdRatio) {
      return 'SATURATED'
    }
    if (ratio >= this.throttleThresholdRatio) {
      return 'THROTTLED'
    }
    return 'NORMAL'
  }

  public evaluateSubmission(taskSize = 1): IngestionDecision {
    const projected = this.pendingQueueDepth + taskSize
    const ratio = projected / this.maxQueueCapacity

    if (projected > this.maxQueueCapacity) {
      return {
        state: 'REJECTING',
        allowSubmission: false,
        delayMs: this.maxThrottleDelayMs,
        currentQueueDepth: this.pendingQueueDepth,
        maxCapacity: this.maxQueueCapacity,
        reason: `Queue capacity exceeded: pending (${String(this.pendingQueueDepth)}) + taskSize (${String(taskSize)}) > max (${String(this.maxQueueCapacity)}).`,
      }
    }

    if (ratio >= this.saturatedThresholdRatio) {
      return {
        state: 'SATURATED',
        allowSubmission: true,
        delayMs: this.maxThrottleDelayMs,
        currentQueueDepth: this.pendingQueueDepth,
        maxCapacity: this.maxQueueCapacity,
        reason: `Queue is saturated (${String(Math.round(ratio * 100))}% load). Maximum throttle delay applied.`,
      }
    }

    if (ratio >= this.throttleThresholdRatio) {
      const normalizedRange =
        (ratio - this.throttleThresholdRatio) /
        (this.saturatedThresholdRatio - this.throttleThresholdRatio)
      const delay = Math.round(
        this.baseThrottleDelayMs +
          normalizedRange * (this.maxThrottleDelayMs - this.baseThrottleDelayMs),
      )
      return {
        state: 'THROTTLED',
        allowSubmission: true,
        delayMs: delay,
        currentQueueDepth: this.pendingQueueDepth,
        maxCapacity: this.maxQueueCapacity,
        reason: `Queue is under moderate load (${String(Math.round(ratio * 100))}%). Throttle delay of ${String(delay)}ms applied.`,
      }
    }

    return {
      state: 'NORMAL',
      allowSubmission: true,
      delayMs: 0,
      currentQueueDepth: this.pendingQueueDepth,
      maxCapacity: this.maxQueueCapacity,
    }
  }

  public enqueueTask(_stepId: string): boolean {
    const decision = this.evaluateSubmission(1)
    if (!decision.allowSubmission) {
      this.totalRejected += 1
      return false
    }
    this.pendingQueueDepth += 1
    this.inflightTasks += 1
    return true
  }

  public completeTask(_stepId: string): void {
    if (this.pendingQueueDepth > 0) {
      this.pendingQueueDepth -= 1
    }
    if (this.inflightTasks > 0) {
      this.inflightTasks -= 1
    }
    this.completedTasks += 1
  }

  public getMetrics(): BackpressureMetrics {
    const decision = this.evaluateSubmission(0)
    return {
      state: this.getState(),
      pendingQueueDepth: this.pendingQueueDepth,
      inflightTasks: this.inflightTasks,
      completedTasks: this.completedTasks,
      totalRejected: this.totalRejected,
      throttleDelayMs: decision.delayMs,
    }
  }

  public reset(): void {
    this.pendingQueueDepth = 0
    this.inflightTasks = 0
    this.completedTasks = 0
    this.totalRejected = 0
  }
}
