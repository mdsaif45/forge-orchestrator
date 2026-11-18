import { afterEach, describe, expect, it } from 'vitest'
import { ProcessManager } from './processManager'

describe('ProcessManager Watchdog & Metrics', () => {
  let pm: ProcessManager | null = null

  afterEach(async () => {
    if (pm) {
      await pm.killAll('test teardown')
      pm = null
    }
  })

  it('terminates process when heartbeatTimeoutMs expires without output', async () => {
    const fakeNow = 1000
    pm = new ProcessManager({ now: () => fakeNow })

    // Spawn a long-running process (e.g. node -e "setTimeout(() => {}, 60000)") with heartbeatTimeoutMs
    const command = process.execPath
    const args = ['-e', 'setTimeout(() => {}, 60000)']

    const handle = await pm.spawn({
      command,
      args,
      cwd: process.cwd(),
      heartbeatTimeoutMs: 100,
    })

    expect(pm.activeCount).toBe(1)
    const activeMetrics = pm.getMetrics(handle.runId)
    expect(activeMetrics).toBeDefined()
    expect(activeMetrics!.status).toBe('running')
    expect(activeMetrics!.command).toBe(command)

    // Wait for idle/heartbeat timeout to fire
    const outcome = await handle.completed
    expect(outcome.reason).toBe('idle-timeout')
    expect(pm.activeCount).toBe(0)

    // Verify completed metrics are recorded
    const completedMetrics = pm.getMetrics(handle.runId)
    expect(completedMetrics).toBeDefined()
    expect(completedMetrics!.status).toBe('completed')
    expect(completedMetrics!.outcomeReason).toBe('idle-timeout')

    const allMetrics = pm.listMetrics()
    expect(allMetrics.some((m) => m.runId === handle.runId)).toBe(true)
  })

  it('reports metrics for multiple processes correctly', async () => {
    pm = new ProcessManager()
    const command = process.execPath
    const args = ['-e', 'console.log("hello"); process.exit(0)']

    const handle = await pm.spawn({
      command,
      args,
      cwd: process.cwd(),
    })

    const outcome = await handle.completed
    expect(outcome.reason).toBe('exited')
    expect(outcome.exitCode).toBe(0)

    const metrics = pm.getMetrics(handle.runId)
    expect(metrics).toBeDefined()
    expect(metrics!.status).toBe('completed')
    expect(metrics!.exitCode).toBe(0)
    expect(metrics!.outputBytes).toBeGreaterThan(0)
  })
})
