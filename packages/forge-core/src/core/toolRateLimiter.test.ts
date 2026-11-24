import { describe, expect, it } from 'vitest'
import { ToolRateLimiter } from './toolRateLimiter'

describe('Tool Call Rate Limiter & Token Bucket Throttler (AGENT-009)', () => {
  it('acquires tokens up to burst capacity and throttles when depleted', () => {
    const limiter = new ToolRateLimiter({ capacity: 3, refillRatePerSec: 10, maxConcurrency: 10 })

    expect(limiter.tryAcquire(1)).toBe(true)
    expect(limiter.tryAcquire(1)).toBe(true)
    expect(limiter.tryAcquire(1)).toBe(true)
    // Depleted
    expect(limiter.tryAcquire(1)).toBe(false)

    const metrics = limiter.getMetrics()
    expect(metrics.totalAcquired).toBe(3)
    expect(metrics.totalThrottled).toBe(1)
  })

  it('enforces maximum in-flight concurrency limits', () => {
    const limiter = new ToolRateLimiter({ capacity: 10, refillRatePerSec: 10, maxConcurrency: 2 })

    expect(limiter.tryAcquire(1)).toBe(true)
    expect(limiter.tryAcquire(1)).toBe(true)
    // Concurrency ceiling reached
    expect(limiter.tryAcquire(1)).toBe(false)

    // Release one slot
    limiter.release()
    expect(limiter.tryAcquire(1)).toBe(true)
  })

  it('fails closed when acquire times out against depleted bucket', async () => {
    const limiter = new ToolRateLimiter({ capacity: 1, refillRatePerSec: 0.1, maxConcurrency: 5 })
    expect(limiter.tryAcquire(1)).toBe(true)

    // Next acquire with low wait time should fail closed
    const acquired = await limiter.acquire(1, 50)
    expect(acquired).toBe(false)
  })

  it('refills tokens over time and resets metrics', async () => {
    const limiter = new ToolRateLimiter({ capacity: 5, refillRatePerSec: 50, maxConcurrency: 5 })
    expect(limiter.tryAcquire(5)).toBe(true)
    expect(limiter.tryAcquire(1)).toBe(false)

    // Wait for refill
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(limiter.tryAcquire(1)).toBe(true)

    limiter.reset()
    const metrics = limiter.getMetrics()
    expect(metrics.currentTokens).toBe(5)
    expect(metrics.activeConcurrency).toBe(0)
  })
})
