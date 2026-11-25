import { createHash, randomUUID } from 'node:crypto'
import * as os from 'node:os'
import { z } from 'zod'

export type TaskPriority = 'critical' | 'high' | 'normal' | 'low'

export type ScalingState =
  'NOMINAL' | 'SCALED_DOWN_CPU' | 'SCALED_DOWN_MEMORY' | 'THROTTLED_TOKENS' | 'DRAINING' | 'DRAINED'

const PRIORITY_SCORES: Readonly<Record<TaskPriority, number>> = {
  critical: 100,
  high: 60,
  normal: 30,
  low: 10,
}

const TOKEN_WINDOW_MS = 60_000

export const concurrencyPolicySchema = z
  .strictObject({
    /** Hard upper bound on concurrent slots. Defaults to clamped CPU core count [1..8]. */
    maxConcurrentSlots: z
      .number()
      .int()
      .positive()
      .default(() => Math.max(1, Math.min(8, os.cpus().length))),
    /** Minimum concurrent slots maintained even under dynamic pressure. */
    minConcurrentSlots: z.number().int().positive().default(1),
    /** Process RSS memory threshold in bytes before scaling concurrency down. */
    maxMemoryRssBytes: z
      .number()
      .int()
      .positive()
      .default(2 * 1024 * 1024 * 1024),
    /** Per-core load ratio threshold (1.0 = 100% of one core average). */
    maxCpuLoadRatio: z.number().positive().max(16).default(0.85),
    /** Maximum estimated API tokens allowed within a rolling 60-second window. */
    tokenRateLimitPerMinute: z.number().int().positive().default(120_000),
    /** Priority aging boost accumulated per second spent queued. */
    agingBoostPerSecond: z.number().nonnegative().default(2),
    /** Queue wait duration in ms after which a task is promoted to prevent starvation. */
    starvationThresholdMs: z.number().int().positive().default(5_000),
    /** Maximum share [0..1] one branch may occupy when other branches are queued. */
    maxPerBranchShare: z.number().positive().max(1).default(0.75),
    /** Default timeout in ms when waiting for active slots during graceful drain. */
    drainTimeoutMs: z.number().int().positive().default(10_000),
    /** Enables automatic slot reduction under CPU or RSS pressure. */
    enableDynamicScaling: z.boolean().default(true),
  })
  .refine((p) => p.minConcurrentSlots <= p.maxConcurrentSlots, {
    message: 'minConcurrentSlots cannot exceed maxConcurrentSlots',
    path: ['minConcurrentSlots'],
  })

export type ConcurrencyPolicy = z.infer<typeof concurrencyPolicySchema>

export interface ResourceSnapshot {
  readonly cpuLoadRatio: number
  readonly cpuCores: number
  readonly memoryRssBytes: number
  readonly tokensConsumedLastMinute: number
  readonly timestampMs: number
}

export interface ExecutionRequest {
  readonly taskId: string
  readonly branchId?: string | undefined
  readonly priority?: TaskPriority | undefined
  readonly estimatedTokens?: number | undefined
  readonly timeoutMs?: number | undefined
}

export interface ResourceSlot {
  readonly slotId: string
  readonly taskId: string
  readonly branchId: string
  readonly priority: TaskPriority
  readonly estimatedTokens: number
  readonly acquiredAtMs: number
  readonly released: boolean
  readonly release: () => void
}

export interface ExecutionQueueEntry {
  readonly entryId: string
  readonly taskId: string
  readonly branchId: string
  readonly priority: TaskPriority
  readonly basePriorityScore: number
  readonly effectivePriorityScore: number
  readonly estimatedTokens: number
  readonly enqueuedAtMs: number
  readonly waitTimeMs: number
  readonly starvationPromoted: boolean
}

export interface BranchConcurrencyStats {
  readonly active: number
  readonly queued: number
  readonly completed: number
}

export interface ConcurrencyMetrics {
  readonly totalAcquired: number
  readonly totalCompleted: number
  readonly totalRejected: number
  readonly totalTimedOut: number
  readonly totalStarvationPromotions: number
  readonly totalScaleDownEvents: number
}

export interface ConcurrencyControllerStatus {
  readonly policy: ConcurrencyPolicy
  readonly effectiveMaxSlots: number
  readonly activeSlotCount: number
  readonly availableSlots: number
  readonly queuedCount: number
  readonly activeSlots: readonly Omit<ResourceSlot, 'release'>[]
  readonly queuedEntries: readonly ExecutionQueueEntry[]
  readonly branchUsage: Readonly<Record<string, BranchConcurrencyStats>>
  readonly resources: ResourceSnapshot
  readonly scalingState: ScalingState
  readonly draining: boolean
  readonly drained: boolean
  readonly metrics: ConcurrencyMetrics
  readonly statusDigest: string
}

export interface DrainOptions {
  readonly timeoutMs?: number | undefined
  readonly cancelQueued?: boolean | undefined
}

export interface DrainResult {
  readonly drainedCleanly: boolean
  readonly waitedMs: number
  readonly cancelledQueuedCount: number
  readonly remainingActiveCount: number
}

export interface ResourceProbeSample {
  readonly cpuLoadRatio: number
  readonly cpuCores: number
  readonly memoryRssBytes: number
}

export interface ConcurrencyControllerOptions {
  readonly policy?: Partial<ConcurrencyPolicy> | undefined
  readonly clock?: (() => number) | undefined
  readonly resourceProbe?: (() => ResourceProbeSample) | undefined
}

export class InvalidConcurrencyPolicyError extends Error {
  constructor(message: string) {
    super(`Invalid concurrency policy: ${message}`)
    this.name = 'InvalidConcurrencyPolicyError'
  }
}

export class ConcurrencyDrainError extends Error {
  constructor(message = 'ConcurrencyController is draining or drained and cannot accept tasks') {
    super(message)
    this.name = 'ConcurrencyDrainError'
  }
}

export class ConcurrencyTimeoutError extends Error {
  readonly taskId: string
  readonly timeoutMs: number

  constructor(taskId: string, timeoutMs: number) {
    super(`Timed out waiting ${String(timeoutMs)}ms to acquire execution slot for "${taskId}"`)
    this.name = 'ConcurrencyTimeoutError'
    this.taskId = taskId
    this.timeoutMs = timeoutMs
  }
}

interface InternalSlot {
  readonly slotId: string
  readonly taskId: string
  readonly branchId: string
  readonly priority: TaskPriority
  readonly estimatedTokens: number
  readonly acquiredAtMs: number
  released: boolean
}

interface InternalWaiter {
  readonly entryId: string
  readonly taskId: string
  readonly branchId: string
  readonly priority: TaskPriority
  readonly basePriorityScore: number
  readonly estimatedTokens: number
  readonly enqueuedAtMs: number
  starvationPromoted: boolean
  timer?: NodeJS.Timeout | undefined
  resolve: (slot: ResourceSlot) => void
  reject: (err: Error) => void
}

interface TokenUsageSample {
  readonly timestampMs: number
  readonly tokens: number
}

function defaultResourceProbe(): ResourceProbeSample {
  const cpuCores = Math.max(1, os.cpus().length)
  const loadAvg1m = os.loadavg()[0] ?? 0
  return {
    cpuCores,
    cpuLoadRatio: Number((loadAvg1m / cpuCores).toFixed(4)),
    memoryRssBytes: process.memoryUsage().rss,
  }
}

/**
 * Policy-Governed Concurrency Controller and Resource Budget Limiter (PAR-001, Axioms A2 & A5).
 * Coordinates multi-branch agent task execution across CPU, RSS memory, and token rate limits.
 */
export class ConcurrencyController {
  private readonly policy: ConcurrencyPolicy
  private readonly clock: () => number
  private readonly resourceProbe: () => ResourceProbeSample

  private readonly activeSlots = new Map<string, InternalSlot>()
  private readonly waitQueue: InternalWaiter[] = []
  private readonly tokenWindow: TokenUsageSample[] = []
  private readonly completedByBranch = new Map<string, number>()
  private readonly drainWaiters: (() => void)[] = []

  private draining = false
  private drained = false
  private tokenRefillTimer?: NodeJS.Timeout | undefined

  private totalAcquired = 0
  private totalCompleted = 0
  private totalRejected = 0
  private totalTimedOut = 0
  private totalStarvationPromotions = 0
  private totalScaleDownEvents = 0
  private lastScalingState: ScalingState = 'NOMINAL'

  constructor(options: ConcurrencyControllerOptions = {}) {
    const parsed = concurrencyPolicySchema.safeParse(options.policy ?? {})
    if (!parsed.success) {
      throw new InvalidConcurrencyPolicyError(
        parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      )
    }
    this.policy = parsed.data
    this.clock = options.clock ?? Date.now
    this.resourceProbe = options.resourceProbe ?? defaultResourceProbe
  }

  /**
   * Acquires an execution slot governed by concurrency, CPU/RSS scaling, token budget, and fair-share policy.
   */
  public acquire(request: ExecutionRequest): Promise<ResourceSlot> {
    const taskId = request.taskId.trim()
    if (taskId.length === 0) {
      this.totalRejected++
      return Promise.reject(
        new InvalidConcurrencyPolicyError('ExecutionRequest.taskId is required'),
      )
    }
    if (this.draining || this.drained) {
      this.totalRejected++
      return Promise.reject(new ConcurrencyDrainError())
    }
    if (
      request.estimatedTokens !== undefined &&
      (!Number.isFinite(request.estimatedTokens) || request.estimatedTokens < 0)
    ) {
      this.totalRejected++
      return Promise.reject(
        new InvalidConcurrencyPolicyError('estimatedTokens must be a non-negative finite number'),
      )
    }
    if (
      request.estimatedTokens !== undefined &&
      request.estimatedTokens > this.policy.tokenRateLimitPerMinute
    ) {
      this.totalRejected++
      return Promise.reject(
        new InvalidConcurrencyPolicyError(
          `estimatedTokens (${String(request.estimatedTokens)}) exceeds per-minute rate ceiling (${String(this.policy.tokenRateLimitPerMinute)})`,
        ),
      )
    }

    const branchId = (request.branchId ?? 'main').trim() || 'main'
    const priority: TaskPriority = request.priority ?? 'normal'
    const estimatedTokens = Math.round(request.estimatedTokens ?? 0)
    const now = this.clock()

    const waiterPromise = new Promise<ResourceSlot>((resolve, reject) => {
      const waiter: InternalWaiter = {
        entryId: randomUUID(),
        taskId,
        branchId,
        priority,
        basePriorityScore: PRIORITY_SCORES[priority],
        estimatedTokens,
        enqueuedAtMs: now,
        starvationPromoted: false,
        resolve,
        reject,
      }

      if (request.timeoutMs !== undefined && request.timeoutMs > 0) {
        waiter.timer = setTimeout(() => {
          const idx = this.waitQueue.indexOf(waiter)
          if (idx !== -1) {
            this.waitQueue.splice(idx, 1)
            this.totalTimedOut++
            this.checkDrainComplete()
            reject(new ConcurrencyTimeoutError(taskId, request.timeoutMs ?? 0))
          }
        }, request.timeoutMs)
        waiter.timer.unref()
      }

      this.waitQueue.push(waiter)
    })

    this.dispatch(now)
    return waiterPromise
  }

  /**
   * Acquires a slot, runs the callback, and guarantees deterministic release in a finally block.
   */
  public async runWithSlot<T>(
    request: ExecutionRequest,
    fn: (slot: ResourceSlot) => Promise<T>,
  ): Promise<T> {
    const slot = await this.acquire(request)
    try {
      return await fn(slot)
    } finally {
      slot.release()
    }
  }

  /**
   * Forces evaluation of queued tasks and expired token windows against current clock/resources.
   */
  public tick(): number {
    return this.dispatch(this.clock())
  }

  /**
   * Records additional token consumption outside an initial estimate.
   */
  public recordTokens(tokens: number): void {
    if (Number.isFinite(tokens) && tokens > 0) {
      this.tokenWindow.push({ timestampMs: this.clock(), tokens: Math.round(tokens) })
      this.pruneTokenWindow(this.clock())
    }
  }

  /**
   * Gracefully drains pending and active execution slots, rejecting any newly submitted tasks.
   */
  public async drain(options: DrainOptions = {}): Promise<DrainResult> {
    const startMs = this.clock()
    const timeoutMs = options.timeoutMs ?? this.policy.drainTimeoutMs
    this.draining = true

    let cancelledQueuedCount = 0
    if (options.cancelQueued) {
      while (this.waitQueue.length > 0) {
        const waiter = this.waitQueue.shift()
        if (!waiter) {
          continue
        }
        if (waiter.timer) {
          clearTimeout(waiter.timer)
        }
        cancelledQueuedCount++
        waiter.reject(
          new ConcurrencyDrainError('Queued execution cancelled during controller drain'),
        )
      }
    } else {
      this.dispatch(startMs)
    }

    if (this.activeSlots.size === 0 && this.waitQueue.length === 0) {
      this.clearTokenRefillTimer()
      this.drained = true
      return {
        drainedCleanly: true,
        waitedMs: 0,
        cancelledQueuedCount,
        remainingActiveCount: 0,
      }
    }

    const drainedCleanly = await new Promise<boolean>((resolve) => {
      let settled = false
      const finish = (clean: boolean): void => {
        if (settled) {
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(clean)
      }

      const timer = setTimeout(() => {
        const idx = this.drainWaiters.indexOf(onComplete)
        if (idx !== -1) {
          this.drainWaiters.splice(idx, 1)
        }
        finish(false)
      }, timeoutMs)
      timer.unref()

      const onComplete = (): void => {
        finish(true)
      }
      this.drainWaiters.push(onComplete)
    })

    if (drainedCleanly) {
      this.clearTokenRefillTimer()
      this.drained = true
    }

    return {
      drainedCleanly,
      waitedMs: Math.max(0, this.clock() - startMs),
      cancelledQueuedCount,
      remainingActiveCount: this.activeSlots.size,
    }
  }

  /**
   * Produces a consistent telemetry snapshot and SHA-256 digest of controller state.
   */
  public getStatus(): ConcurrencyControllerStatus {
    const now = this.clock()
    this.pruneTokenWindow(now)
    const probe = this.resourceProbe()
    const tokensUsed = this.getTokensInWindow(now)
    const { effectiveMaxSlots, scalingState } = this.computeCapacity(probe, tokensUsed)

    const resources: ResourceSnapshot = {
      cpuLoadRatio: probe.cpuLoadRatio,
      cpuCores: probe.cpuCores,
      memoryRssBytes: probe.memoryRssBytes,
      tokensConsumedLastMinute: tokensUsed,
      timestampMs: now,
    }

    const branchActiveCounts = this.computeBranchActiveCounts()
    const branchQueuedCounts = new Map<string, number>()
    for (const waiter of this.waitQueue) {
      branchQueuedCounts.set(waiter.branchId, (branchQueuedCounts.get(waiter.branchId) ?? 0) + 1)
    }

    const allBranches = new Set<string>([
      ...branchActiveCounts.keys(),
      ...branchQueuedCounts.keys(),
      ...this.completedByBranch.keys(),
    ])
    const branchUsage: Record<string, BranchConcurrencyStats> = {}
    for (const branch of Array.from(allBranches).sort()) {
      branchUsage[branch] = {
        active: branchActiveCounts.get(branch) ?? 0,
        queued: branchQueuedCounts.get(branch) ?? 0,
        completed: this.completedByBranch.get(branch) ?? 0,
      }
    }

    const activeSlotList = Array.from(this.activeSlots.values()).map((slot) => ({
      slotId: slot.slotId,
      taskId: slot.taskId,
      branchId: slot.branchId,
      priority: slot.priority,
      estimatedTokens: slot.estimatedTokens,
      acquiredAtMs: slot.acquiredAtMs,
      released: slot.released,
    }))

    const queuedEntries = this.rankWaiters(now, branchActiveCounts, effectiveMaxSlots).map(
      (ranked) => ranked.entry,
    )

    const resolvedState: ScalingState = this.drained
      ? 'DRAINED'
      : this.draining
        ? 'DRAINING'
        : scalingState

    const metrics: ConcurrencyMetrics = {
      totalAcquired: this.totalAcquired,
      totalCompleted: this.totalCompleted,
      totalRejected: this.totalRejected,
      totalTimedOut: this.totalTimedOut,
      totalStarvationPromotions: this.totalStarvationPromotions,
      totalScaleDownEvents: this.totalScaleDownEvents,
    }

    const statusDigest = createHash('sha256')
      .update(
        JSON.stringify({
          effectiveMaxSlots,
          activeSlotCount: activeSlotList.length,
          queuedCount: queuedEntries.length,
          scalingState: resolvedState,
          branchUsage,
          metrics,
        }),
      )
      .digest('hex')

    return {
      policy: this.policy,
      effectiveMaxSlots,
      activeSlotCount: activeSlotList.length,
      availableSlots: Math.max(0, effectiveMaxSlots - activeSlotList.length),
      queuedCount: queuedEntries.length,
      activeSlots: activeSlotList,
      queuedEntries,
      branchUsage,
      resources,
      scalingState: resolvedState,
      draining: this.draining,
      drained: this.drained,
      metrics,
      statusDigest,
    }
  }

  private dispatch(now: number): number {
    this.pruneTokenWindow(now)
    let dispatched = 0

    while (this.waitQueue.length > 0) {
      const probe = this.resourceProbe()
      const tokensUsed = this.getTokensInWindow(now)
      const { effectiveMaxSlots, scalingState } = this.computeCapacity(probe, tokensUsed)

      if (
        (scalingState === 'SCALED_DOWN_CPU' || scalingState === 'SCALED_DOWN_MEMORY') &&
        this.lastScalingState !== scalingState
      ) {
        this.totalScaleDownEvents++
      }
      this.lastScalingState = scalingState

      if (this.activeSlots.size >= effectiveMaxSlots) {
        break
      }

      const branchActiveCounts = this.computeBranchActiveCounts()
      const ranked = this.rankWaiters(now, branchActiveCounts, effectiveMaxSlots)

      let selected: InternalWaiter | undefined
      let blockedByTokens = false

      for (const candidate of ranked) {
        if (tokensUsed + candidate.waiter.estimatedTokens <= this.policy.tokenRateLimitPerMinute) {
          selected = candidate.waiter
          break
        }
        blockedByTokens = true
      }

      if (!selected) {
        if (blockedByTokens) {
          this.lastScalingState = 'THROTTLED_TOKENS'
          this.scheduleTokenRefill(now)
        }
        break
      }

      const idx = this.waitQueue.indexOf(selected)
      if (idx !== -1) {
        this.waitQueue.splice(idx, 1)
      }
      if (selected.timer) {
        clearTimeout(selected.timer)
      }

      const slot = this.activateSlot(selected, now)
      dispatched++
      selected.resolve(slot)
    }

    return dispatched
  }

  private activateSlot(waiter: InternalWaiter, now: number): ResourceSlot {
    if (waiter.estimatedTokens > 0) {
      this.tokenWindow.push({ timestampMs: now, tokens: waiter.estimatedTokens })
    }

    const internalSlot: InternalSlot = {
      slotId: randomUUID(),
      taskId: waiter.taskId,
      branchId: waiter.branchId,
      priority: waiter.priority,
      estimatedTokens: waiter.estimatedTokens,
      acquiredAtMs: now,
      released: false,
    }

    this.activeSlots.set(internalSlot.slotId, internalSlot)
    this.totalAcquired++

    const release = (): void => {
      if (internalSlot.released) {
        return
      }
      internalSlot.released = true
      this.activeSlots.delete(internalSlot.slotId)
      this.totalCompleted++
      this.completedByBranch.set(
        internalSlot.branchId,
        (this.completedByBranch.get(internalSlot.branchId) ?? 0) + 1,
      )
      this.dispatch(this.clock())
      this.checkDrainComplete()
    }

    return {
      slotId: internalSlot.slotId,
      taskId: internalSlot.taskId,
      branchId: internalSlot.branchId,
      priority: internalSlot.priority,
      estimatedTokens: internalSlot.estimatedTokens,
      acquiredAtMs: internalSlot.acquiredAtMs,
      get released() {
        return internalSlot.released
      },
      release,
    }
  }

  private rankWaiters(
    now: number,
    branchActiveCounts: ReadonlyMap<string, number>,
    effectiveMaxSlots: number,
  ): {
    readonly waiter: InternalWaiter
    readonly entry: ExecutionQueueEntry
    readonly fairSharePenalty: number
  }[] {
    const distinctBranches = new Set<string>(this.waitQueue.map((w) => w.branchId))
    const enforceFairShare = distinctBranches.size > 1
    const branchCap = Math.max(1, Math.floor(effectiveMaxSlots * this.policy.maxPerBranchShare))

    const scored = this.waitQueue.map((waiter) => {
      const waitTimeMs = Math.max(0, now - waiter.enqueuedAtMs)
      const isStarved = waitTimeMs >= this.policy.starvationThresholdMs
      if (isStarved && !waiter.starvationPromoted) {
        waiter.starvationPromoted = true
        this.totalStarvationPromotions++
      }

      const agingBoost = (waitTimeMs / 1000) * this.policy.agingBoostPerSecond
      const effectivePriorityScore = Number(
        (waiter.basePriorityScore + agingBoost + (isStarved ? 100 : 0)).toFixed(3),
      )

      const activeForBranch = branchActiveCounts.get(waiter.branchId) ?? 0
      const fairSharePenalty =
        enforceFairShare && !isStarved && activeForBranch >= branchCap ? 1 : 0

      const entry: ExecutionQueueEntry = {
        entryId: waiter.entryId,
        taskId: waiter.taskId,
        branchId: waiter.branchId,
        priority: waiter.priority,
        basePriorityScore: waiter.basePriorityScore,
        effectivePriorityScore,
        estimatedTokens: waiter.estimatedTokens,
        enqueuedAtMs: waiter.enqueuedAtMs,
        waitTimeMs,
        starvationPromoted: waiter.starvationPromoted,
      }

      return { waiter, entry, fairSharePenalty, activeForBranch }
    })

    scored.sort((a, b) => {
      if (a.fairSharePenalty !== b.fairSharePenalty) {
        return a.fairSharePenalty - b.fairSharePenalty
      }
      if (b.entry.effectivePriorityScore !== a.entry.effectivePriorityScore) {
        return b.entry.effectivePriorityScore - a.entry.effectivePriorityScore
      }
      if (enforceFairShare && a.activeForBranch !== b.activeForBranch) {
        return a.activeForBranch - b.activeForBranch
      }
      return a.entry.enqueuedAtMs - b.entry.enqueuedAtMs
    })

    return scored
  }

  private computeCapacity(
    probe: ResourceProbeSample,
    tokensUsed: number,
  ): { readonly effectiveMaxSlots: number; readonly scalingState: ScalingState } {
    if (!this.policy.enableDynamicScaling) {
      return {
        effectiveMaxSlots: this.policy.maxConcurrentSlots,
        scalingState:
          tokensUsed >= this.policy.tokenRateLimitPerMinute ? 'THROTTLED_TOKENS' : 'NOMINAL',
      }
    }

    let limit = this.policy.maxConcurrentSlots
    let state: ScalingState = 'NOMINAL'

    if (probe.memoryRssBytes > this.policy.maxMemoryRssBytes) {
      limit = this.policy.minConcurrentSlots
      state = 'SCALED_DOWN_MEMORY'
    } else if (probe.memoryRssBytes > this.policy.maxMemoryRssBytes * 0.85) {
      limit = Math.max(this.policy.minConcurrentSlots, Math.floor(limit * 0.5))
      state = 'SCALED_DOWN_MEMORY'
    }

    if (probe.cpuLoadRatio > this.policy.maxCpuLoadRatio) {
      limit = Math.max(this.policy.minConcurrentSlots, Math.floor(limit * 0.5))
      if (state === 'NOMINAL') {
        state = 'SCALED_DOWN_CPU'
      }
    }

    if (tokensUsed >= this.policy.tokenRateLimitPerMinute && state === 'NOMINAL') {
      state = 'THROTTLED_TOKENS'
    }

    return { effectiveMaxSlots: limit, scalingState: state }
  }

  private computeBranchActiveCounts(): Map<string, number> {
    const counts = new Map<string, number>()
    for (const slot of this.activeSlots.values()) {
      counts.set(slot.branchId, (counts.get(slot.branchId) ?? 0) + 1)
    }
    return counts
  }

  private pruneTokenWindow(now: number): void {
    const cutoff = now - TOKEN_WINDOW_MS
    while (this.tokenWindow.length > 0) {
      const oldest = this.tokenWindow[0]
      if (!oldest || oldest.timestampMs > cutoff) {
        break
      }
      this.tokenWindow.shift()
    }
  }

  private getTokensInWindow(now: number): number {
    this.pruneTokenWindow(now)
    let sum = 0
    for (const sample of this.tokenWindow) {
      sum += sample.tokens
    }
    return sum
  }

  private scheduleTokenRefill(now: number): void {
    const oldest = this.tokenWindow[0]
    if (!oldest || this.tokenRefillTimer) {
      return
    }
    const waitMs = Math.max(10, oldest.timestampMs + TOKEN_WINDOW_MS - now)
    this.tokenRefillTimer = setTimeout(() => {
      this.tokenRefillTimer = undefined
      this.dispatch(this.clock())
    }, waitMs)
    this.tokenRefillTimer.unref()
  }

  private clearTokenRefillTimer(): void {
    if (this.tokenRefillTimer) {
      clearTimeout(this.tokenRefillTimer)
      this.tokenRefillTimer = undefined
    }
  }

  private checkDrainComplete(): void {
    if (!this.draining) {
      return
    }
    if (this.activeSlots.size === 0 && this.waitQueue.length === 0) {
      this.clearTokenRefillTimer()
      this.drained = true
      while (this.drainWaiters.length > 0) {
        const resolve = this.drainWaiters.shift()
        resolve?.()
      }
    }
  }
}
