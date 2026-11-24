import { describe, expect, it, vi } from 'vitest'
import {
  isFallbackEligibleError,
  ModelCircuitBreaker,
  type ModelFallbackConfig,
  type ModelSpec,
  routeWithFallback,
} from './modelFallbackRouter'

describe('Dynamic Multi-Model Fallback Router & Circuit Breaker (AGENT-008)', () => {
  it('correctly transitions circuit breaker states (closed -> open -> half-open -> closed)', () => {
    const breaker = new ModelCircuitBreaker({
      failureThreshold: 2,
      cooldownMs: 50,
      halfOpenSuccessThreshold: 1,
    })

    expect(breaker.getState('ollama')).toBe('closed')

    // 1st failure: still closed
    breaker.recordFailure('ollama')
    expect(breaker.getState('ollama')).toBe('closed')

    // 2nd failure: trips open
    breaker.recordFailure('ollama')
    expect(breaker.getState('ollama')).toBe('open')

    const status = breaker.getStatus('ollama')
    expect(status.consecutiveFailures).toBe(2)
    expect(status.cooldownRemainingMs).toBeGreaterThan(0)

    // Wait past cooldown
    vi.useFakeTimers()
    vi.advanceTimersByTime(60)

    expect(breaker.getState('ollama')).toBe('half-open')

    // Successful test in half-open state resets circuit to closed
    breaker.recordSuccess('ollama')
    expect(breaker.getState('ollama')).toBe('closed')

    vi.useRealTimers()
  })

  it('routes to primary model when successful without engaging fallbacks', async () => {
    const breaker = new ModelCircuitBreaker()
    const config: ModelFallbackConfig = {
      primary: { providerId: 'ollama', model: 'qwen2.5-coder:7b' },
      fallbacks: [{ providerId: 'openai', model: 'gpt-4o' }],
    }

    const res = await routeWithFallback(config, breaker, async (model: ModelSpec) => {
      await Promise.resolve()
      return `Generated from ${model.providerId}:${model.model}`
    })

    expect(res.success).toBe(true)
    expect(res.executedModel?.providerId).toBe('ollama')
    expect(res.result).toBe('Generated from ollama:qwen2.5-coder:7b')
    expect(res.attempts.length).toBe(1)
    expect(res.formattedSummary).toContain('Executed via primary model')
  })

  it('seamlessly falls back to secondary model when primary fails with eligible error', async () => {
    const breaker = new ModelCircuitBreaker({ failureThreshold: 3 })
    const config: ModelFallbackConfig = {
      primary: { providerId: 'ollama', model: 'qwen2.5-coder:7b' },
      fallbacks: [
        { providerId: 'openrouter', model: 'deepseek-coder' },
        { providerId: 'openai', model: 'gpt-4o' },
      ],
    }

    let callCount = 0
    const res = await routeWithFallback(config, breaker, async (model: ModelSpec) => {
      await Promise.resolve()
      callCount++
      if (model.providerId === 'ollama') {
        throw new Error('Connection refused: ECONNREFUSED at 127.0.0.1:11434')
      }
      return `Success from ${model.providerId}`
    })

    expect(res.success).toBe(true)
    expect(res.executedModel?.providerId).toBe('openrouter')
    expect(res.result).toBe('Success from openrouter')
    expect(res.attempts.length).toBe(2)
    expect(callCount).toBe(2)
    expect(res.formattedSummary).toContain('Executed via fallback model')
  })

  it('fails closed when all candidates in the fallback chain fail', async () => {
    const breaker = new ModelCircuitBreaker()
    const config: ModelFallbackConfig = {
      primary: { providerId: 'ollama', model: 'qwen2.5-coder:7b' },
      fallbacks: [{ providerId: 'openai', model: 'gpt-4o' }],
    }

    const res = await routeWithFallback(config, breaker, async (model: ModelSpec) => {
      await Promise.resolve()
      throw new Error(`503 Service Unavailable on ${model.providerId}`)
    })

    expect(res.success).toBe(false)
    expect(res.result).toBeNull()
    expect(res.executedModel).toBeNull()
    expect(res.attempts.length).toBe(2)
    expect(res.error).toContain('All 2 model candidates in fallback chain failed')
  })

  it('identifies transient and rate limit errors for fallback eligibility', () => {
    expect(isFallbackEligibleError(new Error('Rate limit exceeded 429'))).toBe(true)
    expect(isFallbackEligibleError(new Error('ECONNREFUSED at port 11434'))).toBe(true)
    expect(isFallbackEligibleError(new Error('503 Service Temporarily Unavailable'))).toBe(true)
    expect(isFallbackEligibleError(new Error('SyntaxError: Unexpected token <'))).toBe(false)
    expect(isFallbackEligibleError(null)).toBe(false)
  })
})
