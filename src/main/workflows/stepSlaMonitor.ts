/**
 * WORK-026: Workflow Step Execution Duration SLA Monitor & Deadline Breach Supervisor
 *
 * Tracks individual workflow step execution durations against defined SLA baselines
 * and historical moving averages, alerting on approaching deadlines and triggering
 * breach supervisors before runaway executions deplete workflow budgets.
 *
 * Conforms to Forge Axioms:
 * - A1: Fail-closed evaluation and zero `any`.
 * - A5: Bounded step execution durations and budget monitoring.
 */

export type StepSlaStatus = 'nominal' | 'warning' | 'breached'

export interface StepSlaConfig {
  readonly targetDurationMs: number
  readonly warnThresholdRatio?: number | undefined
  readonly hardTimeoutMs?: number | undefined
}

export interface StepSlaReport {
  readonly stepId: string
  readonly status: StepSlaStatus
  readonly elapsedMs: number
  readonly targetDurationMs: number
  readonly percentConsumed: number
  readonly movingAverageMs?: number | undefined
  readonly isOverdue: boolean
  readonly formattedSummary: string
}

/**
 * Computes moving average duration from historical execution duration samples.
 */
export function calculateMovingAverage(samples: readonly number[]): number {
  if (samples.length === 0) {
    return 0
  }
  const sum = samples.reduce((acc, val) => acc + val, 0)
  return Math.round(sum / samples.length)
}

/**
 * Evaluates execution elapsed time against step SLA thresholds and historical performance.
 */
export function evaluateStepSla(
  stepId: string,
  elapsedMs: number,
  config: StepSlaConfig,
  historySamples?: readonly number[],
): StepSlaReport {
  const targetDurationMs = Math.max(1, config.targetDurationMs)
  const warnRatio = config.warnThresholdRatio ?? 0.8
  const warnThresholdMs = targetDurationMs * warnRatio

  const percentConsumed = Math.round((elapsedMs / targetDurationMs) * 100)
  const isOverdue = elapsedMs > targetDurationMs

  let status: StepSlaStatus = 'nominal'
  if (isOverdue) {
    status = 'breached'
  } else if (elapsedMs >= warnThresholdMs) {
    status = 'warning'
  }

  const movingAverageMs =
    historySamples && historySamples.length > 0 ? calculateMovingAverage(historySamples) : undefined

  const historyContext =
    movingAverageMs !== undefined ? ` | Historical Avg: ${String(movingAverageMs)}ms` : ''

  const formattedSummary =
    `[Step SLA ${status.toUpperCase()}] Step '${stepId}' elapsed: ${String(elapsedMs)}ms / ` +
    `${String(targetDurationMs)}ms (${String(percentConsumed)}%)${historyContext}`

  return {
    stepId,
    status,
    elapsedMs,
    targetDurationMs,
    percentConsumed,
    ...(movingAverageMs !== undefined ? { movingAverageMs } : {}),
    isOverdue,
    formattedSummary,
  }
}
