/**
 * Workflow step dynamic fan-in barrier and multi-branch result aggregator.
 *
 * Synchronizes parallel execution branches following dynamic fan-out, evaluates
 * completion policies (ALL, QUORUM, FIRST_SUCCESS, FAIL_FAST), aggregates heterogeneous
 * payloads, and enforces fail-closed error handling (A1, A4).
 */

export type FanInPolicy = 'ALL' | 'QUORUM' | 'FIRST_SUCCESS' | 'FAIL_FAST'
export type FanInBarrierStatus = 'PENDING' | 'SATISFIED' | 'ABORTED' | 'TIMED_OUT'

export interface BranchExecutionResult {
  readonly branchId: string
  readonly status: 'SUCCESS' | 'FAILED'
  readonly outputPayload?: unknown
  readonly error?: string | undefined
  readonly durationMs: number
}

export interface FanInAggregationReport {
  readonly barrierId: string
  readonly stepId: string
  readonly policy: FanInPolicy
  readonly totalBranches: number
  readonly completedCount: number
  readonly successfulCount: number
  readonly failedCount: number
  readonly status: FanInBarrierStatus
  readonly aggregatedPayload: Record<string, unknown>
  readonly errors: readonly string[]
  readonly decisionReason: string
}

export interface AggregatorConfig {
  /** Default timeout in ms before barrier times out. Defaults to 30000ms. */
  readonly defaultTimeoutMs?: number | undefined
  /** Minimum fraction of successful branches required for QUORUM. Defaults to 0.5. */
  readonly quorumRatio?: number | undefined
}

interface BarrierInternalState {
  readonly barrierId: string
  readonly stepId: string
  readonly policy: FanInPolicy
  readonly expectedBranchIds: Set<string>
  readonly results: Map<string, BranchExecutionResult>
  readonly createdAt: number
  readonly expiresAt: number
  status: FanInBarrierStatus
  decisionReason: string
}

export class WorkflowStepDynamicFanInAggregator {
  private readonly defaultTimeoutMs: number
  private readonly quorumRatio: number
  private readonly barriers = new Map<string, BarrierInternalState>()
  private counter = 0

  constructor(config: AggregatorConfig = {}) {
    this.defaultTimeoutMs = Math.max(10, config.defaultTimeoutMs ?? 30_000)
    this.quorumRatio = Math.max(0.1, Math.min(1.0, config.quorumRatio ?? 0.5))
  }

  /**
   * Initializes a new synchronization barrier for a step and its expected branches.
   */
  createBarrier(
    stepId: string,
    expectedBranchIds: readonly string[],
    policy: FanInPolicy = 'ALL',
    timeoutMs?: number,
  ): FanInAggregationReport {
    if (!stepId || stepId.trim().length === 0) {
      throw new Error('stepId cannot be empty')
    }
    if (expectedBranchIds.length === 0) {
      throw new Error('expectedBranchIds cannot be empty')
    }

    this.counter += 1
    const barrierId = `fanin-${stepId}-${String(Date.now())}-${String(this.counter)}`
    const effectiveTimeout = Math.max(10, timeoutMs ?? this.defaultTimeoutMs)
    const createdAt = Date.now()

    const barrier: BarrierInternalState = {
      barrierId,
      stepId,
      policy,
      expectedBranchIds: new Set(expectedBranchIds),
      results: new Map(),
      createdAt,
      expiresAt: createdAt + effectiveTimeout,
      status: 'PENDING',
      decisionReason: 'Awaiting branch execution results.',
    }

    this.barriers.set(barrierId, barrier)
    return this.buildReport(barrier)
  }

  /**
   * Registers a branch execution result and re-evaluates the barrier status.
   */
  registerBranchResult(barrierId: string, result: BranchExecutionResult): FanInAggregationReport {
    const barrier = this.barriers.get(barrierId)
    if (!barrier) {
      throw new Error(`Barrier not found: ${barrierId}`)
    }

    if (!barrier.expectedBranchIds.has(result.branchId)) {
      throw new Error(`Branch '${result.branchId}' is not registered in barrier '${barrierId}'.`)
    }

    this.evaluateExpiration(barrier)
    if (barrier.status !== 'PENDING') {
      return this.buildReport(barrier)
    }

    barrier.results.set(result.branchId, result)
    return this.evaluateBarrierState(barrier)
  }

  /**
   * Aborts an active barrier with a specified reason.
   */
  abortBarrier(barrierId: string, reason: string): FanInAggregationReport {
    const barrier = this.barriers.get(barrierId)
    if (!barrier) {
      throw new Error(`Barrier not found: ${barrierId}`)
    }

    if (barrier.status === 'SATISFIED') {
      throw new Error(`Cannot abort already SATISFIED barrier '${barrierId}'.`)
    }

    barrier.status = 'ABORTED'
    barrier.decisionReason = reason
    return this.buildReport(barrier)
  }

  /**
   * Evaluates the current state of a barrier, checking for timeouts.
   */
  evaluateBarrier(barrierId: string, now: number = Date.now()): FanInAggregationReport {
    const barrier = this.barriers.get(barrierId)
    if (!barrier) {
      throw new Error(`Barrier not found: ${barrierId}`)
    }

    this.evaluateExpiration(barrier, now)
    if (barrier.status === 'PENDING') {
      return this.evaluateBarrierState(barrier)
    }
    return this.buildReport(barrier)
  }

  /**
   * Retrieves a barrier report by ID.
   */
  getBarrier(barrierId: string): FanInAggregationReport | undefined {
    const barrier = this.barriers.get(barrierId)
    if (!barrier) return undefined
    this.evaluateExpiration(barrier)
    return this.buildReport(barrier)
  }

  /**
   * Lists all active or completed barriers.
   */
  listBarriers(): readonly FanInAggregationReport[] {
    const list: FanInAggregationReport[] = []
    for (const barrier of this.barriers.values()) {
      this.evaluateExpiration(barrier)
      list.push(this.buildReport(barrier))
    }
    return list
  }

  private evaluateExpiration(barrier: BarrierInternalState, now: number = Date.now()): void {
    if (barrier.status === 'PENDING' && now > barrier.expiresAt) {
      barrier.status = 'TIMED_OUT'
      barrier.decisionReason = `Barrier expired at ${String(barrier.expiresAt)} ms before completion.`
    }
  }

  private evaluateBarrierState(barrier: BarrierInternalState): FanInAggregationReport {
    if (barrier.status !== 'PENDING') {
      return this.buildReport(barrier)
    }

    const total = barrier.expectedBranchIds.size
    const completed = barrier.results.size
    let successCount = 0
    let failedCount = 0

    for (const r of barrier.results.values()) {
      if (r.status === 'SUCCESS') successCount += 1
      else failedCount += 1
    }

    switch (barrier.policy) {
      case 'FAIL_FAST': {
        if (failedCount > 0) {
          barrier.status = 'ABORTED'
          barrier.decisionReason = `Fail-fast triggered by failure in branch.`
        } else if (successCount === total) {
          barrier.status = 'SATISFIED'
          barrier.decisionReason = 'All branches succeeded.'
        }
        break
      }

      case 'FIRST_SUCCESS': {
        if (successCount >= 1) {
          barrier.status = 'SATISFIED'
          barrier.decisionReason = 'First success branch achieved.'
        } else if (completed === total) {
          barrier.status = 'ABORTED'
          barrier.decisionReason = 'All branches completed with zero successes.'
        }
        break
      }

      case 'QUORUM': {
        const requiredQuorum = Math.ceil(total * this.quorumRatio)
        if (successCount >= requiredQuorum) {
          barrier.status = 'SATISFIED'
          barrier.decisionReason = `Quorum met (${String(successCount)}/${String(total)} branches succeeded, required: ${String(requiredQuorum)}).`
        } else if (completed === total) {
          barrier.status = 'ABORTED'
          barrier.decisionReason = `Quorum failed (${String(successCount)}/${String(total)} succeeded, required: ${String(requiredQuorum)}).`
        }
        break
      }

      case 'ALL':
      default: {
        if (successCount === total) {
          barrier.status = 'SATISFIED'
          barrier.decisionReason = `All ${String(total)} branches succeeded.`
        } else if (failedCount > 0 && completed === total) {
          barrier.status = 'ABORTED'
          barrier.decisionReason = `${String(failedCount)} branch(es) failed out of ${String(total)}.`
        }
        break
      }
    }

    return this.buildReport(barrier)
  }

  private buildReport(barrier: BarrierInternalState): FanInAggregationReport {
    const totalBranches = barrier.expectedBranchIds.size
    const completedCount = barrier.results.size
    let successfulCount = 0
    let failedCount = 0
    const aggregatedPayload: Record<string, unknown> = {}
    const errors: string[] = []

    for (const [branchId, res] of barrier.results.entries()) {
      if (res.status === 'SUCCESS') {
        successfulCount += 1
        if (res.outputPayload !== undefined) {
          aggregatedPayload[branchId] = res.outputPayload
        }
      } else {
        failedCount += 1
        if (res.error) {
          errors.push(`[${branchId}]: ${res.error}`)
        }
      }
    }

    return {
      barrierId: barrier.barrierId,
      stepId: barrier.stepId,
      policy: barrier.policy,
      totalBranches,
      completedCount,
      successfulCount,
      failedCount,
      status: barrier.status,
      aggregatedPayload,
      errors,
      decisionReason: barrier.decisionReason,
    }
  }
}
