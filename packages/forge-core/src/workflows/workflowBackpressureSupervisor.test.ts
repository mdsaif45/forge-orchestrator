import { describe, expect, it } from 'vitest'
import { WorkflowBackpressureSupervisor } from './workflowBackpressureSupervisor'

describe('WorkflowBackpressureSupervisor', () => {
  it('operates in NORMAL state with zero delay under low queue load', () => {
    const supervisor = new WorkflowBackpressureSupervisor({ maxQueueCapacity: 20 })
    expect(supervisor.getState()).toBe('NORMAL')

    const decision = supervisor.evaluateSubmission(1)
    expect(decision.state).toBe('NORMAL')
    expect(decision.allowSubmission).toBe(true)
    expect(decision.delayMs).toBe(0)
  })

  it('transitions to THROTTLED state and applies dynamic ingestion delay as load increases', () => {
    const supervisor = new WorkflowBackpressureSupervisor({
      maxQueueCapacity: 10,
      throttleThresholdRatio: 0.6,
      saturatedThresholdRatio: 0.85,
      baseThrottleDelayMs: 100,
      maxThrottleDelayMs: 1000,
    })

    // Add 6 tasks to reach 60% load
    for (let i = 0; i < 6; i++) {
      expect(supervisor.enqueueTask(`step-${String(i)}`)).toBe(true)
    }

    expect(supervisor.getState()).toBe('THROTTLED')
    const decision = supervisor.evaluateSubmission(1)
    expect(decision.state).toBe('THROTTLED')
    expect(decision.allowSubmission).toBe(true)
    expect(decision.delayMs).toBeGreaterThanOrEqual(100)
    expect(decision.delayMs).toBeLessThanOrEqual(1000)
  })

  it('transitions to SATURATED state applying maximum delay when near capacity', () => {
    const supervisor = new WorkflowBackpressureSupervisor({
      maxQueueCapacity: 10,
      throttleThresholdRatio: 0.5,
      saturatedThresholdRatio: 0.8,
      maxThrottleDelayMs: 2000,
    })

    for (let i = 0; i < 8; i++) {
      supervisor.enqueueTask(`step-${String(i)}`)
    }

    expect(supervisor.getState()).toBe('SATURATED')
    const decision = supervisor.evaluateSubmission(1)
    expect(decision.state).toBe('SATURATED')
    expect(decision.allowSubmission).toBe(true)
    expect(decision.delayMs).toBe(2000)
  })

  it('transitions to REJECTING state and refuses task submission when queue capacity is exceeded', () => {
    const supervisor = new WorkflowBackpressureSupervisor({ maxQueueCapacity: 5 })

    for (let i = 0; i < 5; i++) {
      supervisor.enqueueTask(`step-${String(i)}`)
    }

    expect(supervisor.getState()).toBe('REJECTING')
    const decision = supervisor.evaluateSubmission(1)
    expect(decision.state).toBe('REJECTING')
    expect(decision.allowSubmission).toBe(false)
    expect(decision.reason).toContain('Queue capacity exceeded')

    const accepted = supervisor.enqueueTask('overflow-step')
    expect(accepted).toBe(false)
    expect(supervisor.getMetrics().totalRejected).toBe(1)
  })

  it('recovers state to NORMAL as tasks complete', () => {
    const supervisor = new WorkflowBackpressureSupervisor({ maxQueueCapacity: 4 })

    supervisor.enqueueTask('step-1')
    supervisor.enqueueTask('step-2')
    supervisor.enqueueTask('step-3')
    supervisor.enqueueTask('step-4')

    expect(supervisor.getState()).toBe('REJECTING')

    supervisor.completeTask('step-1')
    supervisor.completeTask('step-2')
    supervisor.completeTask('step-3')

    expect(supervisor.getState()).toBe('NORMAL')
    const metrics = supervisor.getMetrics()
    expect(metrics.pendingQueueDepth).toBe(1)
    expect(metrics.completedTasks).toBe(3)
  })
})
