import { describe, it, expect } from 'vitest'
import {
  scheduleSpeculativePrefetch,
  computePrefetchKey,
  type PlannedToolStep,
} from './speculativePrefetchScheduler'

describe('speculativePrefetchScheduler (AGENT-020)', () => {
  describe('computePrefetchKey', () => {
    it('generates consistent keys regardless of argument insertion order', () => {
      const key1 = computePrefetchKey('read_file', { path: 'src/main.ts', encoding: 'utf8' })
      const key2 = computePrefetchKey('read_file', { encoding: 'utf8', path: 'src/main.ts' })
      expect(key1).toBe(key2)
      expect(key1).toMatch(/^prefetch:read_file:[0-9a-f]{16}$/)
    })
  })

  describe('scheduleSpeculativePrefetch', () => {
    it('accepts safe read-only idempotent steps with static arguments', () => {
      const steps: PlannedToolStep[] = [
        {
          stepId: 'step-1',
          toolName: 'read_file',
          args: { path: 'package.json' },
          estimatedDurationMs: 200,
        },
        {
          stepId: 'step-2',
          toolName: 'git_status',
          args: {},
          estimatedDurationMs: 150,
        },
      ]

      const report = scheduleSpeculativePrefetch(steps, { maxConcurrency: 2 })

      expect(report.candidateCount).toBe(2)
      expect(report.rejectedCount).toBe(0)
      expect(report.candidates[0]?.stepId).toBe('step-1')
      expect(report.candidates[1]?.stepId).toBe('step-2')
      expect(report.estimatedTimeSavedMs).toBeGreaterThan(0)
      expect(report.formattedSummary).toContain('[Speculative Prefetch] Scheduled 2/2')
    })

    it('rejects unsafe modifying tools strictly under Axiom A7', () => {
      const steps: PlannedToolStep[] = [
        {
          stepId: 'step-mutating',
          toolName: 'write_file',
          args: { path: 'dist/out.txt', content: 'test' },
        },
        {
          stepId: 'step-exec',
          toolName: 'run_bash_command',
          args: { cmd: 'rm -rf tmp' },
        },
      ]

      const report = scheduleSpeculativePrefetch(steps)

      expect(report.candidateCount).toBe(0)
      expect(report.rejectedCount).toBe(2)
      expect(report.rejectedReasons[0]?.reason).toContain(
        'not in safe read-only prefetch whitelist',
      )
      expect(report.rejectedReasons[1]?.reason).toContain(
        'not in safe read-only prefetch whitelist',
      )
    })

    it('rejects steps with unresolved dependencies or dynamic placeholders', () => {
      const steps: PlannedToolStep[] = [
        {
          stepId: 'step-dep',
          toolName: 'read_file',
          args: { path: 'test.ts' },
          dependsOn: ['step-prev'],
        },
        {
          stepId: 'step-dyn',
          toolName: 'read_file',
          args: { path: '$prevStep.output.path' },
        },
      ]

      const report = scheduleSpeculativePrefetch(steps)

      expect(report.candidateCount).toBe(0)
      expect(report.rejectedCount).toBe(2)
      expect(report.rejectedReasons[0]?.reason).toContain('unresolved dependencies')
      expect(report.rejectedReasons[1]?.reason).toContain('unresolved dynamic variable')
    })

    it('respects maxPrefetches bounds (Axiom A5)', () => {
      const steps: PlannedToolStep[] = [
        { stepId: 's1', toolName: 'read_file', args: { path: '1.ts' } },
        { stepId: 's2', toolName: 'read_file', args: { path: '2.ts' } },
        { stepId: 's3', toolName: 'read_file', args: { path: '3.ts' } },
      ]

      const report = scheduleSpeculativePrefetch(steps, { maxPrefetches: 2 })

      expect(report.candidateCount).toBe(2)
      expect(report.rejectedCount).toBe(1)
      expect(report.rejectedReasons[0]?.reason).toContain('Exceeded max prefetch quota')
    })
  })
})
