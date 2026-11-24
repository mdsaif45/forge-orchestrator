import { describe, expect, it } from 'vitest'
import {
  calculateExponentialBackoff,
  classifyStepError,
  evaluateStepRetry,
} from './stepRetryPolicy'

describe('StepRetryPolicySupervisor (WORK-022)', () => {
  it('calculates exponential backoff with ceiling and deterministic bounds', () => {
    const b1 = calculateExponentialBackoff(1, 1000, 2.0, 30000, 0)
    const b2 = calculateExponentialBackoff(2, 1000, 2.0, 30000, 0)
    const b3 = calculateExponentialBackoff(3, 1000, 2.0, 30000, 0)
    const bCapped = calculateExponentialBackoff(10, 1000, 2.0, 10000, 0)

    expect(b1).toBe(1000)
    expect(b2).toBe(2000)
    expect(b3).toBe(4000)
    expect(bCapped).toBe(10000)
  })

  it('classifies transient errors correctly', () => {
    expect(classifyStepError(new Error('Rate limit exceeded 429'))).toBe('transient')
    expect(classifyStepError('Connection reset by peer ECONNRESET')).toBe('transient')
    expect(classifyStepError(new Error('Request timed out after 5000ms'))).toBe('transient')
  })

  it('classifies permanent errors correctly', () => {
    expect(classifyStepError(new Error('SyntaxError: Unexpected token'))).toBe('permanent')
    expect(classifyStepError('401 Unauthorized token')).toBe('permanent')
    expect(classifyStepError(new Error('Validation failed for input schema'))).toBe('permanent')
  })

  it('approves retry for transient failure within attempt ceiling', () => {
    const evalRes = evaluateStepRetry('step-coder', 1, new Error('ECONNRESET: socket hang up'), {
      maxAttempts: 3,
      initialBackoffMs: 500,
    })

    expect(evalRes.shouldRetry).toBe(true)
    expect(evalRes.attempt).toBe(1)
    expect(evalRes.maxAttempts).toBe(3)
    expect(evalRes.backoffMs).toBeGreaterThan(0)
    expect(evalRes.dispatchToDLQ).toBe(false)
    expect(evalRes.errorClassification).toBe('transient')
  })

  it('rejects retry and dispatches to DLQ on permanent error or attempt exhaustion', () => {
    const permRes = evaluateStepRetry('step-coder', 1, new Error('401 Unauthorized API key'))
    expect(permRes.shouldRetry).toBe(false)
    expect(permRes.errorClassification).toBe('permanent')
    expect(permRes.dispatchToDLQ).toBe(true)

    const exhaustRes = evaluateStepRetry('step-coder', 3, new Error('Gateway 504 Timeout'), {
      maxAttempts: 3,
    })
    expect(exhaustRes.shouldRetry).toBe(false)
    expect(exhaustRes.exhausted).toBe(true)
    expect(exhaustRes.dispatchToDLQ).toBe(true)
  })
})
