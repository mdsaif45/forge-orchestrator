import { describe, expect, it } from 'vitest'
import { AgentTokenBudgetThrottler } from './agentTokenBudgetThrottler'

describe('AgentTokenBudgetThrottler (AGENT-023)', () => {
  it('records token transactions and computes window statistics', () => {
    const throttler = new AgentTokenBudgetThrottler({
      windowSeconds: 60,
      maxTotalTokensPerWindow: 10_000,
    })

    const rec = throttler.recordUsage({
      promptTokens: 500,
      completionTokens: 250,
      costDollars: 0.015,
    })

    expect(rec.id).toBe('tok_1')
    expect(rec.totalTokens).toBe(750)
    expect(rec.costDollars).toBe(0.015)

    const stats = throttler.getStats()
    expect(stats.recordCount).toBe(1)
    expect(stats.totalTokensInWindow).toBe(750)
    expect(stats.promptTokensInWindow).toBe(500)
    expect(stats.completionTokensInWindow).toBe(250)
  })

  it('evaluates budget status OK when below soft threshold', () => {
    const throttler = new AgentTokenBudgetThrottler({
      maxTotalTokensPerWindow: 10_000,
      softThresholdRatio: 0.8,
    })

    throttler.recordUsage({ promptTokens: 2000, completionTokens: 1000 })
    const check = throttler.checkBudget(500)

    expect(check.status).toBe('OK')
    expect(check.isThrottled).toBe(false)
    expect(check.utilizationRatio).toBe(0.35)
    expect(check.remainingTokens).toBe(7000)
  })

  it('evaluates WARNING status when crossing soft threshold ratio', () => {
    const throttler = new AgentTokenBudgetThrottler({
      maxTotalTokensPerWindow: 10_000,
      softThresholdRatio: 0.8,
    })

    throttler.recordUsage({ promptTokens: 6000, completionTokens: 2500 })
    const check = throttler.checkBudget(0)

    expect(check.status).toBe('WARNING')
    expect(check.isThrottled).toBe(false)
    expect(check.utilizationRatio).toBe(0.85)
  })

  it('throttles fail-closed when projected tokens or cost exceed window limit', () => {
    const throttler = new AgentTokenBudgetThrottler({
      maxTotalTokensPerWindow: 5000,
      maxCostDollarsPerWindow: 0.1,
    })

    throttler.recordUsage({ promptTokens: 3000, completionTokens: 1500, costDollars: 0.05 })

    // Tokens exceed
    const checkTokens = throttler.checkBudget(1000)
    expect(checkTokens.status).toBe('THROTTLED')
    expect(checkTokens.isThrottled).toBe(true)
    expect(checkTokens.reason).toContain('Token limit exceeded')

    // Cost exceeds
    throttler.reset()
    throttler.recordUsage({ promptTokens: 500, completionTokens: 200, costDollars: 0.12 })
    const checkCost = throttler.checkBudget(0)
    expect(checkCost.status).toBe('THROTTLED')
    expect(checkCost.isThrottled).toBe(true)
    expect(checkCost.reason).toContain('Cost budget exceeded')
  })

  it('prunes expired transactions across rolling time windows automatically', () => {
    const throttler = new AgentTokenBudgetThrottler({
      windowSeconds: 60,
      maxTotalTokensPerWindow: 10_000,
    })

    const baseTime = 1000000
    throttler.recordUsage({ promptTokens: 4000, completionTokens: 1000, nowMs: baseTime })
    expect(throttler.getStats(baseTime).totalTokensInWindow).toBe(5000)

    // After 61 seconds (expired)
    const afterTime = baseTime + 61000
    const statsAfter = throttler.getStats(afterTime)
    expect(statsAfter.recordCount).toBe(0)
    expect(statsAfter.totalTokensInWindow).toBe(0)

    const check = throttler.checkBudget(0, afterTime)
    expect(check.status).toBe('OK')
    expect(check.utilizationRatio).toBe(0)
  })
})
