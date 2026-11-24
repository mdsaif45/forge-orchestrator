import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ProjectId, RunId, RunRecord, StepId, StepRecord, TaskId } from '@shared/domain'
import type { RunStore } from '../db/runStore'
import {
  calculateRunTokenAccounting,
  calculateTokenCost,
  resolveModelPricing,
} from './tokenAccounting'

describe('tokenAccounting', () => {
  it('resolves correct pricing for cloud vs local models', () => {
    const claudePricing = resolveModelPricing('claude-3-5-sonnet')
    expect(claudePricing.inputPerMillion).toBe(3.0)
    expect(claudePricing.outputPerMillion).toBe(15.0)

    const ollamaPricing = resolveModelPricing('qwen2.5-coder:7b')
    expect(ollamaPricing.inputPerMillion).toBe(0.0)
    expect(ollamaPricing.outputPerMillion).toBe(0.0)
  })

  it('calculates token costs accurately with caching', () => {
    const estimate = calculateTokenCost('claude-3-5-sonnet', {
      promptTokens: 1_000_000,
      completionTokens: 1_000_000,
      cachedTokens: 1_000_000,
    })

    expect(estimate.promptCostUsd).toBe(3.0)
    expect(estimate.completionCostUsd).toBe(15.0)
    expect(estimate.cachedCostUsd).toBe(0.3)
    expect(estimate.totalCostUsd).toBe(18.3)
  })

  it('computes run token accounting and enforces token budget ceilings (Axiom A5)', () => {
    const runId = randomUUID() as RunId
    const mockRun: RunRecord = {
      id: runId,
      taskId: randomUUID() as TaskId,
      projectId: randomUUID() as ProjectId,
      type: 'workflow',
      status: 'completed',
      startedAt: '2026-11-18T10:00:00.000Z',
      finishedAt: '2026-11-18T10:05:00.000Z',
      exitCode: 0,
      summary: 'Done',
      error: null,
      metadata: {},
    }

    const mockSteps: StepRecord[] = [
      {
        id: randomUUID() as StepId,
        runId,
        index: 0,
        role: 'claude-3-5-sonnet',
        runtimeId: null,
        status: 'completed',
        startedAt: '2026-11-18T10:00:00.000Z',
        finishedAt: '2026-11-18T10:02:00.000Z',
        summary: 'Step 1',
        changeSetId: null,
        evidenceId: null,
      },
      {
        id: randomUUID() as StepId,
        runId,
        index: 1,
        role: 'claude-3-5-sonnet',
        runtimeId: null,
        status: 'completed',
        startedAt: '2026-11-18T10:02:00.000Z',
        finishedAt: '2026-11-18T10:05:00.000Z',
        summary: 'Step 2',
        changeSetId: null,
        evidenceId: null,
      },
    ]

    const runStore = {
      getRun: vi.fn().mockReturnValue(mockRun),
      listStepsForRun: vi.fn().mockReturnValue(mockSteps),
    } as unknown as RunStore

    // Test without budget limit
    const report1 = calculateRunTokenAccounting(runStore, runId)
    expect(report1.valid).toBe(true)
    expect(report1.steps).toHaveLength(2)
    expect(report1.totalTokens).toBeGreaterThan(0)
    expect(report1.budgetExceeded).toBe(false)

    // Test with breached token budget limit
    const report2 = calculateRunTokenAccounting(runStore, runId, { maxTokens: 100 })
    expect(report2.budgetExceeded).toBe(true)
    expect(report2.budgetViolationReason).toContain('Token budget exceeded')

    // Test with breached cost budget limit
    const report3 = calculateRunTokenAccounting(runStore, runId, { maxCostUsd: 0.0001 })
    expect(report3.budgetExceeded).toBe(true)
    expect(report3.budgetViolationReason).toContain('Cost budget exceeded')
  })

  it('fails closed when run is not found', () => {
    const runStore = {
      getRun: vi.fn().mockReturnValue(null),
    } as unknown as RunStore

    const report = calculateRunTokenAccounting(runStore, randomUUID())
    expect(report.valid).toBe(false)
    expect(report.error).toContain('Run not found')
  })
})
