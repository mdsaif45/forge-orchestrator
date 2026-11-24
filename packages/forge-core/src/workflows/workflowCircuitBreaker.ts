export type CircuitBreakerState = 'CLOSED' | 'OPEN' | 'HALF_OPEN'

export type ErrorCategory = 'deterministic' | 'transient' | 'policy_violation'

export interface StepFailureRecord {
  stepId: string
  error: string
  errorCategory?: ErrorCategory | undefined
  timestamp?: number | undefined
}

export interface CircuitBreakerConfig {
  failureThreshold?: number | undefined
  recoveryCooldownMs?: number | undefined
  windowSize?: number | undefined
  halfOpenSuccessThreshold?: number | undefined
}

export interface CircuitBreakerMetrics {
  state: CircuitBreakerState
  consecutiveFailures: number
  consecutiveSuccesses: number
  totalFailures: number
  totalSuccesses: number
  lastFailureTime: number | null
  lastStateTransitionTime: number
}

export class WorkflowCircuitBreaker {
  private state: CircuitBreakerState = 'CLOSED'
  private consecutiveFailures = 0
  private consecutiveSuccesses = 0
  private totalFailures = 0
  private totalSuccesses = 0
  private lastFailureTime: number | null = null
  private lastStateTransitionTime: number = Date.now()

  private readonly failureThreshold: number
  private readonly recoveryCooldownMs: number
  private readonly halfOpenSuccessThreshold: number

  constructor(config?: CircuitBreakerConfig) {
    this.failureThreshold = Math.max(1, config?.failureThreshold ?? 3)
    this.recoveryCooldownMs = Math.max(10, config?.recoveryCooldownMs ?? 30_000)
    this.halfOpenSuccessThreshold = Math.max(1, config?.halfOpenSuccessThreshold ?? 2)
  }

  public getState(): CircuitBreakerState {
    this.checkCooldownTransition()
    return this.state
  }

  private checkCooldownTransition(): void {
    if (this.state === 'OPEN') {
      const elapsed = Date.now() - this.lastStateTransitionTime
      if (elapsed >= this.recoveryCooldownMs) {
        this.transitionTo('HALF_OPEN')
      }
    }
  }

  private transitionTo(newState: CircuitBreakerState): void {
    if (this.state !== newState) {
      this.state = newState
      this.lastStateTransitionTime = Date.now()
      if (newState === 'HALF_OPEN') {
        this.consecutiveSuccesses = 0
      }
    }
  }

  public canExecute(stepId: string): {
    allowed: boolean
    reason?: string | undefined
    state: CircuitBreakerState
  } {
    this.checkCooldownTransition()

    if (this.state === 'OPEN') {
      const remainingCooldown = Math.max(
        0,
        this.recoveryCooldownMs - (Date.now() - this.lastStateTransitionTime),
      )
      return {
        allowed: false,
        reason: `Circuit breaker is OPEN. Step "${stepId}" intercepted. Cooldown remaining: ${String(remainingCooldown)}ms.`,
        state: this.state,
      }
    }

    return {
      allowed: true,
      state: this.state,
    }
  }

  public recordSuccess(_stepId: string): CircuitBreakerState {
    this.checkCooldownTransition()
    this.totalSuccesses += 1

    if (this.state === 'HALF_OPEN') {
      this.consecutiveSuccesses += 1
      if (this.consecutiveSuccesses >= this.halfOpenSuccessThreshold) {
        this.consecutiveFailures = 0
        this.transitionTo('CLOSED')
      }
    } else if (this.state === 'CLOSED') {
      this.consecutiveFailures = 0
      this.consecutiveSuccesses += 1
    }

    return this.state
  }

  public recordFailure(record: StepFailureRecord): CircuitBreakerState {
    this.checkCooldownTransition()
    this.totalFailures += 1
    this.consecutiveFailures += 1
    this.consecutiveSuccesses = 0
    this.lastFailureTime = record.timestamp ?? Date.now()

    if (this.state === 'CLOSED') {
      if (this.consecutiveFailures >= this.failureThreshold) {
        this.transitionTo('OPEN')
      }
    } else if (this.state === 'HALF_OPEN') {
      // In half-open, any failure trips immediately back to OPEN
      this.transitionTo('OPEN')
    }

    return this.state
  }

  public reset(): void {
    this.state = 'CLOSED'
    this.consecutiveFailures = 0
    this.consecutiveSuccesses = 0
    this.lastFailureTime = null
    this.lastStateTransitionTime = Date.now()
  }

  public getMetrics(): CircuitBreakerMetrics {
    this.checkCooldownTransition()
    return {
      state: this.state,
      consecutiveFailures: this.consecutiveFailures,
      consecutiveSuccesses: this.consecutiveSuccesses,
      totalFailures: this.totalFailures,
      totalSuccesses: this.totalSuccesses,
      lastFailureTime: this.lastFailureTime,
      lastStateTransitionTime: this.lastStateTransitionTime,
    }
  }
}
