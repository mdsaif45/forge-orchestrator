import { z } from 'zod'

export const rateLimiterConfigSchema = z.strictObject({
  /** Maximum burst capacity of tokens in the bucket (default: 60). */
  capacity: z.number().int().positive().default(60),
  /** Number of tokens added to bucket per second (default: 1.0). */
  refillRatePerSec: z.number().positive().default(1),
  /** Maximum allowed concurrent in-flight tool executions (default: 5). */
  maxConcurrency: z.number().int().positive().default(5),
})

export type RateLimiterConfig = z.infer<typeof rateLimiterConfigSchema>

export interface RateLimiterMetrics {
  readonly currentTokens: number
  readonly activeConcurrency: number
  readonly totalAcquired: number
  readonly totalThrottled: number
  readonly capacity: number
  readonly refillRatePerSec: number
  readonly maxConcurrency: number
}

/**
 * In-memory token bucket rate limiter and concurrency throttler for agent tool invocations (Axioms A2, A5).
 */
export class ToolRateLimiter {
  private readonly capacity: number
  private readonly refillRatePerSec: number
  private readonly maxConcurrency: number

  private tokens: number
  private activeConcurrency = 0
  private lastRefillTimestamp: number
  private totalAcquired = 0
  private totalThrottled = 0

  constructor(options: Partial<RateLimiterConfig> = {}) {
    const validated = rateLimiterConfigSchema.parse(options)
    this.capacity = validated.capacity
    this.refillRatePerSec = validated.refillRatePerSec
    this.maxConcurrency = validated.maxConcurrency

    this.tokens = this.capacity
    this.lastRefillTimestamp = Date.now()
  }

  private refill(): void {
    const now = Date.now()
    const elapsedSec = (now - this.lastRefillTimestamp) / 1000
    if (elapsedSec > 0) {
      const addedTokens = elapsedSec * this.refillRatePerSec
      this.tokens = Math.min(this.capacity, this.tokens + addedTokens)
      this.lastRefillTimestamp = now
    }
  }

  /**
   * Immediately attempts to acquire tokens and a concurrency slot without blocking.
   * Returns true if acquired, false if throttled.
   */
  public tryAcquire(cost = 1): boolean {
    this.refill()

    if (this.activeConcurrency >= this.maxConcurrency) {
      this.totalThrottled++
      return false
    }

    if (this.tokens >= cost) {
      this.tokens -= cost
      this.activeConcurrency++
      this.totalAcquired++
      return true
    }

    this.totalThrottled++
    return false
  }

  /**
   * Asynchronously waits to acquire tokens and concurrency slot up to maxWaitMs.
   * Fails closed if timeout is reached (Axiom A2).
   */
  public async acquire(cost = 1, maxWaitMs = 5000): Promise<boolean> {
    const startTime = Date.now()

    while (Date.now() - startTime <= maxWaitMs) {
      if (this.tryAcquire(cost)) {
        return true
      }

      // Calculate estimated wait time for next token
      this.refill()
      const needed = Math.max(0, cost - this.tokens)
      const waitMs = Math.min(100, Math.max(10, Math.ceil((needed / this.refillRatePerSec) * 1000)))

      if (Date.now() - startTime + waitMs > maxWaitMs) {
        break
      }

      await new Promise((resolve) => setTimeout(resolve, waitMs))
    }

    return false
  }

  /**
   * Releases an active concurrency slot when tool execution finishes.
   */
  public release(): void {
    if (this.activeConcurrency > 0) {
      this.activeConcurrency--
    }
  }

  /**
   * Returns current limiter operational metrics.
   */
  public getMetrics(): RateLimiterMetrics {
    this.refill()
    return {
      currentTokens: Math.floor(this.tokens),
      activeConcurrency: this.activeConcurrency,
      totalAcquired: this.totalAcquired,
      totalThrottled: this.totalThrottled,
      capacity: this.capacity,
      refillRatePerSec: this.refillRatePerSec,
      maxConcurrency: this.maxConcurrency,
    }
  }

  /**
   * Resets limiter to full capacity and zero active concurrency.
   */
  public reset(): void {
    this.tokens = this.capacity
    this.activeConcurrency = 0
    this.lastRefillTimestamp = Date.now()
    this.totalAcquired = 0
    this.totalThrottled = 0
  }
}
