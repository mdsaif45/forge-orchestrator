import { describe, it, expect } from 'vitest'
import {
  planForkJoinBatches,
  aggregateForkJoinOutcomes,
  type ForkJoinTaskOutcome,
} from './forkJoinSubflowOrchestrator'

describe('forkJoinSubflowOrchestrator (WORK-027)', () => {
  describe('planForkJoinBatches', () => {
    it('partitions items evenly across batches based on concurrency limit', () => {
      const items = ['a.ts', 'b.ts', 'c.ts', 'd.ts', 'e.ts']
      const plan = planForkJoinBatches(items, { maxConcurrency: 2, taskPrefix: 'lint' })

      expect(plan.totalTasks).toBe(5)
      expect(plan.batchCount).toBe(3) // 2 + 2 + 1
      expect(plan.batches[0]?.tasks).toHaveLength(2)
      expect(plan.batches[1]?.tasks).toHaveLength(2)
      expect(plan.batches[2]?.tasks).toHaveLength(1)
      expect(plan.batches[0]?.tasks[0]?.taskId).toBe('lint-1')
      expect(plan.batches[0]?.tasks[0]?.input).toBe('a.ts')
      expect(plan.formattedSummary).toContain('[Fork-Join Plan] Created 5 tasks across 3 batches')
    })

    it('enforces maximum task boundaries (Axiom A5)', () => {
      const items = Array.from({ length: 30 }, (_, i) => `item-${String(i)}`)
      const plan = planForkJoinBatches(items, { maxTotalTasks: 10, maxConcurrency: 5 })

      expect(plan.totalTasks).toBe(10)
      expect(plan.batchCount).toBe(2)
    })
  })

  describe('aggregateForkJoinOutcomes', () => {
    const outcomes: ForkJoinTaskOutcome[] = [
      { taskId: 'task-1', itemIndex: 0, status: 'completed', durationMs: 120, output: 'ok' },
      { taskId: 'task-2', itemIndex: 1, status: 'failed', durationMs: 90, error: 'syntax error' },
      { taskId: 'task-3', itemIndex: 2, status: 'completed', durationMs: 110, output: 'ok' },
    ]

    it('fails all_or_nothing policy when any child task fails', () => {
      const report = aggregateForkJoinOutcomes(outcomes, 'all_or_nothing')

      expect(report.success).toBe(false)
      expect(report.completedCount).toBe(2)
      expect(report.failedCount).toBe(1)
      expect(report.totalDurationMs).toBe(320)
      expect(report.formattedSummary).toContain('Success: NO')
    })

    it('passes best_effort policy when at least one child task completes', () => {
      const report = aggregateForkJoinOutcomes(outcomes, 'best_effort')

      expect(report.success).toBe(true)
      expect(report.completedCount).toBe(2)
      expect(report.failedCount).toBe(1)
      expect(report.formattedSummary).toContain('Success: YES')
    })
  })
})
