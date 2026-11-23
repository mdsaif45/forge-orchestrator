import { describe, expect, it } from 'vitest'
import {
  auditRuntimeQuotas,
  createResourceBudget,
  DEFAULT_RESOURCE_BUDGET,
  evaluateProcessSample,
  generateMemoryFlags,
} from './resourceLimiter'

describe('Runtime Resource Limiter & Quota Guard (RUNTIME-005)', () => {
  it('creates valid resource budget with defaults and custom overrides', () => {
    const defaultBudget = createResourceBudget()
    expect(defaultBudget.maxRssBytes).toBe(DEFAULT_RESOURCE_BUDGET.maxRssBytes)
    expect(defaultBudget.maxHeapMb).toBe(512)

    const customBudget = createResourceBudget({
      maxRssBytes: 256 * 1024 * 1024,
      maxHeapMb: 128,
      maxDurationMs: 60000,
    })
    expect(customBudget.maxRssBytes).toBe(256 * 1024 * 1024)
    expect(customBudget.maxHeapMb).toBe(128)
    expect(customBudget.maxDurationMs).toBe(60000)
  })

  it('generates V8 memory constraint flags correctly', () => {
    const budget = createResourceBudget({ maxHeapMb: 256 })
    const flags = generateMemoryFlags(budget)
    expect(flags).toContain('--max-old-space-size=256')
  })

  it('evaluates normal process resource usage correctly', () => {
    const budget = createResourceBudget({ maxRssBytes: 100 * 1024 * 1024, maxDurationMs: 10000 })
    const result = evaluateProcessSample(budget, {
      pid: 1234,
      rssBytes: 50 * 1024 * 1024,
      elapsedMs: 2000,
    })

    expect(result.action).toBe('none')
    expect(result.exceededRss).toBe(false)
    expect(result.isWarning).toBe(false)
  })

  it('warns when process usage approaches warning threshold ratio', () => {
    const budget = createResourceBudget({
      maxRssBytes: 100 * 1024 * 1024,
      maxDurationMs: 10000,
      warningThresholdRatio: 0.85,
    })
    const result = evaluateProcessSample(budget, {
      pid: 1234,
      rssBytes: 90 * 1024 * 1024, // 90%
      elapsedMs: 2000,
    })

    expect(result.action).toBe('warn')
    expect(result.isWarning).toBe(true)
    expect(result.reason).toContain('approaching resource budget ceiling')
  })

  it('signals termination when RSS ceiling or duration timeout is exceeded', () => {
    const budget = createResourceBudget({ maxRssBytes: 100 * 1024 * 1024, maxDurationMs: 5000 })

    const rssViolation = evaluateProcessSample(budget, {
      pid: 1234,
      rssBytes: 150 * 1024 * 1024,
      elapsedMs: 1000,
    })
    expect(rssViolation.action).toBe('terminate')
    expect(rssViolation.exceededRss).toBe(true)
    expect(rssViolation.reason).toContain('exceeded ceiling')

    const durationViolation = evaluateProcessSample(budget, {
      pid: 1234,
      rssBytes: 20 * 1024 * 1024,
      elapsedMs: 6000,
    })
    expect(durationViolation.action).toBe('terminate')
    expect(durationViolation.exceededDuration).toBe(true)
    expect(durationViolation.reason).toContain('exceeded timeout budget')
  })

  it('audits runtime quotas cleanly with formatted summary', () => {
    const budget = createResourceBudget()
    const report = auditRuntimeQuotas(budget)
    expect(report.valid).toBe(true)
    expect(report.formattedSummary).toContain('RUNTIME RESOURCE QUOTA SPECIFICATION')
  })
})
