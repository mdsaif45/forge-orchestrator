import { describe, expect, it } from 'vitest'
import {
  BenchmarkLatencyProfiler,
  computePercentile,
  InvalidLatencySampleError,
  LatencyBudgetExceededError,
} from './benchmarkLatencyProfiler'

describe('BenchmarkLatencyProfiler (BENCH-002)', () => {
  it('measures high-resolution stage latencies using monotonic nanosecond timers', async () => {
    let fakeNs = 1_000_000_000n
    const profiler = new BenchmarkLatencyProfiler({
      nowNs: () => fakeNs,
      humanBaselineTotalMs: 150_000,
    })

    const h1 = profiler.startTimer('STARTUP', { worker: 'main' })
    fakeNs += 12_500_000n // +12.5ms
    const s1 = profiler.stopTimer(h1)
    expect(s1.stage).toBe('STARTUP')
    expect(s1.durationMs).toBe(12.5)

    const measured = await profiler.measure('TOOL_EXECUTION', () => {
      fakeNs += 35_000_000n // +35.0ms
      return 'ok'
    })
    expect(measured.result).toBe('ok')
    expect(measured.sample.durationMs).toBe(35)

    const scorecard = profiler.generateScorecard()
    expect(scorecard.totalSamples).toBe(2)
    expect(scorecard.totalObservedMs).toBe(47.5)
    expect(scorecard.verdict).toBe('PASS')
    expect(scorecard.overallSpeedupVsHuman).toBeGreaterThan(1000)
    expect(scorecard.scorecardDigest).toHaveLength(64)
  })

  it('computes accurate p50, p95, p99 percentile aggregations and human speedup ratios', () => {
    expect(computePercentile([], 95)).toBe(0)
    expect(computePercentile([42], 99)).toBe(42)

    const profiler = new BenchmarkLatencyProfiler({
      thresholds: [
        {
          stage: 'MODEL_INFERENCE',
          maxMeanMs: 200,
          maxP95Ms: 250,
          maxP99Ms: 300,
          humanBaselineMs: 60_000,
        },
      ],
    })

    // Ingest 100 deterministic samples: 1..100ms
    for (let i = 1; i <= 100; i += 1) {
      profiler.recordSample('MODEL_INFERENCE', i)
    }

    const metrics = profiler.getStageMetrics('MODEL_INFERENCE')
    expect(metrics.sampleCount).toBe(100)
    expect(metrics.minMs).toBe(1)
    expect(metrics.maxMs).toBe(100)
    expect(metrics.meanMs).toBe(50.5)
    expect(metrics.p50Ms).toBe(50)
    expect(metrics.p95Ms).toBe(95)
    expect(metrics.p99Ms).toBe(99)
    expect(metrics.budgetExceeded).toBe(false)
    expect(metrics.speedupVsHuman).toBeGreaterThan(10)

    const scorecard = profiler.assertWithinBudget()
    expect(scorecard.verdict).toBe('PASS')
    expect(scorecard.alerts).toHaveLength(0)
  })

  it('detects stage and total budget regressions fail-closed with LatencyBudgetExceededError', () => {
    const profiler = new BenchmarkLatencyProfiler({
      maxTotalBudgetMs: 500,
      thresholds: [
        {
          stage: 'DIFF_RECONCILIATION',
          maxMeanMs: 40,
          maxP95Ms: 80,
          maxP99Ms: 90,
        },
      ],
    })

    profiler.recordSample('DIFF_RECONCILIATION', 20)
    profiler.recordSample('DIFF_RECONCILIATION', 120)
    profiler.recordSample('TOOL_EXECUTION', 450) // pushes totalMs to 590 > 500

    const scorecard = profiler.generateScorecard()
    expect(scorecard.verdict).toBe('REGRESSION_FAIL')
    expect(scorecard.regressionDetected).toBe(true)
    expect(scorecard.stageMetrics.DIFF_RECONCILIATION.budgetExceeded).toBe(true)
    expect(
      scorecard.alerts.some((a) => a.stage === 'DIFF_RECONCILIATION' && a.metric === 'meanMs'),
    ).toBe(true)
    expect(
      scorecard.alerts.some((a) => a.stage === 'DIFF_RECONCILIATION' && a.metric === 'p95Ms'),
    ).toBe(true)
    expect(scorecard.alerts.some((a) => a.metric === 'totalBudgetMs')).toBe(true)

    expect(() => profiler.assertWithinBudget()).toThrow(LatencyBudgetExceededError)
  })

  it('enforces invalid sample, double-stop timer, and exception closure safety contracts', async () => {
    let fakeNs = 5_000_000n
    const profiler = new BenchmarkLatencyProfiler({ nowNs: () => fakeNs })

    expect(() => profiler.recordSample('STARTUP', -1)).toThrow(InvalidLatencySampleError)
    expect(() => profiler.recordSample('STARTUP', Number.NaN)).toThrow(InvalidLatencySampleError)
    expect(() => new BenchmarkLatencyProfiler({ humanBaselineTotalMs: 0 })).toThrow(
      InvalidLatencySampleError,
    )
    expect(() => {
      profiler.setMaxTotalBudgetMs(-5)
    }).toThrow(InvalidLatencySampleError)

    const timer = profiler.startTimer('VERIFICATION')
    fakeNs += 2_000_000n
    profiler.stopTimer(timer)
    // Second stop must fail closed
    expect(() => {
      profiler.stopTimer(timer)
    }).toThrow(InvalidLatencySampleError)

    // Exceptions inside measure() still stop and record elapsed latency before rethrowing
    await expect(
      profiler.measure('STARTUP', () => {
        fakeNs += 7_000_000n
        throw new Error('Boom')
      }),
    ).rejects.toThrow('Boom')
    expect(profiler.getStageMetrics('STARTUP').sampleCount).toBe(1)
    expect(profiler.getStageMetrics('STARTUP').totalMs).toBe(7)

    profiler.clear()
    expect(profiler.getStageMetrics('STARTUP').sampleCount).toBe(0)
  })
})
