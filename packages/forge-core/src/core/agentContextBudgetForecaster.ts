/**
 * Copyright (c) 2026 Forge Authors
 * Technology: TypeScript / Node.js
 * Architecture: Agent Multi-Turn Context Budget Forecaster & Compaction Advisor (AGENT-027)
 * Axioms Enforced:
 *  - A1: Bugs are bounded & fail-closed (proactive alerts prevent unexpected token exhaustion).
 *  - A5: Bounded loops, costs, and logs (strict token ceilings and proactive compaction).
 *  - A7: Least privilege & security.
 */

export type ContextHealthStatus = 'HEALTHY' | 'WARN_COMPACT_SOON' | 'CRITICAL_EVICTION_REQUIRED'

export interface TurnTokenRecord {
  readonly turnIndex: number
  readonly tokensUsed: number
  readonly deltaTokens: number
  readonly timestamp: number
}

export interface ForecasterConfig {
  readonly maxWindowTokens: number
  readonly safetyMarginTokens?: number
  readonly emaAlpha?: number
}

export interface ContextHealthReport {
  readonly currentTokens: number
  readonly maxWindowTokens: number
  readonly availableHeadroomTokens: number
  readonly usageRatio: number
  readonly emaBurnRatePerTurn: number
  readonly projectedRemainingTurns: number
  readonly projectedExhaustionTurnIndex: number
  readonly healthStatus: ContextHealthStatus
  readonly advisoryRecommendations: readonly string[]
}

export class AgentContextBudgetForecaster {
  private readonly maxWindowTokens: number
  private readonly safetyMarginTokens: number
  private readonly emaAlpha: number

  private readonly turns: TurnTokenRecord[] = []
  private currentEmaBurnRate = 0

  public constructor(config: ForecasterConfig) {
    this.maxWindowTokens = Math.max(100, config.maxWindowTokens)
    this.safetyMarginTokens = Math.max(
      0,
      config.safetyMarginTokens ?? Math.round(this.maxWindowTokens * 0.1),
    )
    this.emaAlpha = Math.min(1, Math.max(0.05, config.emaAlpha ?? 0.3))
  }

  /**
   * Records a turn and updates the exponential moving average (EMA) burn rate.
   */
  public recordTurn(tokensUsed: number, timestamp = Date.now()): TurnTokenRecord {
    const turnIndex = this.turns.length + 1
    const previousTokens =
      this.turns.length > 0 ? (this.turns[this.turns.length - 1]?.tokensUsed ?? 0) : 0
    const deltaTokens = Math.max(0, tokensUsed - previousTokens)

    if (this.turns.length === 0) {
      this.currentEmaBurnRate = tokensUsed
    } else {
      this.currentEmaBurnRate =
        this.emaAlpha * deltaTokens + (1 - this.emaAlpha) * this.currentEmaBurnRate
    }

    const record: TurnTokenRecord = {
      turnIndex,
      tokensUsed,
      deltaTokens,
      timestamp,
    }

    this.turns.push(record)
    return record
  }

  /**
   * Returns current exponential moving average token burn rate per turn.
   */
  public getEmaBurnRate(): number {
    return Math.round(this.currentEmaBurnRate)
  }

  /**
   * Predicts remaining turns before context window ceiling is breached.
   */
  public forecastRemainingTurns(currentTokens?: number): number {
    const tokens =
      currentTokens ??
      (this.turns.length > 0 ? (this.turns[this.turns.length - 1]?.tokensUsed ?? 0) : 0)
    const effectiveCeiling = Math.max(0, this.maxWindowTokens - this.safetyMarginTokens)
    const headroom = Math.max(0, effectiveCeiling - tokens)

    if (headroom === 0) {
      return 0
    }

    const rate = Math.max(1, this.getEmaBurnRate())
    return Math.floor(headroom / rate)
  }

  /**
   * Evaluates context health and synthesizes compaction advisories.
   */
  public evaluateContextHealth(currentTokensOverride?: number): ContextHealthReport {
    const currentTokens =
      currentTokensOverride ??
      (this.turns.length > 0 ? (this.turns[this.turns.length - 1]?.tokensUsed ?? 0) : 0)
    const effectiveCeiling = Math.max(0, this.maxWindowTokens - this.safetyMarginTokens)
    const availableHeadroomTokens = Math.max(0, effectiveCeiling - currentTokens)
    const usageRatio = Math.min(1, currentTokens / this.maxWindowTokens)
    const burnRate = this.getEmaBurnRate()
    const remainingTurns = this.forecastRemainingTurns(currentTokens)
    const currentTurnIndex = this.turns.length
    const projectedExhaustionTurnIndex = currentTurnIndex + remainingTurns

    const recommendations: string[] = []
    let healthStatus: ContextHealthStatus = 'HEALTHY'

    if (usageRatio >= 0.9 || remainingTurns <= 1 || availableHeadroomTokens === 0) {
      healthStatus = 'CRITICAL_EVICTION_REQUIRED'
      recommendations.push(
        `Critical token pressure (${String(Math.round(usageRatio * 100))}% used). Immediate context compaction required.`,
      )
      recommendations.push(
        'Evict historical tool observation outputs exceeding 250 tokens and compact conversation turns.',
      )
    } else if (usageRatio >= 0.7 || remainingTurns <= 4) {
      healthStatus = 'WARN_COMPACT_SOON'
      recommendations.push(
        `Moderate token consumption (${String(Math.round(usageRatio * 100))}% used, ${String(remainingTurns)} turns remaining at current burn rate).`,
      )
      recommendations.push(
        'Prepare summarization of completed subtasks and truncate verbose CLI logs.',
      )
    } else {
      recommendations.push(
        `Context headroom healthy (${String(availableHeadroomTokens)} tokens remaining, ~${String(remainingTurns)} turns sustainable).`,
      )
    }

    return {
      currentTokens,
      maxWindowTokens: this.maxWindowTokens,
      availableHeadroomTokens,
      usageRatio: Math.round(usageRatio * 100) / 100,
      emaBurnRatePerTurn: burnRate,
      projectedRemainingTurns: remainingTurns,
      projectedExhaustionTurnIndex,
      healthStatus,
      advisoryRecommendations: recommendations,
    }
  }

  /**
   * Resets the forecaster turn history.
   */
  public reset(): void {
    this.turns.length = 0
    this.currentEmaBurnRate = 0
  }
}
