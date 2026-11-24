/**
 * WORK-022: Workflow execution step retry policy and exponential backoff scheduler.
 * Implements deterministic, bounded step retry policies and transient error backoff (Axioms A1, A5).
 */

export type ErrorClassification = 'transient' | 'permanent' | 'unknown'

export interface StepRetryPolicy {
  readonly maxAttempts?: number | undefined
  readonly initialBackoffMs?: number | undefined
  readonly backoffMultiplier?: number | undefined
  readonly maxBackoffMs?: number | undefined
  readonly jitterRatio?: number | undefined
  readonly retryableErrorPatterns?: readonly (string | RegExp)[] | undefined
  readonly permanentErrorPatterns?: readonly (string | RegExp)[] | undefined
}

export interface RetryEvaluation {
  readonly shouldRetry: boolean
  readonly stepId: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly backoffMs: number
  readonly errorClassification: ErrorClassification
  readonly reason: string
  readonly exhausted: boolean
  readonly dispatchToDLQ: boolean
  readonly formattedSummary: string
}

export const DEFAULT_RETRYABLE_PATTERNS: readonly RegExp[] = [
  /time(d)?[\s-]?out/i,
  /rate[\s-]?limit/i,
  /429/i,
  /502|503|504/i,
  /econnreset/i,
  /econnrefused/i,
  /socket[\s-]?hang[\s-]?up/i,
  /overloaded/i,
  /temporarily[\s-]?unavailable/i,
]

export const DEFAULT_PERMANENT_PATTERNS: readonly RegExp[] = [
  /syntax[\s-]?error/i,
  /invalid[\s-]?schema/i,
  /validation[\s-]?failed/i,
  /unauthorized/i,
  /401|403/i,
  /not[\s-]?found/i,
  /type[\s-]?error/i,
]

/**
 * Calculates exponential backoff with ceiling and optional jitter.
 */
export function calculateExponentialBackoff(
  attempt: number,
  initialBackoffMs = 1000,
  backoffMultiplier = 2.0,
  maxBackoffMs = 30000,
  jitterRatio = 0.1,
): number {
  if (attempt <= 1) {
    return initialBackoffMs
  }
  const base = initialBackoffMs * Math.pow(backoffMultiplier, attempt - 1)
  const capped = Math.min(base, maxBackoffMs)
  const jitterAmount = capped * Math.min(1, Math.max(0, jitterRatio))
  // Deterministic pseudo-jitter to maintain Axiom A1 reproducibility
  const deterministicFactor = ((attempt * 37) % 100) / 100
  const jitter = (deterministicFactor * 2 - 1) * jitterAmount
  return Math.max(0, Math.round(capped + jitter))
}

/**
 * Classifies an error as transient, permanent, or unknown based on pattern matching.
 */
export function classifyStepError(
  error: unknown,
  retryablePatterns: readonly (string | RegExp)[] = DEFAULT_RETRYABLE_PATTERNS,
  permanentPatterns: readonly (string | RegExp)[] = DEFAULT_PERMANENT_PATTERNS,
): ErrorClassification {
  const message = error instanceof Error ? error.message : String(error)

  for (const pattern of permanentPatterns) {
    if (typeof pattern === 'string' && message.toLowerCase().includes(pattern.toLowerCase())) {
      return 'permanent'
    }
    if (pattern instanceof RegExp && pattern.test(message)) {
      return 'permanent'
    }
  }

  for (const pattern of retryablePatterns) {
    if (typeof pattern === 'string' && message.toLowerCase().includes(pattern.toLowerCase())) {
      return 'transient'
    }
    if (pattern instanceof RegExp && pattern.test(message)) {
      return 'transient'
    }
  }

  return 'unknown'
}

/**
 * Evaluates whether a failed workflow step should be retried under the given policy.
 */
export function evaluateStepRetry(
  stepId: string,
  attempt: number,
  error: unknown,
  policy: StepRetryPolicy = {},
): RetryEvaluation {
  const maxAttempts = policy.maxAttempts ?? 3
  const initialBackoffMs = policy.initialBackoffMs ?? 1000
  const backoffMultiplier = policy.backoffMultiplier ?? 2.0
  const maxBackoffMs = policy.maxBackoffMs ?? 30000
  const jitterRatio = policy.jitterRatio ?? 0.1

  const retryablePatterns = policy.retryableErrorPatterns ?? DEFAULT_RETRYABLE_PATTERNS
  const permanentPatterns = policy.permanentErrorPatterns ?? DEFAULT_PERMANENT_PATTERNS

  const classification = classifyStepError(error, retryablePatterns, permanentPatterns)
  const errMessage = error instanceof Error ? error.message : String(error)

  if (classification === 'permanent') {
    return {
      shouldRetry: false,
      stepId,
      attempt,
      maxAttempts,
      backoffMs: 0,
      errorClassification: 'permanent',
      reason: `Permanent error detected ("${errMessage}"); retry aborted.`,
      exhausted: false,
      dispatchToDLQ: true,
      formattedSummary: `STEP RETRY AUDIT: Step "${stepId}" failed permanently on attempt ${String(attempt)}/${String(maxAttempts)}: ${errMessage}. Dispatched to DLQ.`,
    }
  }

  if (attempt >= maxAttempts) {
    return {
      shouldRetry: false,
      stepId,
      attempt,
      maxAttempts,
      backoffMs: 0,
      errorClassification: classification,
      reason: `Max retry attempts reached (${String(attempt)}/${String(maxAttempts)}).`,
      exhausted: true,
      dispatchToDLQ: true,
      formattedSummary: `STEP RETRY AUDIT: Step "${stepId}" exhausted all ${String(maxAttempts)} retry attempts: ${errMessage}. Dispatched to DLQ.`,
    }
  }

  const nextAttempt = attempt + 1
  const backoffMs = calculateExponentialBackoff(
    nextAttempt,
    initialBackoffMs,
    backoffMultiplier,
    maxBackoffMs,
    jitterRatio,
  )

  return {
    shouldRetry: true,
    stepId,
    attempt,
    maxAttempts,
    backoffMs,
    errorClassification: classification,
    reason: `Transient/recoverable error ("${errMessage}"); scheduling attempt ${String(nextAttempt)} in ${String(backoffMs)}ms.`,
    exhausted: false,
    dispatchToDLQ: false,
    formattedSummary: `STEP RETRY AUDIT: Step "${stepId}" will retry (attempt ${String(nextAttempt)}/${String(maxAttempts)}) in ${String(backoffMs)}ms after transient error: ${errMessage}.`,
  }
}
