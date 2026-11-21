import { describe, it, expect } from 'vitest'
import { calculateMovingAverage, evaluateStepSla, type StepSlaConfig } from './stepSlaMonitor'

describe('stepSlaMonitor (WORK-026)', () => {
  describe('calculateMovingAverage', () => {
    it('computes rounded average of execution sample durations', () => {
      expect(calculateMovingAverage([100, 200, 300])).toBe(200)
      expect(calculateMovingAverage([150, 250])).toBe(200)
      expect(calculateMovingAverage([])).toBe(0)
    })
  })

  describe('evaluateStepSla', () => {
    const config: StepSlaConfig = {
      targetDurationMs: 10_000,
      warnThresholdRatio: 0.8,
    }

    it('returns nominal status when well within SLA target', () => {
      const report = evaluateStepSla('build_step', 4_000, config)

      expect(report.status).toBe('nominal')
      expect(report.percentConsumed).toBe(40)
      expect(report.isOverdue).toBe(false)
      expect(report.formattedSummary).toContain('[Step SLA NOMINAL]')
    })

    it('returns warning status when execution crosses warning ratio', () => {
      const report = evaluateStepSla('test_step', 8_500, config)

      expect(report.status).toBe('warning')
      expect(report.percentConsumed).toBe(85)
      expect(report.isOverdue).toBe(false)
      expect(report.formattedSummary).toContain('[Step SLA WARNING]')
    })

    it('returns breached status and isOverdue true when elapsed exceeds target', () => {
      const report = evaluateStepSla('deploy_step', 12_500, config)

      expect(report.status).toBe('breached')
      expect(report.percentConsumed).toBe(125)
      expect(report.isOverdue).toBe(true)
      expect(report.formattedSummary).toContain('[Step SLA BREACHED]')
    })

    it('incorporates historical moving average when samples provided', () => {
      const history = [8_000, 9_000, 10_000]
      const report = evaluateStepSla('lint_step', 5_000, config, history)

      expect(report.movingAverageMs).toBe(9_000)
      expect(report.formattedSummary).toContain('Historical Avg: 9000ms')
    })
  })
})
