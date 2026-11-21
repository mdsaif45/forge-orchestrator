import { describe, expect, it } from 'vitest'
import { detectWorkflowDeadlocks } from './workflowDeadlockDetector'

describe('WorkflowDeadlockDetector (WORK-030)', () => {
  it('returns nominal status for linear runnable DAG with no deadlocks', () => {
    const steps = [
      { stepId: 'step-build', dependencies: [] },
      { stepId: 'step-test', dependencies: ['step-build'] },
    ]
    const states = {
      'step-build': 'pending' as const,
      'step-test': 'pending' as const,
    }

    const report = detectWorkflowDeadlocks(steps, states)
    expect(report.isDeadlocked).toBe(false)
    expect(report.canProgress).toBe(true)
    expect(report.runnableStepIds).toContain('step-build')
    expect(report.blockedStepIds).toContain('step-test')
    expect(report.cyclePaths.length).toBe(0)
  })

  it('detects direct circular wait-for dependency cycle between steps', () => {
    const steps = [
      { stepId: 'step-a', dependencies: ['step-b'] },
      { stepId: 'step-b', dependencies: ['step-a'] },
    ]
    const states = {
      'step-a': 'pending' as const,
      'step-b': 'pending' as const,
    }

    const report = detectWorkflowDeadlocks(steps, states)
    expect(report.isDeadlocked).toBe(true)
    expect(report.canProgress).toBe(false)
    expect(report.cyclePaths.length).toBeGreaterThan(0)
    expect(report.deadlockReason).toContain('Circular wait-for dependency cycle')
  })

  it('detects indirect multi-step cycle (step-1 -> step-2 -> step-3 -> step-1)', () => {
    const steps = [
      { stepId: 'step-1', dependencies: ['step-3'] },
      { stepId: 'step-2', dependencies: ['step-1'] },
      { stepId: 'step-3', dependencies: ['step-2'] },
    ]
    const states = {
      'step-1': 'pending' as const,
      'step-2': 'pending' as const,
      'step-3': 'pending' as const,
    }

    const report = detectWorkflowDeadlocks(steps, states)
    expect(report.isDeadlocked).toBe(true)
    expect(report.canProgress).toBe(false)
    expect(report.cyclePaths[0]).toEqual(['step-1', 'step-3', 'step-2', 'step-1'])
  })

  it('identifies execution stalemate when failed dependencies block remaining steps indefinitely', () => {
    const steps = [
      { stepId: 'step-prereq', dependencies: [] },
      { stepId: 'step-consumer', dependencies: ['step-prereq'] },
    ]
    const states = {
      'step-prereq': 'failed' as const,
      'step-consumer': 'pending' as const,
    }

    const report = detectWorkflowDeadlocks(steps, states)
    expect(report.isDeadlocked).toBe(true)
    expect(report.canProgress).toBe(false)
    expect(report.stuckStepIds).toContain('step-consumer')
    expect(report.deadlockReason).toContain('Execution stalemate')
  })

  it('correctly handles resource slot exhaustion blocking steps without false cycle reporting', () => {
    const steps = [
      { stepId: 'step-1', dependencies: [] },
      { stepId: 'step-2', dependencies: [] },
    ]
    const states = {
      'step-1': 'running' as const,
      'step-2': 'pending' as const,
    }

    // Slots full (available: 1, allocated: 1)
    const report = detectWorkflowDeadlocks(steps, states, {
      availableResourceSlots: 1,
      allocatedResourceSlots: 1,
    })

    expect(report.isDeadlocked).toBe(false)
    expect(report.canProgress).toBe(true) // step-1 is running
    expect(report.blockedStepIds).toContain('step-2')
    expect(report.cyclePaths.length).toBe(0)
  })
})
