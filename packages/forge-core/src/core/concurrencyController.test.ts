import { describe, expect, it } from 'vitest'
import {
  ConcurrencyController,
  ConcurrencyDrainError,
  ConcurrencyTimeoutError,
  InvalidConcurrencyPolicyError,
} from './concurrencyController'

describe('ConcurrencyController (PAR-001)', () => {
  it('enforces slot limits and dispatches queued tasks in priority order', async () => {
    let now = 1_000
    const controller = new ConcurrencyController({
      policy: { maxConcurrentSlots: 1, enableDynamicScaling: false },
      clock: () => now,
      resourceProbe: () => ({ cpuCores: 4, cpuLoadRatio: 0.1, memoryRssBytes: 128_000_000 }),
    })

    const executionOrder: string[] = []

    const firstSlot = await controller.acquire({ taskId: 'initial', branchId: 'main' })
    executionOrder.push(firstSlot.taskId)

    const lowPromise = controller
      .acquire({ taskId: 'low-task', branchId: 'main', priority: 'low' })
      .then((slot) => {
        executionOrder.push(slot.taskId)
        slot.release()
      })
    const highPromise = controller
      .acquire({ taskId: 'high-task', branchId: 'main', priority: 'high' })
      .then((slot) => {
        executionOrder.push(slot.taskId)
        slot.release()
      })
    const criticalPromise = controller
      .acquire({ taskId: 'critical-task', branchId: 'main', priority: 'critical' })
      .then((slot) => {
        executionOrder.push(slot.taskId)
        slot.release()
      })

    const midStatus = controller.getStatus()
    expect(midStatus.activeSlotCount).toBe(1)
    expect(midStatus.queuedCount).toBe(3)
    expect(midStatus.statusDigest).toHaveLength(64)

    now += 50
    firstSlot.release()

    await Promise.all([lowPromise, highPromise, criticalPromise])

    expect(executionOrder).toEqual(['initial', 'critical-task', 'high-task', 'low-task'])
    expect(controller.getStatus().metrics.totalCompleted).toBe(4)
  })

  it('prevents starvation by promoting long-waiting low-priority tasks ahead of newer normal work', async () => {
    let now = 10_000
    const controller = new ConcurrencyController({
      policy: {
        maxConcurrentSlots: 1,
        agingBoostPerSecond: 5,
        starvationThresholdMs: 2_000,
        enableDynamicScaling: false,
      },
      clock: () => now,
      resourceProbe: () => ({ cpuCores: 4, cpuLoadRatio: 0.2, memoryRssBytes: 128_000_000 }),
    })

    const blocker = await controller.acquire({ taskId: 'blocker', branchId: 'main' })
    const dispatchOrder: string[] = []

    const starvedLow = controller
      .acquire({ taskId: 'aged-low', branchId: 'feat-a', priority: 'low' })
      .then((s) => {
        dispatchOrder.push(s.taskId)
        s.release()
      })

    now += 3_000
    const freshHigh = controller
      .acquire({ taskId: 'fresh-high', branchId: 'feat-a', priority: 'high' })
      .then((s) => {
        dispatchOrder.push(s.taskId)
        s.release()
      })

    blocker.release()
    await Promise.all([starvedLow, freshHigh])

    expect(dispatchOrder).toEqual(['aged-low', 'fresh-high'])
    expect(controller.getStatus().metrics.totalStarvationPromotions).toBeGreaterThanOrEqual(1)
  })

  it('enforces fair-share scheduling across competing branches under saturation', async () => {
    const controller = new ConcurrencyController({
      policy: {
        maxConcurrentSlots: 2,
        maxPerBranchShare: 0.5,
        enableDynamicScaling: false,
      },
      resourceProbe: () => ({ cpuCores: 4, cpuLoadRatio: 0.2, memoryRssBytes: 128_000_000 }),
    })

    const s1 = await controller.acquire({ taskId: 'a-1', branchId: 'branch-a', priority: 'normal' })
    const s2 = await controller.acquire({ taskId: 'b-1', branchId: 'branch-b', priority: 'normal' })

    const order: string[] = []
    // Queue another branch-a task first, plus a second branch-a task, then branch-b
    const pA2 = controller
      .acquire({ taskId: 'a-2', branchId: 'branch-a', priority: 'normal' })
      .then((slot) => {
        order.push(slot.taskId)
        return slot
      })
    const pB2 = controller
      .acquire({ taskId: 'b-2', branchId: 'branch-b', priority: 'normal' })
      .then((slot) => {
        order.push(slot.taskId)
        return slot
      })

    // Releasing branch-b's active slot leaves branch-a still holding 1 active slot (at 50% cap),
    // so fair-share prefers branch-b's queued task next.
    s2.release()
    const grantedB2 = await pB2
    expect(order[0]).toBe('b-2')

    s1.release()
    const grantedA2 = await pA2
    expect(order).toEqual(['b-2', 'a-2'])

    grantedB2.release()
    grantedA2.release()
  })

  it('dynamically scales down concurrency under CPU and RSS memory pressure', async () => {
    let cpuLoadRatio = 0.2
    let memoryRssBytes = 200_000_000

    const controller = new ConcurrencyController({
      policy: {
        maxConcurrentSlots: 4,
        minConcurrentSlots: 1,
        maxCpuLoadRatio: 0.75,
        maxMemoryRssBytes: 1_000_000_000,
      },
      resourceProbe: () => ({ cpuCores: 4, cpuLoadRatio, memoryRssBytes }),
    })

    expect(controller.getStatus().effectiveMaxSlots).toBe(4)
    expect(controller.getStatus().scalingState).toBe('NOMINAL')

    cpuLoadRatio = 1.2
    expect(controller.getStatus().effectiveMaxSlots).toBe(2)
    expect(controller.getStatus().scalingState).toBe('SCALED_DOWN_CPU')

    cpuLoadRatio = 0.3
    memoryRssBytes = 1_200_000_000
    expect(controller.getStatus().effectiveMaxSlots).toBe(1)
    expect(controller.getStatus().scalingState).toBe('SCALED_DOWN_MEMORY')

    const s1 = await controller.acquire({ taskId: 'mem-1' })
    const s2Promise = controller.acquire({ taskId: 'mem-2' })
    expect(controller.getStatus().queuedCount).toBe(1)

    // Relieving memory pressure and ticking immediately unblocks queued work
    memoryRssBytes = 200_000_000
    expect(controller.tick()).toBe(1)
    const s2 = await s2Promise
    s1.release()
    s2.release()
  })

  it('throttles tasks exceeding rolling per-minute token rate budget and recovers after window expiry', async () => {
    let now = 50_000
    const controller = new ConcurrencyController({
      policy: {
        maxConcurrentSlots: 4,
        tokenRateLimitPerMinute: 1_000,
        enableDynamicScaling: false,
      },
      clock: () => now,
      resourceProbe: () => ({ cpuCores: 4, cpuLoadRatio: 0.1, memoryRssBytes: 128_000_000 }),
    })

    const s1 = await controller.acquire({ taskId: 'tok-1', estimatedTokens: 700 })
    const p2 = controller.acquire({ taskId: 'tok-2', estimatedTokens: 500 })

    expect(controller.getStatus().activeSlotCount).toBe(1)
    expect(controller.getStatus().queuedCount).toBe(1)
    expect(controller.getStatus().resources.tokensConsumedLastMinute).toBe(700)

    s1.release()
    // Advance past 60s sliding window and tick
    now += 61_000
    expect(controller.tick()).toBe(1)
    const s2 = await p2
    s2.release()
  })

  it('handles graceful draining, acquisition timeouts, runWithSlot safety, and policy validation', async () => {
    expect(
      () => new ConcurrencyController({ policy: { maxConcurrentSlots: 1, minConcurrentSlots: 4 } }),
    ).toThrow(InvalidConcurrencyPolicyError)

    const controller = new ConcurrencyController({
      policy: { maxConcurrentSlots: 1, drainTimeoutMs: 500, enableDynamicScaling: false },
      resourceProbe: () => ({ cpuCores: 2, cpuLoadRatio: 0.1, memoryRssBytes: 64_000_000 }),
    })

    await expect(
      controller.runWithSlot({ taskId: 'err-task' }, () =>
        Promise.reject(new Error('simulated failure')),
      ),
    ).rejects.toThrow('simulated failure')
    expect(controller.getStatus().activeSlotCount).toBe(0)

    const held = await controller.acquire({ taskId: 'held-slot' })
    await expect(controller.acquire({ taskId: 'timed-out', timeoutMs: 25 })).rejects.toThrow(
      ConcurrencyTimeoutError,
    )

    const drainPromise = controller.drain({ cancelQueued: false, timeoutMs: 1_000 })
    await expect(controller.acquire({ taskId: 'after-drain' })).rejects.toThrow(
      ConcurrencyDrainError,
    )

    held.release()
    const drainResult = await drainPromise
    expect(drainResult.drainedCleanly).toBe(true)
    expect(drainResult.remainingActiveCount).toBe(0)
    expect(controller.getStatus().scalingState).toBe('DRAINED')
  })
})
