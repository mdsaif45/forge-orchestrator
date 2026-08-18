import { RULE_SCOPES, ruleScopeSpecificity, type RuleScope } from './enums'

/**
 * Rule resolution.
 *
 * ```
 * global ──> workspace ──> project ──> workflow ──> agent ──> task
 *                  most-specific scope wins on conflict
 * ```
 *
 * A pure function over rules, deliberately: this decides what an agent is told it
 * must do, so it has to be exhaustively testable without a database, a project, or
 * a running workflow. It lives in `shared` so main resolves the policy it sends and
 * the renderer resolves the same answer it displays — one implementation, not two
 * that can disagree.
 *
 * Rules are prose statements keyed by a stable `key`. Two rules with the same key
 * are the *same concern* stated at different scopes, and the narrower one replaces
 * the wider one. Different keys never conflict; they accumulate.
 */

/**
 * The parts of a rule that resolution actually uses.
 *
 * Structural rather than the full `Rule`, so both a stored rule (which has a
 * branded id and a timestamp) and a code-defined default (which has neither) resolve
 * through the same function. Widening the input here is what keeps there from being
 * a second merge path for the built-in ruleset.
 */
export interface ResolvableRule {
  readonly scope: RuleScope
  readonly key: string
  readonly statement: string
  readonly source: string
}

/** One resolved rule, plus what it displaced. */
export interface EffectiveRule {
  readonly key: string
  readonly statement: string
  readonly scope: RuleScope
  readonly source: string
  /**
   * Rules with the same key that lost, widest first.
   *
   * Kept rather than discarded because "this rule is being overridden" is exactly
   * what a user needs to see in a settings screen, and because a silent override
   * is how a global safety rule disappears without anyone noticing.
   */
  readonly shadowed: readonly ShadowedRule[]
}

export interface ShadowedRule {
  readonly statement: string
  readonly scope: RuleScope
  readonly source: string
}

/** True when a narrower scope replaced a wider one for this key. */
export function isOverridden(rule: EffectiveRule): boolean {
  return rule.shadowed.length > 0
}

/**
 * Merges rules from every scope into the effective policy.
 *
 * Deterministic in both senses that matter: the same input always produces the same
 * output, and the output order does not depend on the input order. Ordering is by
 * key, because this text goes into a prompt packet that is snapshotted and compared
 * — an unstable order would make two identical policies look like a change.
 *
 * Input order is otherwise irrelevant: a rule's scope decides precedence, not its
 * position in the array.
 */
export function resolveEffectivePolicy(rules: readonly ResolvableRule[]): readonly EffectiveRule[] {
  const byKey = new Map<string, ResolvableRule[]>()

  for (const rule of rules) {
    const existing = byKey.get(rule.key)
    if (existing === undefined) {
      byKey.set(rule.key, [rule])
    } else {
      existing.push(rule)
    }
  }

  const resolved: EffectiveRule[] = []

  for (const [key, candidates] of byKey) {
    // Widest first, so the last entry is the winner and everything before it is
    // what the winner displaced.
    const ordered = [...candidates].sort(compareByScope)
    const winner = ordered[ordered.length - 1]
    if (winner === undefined) continue

    resolved.push({
      key,
      statement: winner.statement,
      scope: winner.scope,
      source: winner.source,
      shadowed: ordered.slice(0, -1).map((rule) => ({
        statement: rule.statement,
        scope: rule.scope,
        source: rule.source,
      })),
    })
  }

  return resolved.sort((left, right) => compareCodepoint(left.key, right.key))
}

/**
 * Orders strings by codepoint, not by locale.
 *
 * `localeCompare` reads the host's default locale, so the same policy could order
 * differently on a user's machine than in CI — and this ordering ends up in prompt
 * packets that are snapshotted and compared, where a reordering reads as a change.
 * Codepoint comparison is the same everywhere.
 */
function compareCodepoint(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}

/**
 * Orders two rules by scope specificity.
 *
 * Two rules at the *same* scope with the same key should not exist — the database
 * enforces one row per (project, scope, key) — but the comparison still has to be
 * total, or the sort is implementation-defined. `source` breaks the tie so the
 * result stays deterministic even if a caller passes duplicates in memory.
 */
function compareByScope(left: ResolvableRule, right: ResolvableRule): number {
  const bySpecificity = ruleScopeSpecificity(left.scope) - ruleScopeSpecificity(right.scope)
  if (bySpecificity !== 0) return bySpecificity

  return compareCodepoint(left.source, right.source)
}

/**
 * Renders the effective policy as the text an agent receives.
 *
 * Numbered, one per line, with no scope labels: an agent is told what the rules
 * *are*, not where they came from. Provenance is for the user's settings screen —
 * an agent that knew a rule was "only" a project rule might treat it as negotiable.
 */
export function formatPolicyForAgent(policy: readonly EffectiveRule[]): string {
  return policy.map((rule, index) => `${String(index + 1)}. ${rule.statement}`).join('\n')
}

/**
 * Every scope, widest to narrowest.
 *
 * Re-exported so a settings screen can render the inheritance chain without
 * importing the enum module and re-deriving the order.
 */
export const POLICY_SCOPES = RULE_SCOPES
