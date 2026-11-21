/**
 * AGENT-023: Agent Token Budget Throttler & Rolling Window Rate Supervisor.
 *
 * Enforces sliding-window token accounting across prompt tokens, completion tokens,
 * and cost metrics, providing soft warning watermarks and fail-closed throttling.
 */

export interface TokenWindowRecord {
  id: string
  timestamp: string
  timestampMs: number
  promptTokens: number
  completionTokens: number
  totalTokens: number
  costDollars: number
}

export interface TokenBudgetThrottlerOptions {
  windowSeconds?: number
  maxTotalTokensPerWindow?: number
  maxPromptTokensPerWindow?: number
  maxCostDollarsPerWindow?: number
  softThresholdRatio?: number
}

export type BudgetStatus = 'OK' | 'WARNING' | 'THROTTLED'

export interface BudgetCheckResult {
  status: BudgetStatus
  isThrottled: boolean
  utilizationRatio: number
  currentWindowTokens: number
  maxTokensLimit: number
  remainingTokens: number
  currentWindowCostDollars: number
  maxCostLimit: number
  secondsUntilReset: number
  reason: string
}

export interface TokenBudgetStats {
  recordCount: number
  windowSeconds: number
  totalTokensInWindow: number
  promptTokensInWindow: number
  completionTokensInWindow: number
  totalCostInWindow: number
  maxTotalTokens: number
  softThresholdRatio: number
  oldestRecordTimestamp?: string | undefined
  newestRecordTimestamp?: string | undefined
}

const DEFAULT_WINDOW_SECONDS = 60
const DEFAULT_MAX_TOTAL_TOKENS = 100_000
const DEFAULT_MAX_PROMPT_TOKENS = 80_000
const DEFAULT_MAX_COST_DOLLARS = 5.0
const DEFAULT_SOFT_THRESHOLD = 0.8

export class AgentTokenBudgetThrottler {
  private readonly records: TokenWindowRecord[] = []
  private readonly windowMs: number
  private readonly maxTotalTokens: number
  private readonly maxPromptTokens: number
  private readonly maxCostDollars: number
  private readonly softThresholdRatio: number
  private recordSequence = 0

  constructor(options: TokenBudgetThrottlerOptions = {}) {
    const windowSec = options.windowSeconds ?? DEFAULT_WINDOW_SECONDS
    if (windowSec <= 0) {
      throw new Error('windowSeconds must be greater than 0.')
    }
    this.windowMs = windowSec * 1000
    this.maxTotalTokens = options.maxTotalTokensPerWindow ?? DEFAULT_MAX_TOTAL_TOKENS
    this.maxPromptTokens = options.maxPromptTokensPerWindow ?? DEFAULT_MAX_PROMPT_TOKENS
    this.maxCostDollars = options.maxCostDollarsPerWindow ?? DEFAULT_MAX_COST_DOLLARS
    this.softThresholdRatio = options.softThresholdRatio ?? DEFAULT_SOFT_THRESHOLD

    if (this.maxTotalTokens <= 0 || this.maxPromptTokens <= 0 || this.maxCostDollars <= 0) {
      throw new Error('Budget limits must be positive numbers.')
    }
  }

  public recordUsage(usage: {
    promptTokens: number
    completionTokens: number
    costDollars?: number
    nowMs?: number
  }): TokenWindowRecord {
    const now = usage.nowMs ?? Date.now()
    this.pruneExpired(now)

    const prompt = Math.max(0, usage.promptTokens)
    const completion = Math.max(0, usage.completionTokens)
    const cost = Math.max(0, usage.costDollars ?? 0)
    const total = prompt + completion

    this.recordSequence++
    const record: TokenWindowRecord = {
      id: `tok_${String(this.recordSequence)}`,
      timestamp: new Date(now).toISOString(),
      timestampMs: now,
      promptTokens: prompt,
      completionTokens: completion,
      totalTokens: total,
      costDollars: cost,
    }

    this.records.push(record)
    return record
  }

  public checkBudget(estimatedPromptTokens = 0, nowMs?: number): BudgetCheckResult {
    const now = nowMs ?? Date.now()
    this.pruneExpired(now)

    let currentTokens = 0
    let currentCost = 0
    let oldestMs = Infinity

    for (const rec of this.records) {
      currentTokens += rec.totalTokens
      currentCost += rec.costDollars
      if (rec.timestampMs < oldestMs) {
        oldestMs = rec.timestampMs
      }
    }

    const projectedTokens = currentTokens + Math.max(0, estimatedPromptTokens)
    const tokenUtilization = projectedTokens / this.maxTotalTokens
    const costUtilization = currentCost / this.maxCostDollars
    const maxUtilization = Math.max(tokenUtilization, costUtilization)

    const remainingTokens = Math.max(0, this.maxTotalTokens - currentTokens)
    const secondsUntilReset =
      this.records.length > 0 && oldestMs !== Infinity
        ? Math.max(0, Math.ceil((oldestMs + this.windowMs - now) / 1000))
        : 0

    if (projectedTokens > this.maxTotalTokens) {
      return {
        status: 'THROTTLED',
        isThrottled: true,
        utilizationRatio: Number(maxUtilization.toFixed(4)),
        currentWindowTokens: currentTokens,
        maxTokensLimit: this.maxTotalTokens,
        remainingTokens,
        currentWindowCostDollars: Number(currentCost.toFixed(4)),
        maxCostLimit: this.maxCostDollars,
        secondsUntilReset,
        reason: `Token limit exceeded: projected ${String(projectedTokens)} tokens exceeds window limit of ${String(this.maxTotalTokens)}. Reset in ${String(secondsUntilReset)}s.`,
      }
    }

    if (currentCost >= this.maxCostDollars) {
      return {
        status: 'THROTTLED',
        isThrottled: true,
        utilizationRatio: Number(maxUtilization.toFixed(4)),
        currentWindowTokens: currentTokens,
        maxTokensLimit: this.maxTotalTokens,
        remainingTokens,
        currentWindowCostDollars: Number(currentCost.toFixed(4)),
        maxCostLimit: this.maxCostDollars,
        secondsUntilReset,
        reason: `Cost budget exceeded: current window cost $${currentCost.toFixed(4)} exceeds limit of $${this.maxCostDollars.toFixed(2)}. Reset in ${String(secondsUntilReset)}s.`,
      }
    }

    if (maxUtilization >= this.softThresholdRatio) {
      return {
        status: 'WARNING',
        isThrottled: false,
        utilizationRatio: Number(maxUtilization.toFixed(4)),
        currentWindowTokens: currentTokens,
        maxTokensLimit: this.maxTotalTokens,
        remainingTokens,
        currentWindowCostDollars: Number(currentCost.toFixed(4)),
        maxCostLimit: this.maxCostDollars,
        secondsUntilReset,
        reason: `Token budget warning: utilization at ${(maxUtilization * 100).toFixed(1)}% (soft threshold: ${(this.softThresholdRatio * 100).toFixed(0)}%).`,
      }
    }

    return {
      status: 'OK',
      isThrottled: false,
      utilizationRatio: Number(maxUtilization.toFixed(4)),
      currentWindowTokens: currentTokens,
      maxTokensLimit: this.maxTotalTokens,
      remainingTokens,
      currentWindowCostDollars: Number(currentCost.toFixed(4)),
      maxCostLimit: this.maxCostDollars,
      secondsUntilReset,
      reason: `Budget nominal: ${(maxUtilization * 100).toFixed(1)}% utilization, ${String(remainingTokens)} tokens remaining.`,
    }
  }

  public getStats(nowMs?: number): TokenBudgetStats {
    const now = nowMs ?? Date.now()
    this.pruneExpired(now)

    let totalTokens = 0
    let promptTokens = 0
    let completionTokens = 0
    let totalCost = 0
    let oldest: string | undefined
    let newest: string | undefined

    if (this.records.length > 0) {
      oldest = this.records[0]?.timestamp
      newest = this.records[this.records.length - 1]?.timestamp
    }

    for (const r of this.records) {
      totalTokens += r.totalTokens
      promptTokens += r.promptTokens
      completionTokens += r.completionTokens
      totalCost += r.costDollars
    }

    return {
      recordCount: this.records.length,
      windowSeconds: Math.floor(this.windowMs / 1000),
      totalTokensInWindow: totalTokens,
      promptTokensInWindow: promptTokens,
      completionTokensInWindow: completionTokens,
      totalCostInWindow: Number(totalCost.toFixed(4)),
      maxTotalTokens: this.maxTotalTokens,
      softThresholdRatio: this.softThresholdRatio,
      oldestRecordTimestamp: oldest,
      newestRecordTimestamp: newest,
    }
  }

  public formatSummary(nowMs?: number): string {
    const stats = this.getStats(nowMs)
    const check = this.checkBudget(0, nowMs)
    const lines = [
      `TOKEN BUDGET SUPERVISOR: [${check.status}]`,
      `  Window: ${String(stats.windowSeconds)}s (Records: ${String(stats.recordCount)})`,
      `  Tokens: ${String(stats.totalTokensInWindow)} / ${String(stats.maxTotalTokens)} (${String(check.remainingTokens)} remaining)`,
      `  Prompt / Completion: ${String(stats.promptTokensInWindow)} / ${String(stats.completionTokensInWindow)}`,
      `  Cost: $${stats.totalCostInWindow.toFixed(4)} / $${this.maxCostDollars.toFixed(2)}`,
      `  Status: ${check.reason}`,
    ]
    return lines.join('\n')
  }

  public reset(): void {
    this.records.length = 0
  }

  private pruneExpired(now: number): void {
    const cutoff = now - this.windowMs
    while (this.records.length > 0) {
      const first = this.records[0]
      if (first && first.timestampMs < cutoff) {
        this.records.shift()
      } else {
        break
      }
    }
  }
}
