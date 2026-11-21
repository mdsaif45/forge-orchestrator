export interface StepResourceLimits {
  readonly maxMemoryRssBytes: number
  readonly maxCpuTimeMs: number
  readonly maxOutputBytes: number
  readonly maxDurationMs: number
}

export interface StepResourceUsage {
  readonly memoryRssBytes: number
  readonly cpuTimeMs: number
  readonly outputBytes: number
  readonly durationMs: number
}

export type QuotaStatus = 'WITHIN_LIMITS' | 'WARNING' | 'EXCEEDED'
export type QuotaResourceKind = 'MEMORY_RSS' | 'CPU_TIME' | 'OUTPUT_BYTES' | 'DURATION'

export interface QuotaViolation {
  readonly resource: QuotaResourceKind
  readonly limit: number
  readonly observed: number
  readonly utilizationRatio: number
}

export interface QuotaEvaluationResult {
  readonly stepId: string
  readonly status: QuotaStatus
  readonly maxUtilizationRatio: number
  readonly violations: readonly QuotaViolation[]
  readonly warnings: readonly QuotaViolation[]
  readonly shouldEvict: boolean
  readonly recommendedAction: 'CONTINUE' | 'THROTTLE' | 'EVICT'
}

export interface GovernorMetrics {
  readonly totalEvaluations: number
  readonly withinLimitsCount: number
  readonly warningCount: number
  readonly exceededCount: number
  readonly evictionCount: number
}

export interface WorkflowResourceQuotaGovernorConfig {
  readonly defaultLimits?: Partial<StepResourceLimits>
  readonly warningThresholdRatio?: number // default: 0.8 (80%)
}

export class WorkflowQuotaExceededError extends Error {
  public readonly stepId: string
  public readonly violations: readonly QuotaViolation[]

  constructor(stepId: string, violations: readonly QuotaViolation[]) {
    const details = violations
      .map(
        (v) =>
          `${v.resource}: ${String(v.observed)}/${String(v.limit)} (${(v.utilizationRatio * 100).toFixed(1)}%)`,
      )
      .join(', ')
    super(`Workflow step "${stepId}" exceeded resource quotas: ${details}`)
    this.name = 'WorkflowQuotaExceededError'
    this.stepId = stepId
    this.violations = violations
  }
}

export const DEFAULT_STEP_RESOURCE_LIMITS: StepResourceLimits = {
  maxMemoryRssBytes: 512 * 1024 * 1024, // 512 MB
  maxCpuTimeMs: 60_000, // 60s
  maxOutputBytes: 10 * 1024 * 1024, // 10 MB
  maxDurationMs: 120_000, // 120s
}

export class WorkflowResourceQuotaGovernor {
  private readonly defaultLimits: StepResourceLimits
  private readonly warningThresholdRatio: number
  private readonly stepProfiles = new Map<string, StepResourceLimits>()

  private totalEvaluations = 0
  private withinLimitsCount = 0
  private warningCount = 0
  private exceededCount = 0
  private evictionCount = 0

  constructor(config?: WorkflowResourceQuotaGovernorConfig) {
    this.defaultLimits = {
      maxMemoryRssBytes:
        config?.defaultLimits?.maxMemoryRssBytes ?? DEFAULT_STEP_RESOURCE_LIMITS.maxMemoryRssBytes,
      maxCpuTimeMs:
        config?.defaultLimits?.maxCpuTimeMs ?? DEFAULT_STEP_RESOURCE_LIMITS.maxCpuTimeMs,
      maxOutputBytes:
        config?.defaultLimits?.maxOutputBytes ?? DEFAULT_STEP_RESOURCE_LIMITS.maxOutputBytes,
      maxDurationMs:
        config?.defaultLimits?.maxDurationMs ?? DEFAULT_STEP_RESOURCE_LIMITS.maxDurationMs,
    }
    this.warningThresholdRatio = config?.warningThresholdRatio ?? 0.8
  }

  public registerStepProfile(stepId: string, limits: Partial<StepResourceLimits>): void {
    const merged: StepResourceLimits = {
      maxMemoryRssBytes: limits.maxMemoryRssBytes ?? this.defaultLimits.maxMemoryRssBytes,
      maxCpuTimeMs: limits.maxCpuTimeMs ?? this.defaultLimits.maxCpuTimeMs,
      maxOutputBytes: limits.maxOutputBytes ?? this.defaultLimits.maxOutputBytes,
      maxDurationMs: limits.maxDurationMs ?? this.defaultLimits.maxDurationMs,
    }
    this.stepProfiles.set(stepId, merged)
  }

  public getStepProfile(stepId: string): StepResourceLimits {
    return this.stepProfiles.get(stepId) ?? this.defaultLimits
  }

  public evaluateStepUsage(stepId: string, usage: StepResourceUsage): QuotaEvaluationResult {
    this.totalEvaluations++
    const limits = this.getStepProfile(stepId)

    const checks: { resource: QuotaResourceKind; observed: number; limit: number }[] = [
      { resource: 'MEMORY_RSS', observed: usage.memoryRssBytes, limit: limits.maxMemoryRssBytes },
      { resource: 'CPU_TIME', observed: usage.cpuTimeMs, limit: limits.maxCpuTimeMs },
      { resource: 'OUTPUT_BYTES', observed: usage.outputBytes, limit: limits.maxOutputBytes },
      { resource: 'DURATION', observed: usage.durationMs, limit: limits.maxDurationMs },
    ]

    const violations: QuotaViolation[] = []
    const warnings: QuotaViolation[] = []
    let maxUtilizationRatio = 0

    for (const check of checks) {
      if (check.limit <= 0) {
        continue
      }
      const ratio = check.observed / check.limit
      if (ratio > maxUtilizationRatio) {
        maxUtilizationRatio = ratio
      }

      const item: QuotaViolation = {
        resource: check.resource,
        limit: check.limit,
        observed: check.observed,
        utilizationRatio: ratio,
      }

      if (ratio >= 1.0) {
        violations.push(item)
      } else if (ratio >= this.warningThresholdRatio) {
        warnings.push(item)
      }
    }

    let status: QuotaStatus = 'WITHIN_LIMITS'
    let shouldEvict = false
    let recommendedAction: 'CONTINUE' | 'THROTTLE' | 'EVICT' = 'CONTINUE'

    if (violations.length > 0) {
      status = 'EXCEEDED'
      shouldEvict = true
      recommendedAction = 'EVICT'
      this.exceededCount++
      this.evictionCount++
    } else if (warnings.length > 0) {
      status = 'WARNING'
      shouldEvict = false
      recommendedAction = 'THROTTLE'
      this.warningCount++
    } else {
      this.withinLimitsCount++
    }

    return {
      stepId,
      status,
      maxUtilizationRatio,
      violations,
      warnings,
      shouldEvict,
      recommendedAction,
    }
  }

  public assertStepWithinLimits(stepId: string, usage: StepResourceUsage): QuotaEvaluationResult {
    const result = this.evaluateStepUsage(stepId, usage)
    if (result.status === 'EXCEEDED') {
      throw new WorkflowQuotaExceededError(stepId, result.violations)
    }
    return result
  }

  public getMetrics(): GovernorMetrics {
    return {
      totalEvaluations: this.totalEvaluations,
      withinLimitsCount: this.withinLimitsCount,
      warningCount: this.warningCount,
      exceededCount: this.exceededCount,
      evictionCount: this.evictionCount,
    }
  }

  public reset(): void {
    this.totalEvaluations = 0
    this.withinLimitsCount = 0
    this.warningCount = 0
    this.exceededCount = 0
    this.evictionCount = 0
    this.stepProfiles.clear()
  }
}
