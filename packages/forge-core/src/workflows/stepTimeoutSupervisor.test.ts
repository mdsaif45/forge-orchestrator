import { afterEach, describe, expect, it } from 'vitest'
import {
  StepTimeoutError,
  StepTimeoutSupervisor,
  type StepTimeoutEvent,
} from './stepTimeoutSupervisor'

describe('Workflow Step Timeout Supervisor & Zombie Stage Terminator (WORK-016)', () => {
  let supervisor: StepTimeoutSupervisor | undefined

  afterEach(() => {
    supervisor?.dispose()
  })

  it('deregisters completed stages cleanly before timeout fires', () => {
    supervisor = new StepTimeoutSupervisor()
    const controller = new AbortController()

    const lease = supervisor.register('node-test-1', 1000, controller)
    expect(lease.nodeId).toBe('node-test-1')
    expect(supervisor.getActiveLeases().length).toBe(1)

    // Complete naturally
    const deregistered = supervisor.deregister('node-test-1')
    expect(deregistered).toBe(true)
    expect(supervisor.getActiveLeases().length).toBe(0)
    expect(controller.signal.aborted).toBe(false)
    expect(supervisor.getAuditHistory().length).toBe(0)
  })

  it('triggers abort signal and logs timeout event when execution budget expires', async () => {
    const events: StepTimeoutEvent[] = []
    supervisor = new StepTimeoutSupervisor({
      onTimeout: (ev) => {
        events.push(ev)
      },
    })
    const controller = new AbortController()

    supervisor.register('hung-agent-step', 30, controller, 2)

    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(controller.signal.aborted).toBe(true)
    expect(controller.signal.reason).toBeInstanceOf(StepTimeoutError)
    expect((controller.signal.reason as StepTimeoutError).nodeId).toBe('hung-agent-step')
    expect((controller.signal.reason as StepTimeoutError).attempt).toBe(2)

    expect(events.length).toBe(1)
    expect(events[0]?.nodeId).toBe('hung-agent-step')
    expect(supervisor.getActiveLeases().length).toBe(0)
    expect(supervisor.getAuditHistory().length).toBe(1)
  })

  it('manages multiple concurrent node leases and disposes cleanly', () => {
    supervisor = new StepTimeoutSupervisor()
    const c1 = new AbortController()
    const c2 = new AbortController()

    supervisor.register('stage-a', 5000, c1)
    supervisor.register('stage-b', 5000, c2)

    expect(supervisor.getActiveLeases().length).toBe(2)

    supervisor.dispose()
    expect(supervisor.getActiveLeases().length).toBe(0)
  })
})
