import { describe, it, expect } from 'vitest'
import { AgentContextBudgetForecaster } from './agentContextBudgetForecaster'

describe('AgentContextBudgetForecaster (AGENT-027)', () => {
  it('records turns and tracks token growth rate', () => {
    const forecaster = new AgentContextBudgetForecaster({
      maxWindowTokens: 10000,
      safetyMarginTokens: 1000,
      emaAlpha: 0.5,
    })

    const t1 = forecaster.recordTurn(1500)
    expect(t1.turnIndex).toBe(1)
    expect(t1.tokensUsed).toBe(1500)
    expect(t1.deltaTokens).toBe(1500)

    const t2 = forecaster.recordTurn(2500)
    expect(t2.turnIndex).toBe(2)
    expect(t2.tokensUsed).toBe(2500)
    expect(t2.deltaTokens).toBe(1000)

    expect(forecaster.getEmaBurnRate()).toBeGreaterThan(0)
  })

  it('reports HEALTHY status when usage is well within safety thresholds', () => {
    const forecaster = new AgentContextBudgetForecaster({
      maxWindowTokens: 20000,
      safetyMarginTokens: 2000,
    })

    forecaster.recordTurn(1000)
    forecaster.recordTurn(2000)

    const report = forecaster.evaluateContextHealth()
    expect(report.healthStatus).toBe('HEALTHY')
    expect(report.usageRatio).toBe(0.1)
    expect(report.projectedRemainingTurns).toBeGreaterThan(5)
    expect(report.advisoryRecommendations[0]).toContain('Context headroom healthy')
  })

  it('triggers WARN_COMPACT_SOON when projected turns drop below 5 or usage exceeds 70%', () => {
    const forecaster = new AgentContextBudgetForecaster({
      maxWindowTokens: 10000,
      safetyMarginTokens: 500,
    })

    forecaster.recordTurn(2000)
    forecaster.recordTurn(3000)
    forecaster.recordTurn(4000)

    const report = forecaster.evaluateContextHealth()
    expect(report.healthStatus).toBe('WARN_COMPACT_SOON')
    expect(report.projectedRemainingTurns).toBeLessThanOrEqual(4)
    expect(report.advisoryRecommendations[0]).toContain('Moderate token consumption')
  })

  it('triggers CRITICAL_EVICTION_REQUIRED when usage exceeds 90% or headroom is depleted', () => {
    const forecaster = new AgentContextBudgetForecaster({
      maxWindowTokens: 10000,
      safetyMarginTokens: 1000,
    })

    forecaster.recordTurn(3000)
    forecaster.recordTurn(6000)
    forecaster.recordTurn(9200)

    const report = forecaster.evaluateContextHealth()
    expect(report.healthStatus).toBe('CRITICAL_EVICTION_REQUIRED')
    expect(report.usageRatio).toBe(0.92)
    expect(report.projectedRemainingTurns).toBe(0)
    expect(report.advisoryRecommendations[0]).toContain('Critical token pressure')
  })

  it('supports explicit currentTokensOverride and reset', () => {
    const forecaster = new AgentContextBudgetForecaster({
      maxWindowTokens: 10000,
      safetyMarginTokens: 500,
    })

    forecaster.recordTurn(1000)
    const reportOverride = forecaster.evaluateContextHealth(9500)
    expect(reportOverride.healthStatus).toBe('CRITICAL_EVICTION_REQUIRED')

    forecaster.reset()
    expect(forecaster.forecastRemainingTurns()).toBe(9500)
  })
})
