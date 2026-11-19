import { z } from 'zod'

export type CircuitBreakerState = 'closed' | 'open' | 'half-open'

export const modelSpecSchema = z.strictObject({
  providerId: z.string().min(1),
  model: z.string().min(1),
  endpointUrl: z.string().optional(),
  apiKey: z.string().optional(),
})

export type ModelSpec = z.infer<typeof modelSpecSchema>

export const modelFallbackConfigSchema = z.strictObject({
  primary: modelSpecSchema,
  fallbacks: z.array(modelSpecSchema).default([]),
})

export type ModelFallbackConfig = z.infer<typeof modelFallbackConfigSchema>

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before tripping circuit from closed to open (default: 3). */
  readonly failureThreshold?: number
  /** Cooldown time in ms before attempting a half-open trial (default: 30,000 ms). */
  readonly cooldownMs?: number
  /** Maximum consecutive successes in half-open state before closing circuit (default: 1). */
  readonly halfOpenSuccessThreshold?: number
}

export interface ModelBreakerStatus {
  readonly providerId: string
  readonly state: CircuitBreakerState
  readonly consecutiveFailures: number
  readonly consecutiveSuccesses: number
  readonly lastFailureTimestamp: number | null
  readonly cooldownRemainingMs: number
}

export interface FallbackAttemptRecord {
  readonly model: ModelSpec
  readonly durationMs: number
  readonly error?: string | undefined
}

export interface FallbackRouteResult<T> {
  readonly success: boolean
  readonly result: T | null
  readonly executedModel: ModelSpec | null
  readonly attempts: readonly FallbackAttemptRecord[]
  readonly error?: string | undefined
  readonly formattedSummary: string
}

/**
 * In-memory provider circuit breaker preventing cascading failures and hammering unavailable endpoints (Axiom A2).
 */
export class ModelCircuitBreaker {
  private readonly failureThreshold: number
  private readonly cooldownMs: number
  private readonly halfOpenSuccessThreshold: number

  private readonly failureCounts = new Map<string, number>()
  private readonly successCounts = new Map<string, number>()
  private readonly lastFailureTimes = new Map<string, number>()
  private readonly forcedStates = new Map<string, CircuitBreakerState>()

  constructor(options: CircuitBreakerOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3
    this.cooldownMs = options.cooldownMs ?? 30_000
    this.halfOpenSuccessThreshold = options.halfOpenSuccessThreshold ?? 1
  }

  public getState(providerId: string): CircuitBreakerState {
    const forced = this.forcedStates.get(providerId)
    if (forced) return forced

    const failures = this.failureCounts.get(providerId) ?? 0
    if (failures < this.failureThreshold) {
      return 'closed'
    }

    const lastFailure = this.lastFailureTimes.get(providerId) ?? 0
    const elapsed = Date.now() - lastFailure
    if (elapsed >= this.cooldownMs) {
      return 'half-open'
    }

    return 'open'
  }

  public getStatus(providerId: string): ModelBreakerStatus {
    const state = this.getState(providerId)
    const consecutiveFailures = this.failureCounts.get(providerId) ?? 0
    const consecutiveSuccesses = this.successCounts.get(providerId) ?? 0
    const lastFailure = this.lastFailureTimes.get(providerId) ?? null
    let cooldownRemainingMs = 0

    if (state === 'open' && lastFailure !== null) {
      const elapsed = Date.now() - lastFailure
      cooldownRemainingMs = Math.max(0, this.cooldownMs - elapsed)
    }

    return {
      providerId,
      state,
      consecutiveFailures,
      consecutiveSuccesses,
      lastFailureTimestamp: lastFailure,
      cooldownRemainingMs,
    }
  }

  public getAllStatuses(): ModelBreakerStatus[] {
    const allProviders = new Set([
      ...this.failureCounts.keys(),
      ...this.forcedStates.keys(),
      ...this.lastFailureTimes.keys(),
    ])
    return Array.from(allProviders)
      .sort()
      .map((p) => this.getStatus(p))
  }

  public recordFailure(providerId: string): CircuitBreakerState {
    this.successCounts.delete(providerId)
    const current = (this.failureCounts.get(providerId) ?? 0) + 1
    this.failureCounts.set(providerId, current)
    this.lastFailureTimes.set(providerId, Date.now())

    return this.getState(providerId)
  }

  public recordSuccess(providerId: string): void {
    const state = this.getState(providerId)
    if (state === 'half-open') {
      const successes = (this.successCounts.get(providerId) ?? 0) + 1
      this.successCounts.set(providerId, successes)
      if (successes >= this.halfOpenSuccessThreshold) {
        this.reset(providerId)
      }
    } else if (state === 'closed') {
      this.failureCounts.delete(providerId)
      this.lastFailureTimes.delete(providerId)
      this.successCounts.delete(providerId)
    }
  }

  public reset(providerId?: string): void {
    if (providerId) {
      this.failureCounts.delete(providerId)
      this.successCounts.delete(providerId)
      this.lastFailureTimes.delete(providerId)
      this.forcedStates.delete(providerId)
    } else {
      this.failureCounts.clear()
      this.successCounts.clear()
      this.lastFailureTimes.clear()
      this.forcedStates.clear()
    }
  }
}

/**
 * Determines whether an error is transient/fatal and eligible for circuit fallback (Axioms A2, A6).
 */
export function isFallbackEligibleError(error: unknown): boolean {
  if (!error) return false
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error)
  const lower = msg.toLowerCase()

  return (
    lower.includes('429') ||
    lower.includes('rate limit') ||
    lower.includes('quota') ||
    lower.includes('econnrefused') ||
    lower.includes('fetch failed') ||
    lower.includes('503') ||
    lower.includes('502') ||
    lower.includes('504') ||
    lower.includes('timeout') ||
    lower.includes('overloaded')
  )
}

/**
 * Executes a model task against the primary model with automatic fallback through the fallback chain (Axiom A2).
 */
export async function routeWithFallback<T>(
  config: ModelFallbackConfig,
  breaker: ModelCircuitBreaker,
  executeFn: (model: ModelSpec) => Promise<T>,
): Promise<FallbackRouteResult<T>> {
  const chain: ModelSpec[] = [config.primary, ...config.fallbacks]
  const attempts: FallbackAttemptRecord[] = []

  for (let i = 0; i < chain.length; i++) {
    const candidate = chain[i]
    if (!candidate) continue

    const state = breaker.getState(candidate.providerId)
    if (state === 'open') {
      attempts.push({
        model: candidate,
        durationMs: 0,
        error: `Circuit breaker OPEN for provider "${candidate.providerId}" (cooldown active)`,
      })
      continue
    }

    const start = Date.now()
    try {
      const result = await executeFn(candidate)
      const durationMs = Date.now() - start
      breaker.recordSuccess(candidate.providerId)
      attempts.push({ model: candidate, durationMs })

      const fallbackUsed = i > 0
      const summary = fallbackUsed
        ? `✓ Executed via fallback model ${candidate.providerId} (${candidate.model}) after ${String(i)} failed attempt(s)`
        : `✓ Executed via primary model ${candidate.providerId} (${candidate.model}) in ${String(durationMs)}ms`

      return {
        success: true,
        result,
        executedModel: candidate,
        attempts,
        formattedSummary: summary,
      }
    } catch (err) {
      const durationMs = Date.now() - start
      const errMsg = err instanceof Error ? err.message : String(err)
      attempts.push({ model: candidate, durationMs, error: errMsg })

      if (isFallbackEligibleError(err)) {
        breaker.recordFailure(candidate.providerId)
      }

      // If last candidate failed, break
      if (i === chain.length - 1) {
        break
      }
    }
  }

  const errorSummary = `All ${String(chain.length)} model candidates in fallback chain failed.`
  return {
    success: false,
    result: null,
    executedModel: null,
    attempts,
    error: errorSummary,
    formattedSummary:
      `✗ ${errorSummary}\n` +
      attempts
        .map((a) => `  • ${a.model.providerId}/${a.model.model}: ${a.error ?? 'unknown error'}`)
        .join('\n'),
  }
}
