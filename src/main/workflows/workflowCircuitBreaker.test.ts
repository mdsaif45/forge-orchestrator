import { describe, expect, it } from 'vitest'
import { WorkflowCircuitBreaker } from './workflowCircuitBreaker'

describe('WorkflowCircuitBreaker', () => {
  it('starts in CLOSED state and allows execution', () => {
    const breaker = new WorkflowCircuitBreaker({ failureThreshold: 3 })
    expect(breaker.getState()).toBe('CLOSED')
    const check = breaker.canExecute('step-1')
    expect(check.allowed).toBe(true)
    expect(check.state).toBe('CLOSED')
  })

  it('trips to OPEN state when failures reach threshold and intercepts execution', () => {
    const breaker = new WorkflowCircuitBreaker({ failureThreshold: 2 })
    breaker.recordFailure({ stepId: 'step-1', error: 'compile error' })
    expect(breaker.getState()).toBe('CLOSED')

    breaker.recordFailure({ stepId: 'step-1', error: 'type error' })
    expect(breaker.getState()).toBe('OPEN')

    const check = breaker.canExecute('step-2')
    expect(check.allowed).toBe(false)
    expect(check.state).toBe('OPEN')
    expect(check.reason).toContain('Circuit breaker is OPEN. Step "step-2" intercepted')
  })

  it('resets consecutive failures upon success in CLOSED state', () => {
    const breaker = new WorkflowCircuitBreaker({ failureThreshold: 2 })
    breaker.recordFailure({ stepId: 'step-1', error: 'intermittent timeout' })
    expect(breaker.getState()).toBe('CLOSED')

    breaker.recordSuccess('step-1')
    const metrics = breaker.getMetrics()
    expect(metrics.consecutiveFailures).toBe(0)

    breaker.recordFailure({ stepId: 'step-1', error: 'another timeout' })
    expect(breaker.getState()).toBe('CLOSED')
  })

  it('transitions from OPEN to HALF_OPEN after cooldown and recovers to CLOSED upon reaching success threshold', async () => {
    const breaker = new WorkflowCircuitBreaker({
      failureThreshold: 1,
      recoveryCooldownMs: 50,
      halfOpenSuccessThreshold: 2,
    })

    breaker.recordFailure({ stepId: 'step-1', error: 'boom' })
    expect(breaker.getState()).toBe('OPEN')

    // Wait for cooldown
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(breaker.getState()).toBe('HALF_OPEN')

    const check = breaker.canExecute('step-retry')
    expect(check.allowed).toBe(true)
    expect(check.state).toBe('HALF_OPEN')

    breaker.recordSuccess('step-retry')
    expect(breaker.getState()).toBe('HALF_OPEN')

    breaker.recordSuccess('step-retry-2')
    expect(breaker.getState()).toBe('CLOSED')
  })

  it('trips back to OPEN immediately if failure occurs during HALF_OPEN state', async () => {
    const breaker = new WorkflowCircuitBreaker({
      failureThreshold: 2,
      recoveryCooldownMs: 50,
      halfOpenSuccessThreshold: 2,
    })

    breaker.recordFailure({ stepId: 'step-1', error: 'fail 1' })
    breaker.recordFailure({ stepId: 'step-1', error: 'fail 2' })
    expect(breaker.getState()).toBe('OPEN')

    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(breaker.getState()).toBe('HALF_OPEN')

    breaker.recordFailure({ stepId: 'step-test', error: 'immediate failure in half-open' })
    expect(breaker.getState()).toBe('OPEN')

    const check = breaker.canExecute('step-next')
    expect(check.allowed).toBe(false)
  })
})
