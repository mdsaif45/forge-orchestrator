export interface ResourceBudgetConfig {
  /** Maximum Resident Set Size in bytes (default: 1 GB = 1073741824 bytes). */
  readonly maxRssBytes: number
  /** Maximum V8 heap size in megabytes (default: 512 MB). */
  readonly maxHeapMb: number
  /** Maximum execution duration in milliseconds (default: 300,000 ms = 5 minutes). */
  readonly maxDurationMs: number
  /** Memory warning threshold percentage (0.0 to 1.0, default: 0.85). */
  readonly warningThresholdRatio: number
}

export interface ProcessResourceSample {
  readonly pid: number
  readonly rssBytes: number
  readonly heapUsedBytes?: number | undefined
  readonly elapsedMs: number
}

export type ResourceAction = 'none' | 'warn' | 'terminate' | 'kill'

export interface ResourceEvaluationResult {
  readonly action: ResourceAction
  readonly exceededRss: boolean
  readonly exceededDuration: boolean
  readonly isWarning: boolean
  readonly reason?: string | undefined
  readonly details: {
    readonly rssMb: number
    readonly maxRssMb: number
    readonly elapsedSec: number
    readonly maxDurationSec: number
  }
}

export interface RuntimeQuotaAuditReport {
  readonly valid: boolean
  readonly budget: ResourceBudgetConfig
  readonly memoryFlags: readonly string[]
  readonly formattedSummary: string
}

export const DEFAULT_RESOURCE_BUDGET: ResourceBudgetConfig = {
  maxRssBytes: 1024 * 1024 * 1024, // 1 GB
  maxHeapMb: 512, // 512 MB
  maxDurationMs: 5 * 60 * 1000, // 5 minutes
  warningThresholdRatio: 0.85,
}

/**
 * Creates a validated resource budget configuration, applying defaults for unspecified fields.
 */
export function createResourceBudget(
  overrides?: Partial<ResourceBudgetConfig>,
): ResourceBudgetConfig {
  return {
    maxRssBytes: Math.max(
      overrides?.maxRssBytes ?? DEFAULT_RESOURCE_BUDGET.maxRssBytes,
      64 * 1024 * 1024,
    ),
    maxHeapMb: Math.max(overrides?.maxHeapMb ?? DEFAULT_RESOURCE_BUDGET.maxHeapMb, 32),
    maxDurationMs: Math.max(
      overrides?.maxDurationMs ?? DEFAULT_RESOURCE_BUDGET.maxDurationMs,
      1000,
    ),
    warningThresholdRatio: Math.min(
      Math.max(
        overrides?.warningThresholdRatio ?? DEFAULT_RESOURCE_BUDGET.warningThresholdRatio,
        0.5,
      ),
      0.95,
    ),
  }
}

/**
 * Generates runtime memory constraint flags (such as V8 --max-old-space-size) based on configured budget.
 */
export function generateMemoryFlags(budget: ResourceBudgetConfig): string[] {
  return [`--max-old-space-size=${String(budget.maxHeapMb)}`]
}

/**
 * Evaluates a point-in-time process resource usage sample against configured budget quotas (Axiom A5, A7).
 */
export function evaluateProcessSample(
  budget: ResourceBudgetConfig,
  sample: ProcessResourceSample,
): ResourceEvaluationResult {
  const rssMb = Math.round((sample.rssBytes / (1024 * 1024)) * 100) / 100
  const maxRssMb = Math.round((budget.maxRssBytes / (1024 * 1024)) * 100) / 100
  const elapsedSec = Math.round((sample.elapsedMs / 1000) * 10) / 10
  const maxDurationSec = Math.round(budget.maxDurationMs / 1000)

  const exceededRss = sample.rssBytes > budget.maxRssBytes
  const exceededDuration = sample.elapsedMs > budget.maxDurationMs
  const isWarning =
    !exceededRss &&
    !exceededDuration &&
    (sample.rssBytes >= budget.maxRssBytes * budget.warningThresholdRatio ||
      sample.elapsedMs >= budget.maxDurationMs * budget.warningThresholdRatio)

  let action: ResourceAction = 'none'
  let reason: string | undefined

  if (exceededRss) {
    action = 'terminate'
    reason = `Process RSS memory (${String(rssMb)} MB) exceeded ceiling (${String(maxRssMb)} MB)`
  } else if (exceededDuration) {
    action = 'terminate'
    reason = `Process execution duration (${String(elapsedSec)}s) exceeded timeout budget (${String(maxDurationSec)}s)`
  } else if (isWarning) {
    action = 'warn'
    reason = `Process approaching resource budget ceiling: RSS=${String(rssMb)} MB, elapsed=${String(elapsedSec)}s`
  }

  return {
    action,
    exceededRss,
    exceededDuration,
    isWarning,
    reason,
    details: {
      rssMb,
      maxRssMb,
      elapsedSec,
      maxDurationSec,
    },
  }
}

/**
 * Audits and formats active runtime resource quotas for CLI and observability inspection.
 */
export function auditRuntimeQuotas(budget: ResourceBudgetConfig): RuntimeQuotaAuditReport {
  const flags = generateMemoryFlags(budget)
  const maxRssMb = Math.round(budget.maxRssBytes / (1024 * 1024))
  const maxSec = Math.round(budget.maxDurationMs / 1000)

  const lines: string[] = []
  lines.push('================================================================================')
  lines.push('RUNTIME RESOURCE QUOTA SPECIFICATION')
  lines.push('================================================================================')
  lines.push(`  Max RSS Memory:      ${String(maxRssMb)} MB (${String(budget.maxRssBytes)} bytes)`)
  lines.push(`  Max V8 Heap:         ${String(budget.maxHeapMb)} MB`)
  lines.push(`  Max Duration:        ${String(maxSec)}s (${String(budget.maxDurationMs)} ms)`)
  lines.push(`  Warning Threshold:   ${String(Math.round(budget.warningThresholdRatio * 100))}%`)
  lines.push(`  Runtime Flags:       ${flags.join(' ')}`)
  lines.push('================================================================================')

  return {
    valid: true,
    budget,
    memoryFlags: flags,
    formattedSummary: lines.join('\n'),
  }
}
