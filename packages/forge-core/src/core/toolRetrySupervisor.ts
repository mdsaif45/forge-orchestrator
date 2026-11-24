/**
 * AGENT-019: Adaptive Tool Invocation Retry Supervisor & Circuit Breaker
 *
 * Evaluates agent tool call execution failures, categorizing transient vs. fatal
 * errors, calculating exponential backoff with randomized jitter, and tripping circuit
 * breakers when deterministic identical failure patterns repeat.
 *
 * Conforms to Forge Axioms:
 * - A1: Fail-closed evaluation and zero `any`.
 * - A2: Rigorous isolation and error boundary confinement.
 * - A5: Bounded retry attempts and bounded sleep delays.
 */

export type ToolErrorClassification = 'fatal' | 'transient' | 'rate_limited' | 'timeout'

export interface ToolRetryPolicy {
  readonly maxAttempts?: number | undefined
  readonly baseBackoffMs?: number | undefined
  readonly maxBackoffMs?: number | undefined
  readonly failureThreshold?: number | undefined
}

export interface ToolRetryDecision {
  readonly shouldRetry: boolean
  readonly classification: ToolErrorClassification
  readonly attempt: number
  readonly maxAttempts: number
  readonly backoffMs: number
  readonly circuitTripped: boolean
  readonly reason: string
  readonly formattedSummary: string
}

/**
 * Categorizes an error thrown by a tool execution into fatal, transient, rate_limited, or timeout.
 */
export function classifyToolError(error: unknown): ToolErrorClassification {
  if (!error) {
    return 'fatal'
  }

  let message = ''
  let code = ''

  if (error instanceof Error) {
    message = error.message
  } else if (typeof error === 'string') {
    message = error
  } else if (typeof error === 'object') {
    const record = error as Record<string, unknown>
    if (typeof record.message === 'string') {
      message = record.message
    }
    if (typeof record.code === 'string') {
      code = record.code
    }
  }

  const lowerMsg = message.toLowerCase()
  const lowerCode = code.toLowerCase()

  // Timeout checks
  if (
    lowerCode === 'etimedout' ||
    lowerMsg.includes('timed out') ||
    lowerMsg.includes('timeout') ||
    lowerMsg.includes('deadline exceeded')
  ) {
    return 'timeout'
  }

  // Rate limit checks
  if (
    lowerMsg.includes('429') ||
    lowerMsg.includes('rate limit') ||
    lowerMsg.includes('too many requests') ||
    lowerMsg.includes('quota exceeded')
  ) {
    return 'rate_limited'
  }

  // Transient system / OS / IO checks
  const transientCodes = [
    'ebusy',
    'eperm',
    'eagain',
    'emfile',
    'enfile',
    'econnreset',
    'econnrefused',
    'epipe',
  ]
  if (
    transientCodes.includes(lowerCode) ||
    lowerMsg.includes('resource busy') ||
    lowerMsg.includes('locked') ||
    lowerMsg.includes('socket hang up') ||
    lowerMsg.includes('temporarily unavailable')
  ) {
    return 'transient'
  }

  return 'fatal'
}

/**
 * Calculates exponential backoff with full jitter formula.
 */
export function calculateToolBackoff(
  attempt: number,
  policy?: ToolRetryPolicy,
  randomSource?: () => number,
): number {
  const baseBackoffMs = policy?.baseBackoffMs ?? 500
  const maxBackoffMs = policy?.maxBackoffMs ?? 10_000
  const rand = (randomSource ?? Math.random)()

  const expBackoff = baseBackoffMs * 2 ** Math.max(0, attempt - 1)
  const cappedBackoff = Math.min(maxBackoffMs, expBackoff)

  return Math.floor(rand * cappedBackoff)
}

/**
 * Evaluates whether a tool failure should be retried, computing backoff and circuit trip status.
 */
export function evaluateToolRetry(
  toolName: string,
  attempt: number,
  error: unknown,
  policy?: ToolRetryPolicy,
  recentErrors?: readonly string[],
  randomSource?: () => number,
): ToolRetryDecision {
  const maxAttempts = policy?.maxAttempts ?? 3
  const failureThreshold = policy?.failureThreshold ?? 3
  const classification = classifyToolError(error)

  const errorMsg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error)

  // Circuit breaker: check if identical error message repeated failureThreshold times
  let circuitTripped = false
  if (recentErrors && recentErrors.length >= failureThreshold) {
    const lastN = recentErrors.slice(-failureThreshold)
    const allIdentical = lastN.every((msg) => msg === errorMsg)
    if (allIdentical) {
      circuitTripped = true
    }
  }

  if (circuitTripped) {
    const summary =
      `[Tool Retry Denied] Circuit breaker tripped for '${toolName}' after ` +
      `${String(failureThreshold)} identical failure(s): ${errorMsg}`
    return {
      shouldRetry: false,
      classification,
      attempt,
      maxAttempts,
      backoffMs: 0,
      circuitTripped: true,
      reason: `Circuit breaker tripped due to ${String(failureThreshold)} consecutive identical errors`,
      formattedSummary: summary,
    }
  }

  if (classification === 'fatal') {
    const summary = `[Tool Retry Denied] Fatal unrecoverable error for '${toolName}': ${errorMsg}`
    return {
      shouldRetry: false,
      classification,
      attempt,
      maxAttempts,
      backoffMs: 0,
      circuitTripped: false,
      reason: 'Fatal error classification is not retryable',
      formattedSummary: summary,
    }
  }

  if (attempt >= maxAttempts) {
    const summary = `[Tool Retry Denied] Attempt limit reached (${String(attempt)}/${String(maxAttempts)}) for '${toolName}': ${errorMsg}`
    return {
      shouldRetry: false,
      classification,
      attempt,
      maxAttempts,
      backoffMs: 0,
      circuitTripped: false,
      reason: `Exceeded maximum retry attempts (${String(maxAttempts)})`,
      formattedSummary: summary,
    }
  }

  const backoffMs = calculateToolBackoff(attempt, policy, randomSource)
  const summary =
    `[Tool Retry Approved] Tool '${toolName}' attempt ${String(attempt)}/${String(maxAttempts)} ` +
    `scheduled in ${String(backoffMs)}ms (${classification})`

  return {
    shouldRetry: true,
    classification,
    attempt,
    maxAttempts,
    backoffMs,
    circuitTripped: false,
    reason: `Retryable ${classification} failure, attempt ${String(attempt)} of ${String(maxAttempts)}`,
    formattedSummary: summary,
  }
}
