import { describe, it, expect, beforeEach } from 'vitest'
import { StepExecutionConcurrencyLimiter } from './stepConcurrencyLimiter'

describe('StepExecutionConcurrencyLimiter (WORK-023)', () => {
  let limiter: StepExecutionConcurrencyLimiter

  beforeEach(() => {
    limiter = new StepExecutionConcurrencyLimiter(2)
  })

  it('rejects invalid capacity configuration', () => {
    expect(() => new StepExecutionConcurrencyLimiter(0)).toThrow(/positive integer/i)
    expect(() => new StepExecutionConcurrencyLimiter(-1)).toThrow(/positive integer/i)
  })

  it('acquires and releases permits within capacity limit', async () => {
    expect(limiter.getAvailablePermits()).toBe(2)

    const p1 = await limiter.acquire('step-1')
    expect(p1.stepId).toBe('step-1')
    expect(limiter.getActiveCount()).toBe(1)
    expect(limiter.getAvailablePermits()).toBe(1)

    const p2 = await limiter.acquire('step-2')
    expect(p2.stepId).toBe('step-2')
    expect(limiter.getActiveCount()).toBe(2)
    expect(limiter.getAvailablePermits()).toBe(0)

    limiter.release(p1.permitId)
    expect(limiter.getActiveCount()).toBe(1)
    expect(limiter.getAvailablePermits()).toBe(1)

    limiter.release(p2.permitId)
    expect(limiter.getActiveCount()).toBe(0)
    expect(limiter.getAvailablePermits()).toBe(2)
  })

  it('queues permit requests when capacity is exceeded and resolves FIFO on release', async () => {
    const p1 = await limiter.acquire('step-1')
    const p2 = await limiter.acquire('step-2')
    expect(limiter.getActiveCount()).toBe(2)

    // step-3 should wait
    let p3Resolved = false
    const p3Promise = limiter.acquire('step-3').then((permit) => {
      p3Resolved = true
      return permit
    })

    expect(limiter.getQueueLength()).toBe(1)
    expect(p3Resolved).toBe(false)

    // Release p1 -> step-3 should be resolved
    limiter.release(p1.permitId)
    const p3 = await p3Promise
    expect(p3Resolved).toBe(true)
    expect(p3.stepId).toBe('step-3')
    expect(limiter.getQueueLength()).toBe(0)

    limiter.release(p2.permitId)
    limiter.release(p3.permitId)
    expect(limiter.getActiveCount()).toBe(0)
  })

  it('times out waiting permit requests when timeout is exceeded', async () => {
    await limiter.acquire('step-1')
    await limiter.acquire('step-2')

    // Timeout in 20ms
    await expect(limiter.acquire('step-3', 20)).rejects.toThrow(/timed out after 20ms/i)
    expect(limiter.getQueueLength()).toBe(0)
  })

  it('withPermit executes scoped callback and automatically releases permit even on error', async () => {
    let activeDuring = 0
    await limiter.withPermit('scoped-step', () => {
      activeDuring = limiter.getActiveCount()
      return Promise.resolve('done')
    })

    expect(activeDuring).toBe(1)
    expect(limiter.getActiveCount()).toBe(0)

    // On exception
    await expect(
      limiter.withPermit('failing-step', () => {
        return Promise.reject(new Error('boom'))
      }),
    ).rejects.toThrow('boom')

    expect(limiter.getActiveCount()).toBe(0)
  })

  it('reports formatted status summary', async () => {
    await limiter.acquire('step-diag')
    const status = limiter.getStatus()
    expect(status.capacity).toBe(2)
    expect(status.activeCount).toBe(1)
    expect(status.availablePermits).toBe(1)
    expect(status.formattedSummary).toContain('STEP CONCURRENCY SEMAPHORE STATUS')
    expect(status.formattedSummary).toContain('step-diag')
  })
})
