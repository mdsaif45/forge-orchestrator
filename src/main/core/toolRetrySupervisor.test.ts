import { describe, it, expect } from 'vitest'
import {
  classifyToolError,
  calculateToolBackoff,
  evaluateToolRetry,
  type ToolRetryPolicy,
} from './toolRetrySupervisor'

describe('toolRetrySupervisor (AGENT-019)', () => {
  describe('classifyToolError', () => {
    it('classifies timeout errors accurately', () => {
      expect(classifyToolError(new Error('Operation timed out after 5000ms'))).toBe('timeout')
      expect(classifyToolError({ code: 'ETIMEDOUT', message: 'Connection dropped' })).toBe(
        'timeout',
      )
      expect(classifyToolError('deadline exceeded')).toBe('timeout')
    })

    it('classifies rate limit errors accurately', () => {
      expect(classifyToolError(new Error('HTTP 429 Too Many Requests'))).toBe('rate_limited')
      expect(classifyToolError('API quota exceeded for this billing cycle')).toBe('rate_limited')
    })

    it('classifies transient system errors accurately', () => {
      expect(classifyToolError({ code: 'EBUSY', message: 'Resource busy' })).toBe('transient')
      expect(classifyToolError(new Error('socket hang up'))).toBe('transient')
      expect(classifyToolError({ code: 'ECONNRESET', message: 'connection reset' })).toBe(
        'transient',
      )
    })

    it('classifies fatal syntax and argument errors as fatal', () => {
      expect(classifyToolError(new TypeError('Invalid argument: expected string'))).toBe('fatal')
      expect(classifyToolError(new Error('ENOENT: no such file or directory'))).toBe('fatal')
      expect(classifyToolError(null)).toBe('fatal')
    })
  })

  describe('calculateToolBackoff', () => {
    it('computes bounded exponential backoff with full jitter', () => {
      // Deterministic pseudo-random source returning 0.5
      const fixedRandom = () => 0.5
      const policy: ToolRetryPolicy = { baseBackoffMs: 1000, maxBackoffMs: 8000 }

      // Attempt 1: 0.5 * 1000 = 500
      expect(calculateToolBackoff(1, policy, fixedRandom)).toBe(500)
      // Attempt 2: 0.5 * 2000 = 1000
      expect(calculateToolBackoff(2, policy, fixedRandom)).toBe(1000)
      // Attempt 3: 0.5 * 4000 = 2000
      expect(calculateToolBackoff(3, policy, fixedRandom)).toBe(2000)
      // Attempt 4: 0.5 * 8000 = 4000 (capped at max 8000)
      expect(calculateToolBackoff(4, policy, fixedRandom)).toBe(4000)
    })
  })

  describe('evaluateToolRetry', () => {
    it('approves retry for transient error within attempt budget', () => {
      const decision = evaluateToolRetry(
        'read_file',
        1,
        { code: 'EBUSY', message: 'file locked' },
        { maxAttempts: 3 },
        [],
        () => 0.5,
      )

      expect(decision.shouldRetry).toBe(true)
      expect(decision.classification).toBe('transient')
      expect(decision.circuitTripped).toBe(false)
      expect(decision.backoffMs).toBe(250) // 0.5 * 500
      expect(decision.formattedSummary).toContain('[Tool Retry Approved]')
    })

    it('denies retry for fatal error', () => {
      const decision = evaluateToolRetry(
        'execute_command',
        1,
        new Error('Command not found: invalid_tool'),
      )

      expect(decision.shouldRetry).toBe(false)
      expect(decision.classification).toBe('fatal')
      expect(decision.formattedSummary).toContain('[Tool Retry Denied]')
    })

    it('denies retry when attempt budget is exceeded', () => {
      const decision = evaluateToolRetry('fetch_api', 3, new Error('HTTP 429 Too Many Requests'), {
        maxAttempts: 3,
      })

      expect(decision.shouldRetry).toBe(false)
      expect(decision.reason).toContain('Exceeded maximum retry attempts')
    })

    it('trips circuit breaker when repetitive identical failure pattern occurs', () => {
      const err = 'Database locked'
      const recentErrors = [err, err, err]

      const decision = evaluateToolRetry(
        'db_query',
        1,
        new Error(err),
        { failureThreshold: 3 },
        recentErrors,
      )

      expect(decision.shouldRetry).toBe(false)
      expect(decision.circuitTripped).toBe(true)
      expect(decision.reason).toContain('Circuit breaker tripped')
      expect(decision.formattedSummary).toContain('Circuit breaker tripped')
    })
  })
})
