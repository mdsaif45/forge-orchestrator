/**
 * BENCH-002: Stage Wall-Clock Latency Profiler and Comparative Performance Auditor.
 *
 * Captures monotonic high-resolution stage timings (STARTUP, TOOL_EXECUTION,
 * MODEL_INFERENCE, DIFF_RECONCILIATION, VERIFICATION) using process.hrtime.bigint()
 * to eliminate OS clock drift, computes percentile distributions (p50, p95, p99),
 * compares performance against historical human baselines, and fails closed when
 * latency regression ceilings are exceeded (Axioms A1, A3, A6).
 */

import { createHash, randomUUID } from 'node:crypto'
import { COMMITTED_BENCHMARK_BASELINE } from '../benchmarks/benchmarkHarness'

export type LatencyStageCategory =
  'STARTUP' | 'TOOL_EXECUTION' | 'MODEL_INFERENCE' | 'DIFF_RECONCILIATION' | 'VERIFICATION'

export const ALL_LATENCY_STAGES: readonly LatencyStageCategory[] = [
  'STARTUP',
  'TOOL_EXECUTION',
  'MODEL_INFERENCE',
  'DIFF_RECONCILIATION',
  'VERIFICATION',
]

export interface LatencyTimerHandle {
  readonly timerId: string
  readonly stage: LatencyStageCategory
  readonly startedAtNs: bigint
  readonly startedAtMs: number
  readonly metadata?: Record<string, unknown> | undefined
}

export interface LatencySample {
  readonly sampleId: string
  readonly stage: LatencyStageCategory
  readonly durationMs: number
  readonly recordedAt: number
  readonly metadata?: Record<string, unknown> | undefined
}

export interface LatencyRegressionThreshold {
  readonly stage: LatencyStageCategory
  readonly maxMeanMs?: number | undefined
  readonly maxP95Ms?: number | undefined
  readonly maxP99Ms?: number | undefined
  readonly humanBaselineMs?: number | undefined
}

export interface StageLatencyMetrics {
  readonly stage: LatencyStageCategory
  readonly sampleCount: number
  readonly totalMs: number
  readonly minMs: number
  readonly maxMs: number
  readonly meanMs: number
  readonly p50Ms: number
  readonly p95Ms: number
  readonly p99Ms: number
  readonly humanBaselineMs?: number | undefined
  readonly speedupVsHuman?: number | undefined
  readonly budgetExceeded: boolean
  readonly breachReasons: readonly string[]
}

export interface ComparativeRegressionAlert {
  readonly stage: LatencyStageCategory
  readonly metric: 'meanMs' | 'p95Ms' | 'p99Ms' | 'totalBudgetMs'
  readonly observedMs: number
  readonly ceilingMs: number
  readonly severity: 'HIGH' | 'CRITICAL'
  readonly message: string
}

export interface ComparativeScorecard {
  readonly profileId: string
  readonly generatedAt: string
  readonly totalSamples: number
  readonly totalObservedMs: number
  readonly humanBaselineTotalMs: number
  readonly overallSpeedupVsHuman: number
  readonly committedBaselineTotalSeconds: number
  readonly maxTotalBudgetMs?: number | undefined
  readonly stageMetrics: Record<LatencyStageCategory, StageLatencyMetrics>
  readonly alerts: readonly ComparativeRegressionAlert[]
  readonly regressionDetected: boolean
  readonly verdict: 'PASS' | 'REGRESSION_FAIL'
  readonly scorecardDigest: string
}

export interface LatencyProfilerConfig {
  readonly thresholds?: readonly LatencyRegressionThreshold[] | undefined
  readonly humanBaselineTotalMs?: number | undefined
  readonly maxTotalBudgetMs?: number | undefined
  readonly nowNs?: (() => bigint) | undefined
}

export class LatencyBudgetExceededError extends Error {
  constructor(
    readonly scorecard: ComparativeScorecard,
    details: string,
  ) {
    super(`Latency regression budget exceeded: ${details}`)
    this.name = 'LatencyBudgetExceededError'
  }
}

export class InvalidLatencySampleError extends Error {
  constructor(details: string) {
    super(`Invalid latency sample or timer operation: ${details}`)
    this.name = 'InvalidLatencySampleError'
  }
}

const DEFAULT_HUMAN_BASELINE_MS =
  ((COMMITTED_BENCHMARK_BASELINE.manualEquivalentSeconds[0] +
    COMMITTED_BENCHMARK_BASELINE.manualEquivalentSeconds[1]) /
    2) *
  1000 // 150,000ms midpoint

function roundMs(val: number): number {
  return Number(val.toFixed(4))
}

/**
 * Computes nearest-rank percentile on a pre-sorted ascending array of non-negative values.
 */
export function computePercentile(sortedValues: readonly number[], percentile: number): number {
  if (sortedValues.length === 0) return 0
  if (sortedValues.length === 1) return sortedValues[0] ?? 0
  const rank = Math.ceil((percentile / 100) * sortedValues.length)
  const clampedIdx = Math.max(0, Math.min(sortedValues.length - 1, rank - 1))
  return sortedValues[clampedIdx] ?? 0
}

export class BenchmarkLatencyProfiler {
  private readonly samplesByStage = new Map<LatencyStageCategory, LatencySample[]>()
  private readonly activeTimers = new Map<string, LatencyTimerHandle>()
  private readonly thresholds = new Map<LatencyStageCategory, LatencyRegressionThreshold>()
  private readonly nowNs: () => bigint
  private humanBaselineTotalMs: number
  private maxTotalBudgetMs?: number | undefined

  constructor(config: LatencyProfilerConfig = {}) {
    this.nowNs = config.nowNs ?? (() => process.hrtime.bigint())
    const baseline = config.humanBaselineTotalMs ?? DEFAULT_HUMAN_BASELINE_MS
    if (!Number.isFinite(baseline) || baseline <= 0) {
      throw new InvalidLatencySampleError(
        `humanBaselineTotalMs must be positive, got ${String(baseline)}`,
      )
    }
    this.humanBaselineTotalMs = baseline
    this.maxTotalBudgetMs = config.maxTotalBudgetMs

    for (const stage of ALL_LATENCY_STAGES) {
      this.samplesByStage.set(stage, [])
    }

    if (config.thresholds) {
      this.setThresholds(config.thresholds)
    }
  }

  setThresholds(thresholds: readonly LatencyRegressionThreshold[]): void {
    for (const t of thresholds) {
      this.thresholds.set(t.stage, t)
    }
  }

  setMaxTotalBudgetMs(limitMs: number | undefined): void {
    if (limitMs !== undefined && (!Number.isFinite(limitMs) || limitMs <= 0)) {
      throw new InvalidLatencySampleError(
        `maxTotalBudgetMs must be positive, got ${String(limitMs)}`,
      )
    }
    this.maxTotalBudgetMs = limitMs
  }

  startTimer(stage: LatencyStageCategory, metadata?: Record<string, unknown>): LatencyTimerHandle {
    const timerId = `tmr-${stage.toLowerCase()}-${randomUUID().slice(0, 8)}`
    const handle: LatencyTimerHandle = {
      timerId,
      stage,
      startedAtNs: this.nowNs(),
      startedAtMs: Date.now(),
      ...(metadata ? { metadata: { ...metadata } } : {}),
    }
    this.activeTimers.set(timerId, handle)
    return handle
  }

  stopTimer(handle: LatencyTimerHandle): LatencySample {
    const active = this.activeTimers.get(handle.timerId)
    if (!active) {
      throw new InvalidLatencySampleError(
        `Timer "${handle.timerId}" is not active or was already stopped`,
      )
    }
    this.activeTimers.delete(handle.timerId)

    const elapsedNs = this.nowNs() - active.startedAtNs
    const elapsedMs = Math.max(0, Number(elapsedNs) / 1_000_000)
    return this.recordSample(active.stage, elapsedMs, active.metadata)
  }

  /**
   * Executes an async or sync unit of work under high-resolution monotonic timing,
   * guaranteeing timer closure even if the callback throws.
   */
  async measure<T>(
    stage: LatencyStageCategory,
    fn: () => Promise<T> | T,
    metadata?: Record<string, unknown>,
  ): Promise<{ readonly result: T; readonly sample: LatencySample }> {
    const handle = this.startTimer(stage, metadata)
    try {
      const result = await fn()
      const sample = this.stopTimer(handle)
      return { result, sample }
    } catch (err) {
      if (this.activeTimers.has(handle.timerId)) {
        this.stopTimer(handle)
      }
      throw err
    }
  }

  recordSample(
    stage: LatencyStageCategory,
    durationMs: number,
    metadata?: Record<string, unknown>,
  ): LatencySample {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new InvalidLatencySampleError(
        `Duration must be a finite non-negative number, got ${String(durationMs)}`,
      )
    }

    const sample: LatencySample = {
      sampleId: `smp-${randomUUID().slice(0, 8)}`,
      stage,
      durationMs: roundMs(durationMs),
      recordedAt: Date.now(),
      ...(metadata ? { metadata: { ...metadata } } : {}),
    }

    const bucket = this.samplesByStage.get(stage)
    if (bucket) {
      bucket.push(sample)
    }
    return sample
  }

  getStageMetrics(stage: LatencyStageCategory): StageLatencyMetrics {
    const samples = this.samplesByStage.get(stage) ?? []
    const durations = samples.map((s) => s.durationMs).sort((a, b) => a - b)
    const count = durations.length
    const totalMs = roundMs(durations.reduce((acc, d) => acc + d, 0))
    const minMs = count > 0 ? (durations[0] ?? 0) : 0
    const maxMs = count > 0 ? (durations[count - 1] ?? 0) : 0
    const meanMs = count > 0 ? roundMs(totalMs / count) : 0
    const p50Ms = roundMs(computePercentile(durations, 50))
    const p95Ms = roundMs(computePercentile(durations, 95))
    const p99Ms = roundMs(computePercentile(durations, 99))

    const threshold = this.thresholds.get(stage)
    const breachReasons: string[] = []

    if (threshold && count > 0) {
      if (threshold.maxMeanMs !== undefined && meanMs > threshold.maxMeanMs) {
        breachReasons.push(
          `mean ${String(meanMs)}ms exceeded ceiling ${String(threshold.maxMeanMs)}ms`,
        )
      }
      if (threshold.maxP95Ms !== undefined && p95Ms > threshold.maxP95Ms) {
        breachReasons.push(
          `p95 ${String(p95Ms)}ms exceeded ceiling ${String(threshold.maxP95Ms)}ms`,
        )
      }
      if (threshold.maxP99Ms !== undefined && p99Ms > threshold.maxP99Ms) {
        breachReasons.push(
          `p99 ${String(p99Ms)}ms exceeded ceiling ${String(threshold.maxP99Ms)}ms`,
        )
      }
    }

    const humanBaselineMs = threshold?.humanBaselineMs
    const speedupVsHuman =
      humanBaselineMs !== undefined && totalMs > 0
        ? Number((humanBaselineMs / totalMs).toFixed(2))
        : undefined

    return {
      stage,
      sampleCount: count,
      totalMs,
      minMs,
      maxMs,
      meanMs,
      p50Ms,
      p95Ms,
      p99Ms,
      ...(humanBaselineMs !== undefined ? { humanBaselineMs } : {}),
      ...(speedupVsHuman !== undefined ? { speedupVsHuman } : {}),
      budgetExceeded: breachReasons.length > 0,
      breachReasons,
    }
  }

  generateScorecard(): ComparativeScorecard {
    const profileId = `prof-${randomUUID().slice(0, 10)}`
    const generatedAt = new Date().toISOString()

    const stageMetricsMap: Record<LatencyStageCategory, StageLatencyMetrics> = {
      STARTUP: this.getStageMetrics('STARTUP'),
      TOOL_EXECUTION: this.getStageMetrics('TOOL_EXECUTION'),
      MODEL_INFERENCE: this.getStageMetrics('MODEL_INFERENCE'),
      DIFF_RECONCILIATION: this.getStageMetrics('DIFF_RECONCILIATION'),
      VERIFICATION: this.getStageMetrics('VERIFICATION'),
    }

    const alerts: ComparativeRegressionAlert[] = []
    let totalSamples = 0
    let totalObservedMs = 0

    for (const stage of ALL_LATENCY_STAGES) {
      const m = stageMetricsMap[stage]
      totalSamples += m.sampleCount
      totalObservedMs += m.totalMs

      const threshold = this.thresholds.get(stage)
      if (!threshold || m.sampleCount === 0) continue

      if (threshold.maxMeanMs !== undefined && m.meanMs > threshold.maxMeanMs) {
        alerts.push({
          stage,
          metric: 'meanMs',
          observedMs: m.meanMs,
          ceilingMs: threshold.maxMeanMs,
          severity: 'HIGH',
          message: `Stage ${stage} mean latency (${String(m.meanMs)}ms) exceeded ceiling (${String(threshold.maxMeanMs)}ms)`,
        })
      }
      if (threshold.maxP95Ms !== undefined && m.p95Ms > threshold.maxP95Ms) {
        alerts.push({
          stage,
          metric: 'p95Ms',
          observedMs: m.p95Ms,
          ceilingMs: threshold.maxP95Ms,
          severity: 'CRITICAL',
          message: `Stage ${stage} p95 latency (${String(m.p95Ms)}ms) exceeded ceiling (${String(threshold.maxP95Ms)}ms)`,
        })
      }
      if (threshold.maxP99Ms !== undefined && m.p99Ms > threshold.maxP99Ms) {
        alerts.push({
          stage,
          metric: 'p99Ms',
          observedMs: m.p99Ms,
          ceilingMs: threshold.maxP99Ms,
          severity: 'CRITICAL',
          message: `Stage ${stage} p99 latency (${String(m.p99Ms)}ms) exceeded ceiling (${String(threshold.maxP99Ms)}ms)`,
        })
      }
    }

    totalObservedMs = roundMs(totalObservedMs)

    if (this.maxTotalBudgetMs !== undefined && totalObservedMs > this.maxTotalBudgetMs) {
      alerts.push({
        stage: 'VERIFICATION',
        metric: 'totalBudgetMs',
        observedMs: totalObservedMs,
        ceilingMs: this.maxTotalBudgetMs,
        severity: 'CRITICAL',
        message: `Total observed latency (${String(totalObservedMs)}ms) exceeded suite budget (${String(this.maxTotalBudgetMs)}ms)`,
      })
    }

    const overallSpeedupVsHuman =
      totalObservedMs > 0 ? Number((this.humanBaselineTotalMs / totalObservedMs).toFixed(2)) : 1.0
    const regressionDetected = alerts.length > 0
    const verdict: ComparativeScorecard['verdict'] = regressionDetected ? 'REGRESSION_FAIL' : 'PASS'

    const digestPayload = [
      profileId,
      String(totalSamples),
      String(totalObservedMs),
      verdict,
      alerts.map((a) => `${a.stage}:${a.metric}:${String(a.observedMs)}`).join('|'),
    ].join(':')

    const scorecardDigest = createHash('sha256').update(digestPayload, 'utf8').digest('hex')

    return {
      profileId,
      generatedAt,
      totalSamples,
      totalObservedMs,
      humanBaselineTotalMs: this.humanBaselineTotalMs,
      overallSpeedupVsHuman,
      committedBaselineTotalSeconds: COMMITTED_BENCHMARK_BASELINE.total,
      ...(this.maxTotalBudgetMs !== undefined ? { maxTotalBudgetMs: this.maxTotalBudgetMs } : {}),
      stageMetrics: stageMetricsMap,
      alerts,
      regressionDetected,
      verdict,
      scorecardDigest,
    }
  }

  /**
   * Generates a ComparativeScorecard and throws LatencyBudgetExceededError fail-closed
   * if any stage ceiling or total budget constraint was breached.
   */
  assertWithinBudget(): ComparativeScorecard {
    const scorecard = this.generateScorecard()
    if (scorecard.regressionDetected) {
      throw new LatencyBudgetExceededError(
        scorecard,
        scorecard.alerts.map((a) => a.message).join('; '),
      )
    }
    return scorecard
  }

  clear(): void {
    this.activeTimers.clear()
    for (const stage of ALL_LATENCY_STAGES) {
      this.samplesByStage.set(stage, [])
    }
  }
}
