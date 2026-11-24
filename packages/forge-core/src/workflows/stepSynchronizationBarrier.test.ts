import { describe, expect, it } from 'vitest'
import { evaluateStepBarrier, type StepDependencyOutcome } from './stepSynchronizationBarrier'

describe('stepSynchronizationBarrier (WORK-029)', () => {
  it('opens barrier immediately when there are zero dependencies', () => {
    const decision = evaluateStepBarrier('step-barrier-0', [])
    expect(decision.canProceed).toBe(true)
    expect(decision.isSatisfied).toBe(true)
    expect(decision.isImpossible).toBe(false)
  })

  it('evaluates ALL_SUCCEEDED policy requiring 100% success', () => {
    const deps: StepDependencyOutcome[] = [
      { stepId: 'sub-1', status: 'SUCCEEDED', required: false },
      { stepId: 'sub-2', status: 'PENDING', required: false },
    ]

    const pendingDecision = evaluateStepBarrier('merge-stage', deps, 'ALL_SUCCEEDED')
    expect(pendingDecision.canProceed).toBe(false)
    expect(pendingDecision.isImpossible).toBe(false)
    expect(pendingDecision.pendingStepIds).toEqual(['sub-2'])

    deps[1] = { stepId: 'sub-2', status: 'SUCCEEDED', required: false }
    const completeDecision = evaluateStepBarrier('merge-stage', deps, 'ALL_SUCCEEDED')
    expect(completeDecision.canProceed).toBe(true)
    expect(completeDecision.isSatisfied).toBe(true)

    deps[1] = { stepId: 'sub-2', status: 'FAILED', required: false }
    const failedDecision = evaluateStepBarrier('merge-stage', deps, 'ALL_SUCCEEDED')
    expect(failedDecision.canProceed).toBe(false)
    expect(failedDecision.isImpossible).toBe(true)
  })

  it('evaluates AT_LEAST_ONE_SUCCEEDED policy', () => {
    const deps: StepDependencyOutcome[] = [
      { stepId: 'sub-1', status: 'FAILED', required: false },
      { stepId: 'sub-2', status: 'PENDING', required: false },
    ]

    const pendingDecision = evaluateStepBarrier('fan-in', deps, 'AT_LEAST_ONE_SUCCEEDED')
    expect(pendingDecision.canProceed).toBe(false)
    expect(pendingDecision.isImpossible).toBe(false)

    deps[1] = { stepId: 'sub-2', status: 'SUCCEEDED', required: false }
    const satisfiedDecision = evaluateStepBarrier('fan-in', deps, 'AT_LEAST_ONE_SUCCEEDED')
    expect(satisfiedDecision.canProceed).toBe(true)
    expect(satisfiedDecision.isSatisfied).toBe(true)
  })

  it('evaluates MAJORITY_SUCCEEDED policy and detects impossible quorum early', () => {
    // 3 total dependencies -> majority threshold is 2
    const deps: StepDependencyOutcome[] = [
      { stepId: 'branch-1', status: 'FAILED', required: false },
      { stepId: 'branch-2', status: 'FAILED', required: false },
      { stepId: 'branch-3', status: 'PENDING', required: false },
    ]

    // Succeeded: 0, Pending: 1. Max possible succeeded = 1 < 2 threshold!
    const decision = evaluateStepBarrier('quorum-gate', deps, 'MAJORITY_SUCCEEDED')
    expect(decision.canProceed).toBe(false)
    expect(decision.isImpossible).toBe(true)
  })

  it('fails closed immediately when any required dependency fails', () => {
    const deps: StepDependencyOutcome[] = [
      { stepId: 'critical-sub', status: 'FAILED', required: true },
      { stepId: 'optional-sub', status: 'SUCCEEDED', required: false },
    ]

    const decision = evaluateStepBarrier('gate', deps, 'AT_LEAST_ONE_SUCCEEDED')
    expect(decision.canProceed).toBe(false)
    expect(decision.isImpossible).toBe(true)
    expect(decision.summary).toContain('required failure: true')
  })
})
