/**
 * WORK-028: Workflow Step Retry Backoff Scheduler & Dead-Letter Escalation Router.
 *
 * Implements adaptive retry scheduling with exponential backoff and bounded jitter,
 * failure categorization (transient vs deterministic), and automatic escalation to
 * dead-letter queues (DLQ) upon retry exhaustion or unrecoverable error classification.
 */

export type FailureCategory =
  | 'transient_network'
  | 'resource_contention'
  | 'timeout'
  | 'fatal_logic'
  | 'validation_error'
  | 'unknown'

export interface WorkflowRetryEscalationPolicy {
  maxRetries: number
  baseDelayMs: number
  maxDelayMs: number
  backoffFactor: number
  enableJitter: boolean
  fatalCategories: FailureCategory[]
}

export interface RetryDecision {
  stepId: string
  shouldRetry: boolean
  failureCategory: FailureCategory
  attempt: number
  maxRetries: number
  delayMs: number
  escalatedToDlq: boolean
  reason: string
  timestamp: string
}

export const DEFAULT_WORKFLOW_RETRY_POLICY: WorkflowRetryEscalationPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffFactor: 2,
  enableJitter: true,
  fatalCategories: ['fatal_logic', 'validation_error'],
}

/**
 * Classifies an error into a standardized FailureCategory based on message or error details.
 */
export function classifyWorkflowFailure(error: unknown): FailureCategory {
  if (!error) {
    return 'unknown'
  }

  const message = (
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error)
  ).toLowerCase()

  if (
    message.includes('econnrefused') ||
    message.includes('econnreset') ||
    message.includes('connection reset') ||
    message.includes('etimedout') ||
    message.includes('network') ||
    message.includes('socket hang up') ||
    message.includes('fetch failed')
  ) {
    return 'transient_network'
  }

  if (
    message.includes('ebusy') ||
    message.includes('locked') ||
    message.includes('sqlite_busy') ||
    message.includes('contention') ||
    message.includes('rate limit') ||
    message.includes('too many requests')
  ) {
    return 'resource_contention'
  }

  if (
    message.includes('timeout') ||
    message.includes('timed out') ||
    message.includes('deadline')
  ) {
    return 'timeout'
  }

  if (
    message.includes('syntax') ||
    message.includes('typeerror') ||
    message.includes('referenceerror') ||
    message.includes('assertion') ||
    message.includes('not implemented')
  ) {
    return 'fatal_logic'
  }

  if (
    message.includes('invalid schema') ||
    message.includes('validation') ||
    message.includes('unrecognized key') ||
    message.includes('missing required')
  ) {
    return 'validation_error'
  }

  return 'unknown'
}

/**
 * Calculates deterministic backoff delay with optional pseudo-random jitter.
 */
export function calculateWorkflowBackoffDelay(
  attempt: number,
  policy: WorkflowRetryEscalationPolicy,
  pseudoRandomSeed = 0.5,
): number {
  const boundedAttempt = Math.max(1, attempt)
  const rawDelay = policy.baseDelayMs * Math.pow(policy.backoffFactor, boundedAttempt - 1)
  const cappedDelay = Math.min(policy.maxDelayMs, rawDelay)

  if (!policy.enableJitter) {
    return Math.round(cappedDelay)
  }

  // Jitter between 0.8x and 1.2x of cappedDelay
  const jitterMultiplier = 0.8 + 0.4 * Math.max(0, Math.min(1, pseudoRandomSeed))
  return Math.round(Math.min(policy.maxDelayMs, cappedDelay * jitterMultiplier))
}

/**
 * Evaluates whether a failed workflow step should be retried or escalated to DLQ.
 */
export function evaluateStepRetryAndEscalation(
  stepId: string,
  attempt: number,
  error: unknown,
  customPolicy?: Partial<WorkflowRetryEscalationPolicy>,
  jitterSeed?: number,
): RetryDecision {
  const policy: WorkflowRetryEscalationPolicy = {
    ...DEFAULT_WORKFLOW_RETRY_POLICY,
    ...(customPolicy ?? {}),
  }

  const timestamp = new Date().toISOString()
  const failureCategory = classifyWorkflowFailure(error)

  // If the failure category is designated as unrecoverable / fatal
  if (policy.fatalCategories.includes(failureCategory)) {
    return {
      stepId,
      shouldRetry: false,
      failureCategory,
      attempt,
      maxRetries: policy.maxRetries,
      delayMs: 0,
      escalatedToDlq: true,
      reason: `Fatal non-retryable failure classified as ${failureCategory}.`,
      timestamp,
    }
  }

  // If retry attempts have exceeded maxRetries
  if (attempt >= policy.maxRetries) {
    return {
      stepId,
      shouldRetry: false,
      failureCategory,
      attempt,
      maxRetries: policy.maxRetries,
      delayMs: 0,
      escalatedToDlq: true,
      reason: `Retry limit exhausted (${String(attempt)}/${String(policy.maxRetries)} attempts). Escalating to Dead-Letter Queue.`,
      timestamp,
    }
  }

  // Retry permitted: schedule backoff delay
  const nextAttempt = attempt + 1
  const delayMs = calculateWorkflowBackoffDelay(nextAttempt, policy, jitterSeed)

  return {
    stepId,
    shouldRetry: true,
    failureCategory,
    attempt,
    maxRetries: policy.maxRetries,
    delayMs,
    escalatedToDlq: false,
    reason: `Transient error (${failureCategory}). Retrying in ${String(delayMs)}ms (attempt ${String(nextAttempt)}/${String(policy.maxRetries)}).`,
    timestamp,
  }
}
