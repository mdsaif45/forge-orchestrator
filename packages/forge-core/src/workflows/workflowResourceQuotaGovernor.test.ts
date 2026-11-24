import { describe, expect, it } from 'vitest'
import {
  WorkflowQuotaExceededError,
  WorkflowResourceQuotaGovernor,
} from './workflowResourceQuotaGovernor'

describe('WorkflowResourceQuotaGovernor', () => {
  it('reports WITHIN_LIMITS when consumption is well within profile boundaries', () => {
    const governor = new WorkflowResourceQuotaGovernor({
      defaultLimits: {
        maxMemoryRssBytes: 100 * 1024 * 1024,
        maxCpuTimeMs: 10_000,
        maxOutputBytes: 1024 * 1024,
        maxDurationMs: 30_000,
      },
    })

    const result = governor.evaluateStepUsage('step-1', {
      memoryRssBytes: 20 * 1024 * 1024,
      cpuTimeMs: 2_000,
      outputBytes: 50 * 1024,
      durationMs: 3_000,
    })

    expect(result.status).toBe('WITHIN_LIMITS')
    expect(result.shouldEvict).toBe(false)
    expect(result.recommendedAction).toBe('CONTINUE')
    expect(result.violations).toHaveLength(0)
    expect(result.warnings).toHaveLength(0)
  })

  it('reports WARNING and advises THROTTLE when usage exceeds warning ratio', () => {
    const governor = new WorkflowResourceQuotaGovernor({
      defaultLimits: {
        maxMemoryRssBytes: 100 * 1024 * 1024,
        maxCpuTimeMs: 10_000,
        maxOutputBytes: 1024 * 1024,
        maxDurationMs: 30_000,
      },
      warningThresholdRatio: 0.8,
    })

    const result = governor.evaluateStepUsage('step-2', {
      memoryRssBytes: 85 * 1024 * 1024, // 85%
      cpuTimeMs: 2_000,
      outputBytes: 50 * 1024,
      durationMs: 3_000,
    })

    expect(result.status).toBe('WARNING')
    expect(result.shouldEvict).toBe(false)
    expect(result.recommendedAction).toBe('THROTTLE')
    expect(result.warnings).toHaveLength(1)
    expect(result.warnings[0]?.resource).toBe('MEMORY_RSS')
  })

  it('reports EXCEEDED and advises EVICT when hard limits are breached', () => {
    const governor = new WorkflowResourceQuotaGovernor({
      defaultLimits: {
        maxMemoryRssBytes: 100 * 1024 * 1024,
        maxCpuTimeMs: 10_000,
        maxOutputBytes: 1024 * 1024,
        maxDurationMs: 30_000,
      },
    })

    const result = governor.evaluateStepUsage('step-3', {
      memoryRssBytes: 120 * 1024 * 1024, // 120%
      cpuTimeMs: 15_000, // 150%
      outputBytes: 50 * 1024,
      durationMs: 3_000,
    })

    expect(result.status).toBe('EXCEEDED')
    expect(result.shouldEvict).toBe(true)
    expect(result.recommendedAction).toBe('EVICT')
    expect(result.violations).toHaveLength(2)
  })

  it('throws WorkflowQuotaExceededError fail-closed via assertStepWithinLimits', () => {
    const governor = new WorkflowResourceQuotaGovernor({
      defaultLimits: {
        maxMemoryRssBytes: 100 * 1024 * 1024,
        maxCpuTimeMs: 10_000,
        maxOutputBytes: 1024 * 1024,
        maxDurationMs: 30_000,
      },
    })

    expect(() =>
      governor.assertStepWithinLimits('step-bad', {
        memoryRssBytes: 50 * 1024 * 1024,
        cpuTimeMs: 20_000, // exceeded
        outputBytes: 100,
        durationMs: 1_000,
      }),
    ).toThrow(WorkflowQuotaExceededError)
  })

  it('supports per-step profile customization and metrics tracking', () => {
    const governor = new WorkflowResourceQuotaGovernor({
      defaultLimits: {
        maxMemoryRssBytes: 50 * 1024 * 1024,
        maxCpuTimeMs: 5_000,
        maxOutputBytes: 500 * 1024,
        maxDurationMs: 10_000,
      },
    })

    governor.registerStepProfile('heavy-step', {
      maxMemoryRssBytes: 500 * 1024 * 1024,
    })

    // 100MB is over default, but within heavy-step's 500MB
    const res = governor.evaluateStepUsage('heavy-step', {
      memoryRssBytes: 100 * 1024 * 1024,
      cpuTimeMs: 1_000,
      outputBytes: 1_000,
      durationMs: 1_000,
    })

    expect(res.status).toBe('WITHIN_LIMITS')

    const metrics = governor.getMetrics()
    expect(metrics.totalEvaluations).toBe(1)
    expect(metrics.withinLimitsCount).toBe(1)

    governor.reset()
    expect(governor.getMetrics().totalEvaluations).toBe(0)
  })
})
