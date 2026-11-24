/**
 * AGENT-020: Tool Invocation Speculative Prefetch & Execution Pipeline Scheduler
 *
 * Analyzes planned agent steps, detects candidate read-only idempotent tool calls whose
 * parameters are known in advance, and constructs a speculative background prefetch schedule
 * to eliminate sequential execution latency.
 *
 * Conforms to Forge Axioms:
 * - A1: Fail-closed safety and zero `any`.
 * - A5: Bounded prefetch concurrency and candidate count.
 * - A6: Provider-neutral tool scheduling.
 * - A7: Strict least privilege barrier — only safe read-only tools may be prefetched.
 */

import { createHash } from 'node:crypto'

export interface PlannedToolStep {
  readonly stepId: string
  readonly toolName: string
  readonly args: Record<string, unknown>
  readonly dependsOn?: readonly string[] | undefined
  readonly estimatedDurationMs?: number | undefined
}

export interface PrefetchCandidate {
  readonly stepId: string
  readonly toolName: string
  readonly args: Record<string, unknown>
  readonly cacheKey: string
  readonly reason: string
  readonly estimatedDurationMs: number
}

export interface PrefetchSchedulerOptions {
  readonly maxConcurrency?: number | undefined
  readonly maxPrefetches?: number | undefined
  readonly customSafeTools?: readonly string[] | undefined
  readonly defaultStepDurationMs?: number | undefined
}

export interface PrefetchScheduleReport {
  readonly totalPlannedSteps: number
  readonly candidateCount: number
  readonly rejectedCount: number
  readonly candidates: readonly PrefetchCandidate[]
  readonly rejectedReasons: readonly { readonly stepId: string; readonly reason: string }[]
  readonly concurrency: number
  readonly estimatedTimeSavedMs: number
  readonly formattedSummary: string
}

export const DEFAULT_SAFE_PREFETCH_TOOLS = new Set<string>([
  'read_file',
  'git_status',
  'git_diff',
  'git_log',
  'grep',
  'glob',
  'list_dir',
  'file_stat',
  'inspect_ast',
  'fetch_doc',
])

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Deterministically computes a unique cache key for a tool call.
 */
export function computePrefetchKey(toolName: string, args: Record<string, unknown>): string {
  const canonicalArgs = JSON.stringify(args, Object.keys(args).sort())
  return `prefetch:${toolName}:${sha256(canonicalArgs).slice(0, 16)}`
}

/**
 * Checks whether an argument object contains unresolved dynamic placeholder tokens.
 */
function hasDynamicPlaceholders(val: unknown): boolean {
  if (typeof val === 'string') {
    return val.startsWith('$') || val.includes('{{') || val.includes('<pending>')
  }
  if (typeof val === 'object' && val !== null) {
    return Object.values(val as Record<string, unknown>).some(hasDynamicPlaceholders)
  }
  return false
}

/**
 * Analyzes planned tool steps and schedules speculative read-only prefetches.
 */
export function scheduleSpeculativePrefetch(
  plannedSteps: readonly PlannedToolStep[],
  options?: PrefetchSchedulerOptions,
): PrefetchScheduleReport {
  const maxConcurrency = Math.max(1, Math.min(8, options?.maxConcurrency ?? 4))
  const maxPrefetches = Math.max(1, Math.min(16, options?.maxPrefetches ?? 6))
  const defaultDurationMs = options?.defaultStepDurationMs ?? 250

  const safeTools = new Set<string>(options?.customSafeTools ?? DEFAULT_SAFE_PREFETCH_TOOLS)
  const candidates: PrefetchCandidate[] = []
  const rejectedReasons: { stepId: string; reason: string }[] = []

  for (const step of plannedSteps) {
    if (candidates.length >= maxPrefetches) {
      rejectedReasons.push({
        stepId: step.stepId,
        reason: `Exceeded max prefetch quota (${String(maxPrefetches)})`,
      })
      continue
    }

    if (!safeTools.has(step.toolName)) {
      rejectedReasons.push({
        stepId: step.stepId,
        reason: `Tool '${step.toolName}' is not in safe read-only prefetch whitelist (Axiom A7)`,
      })
      continue
    }

    if (step.dependsOn && step.dependsOn.length > 0) {
      rejectedReasons.push({
        stepId: step.stepId,
        reason: `Step has unresolved dependencies: [${step.dependsOn.join(', ')}]`,
      })
      continue
    }

    if (hasDynamicPlaceholders(step.args)) {
      rejectedReasons.push({
        stepId: step.stepId,
        reason: 'Step arguments contain unresolved dynamic variable references',
      })
      continue
    }

    const duration = step.estimatedDurationMs ?? defaultDurationMs
    const cacheKey = computePrefetchKey(step.toolName, step.args)

    candidates.push({
      stepId: step.stepId,
      toolName: step.toolName,
      args: step.args,
      cacheKey,
      reason: 'Idempotent read-only tool with resolved static arguments',
      estimatedDurationMs: duration,
    })
  }

  // Calculate estimated time saved: sum of candidate durations minus parallel overlapped duration
  const totalDuration = candidates.reduce((acc, c) => acc + c.estimatedDurationMs, 0)
  const parallelDuration =
    candidates.length > 0
      ? Math.ceil(totalDuration / Math.min(candidates.length, maxConcurrency))
      : 0
  const estimatedTimeSavedMs = Math.max(0, totalDuration - parallelDuration)

  const formattedSummary =
    `[Speculative Prefetch] Scheduled ${String(candidates.length)}/${String(plannedSteps.length)} candidates ` +
    `| Est. Saved: ${String(estimatedTimeSavedMs)}ms (Concurrency: ${String(maxConcurrency)})`

  return {
    totalPlannedSteps: plannedSteps.length,
    candidateCount: candidates.length,
    rejectedCount: rejectedReasons.length,
    candidates,
    rejectedReasons,
    concurrency: maxConcurrency,
    estimatedTimeSavedMs,
    formattedSummary,
  }
}
