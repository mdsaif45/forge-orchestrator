import { describe, expect, it } from 'vitest'
import {
  COMMITTED_BENCHMARK_BASELINE,
  computeBenchmarkResult,
  formatBenchmarkReport,
  parseTimelineJsonl,
  type StageTiming,
} from './benchmarkHarness'

describe('Benchmark Harness (Issue #159)', () => {
  it('parses timeline.jsonl marks into structured stage timings', () => {
    const jsonl = [
      JSON.stringify({ kind: 'mark', label: 'Start planning', t: 0 }),
      JSON.stringify({ kind: 'frame', label: 'planning-progress' }),
      JSON.stringify({ kind: 'mark', label: 'Finish planning', t: 45200 }),
      JSON.stringify({ kind: 'mark', label: 'Start implementation', t: 45200 }),
      JSON.stringify({ kind: 'mark', label: 'Finish implementation', t: 65300 }),
      JSON.stringify({ kind: 'mark', label: 'Skip code audit', t: 65300 }),
      JSON.stringify({ kind: 'mark', label: 'Workflow complete', t: 65300 }),
    ].join('\n')

    const stages = parseTimelineJsonl(jsonl)
    expect(stages).toHaveLength(3)
    expect(stages[0]?.name).toBe('Start planning')
    expect(stages[0]?.durationSeconds).toBe(45.2)
    expect(stages[0]?.status).toBe('completed')

    expect(stages[2]?.name).toBe('Skip code audit')
    expect(stages[2]?.status).toBe('skipped')
    expect(stages[2]?.notes).toContain('skipped')
  })

  it('computes comparison against the committed 2026-08-31 baseline', () => {
    const stages: StageTiming[] = [
      { name: 'Planning', durationSeconds: 40.0, status: 'completed' },
      { name: 'Implementation', durationSeconds: 20.0, status: 'completed' },
      { name: 'Audit', durationSeconds: 0.0, status: 'skipped', notes: 'Skipped unrequested' },
    ]

    const result = computeBenchmarkResult({
      repository: 'test-repo',
      stages,
      runAt: '2026-11-18T12:00:00.000Z',
    })

    expect(result.totalSeconds).toBe(60.0)
    expect(result.comparisonWithBaseline.baselineTotalSeconds).toBe(
      COMMITTED_BENCHMARK_BASELINE.total,
    )
    expect(result.comparisonWithBaseline.deltaSeconds).toBeCloseTo(
      60.0 - COMMITTED_BENCHMARK_BASELINE.total,
      1,
    )
    expect(result.comparisonWithBaseline.speedupRatio).toBeGreaterThan(1)
  })

  it('generates a clean markdown comparison table explicitly naming skipped/capped stages', () => {
    const stages: StageTiming[] = [
      { name: 'Planning', durationSeconds: 50.0, status: 'completed' },
      { name: 'Code Audit', durationSeconds: 0.0, status: 'skipped', notes: 'Unrequested' },
      { name: 'Review Loop', durationSeconds: 120.0, status: 'capped', notes: 'Max iterations' },
    ]

    const result = computeBenchmarkResult({
      repository: 'foldervault',
      stages,
    })

    const report = formatBenchmarkReport(result)
    expect(report).toContain('# Forge Benchmark Comparison')
    expect(report).toContain('foldervault')
    expect(report).toContain('⏭️ Skipped')
    expect(report).toContain('⏱️ Capped')
    expect(report).toContain('Unrequested')
    expect(report).toContain('Max iterations')
    expect(report).toContain('Baseline:')
  })
})
