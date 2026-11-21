/**
 * WORK-024: Workflow step precondition evaluator and dynamic skip strategy.
 * Evaluates preflight predicates before step execution, allowing clean skipping instead of abrupt pipeline crashes (Axioms A1, A4).
 */

export interface StepPrecondition {
  readonly requiredArtifacts?: readonly string[] | undefined
  readonly requiredEnv?: readonly string[] | undefined
  readonly requiredPriorStages?: Readonly<Record<string, 'success' | 'skipped'>> | undefined
  readonly predicateExpression?: string | undefined
}

export interface StageExecutionRecord {
  readonly status: 'success' | 'failure' | 'skipped' | 'halted'
  readonly exitCode?: number | undefined
}

export interface PreconditionEvaluationContext {
  readonly existingArtifacts?: readonly string[] | undefined
  readonly environment?: Readonly<Record<string, string>> | undefined
  readonly completedStages?: Readonly<Record<string, StageExecutionRecord>> | undefined
  readonly variables?: Readonly<Record<string, unknown>> | undefined
}

export interface PreconditionResult {
  readonly pass: boolean
  readonly shouldSkip: boolean
  readonly skipReason?: string | undefined
  readonly missingArtifacts: readonly string[]
  readonly missingEnv: readonly string[]
  readonly unmetStages: readonly string[]
  readonly formattedSummary: string
}

/**
 * Safely evaluates simple boolean predicate expressions without eval/Function.
 * Supports basic comparisons: <key> == <val>, <key> != <val>, <key> === true, etc.
 */
function evaluatePredicateExpression(
  expr: string,
  variables: Readonly<Record<string, unknown>> = {},
): boolean {
  const trimmed = expr.trim()
  if (!trimmed) return true

  // Boolean literals
  if (trimmed === 'true') return true
  if (trimmed === 'false') return false

  // Equality comparison: left == right or left === right
  const eqMatch = /^([a-zA-Z0-9_$.]+)\s*==={0,1}\s*([^=]+)$/.exec(trimmed)
  if (eqMatch) {
    const rawKey = eqMatch[1]?.trim() ?? ''
    const rawExpected = eqMatch[2]?.trim().replace(/^['"]|['"]$/g, '') ?? ''

    const actualVal = resolveNestedValue(variables, rawKey)
    return String(actualVal) === rawExpected
  }

  // Inequality comparison: left != right or left !== right
  const neMatch = /^([a-zA-Z0-9_$.]+)\s*!=={0,1}\s*([^=]+)$/.exec(trimmed)
  if (neMatch) {
    const rawKey = neMatch[1]?.trim() ?? ''
    const rawExpected = neMatch[2]?.trim().replace(/^['"]|['"]$/g, '') ?? ''

    const actualVal = resolveNestedValue(variables, rawKey)
    return String(actualVal) !== rawExpected
  }

  // Truthy variable check: key alone
  const val = resolveNestedValue(variables, trimmed)
  return Boolean(val)
}

function resolveNestedValue(obj: Readonly<Record<string, unknown>>, path: string): unknown {
  const parts = path.split('.')
  let current: unknown = obj

  for (const part of parts) {
    if (current && typeof current === 'object' && part in current) {
      current = (current as Record<string, unknown>)[part]
    } else {
      return undefined
    }
  }

  return current
}

/**
 * Evaluates step preconditions against the current execution environment and state.
 */
export function evaluateStepPreconditions(
  preconditions: StepPrecondition,
  context: PreconditionEvaluationContext = {},
): PreconditionResult {
  const missingArtifacts: string[] = []
  const missingEnv: string[] = []
  const unmetStages: string[] = []

  const existingArtifactsSet = new Set(context.existingArtifacts ?? [])
  const env = context.environment ?? process.env
  const completedStages = context.completedStages ?? {}

  // 1. Check required artifacts
  if (preconditions.requiredArtifacts) {
    for (const art of preconditions.requiredArtifacts) {
      if (!existingArtifactsSet.has(art)) {
        missingArtifacts.push(art)
      }
    }
  }

  // 2. Check required environment variables
  if (preconditions.requiredEnv) {
    for (const envKey of preconditions.requiredEnv) {
      const val = env[envKey]
      if (val === undefined || val === '') {
        missingEnv.push(envKey)
      }
    }
  }

  // 3. Check prior stage statuses
  if (preconditions.requiredPriorStages) {
    for (const [stageName, requiredStatus] of Object.entries(preconditions.requiredPriorStages)) {
      const stageRecord = completedStages[stageName]
      if (stageRecord?.status !== requiredStatus) {
        unmetStages.push(
          `${stageName} (expected "${requiredStatus}", found "${stageRecord?.status ?? 'unexecuted'}")`,
        )
      }
    }
  }

  // 4. Check expression predicate
  let predicateSatisfied = true
  let predicateFailureReason: string | undefined

  if (preconditions.predicateExpression) {
    try {
      predicateSatisfied = evaluatePredicateExpression(
        preconditions.predicateExpression,
        context.variables ?? {},
      )
      if (!predicateSatisfied) {
        predicateFailureReason = `Predicate expression "${preconditions.predicateExpression}" evaluated to false.`
      }
    } catch (err) {
      predicateSatisfied = false
      predicateFailureReason = `Predicate evaluation error: ${err instanceof Error ? err.message : String(err)}`
    }
  }

  // Determine overall pass or skip
  const hasFailures =
    missingArtifacts.length > 0 ||
    missingEnv.length > 0 ||
    unmetStages.length > 0 ||
    !predicateSatisfied

  if (!hasFailures) {
    return {
      pass: true,
      shouldSkip: false,
      missingArtifacts: [],
      missingEnv: [],
      unmetStages: [],
      formattedSummary: '✓ [PRECONDITIONS PASSED] All step execution preflight criteria satisfied.',
    }
  }

  const reasons: string[] = []
  if (missingArtifacts.length > 0) {
    reasons.push(`Missing required artifacts: ${missingArtifacts.join(', ')}`)
  }
  if (missingEnv.length > 0) {
    reasons.push(`Missing environment variables: ${missingEnv.join(', ')}`)
  }
  if (unmetStages.length > 0) {
    reasons.push(`Unmet prior stage dependencies: ${unmetStages.join('; ')}`)
  }
  if (predicateFailureReason) {
    reasons.push(predicateFailureReason)
  }

  const skipReason = reasons.join(' | ')

  return {
    pass: false,
    shouldSkip: true,
    skipReason,
    missingArtifacts,
    missingEnv,
    unmetStages,
    formattedSummary: `⏭ [STEP SKIPPED] ${skipReason}`,
  }
}
