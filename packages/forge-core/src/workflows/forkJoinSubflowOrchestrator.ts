/**
 * WORK-027: Dynamic Fork-Join Fan-Out Subflow Orchestrator
 *
 * Implements dynamic scatter-gather parallelism for workflow stages. Partitions input item collections
 * into concurrency-bounded execution batches (fork/scatter), enforces fault-tolerance policies,
 * and synthesizes child subflow outcomes into a consolidated stage state (join/gather).
 *
 * Conforms to Forge Axioms:
 * - A1: Fail-closed error handling and zero `any`.
 * - A4: Deterministic and reproducible result aggregation.
 * - A5: Strictly bounded concurrency and batch partitioning.
 */

export type ForkJoinTolerancePolicy = 'all_or_nothing' | 'best_effort'

export interface ForkJoinTaskSpec<T = unknown> {
  readonly taskId: string
  readonly itemIndex: number
  readonly input: T
  readonly taskName?: string | undefined
}

export interface ForkJoinBatchPlan<T = unknown> {
  readonly batchIndex: number
  readonly tasks: readonly ForkJoinTaskSpec<T>[]
}

export interface ForkJoinExecutionPlan<T = unknown> {
  readonly totalTasks: number
  readonly batchCount: number
  readonly maxConcurrency: number
  readonly batches: readonly ForkJoinBatchPlan<T>[]
  readonly formattedSummary: string
}

export interface ForkJoinPlanningOptions {
  readonly maxConcurrency?: number | undefined
  readonly maxTotalTasks?: number | undefined
  readonly taskPrefix?: string | undefined
}

export interface ForkJoinTaskOutcome {
  readonly taskId: string
  readonly itemIndex: number
  readonly status: 'completed' | 'failed' | 'skipped'
  readonly output?: unknown
  readonly error?: string | undefined
  readonly durationMs: number
}

export interface ForkJoinAggregateReport {
  readonly totalTasks: number
  readonly completedCount: number
  readonly failedCount: number
  readonly skippedCount: number
  readonly success: boolean
  readonly policy: ForkJoinTolerancePolicy
  readonly totalDurationMs: number
  readonly results: readonly ForkJoinTaskOutcome[]
  readonly formattedSummary: string
}

/**
 * Partitions items into bounded concurrency batches for parallel subflow dispatch.
 */
export function planForkJoinBatches<T>(
  items: readonly T[],
  options?: ForkJoinPlanningOptions,
): ForkJoinExecutionPlan<T> {
  const maxConcurrency = Math.max(1, Math.min(16, options?.maxConcurrency ?? 4))
  const maxTotalTasks = Math.max(1, Math.min(100, options?.maxTotalTasks ?? 50))
  const prefix = options?.taskPrefix ?? 'subflow'

  const totalToSchedule = Math.min(items.length, maxTotalTasks)
  const tasks: ForkJoinTaskSpec<T>[] = []

  for (let i = 0; i < totalToSchedule; i++) {
    const item = items[i] as T
    tasks.push({
      taskId: `${prefix}-${String(i + 1)}`,
      itemIndex: i,
      input: item,
      taskName: `${prefix} item #${String(i + 1)}`,
    })
  }

  const batches: ForkJoinBatchPlan<T>[] = []
  let batchIndex = 0

  for (let i = 0; i < tasks.length; i += maxConcurrency) {
    const batchTasks = tasks.slice(i, i + maxConcurrency)
    batches.push({
      batchIndex,
      tasks: batchTasks,
    })
    batchIndex++
  }

  const formattedSummary =
    `[Fork-Join Plan] Created ${String(tasks.length)} tasks across ${String(batches.length)} ` +
    `batches (Max Concurrency: ${String(maxConcurrency)})`

  return {
    totalTasks: tasks.length,
    batchCount: batches.length,
    maxConcurrency,
    batches,
    formattedSummary,
  }
}

/**
 * Gathers and aggregates executed subflow outcomes according to tolerance policy.
 */
export function aggregateForkJoinOutcomes(
  outcomes: readonly ForkJoinTaskOutcome[],
  policy: ForkJoinTolerancePolicy = 'all_or_nothing',
): ForkJoinAggregateReport {
  let completedCount = 0
  let failedCount = 0
  let skippedCount = 0
  let totalDurationMs = 0

  for (const outcome of outcomes) {
    totalDurationMs += outcome.durationMs
    if (outcome.status === 'completed') {
      completedCount++
    } else if (outcome.status === 'failed') {
      failedCount++
    } else {
      skippedCount++
    }
  }

  const success =
    policy === 'all_or_nothing' ? failedCount === 0 && outcomes.length > 0 : completedCount > 0

  const formattedSummary =
    `[Fork-Join Aggregate] Policy: ${policy.toUpperCase()} | Success: ${success ? 'YES' : 'NO'} ` +
    `| Completed: ${String(completedCount)} | Failed: ${String(failedCount)} | Skipped: ${String(skippedCount)} ` +
    `| Total Wall-Clock: ${String(totalDurationMs)}ms`

  return {
    totalTasks: outcomes.length,
    completedCount,
    failedCount,
    skippedCount,
    success,
    policy,
    totalDurationMs,
    results: outcomes,
    formattedSummary,
  }
}
