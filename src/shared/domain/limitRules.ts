import { z } from 'zod'
import { resolveEffectivePolicy, type ResolvableRule } from './policy'
import { workflowLimitsSchema, type WorkflowLimits } from './workflow'

/**
 * Limits resolved through the rules-inheritance chain.
 *
 * ```
 * global ──> workspace ──> project ──> workflow ──> agent ──> task
 *                  most-specific scope wins
 * ```
 *
 * The issue asks for the limits to be configurable that way, and reusing the rules engine
 * rather than adding a parallel settings mechanism means one inheritance implementation
 * rather than two that can disagree. It also means an overridden limit is *visible* in the
 * settings screen with its provenance, alongside every other rule.
 *
 * Rule keys are namespaced under `limit.`:
 *
 * ```
 * limit.maxIterations   limit.stepTimeoutMs   limit.idleTimeoutMs
 * limit.totalTimeoutMs  limit.maxRetries      limit.retryDelayMs
 * limit.stopOn.buildFailure   …
 * ```
 *
 * A rule's statement is its value as text, because that is what a `Rule` holds — the schema
 * keeps `statement` as prose so the same mechanism serves "never modify migrations" and
 * "maxIterations = 3". Parsing happens here, and a malformed value is reported rather than
 * silently ignored: a project that meant to cap iterations at 3 and typed "three" must not
 * quietly run with 5.
 */

const LIMIT_PREFIX = 'limit.'

/** A limit rule that could not be understood. Surfaced, never swallowed. */
export interface LimitRuleProblem {
  readonly key: string
  readonly value: string
  readonly detail: string
}

export interface ResolvedLimits {
  readonly limits: WorkflowLimits
  /** Which keys were overridden, and by which scope — for the settings screen. */
  readonly overrides: readonly {
    readonly key: string
    readonly scope: string
    readonly value: string
  }[]
  readonly problems: readonly LimitRuleProblem[]
}

/** The numeric limits, by rule key. */
const NUMERIC_KEYS = {
  maxIterations: 'maxIterations',
  stepTimeoutMs: 'stepTimeoutMs',
  idleTimeoutMs: 'idleTimeoutMs',
  totalTimeoutMs: 'totalTimeoutMs',
  maxRetries: 'maxRetries',
  retryDelayMs: 'retryDelayMs',
} as const

/** The boolean stop-on toggles, by rule key suffix. */
const TOGGLE_KEYS = {
  'stopOn.buildFailure': 'buildFailure',
  'stopOn.testFailure': 'testFailure',
  'stopOn.openQuestion': 'openQuestion',
  'stopOn.unexpectedFileModification': 'unexpectedFileModification',
} as const

/**
 * Resolves the effective limits for a workflow.
 *
 * Runs the rules through `resolveEffectivePolicy` first, so precedence is decided by exactly
 * the same code that decides it for every other rule. Anything not overridden keeps the
 * schema's default.
 */
export function resolveLimits(rules: readonly ResolvableRule[]): ResolvedLimits {
  const policy = resolveEffectivePolicy(rules)

  const numeric: Record<string, number> = {}
  const toggles: Record<string, boolean> = {}
  const overrides: { key: string; scope: string; value: string }[] = []
  const problems: LimitRuleProblem[] = []

  for (const rule of policy) {
    if (!rule.key.startsWith(LIMIT_PREFIX)) continue

    const key = rule.key.slice(LIMIT_PREFIX.length)
    const value = rule.statement.trim()

    if (key in NUMERIC_KEYS) {
      const parsed = Number(value)

      // `Number('')` is 0 and `Number('three')` is NaN; both are rejected rather than
      // accepted as a limit of zero, which would be a far stranger run than a reported
      // error.
      if (value === '' || !Number.isFinite(parsed) || !Number.isInteger(parsed)) {
        problems.push({ key: rule.key, value, detail: 'Expected a whole number' })
        continue
      }

      numeric[key] = parsed
      overrides.push({ key: rule.key, scope: rule.scope, value })
      continue
    }

    if (key in TOGGLE_KEYS) {
      if (value !== 'true' && value !== 'false') {
        problems.push({ key: rule.key, value, detail: 'Expected "true" or "false"' })
        continue
      }

      toggles[TOGGLE_KEYS[key as keyof typeof TOGGLE_KEYS]] = value === 'true'
      overrides.push({ key: rule.key, scope: rule.scope, value })
      continue
    }

    // An unknown `limit.*` key is a typo, and a typo that silently does nothing is how a
    // user believes a limit is set when it is not.
    problems.push({
      key: rule.key,
      value,
      detail: `Unknown limit. Known keys: ${[
        ...Object.keys(NUMERIC_KEYS),
        ...Object.keys(TOGGLE_KEYS),
      ]
        .map((known) => LIMIT_PREFIX + known)
        .join(', ')}`,
    })
  }

  const candidate = { ...numeric, ...(Object.keys(toggles).length > 0 ? { stopOn: toggles } : {}) }
  const parsed = workflowLimitsSchema.safeParse(candidate)

  if (!parsed.success) {
    // A value that is a number but not a *valid* limit — zero iterations, a negative
    // timeout — fails the schema. Reported per-key and the defaults kept, so a bad rule
    // degrades to the default rather than to an unrunnable workflow.
    for (const issue of parsed.error.issues) {
      const key = issue.path.join('.')
      problems.push({
        key: LIMIT_PREFIX + key,
        value: String(numeric[key] ?? ''),
        detail: issue.message,
      })
    }

    return { limits: workflowLimitsSchema.parse({}), overrides: [], problems }
  }

  return { limits: parsed.data, overrides, problems }
}

/** The rule key for a limit, so a settings screen writes the same key this reads. */
export function limitRuleKey(field: keyof typeof NUMERIC_KEYS | keyof typeof TOGGLE_KEYS): string {
  return LIMIT_PREFIX + field
}

export const limitRuleProblemSchema = z.strictObject({
  key: z.string().min(1),
  value: z.string(),
  detail: z.string().min(1),
})
