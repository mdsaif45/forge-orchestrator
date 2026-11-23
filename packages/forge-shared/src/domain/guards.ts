import { z } from 'zod'
import type { WorkflowLimits } from './workflow'

/**
 * Loop guards — axiom A5 made enforceable.
 *
 * The failure mode this exists to prevent:
 *
 * ```
 * planner → builder → reviewer → builder → reviewer → ...   forever
 * ```
 *
 * Two agents can exchange work indefinitely, each one plausibly making progress, until the
 * quota is gone and the day with it. Every guard here answers one question: *is it still
 * reasonable to continue?*
 *
 * All pure. The engine calls these and acts; nothing here spawns, kills, or waits. That
 * makes the awkward cases — a retry budget that interacts with a wall clock, two diffs that
 * are equal but arrived in a different order — testable without a running workflow.
 */

/**
 * Why a workflow stopped, machine-readable.
 *
 * Coded so the UI can present it and the engine can branch on it without matching on prose.
 * The human explanation travels alongside in `haltReason`, since a code alone tells a user
 * nothing about *their* run.
 */
export const HALT_CODES = [
  'iteration-cap',
  'step-timeout',
  'idle-timeout',
  'total-timeout',
  'no-progress',
  'retries-exhausted',
  'build-failure',
  'test-failure',
  'permission-violation',
  'unexpected-file-modification',
  'open-question',
  // A provider-side limit, not a failure of the work. The agent did nothing wrong, the
  // code is fine, and retrying immediately fails identically — which is exactly why it
  // must not be reported as a step failure (#137).
  'provider-limit',
] as const

export const haltCodeSchema = z.enum(HALT_CODES)
export type HaltCode = z.infer<typeof haltCodeSchema>

/** Which terminal state a halt code leads to. */
export function haltStateFor(code: HaltCode): 'HALTED_LIMIT' | 'HALTED_POLICY' {
  switch (code) {
    // Exhausting a budget is a limit; violating a rule is a policy failure. The
    // distinction is what a user needs to tell "it ran out of room" from "it did
    // something it was told not to".
    case 'iteration-cap':
    case 'step-timeout':
    case 'idle-timeout':
    case 'total-timeout':
    case 'no-progress':
    case 'retries-exhausted':
    case 'provider-limit':
      // `provider-limit` is a limit rather than a policy failure: nothing was violated,
      // the account is simply spent (#137).
      return 'HALTED_LIMIT'
    case 'build-failure':
    case 'test-failure':
    case 'permission-violation':
    case 'unexpected-file-modification':
    case 'open-question':
      return 'HALTED_POLICY'
  }
}

export interface HaltDecision {
  readonly code: HaltCode
  /** Written for the user, naming the specific budget or rule. */
  readonly reason: string
}

/** What the engine knows when it asks whether to continue. */
export interface BudgetState {
  readonly iteration: number
  /** Wall-clock milliseconds since the workflow started. */
  readonly elapsedMs: number
  /** Milliseconds since the current step started, or null between steps. */
  readonly stepElapsedMs: number | null
  /** Milliseconds since the current step last produced output. */
  readonly stepIdleMs: number | null
}

/**
 * Checks every budget, returning the first that is exhausted.
 *
 * Ordered deliberately: the total wall clock is checked before the per-step budgets, because
 * a workflow past its overall deadline should report *that* rather than whichever step
 * happened to be running when the deadline passed. A user reading "step timed out" would
 * draw the wrong conclusion about what went wrong.
 */
export function checkBudgets(state: BudgetState, limits: WorkflowLimits): HaltDecision | null {
  if (state.elapsedMs >= limits.totalTimeoutMs) {
    return {
      code: 'total-timeout',
      reason: `The workflow exceeded its total budget of ${formatDuration(limits.totalTimeoutMs)}`,
    }
  }

  if (state.iteration > limits.maxIterations) {
    return {
      code: 'iteration-cap',
      reason: `Reached the maximum of ${String(limits.maxIterations)} review iterations`,
    }
  }

  if (state.stepElapsedMs !== null && state.stepElapsedMs >= limits.stepTimeoutMs) {
    return {
      code: 'step-timeout',
      reason: `A step exceeded its budget of ${formatDuration(limits.stepTimeoutMs)}`,
    }
  }

  if (state.stepIdleMs !== null && state.stepIdleMs >= limits.idleTimeoutMs) {
    return {
      code: 'idle-timeout',
      reason: `A step produced no output for ${formatDuration(limits.idleTimeoutMs)}`,
    }
  }

  return null
}

/** What remains, for the UI to show before a run gets anywhere near a wall. */
export interface RemainingBudget {
  readonly iterationsLeft: number
  readonly totalMsLeft: number
  readonly stepMsLeft: number | null
}

export function remainingBudget(state: BudgetState, limits: WorkflowLimits): RemainingBudget {
  return {
    // Never negative: a user reading "-1 iterations left" learns nothing useful.
    iterationsLeft: Math.max(0, limits.maxIterations - state.iteration),
    totalMsLeft: Math.max(0, limits.totalTimeoutMs - state.elapsedMs),
    stepMsLeft:
      state.stepElapsedMs === null ? null : Math.max(0, limits.stepTimeoutMs - state.stepElapsedMs),
  }
}

/**
 * Whether a failure is worth retrying.
 *
 * The distinction that matters most in this file. A transient failure is one where the same
 * request could plausibly succeed unchanged — a crashed process, a dropped connection. A
 * semantic failure is one where it could not: bad credentials, a policy violation, a report
 * that fails validation twice. Retrying a semantic failure spends the budget on a certainty
 * and delays the halt the user needs to see.
 */
export const FAILURE_KINDS = ['transient', 'semantic'] as const
export const failureKindSchema = z.enum(FAILURE_KINDS)
export type FailureKind = z.infer<typeof failureKindSchema>

export interface RetryDecision {
  readonly shouldRetry: boolean
  readonly attemptsUsed: number
  /** Milliseconds to wait first. Zero when not retrying. */
  readonly delayMs: number
  readonly reason: string
}

/**
 * Decides whether to retry, and after how long.
 *
 * Fixed backoff rather than exponential, deliberately. Exponential backoff earns its
 * complexity when many clients contend for one resource; here a single workflow is retrying
 * its own step against a local CLI, so doubling the wait only makes a doomed run take
 * longer to admit it. The delay is configurable if a project disagrees.
 */
export function decideRetry(
  kind: FailureKind,
  attemptsUsed: number,
  limits: WorkflowLimits,
): RetryDecision {
  if (kind === 'semantic') {
    return {
      shouldRetry: false,
      attemptsUsed,
      delayMs: 0,
      reason: 'The failure is semantic: the same request would fail the same way',
    }
  }

  if (attemptsUsed >= limits.maxRetries) {
    return {
      shouldRetry: false,
      attemptsUsed,
      delayMs: 0,
      reason: `Exhausted ${String(limits.maxRetries)} retries`,
    }
  }

  return {
    shouldRetry: true,
    attemptsUsed: attemptsUsed + 1,
    delayMs: limits.retryDelayMs,
    reason: `Transient failure; retrying (attempt ${String(attemptsUsed + 1)} of ${String(limits.maxRetries)})`,
  }
}

/**
 * A fingerprint of what an iteration actually changed.
 *
 * Built from the *diff*, not from the agent's report, because the point is to catch an agent
 * resubmitting the same work while describing it differently each time (A3). Two iterations
 * with the same fingerprint made no progress, whatever their summaries claim.
 *
 * File order is normalised: git's ordering is stable in practice, but a fingerprint that
 * changed because two files swapped places would report progress that did not happen.
 */
export function fingerprintChange(
  files: readonly {
    readonly path: string
    readonly insertions: number
    readonly deletions: number
  }[],
  patch: string,
): string {
  const shape = [...files]
    .map((file) => `${file.path}:${String(file.insertions)}:${String(file.deletions)}`)
    .sort()
    .join('|')

  // The patch text is included because line counts alone are too coarse: changing a
  // constant from 41 to 43 instead of 42 is the same shape and a different change. Hashed
  // rather than kept whole so a fingerprint stays cheap to store and compare.
  return `${shape}#${hash(patch)}`
}

/**
 * A small, stable string hash.
 *
 * FNV-1a: not cryptographic, and does not need to be — this compares two of Forge's own
 * consecutive diffs, where an adversary would have to be the agent deliberately crafting a
 * collision to *avoid* being caught making no progress. Chosen over `node:crypto` so this
 * module stays pure and usable in the renderer.
 */
function hash(value: string): string {
  let result = 0x811c9dc5

  for (let index = 0; index < value.length; index += 1) {
    result ^= value.charCodeAt(index)
    // The FNV prime, applied with Math.imul to keep 32-bit multiplication exact.
    result = Math.imul(result, 0x01000193)
  }

  return (result >>> 0).toString(16)
}

/**
 * Detects an agent making no progress.
 *
 * Two consecutive iterations producing an identical diff means the loop is spinning: the
 * reviewer keeps objecting, the implementer keeps submitting the same thing, and the
 * iteration cap alone would let that burn the full budget before stopping. Halting on the
 * repeat turns a slow waste into an immediate, explicable stop.
 *
 * Compares only *consecutive* iterations. Two identical diffs separated by a different one
 * is a loop that tried something else in between, which is progress even if it was
 * eventually reverted.
 */
export function detectNoProgress(fingerprints: readonly string[]): HaltDecision | null {
  if (fingerprints.length < 2) return null

  const latest = fingerprints[fingerprints.length - 1]
  const previous = fingerprints[fingerprints.length - 2]

  if (latest === undefined || previous === undefined || latest !== previous) return null

  return {
    code: 'no-progress',
    reason:
      'Two consecutive iterations produced an identical change: the correction loop is not making progress',
  }
}

/** What a step reported, in the terms the stop-on toggles are written in. */
export interface StepOutcomeSignals {
  readonly buildFailed: boolean
  readonly testsFailed: boolean
  readonly hasOpenQuestion: boolean
  readonly permissionViolated: boolean
  readonly modifiedUnexpectedFiles: boolean
}

/**
 * Applies the stop-on toggles.
 *
 * A permission violation halts regardless of configuration — A7 is not a preference, and a
 * toggle that could disable it would make the guarantee advisory. The schema enforces that
 * by typing the field as `true` rather than `boolean`; this is the runtime half.
 */
export function checkStopConditions(
  signals: StepOutcomeSignals,
  limits: WorkflowLimits,
): HaltDecision | null {
  if (signals.permissionViolated) {
    return {
      code: 'permission-violation',
      reason: 'The agent attempted something its permissions do not allow',
    }
  }

  if (signals.modifiedUnexpectedFiles && limits.stopOn.unexpectedFileModification) {
    return {
      code: 'unexpected-file-modification',
      reason: 'The agent modified files outside the task’s allowed paths',
    }
  }

  if (signals.buildFailed && limits.stopOn.buildFailure) {
    return { code: 'build-failure', reason: 'The build failed and the project halts on that' }
  }

  if (signals.testsFailed && limits.stopOn.testFailure) {
    return { code: 'test-failure', reason: 'The tests failed and the project halts on that' }
  }

  if (signals.hasOpenQuestion && limits.stopOn.openQuestion) {
    return {
      code: 'open-question',
      reason: 'The agent raised a question and the project halts rather than waiting',
    }
  }

  return null
}

/** Renders a duration the way a person would say it. */
function formatDuration(ms: number): string {
  const hours = Math.floor(ms / 3_600_000)
  const minutes = Math.round((ms % 3_600_000) / 60_000)

  if (hours > 0)
    return minutes === 0 ? `${String(hours)}h` : `${String(hours)}h ${String(minutes)}m`
  if (minutes > 0) return `${String(minutes)}m`
  return `${String(Math.round(ms / 1000))}s`
}
