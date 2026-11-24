import { describe, expect, it } from 'vitest'
import {
  calculateWorkflowBackoffDelay,
  classifyWorkflowFailure,
  DEFAULT_WORKFLOW_RETRY_POLICY,
  evaluateStepRetryAndEscalation,
} from './retryEscalationRouter'

describe('retryEscalationRouter (WORK-028)', () => {
  it('classifies errors correctly into failure categories', () => {
    expect(classifyWorkflowFailure(new Error('fetch failed: ECONNREFUSED'))).toBe(
      'transient_network',
    )
    expect(classifyWorkflowFailure('Database is locked: sqlite_busy')).toBe('resource_contention')
    expect(classifyWorkflowFailure('Step execution timed out after 30000ms')).toBe('timeout')
    expect(classifyWorkflowFailure('TypeError: Cannot read properties of undefined')).toBe(
      'fatal_logic',
    )
    expect(classifyWorkflowFailure('Invalid schema: missing required field id')).toBe(
      'validation_error',
    )
    expect(classifyWorkflowFailure(null)).toBe('unknown')
  })

  it('calculates deterministic backoff delays with and without jitter', () => {
    const noJitterPolicy = {
      ...DEFAULT_WORKFLOW_RETRY_POLICY,
      enableJitter: false,
      baseDelayMs: 1000,
      backoffFactor: 2,
      maxDelayMs: 10000,
    }

    expect(calculateWorkflowBackoffDelay(1, noJitterPolicy)).toBe(1000)
    expect(calculateWorkflowBackoffDelay(2, noJitterPolicy)).toBe(2000)
    expect(calculateWorkflowBackoffDelay(3, noJitterPolicy)).toBe(4000)
    expect(calculateWorkflowBackoffDelay(4, noJitterPolicy)).toBe(8000)
    expect(calculateWorkflowBackoffDelay(5, noJitterPolicy)).toBe(10000) // capped at maxDelayMs
  })

  it('schedules retry for transient error when attempts < maxRetries', () => {
    const decision = evaluateStepRetryAndEscalation(
      'step-http-fetch',
      1,
      new Error('socket hang up (ECONNREFUSED)'),
      { maxRetries: 3, baseDelayMs: 500, enableJitter: false },
    )

    expect(decision.stepId).toBe('step-http-fetch')
    expect(decision.shouldRetry).toBe(true)
    expect(decision.failureCategory).toBe('transient_network')
    expect(decision.escalatedToDlq).toBe(false)
    expect(decision.delayMs).toBe(1000) // attempt 2 => 500 * 2^1 = 1000
    expect(decision.reason).toContain('Transient error')
  })

  it('escalates immediately to DLQ for fatal logic or validation error', () => {
    const decision = evaluateStepRetryAndEscalation(
      'step-validate-payload',
      1,
      new Error('Validation error: invalid schema definition'),
    )

    expect(decision.shouldRetry).toBe(false)
    expect(decision.failureCategory).toBe('validation_error')
    expect(decision.escalatedToDlq).toBe(true)
    expect(decision.delayMs).toBe(0)
    expect(decision.reason).toContain('Fatal non-retryable failure')
  })

  it('escalates to DLQ when maxRetries is exhausted', () => {
    const decision = evaluateStepRetryAndEscalation(
      'step-db-write',
      3,
      new Error('Database locked: sqlite_busy'),
      { maxRetries: 3 },
    )

    expect(decision.shouldRetry).toBe(false)
    expect(decision.escalatedToDlq).toBe(true)
    expect(decision.reason).toContain('Retry limit exhausted (3/3 attempts)')
  })
})
