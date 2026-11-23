import { describe, expect, it } from 'vitest'
import { RULE_SCOPES, type RuleScope } from './enums'
import { FORGE_DEFAULT_RULES, FORGE_DEFAULT_RULE_KEYS } from './forgeRules'
import {
  formatPolicyForAgent,
  isOverridden,
  resolveEffectivePolicy,
  type ResolvableRule,
} from './policy'

/**
 * Rule resolution.
 *
 * This function decides what an agent is told it must do, so it is tested
 * exhaustively rather than representatively: every scope pair, the full chain, and
 * the cases where a wrong answer would silently drop a safety rule.
 */

function rule(scope: RuleScope, key: string, statement: string, source = 'test'): ResolvableRule {
  return { scope, key, statement, source }
}

describe('resolveEffectivePolicy', () => {
  it('returns an empty policy for no rules', () => {
    expect(resolveEffectivePolicy([])).toEqual([])
  })

  it('accumulates rules with different keys', () => {
    // Different keys are different concerns; they never conflict.
    const policy = resolveEffectivePolicy([
      rule('global', 'R1', 'never guess'),
      rule('project', 'tech', '.NET 9 and React'),
      rule('workflow', 'db', 'no database changes'),
    ])

    // Codepoint order, so uppercase sorts before lowercase.
    expect(policy.map((entry) => entry.key)).toEqual(['R1', 'db', 'tech'])
    expect(policy.every((entry) => !isOverridden(entry))).toBe(true)
  })

  it('resolves the example from the issue across four scopes', () => {
    // The definition of done: a rule set at four scopes resolves correctly.
    const policy = resolveEffectivePolicy([
      rule('global', 'guessing', 'never guess'),
      rule('project', 'tech', '.NET 9 + React'),
      rule('workflow', 'db', 'no database changes'),
      rule('agent', 'write', 'read-only'),
      rule('task', 'files', 'modify AuthService only'),
    ])

    expect(policy.map((entry) => entry.statement).sort()).toEqual([
      '.NET 9 + React',
      'modify AuthService only',
      'never guess',
      'no database changes',
      'read-only',
    ])
  })

  it('lets the narrower scope win on the same key', () => {
    const policy = resolveEffectivePolicy([
      rule('global', 'files', 'modify anything'),
      rule('task', 'files', 'modify AuthService only'),
    ])

    expect(policy).toHaveLength(1)
    expect(policy[0]?.statement).toBe('modify AuthService only')
    expect(policy[0]?.scope).toBe('task')
  })

  it('keeps what it shadowed, rather than discarding it', () => {
    // A silent override is how a global safety rule disappears unnoticed, so the
    // displaced rule is retained for the settings screen to show.
    const policy = resolveEffectivePolicy([
      rule('global', 'files', 'modify anything', 'docs/FORGE_RULES.md'),
      rule('project', 'files', 'src only', 'project settings'),
      rule('task', 'files', 'AuthService only', 'task definition'),
    ])

    const entry = policy[0]
    expect(entry).toBeDefined()
    if (entry === undefined) return

    expect(entry.statement).toBe('AuthService only')
    expect(isOverridden(entry)).toBe(true)
    // Widest first, so the chain reads in inheritance order.
    expect(entry.shadowed).toEqual([
      { statement: 'modify anything', scope: 'global', source: 'docs/FORGE_RULES.md' },
      { statement: 'src only', scope: 'project', source: 'project settings' },
    ])
  })

  it('respects precedence for every adjacent pair of scopes', () => {
    // Rather than trusting the enum's order, assert the behaviour it implies at
    // every step of the chain.
    for (let index = 0; index < RULE_SCOPES.length - 1; index += 1) {
      const wider = RULE_SCOPES[index]
      const narrower = RULE_SCOPES[index + 1]
      if (wider === undefined || narrower === undefined) continue

      const policy = resolveEffectivePolicy([
        rule(wider, 'k', 'wider'),
        rule(narrower, 'k', 'narrower'),
      ])

      expect(policy[0]?.statement, `${narrower} should beat ${wider}`).toBe('narrower')
    }
  })

  it('resolves the same answer whatever order the rules arrive in', () => {
    // Precedence comes from scope, never from position in the array.
    const rules = [
      rule('task', 'k', 'task wins'),
      rule('global', 'k', 'global'),
      rule('agent', 'k', 'agent'),
      rule('project', 'k', 'project'),
    ]

    const forward = resolveEffectivePolicy(rules)
    const reversed = resolveEffectivePolicy([...rules].reverse())

    expect(forward).toEqual(reversed)
    expect(forward[0]?.statement).toBe('task wins')
  })

  it('orders the output by key, independently of input order', () => {
    // The policy text goes into a snapshotted prompt packet; an unstable order
    // would make two identical policies look like a change.
    const first = resolveEffectivePolicy([
      rule('global', 'zebra', 'z'),
      rule('global', 'alpha', 'a'),
    ])
    const second = resolveEffectivePolicy([
      rule('global', 'alpha', 'a'),
      rule('global', 'zebra', 'z'),
    ])

    expect(first.map((entry) => entry.key)).toEqual(['alpha', 'zebra'])
    expect(first).toEqual(second)
  })

  it('orders by codepoint rather than by the host locale', () => {
    // `localeCompare` reads the machine's default locale, so a policy could order
    // one way locally and another in CI — and this text goes into snapshotted prompt
    // packets, where a reordering reads as a change. Codepoint order puts uppercase
    // before lowercase everywhere; a locale-aware sort interleaves them.
    const policy = resolveEffectivePolicy([
      rule('global', 'db', 'b'),
      rule('global', 'R1', 'a'),
      rule('global', 'alpha', 'c'),
    ])

    expect(policy.map((entry) => entry.key)).toEqual(['R1', 'alpha', 'db'])
  })

  it('is deterministic when two rules share a scope and key', () => {
    // The database prevents this, but the comparison must still be total or the
    // sort would be implementation-defined.
    const rules = [
      rule('project', 'k', 'from B', 'b-source'),
      rule('project', 'k', 'from A', 'a-source'),
    ]

    expect(resolveEffectivePolicy(rules)).toEqual(resolveEffectivePolicy([...rules].reverse()))
  })

  it('does not mutate the array it was given', () => {
    const rules = [rule('task', 'k', 'task'), rule('global', 'k', 'global')]
    const snapshot = [...rules]

    resolveEffectivePolicy(rules)

    expect(rules).toEqual(snapshot)
  })
})

describe('formatPolicyForAgent', () => {
  it('numbers the rules and states nothing about scope', () => {
    // An agent is told what the rules are, not where they came from: knowing a rule
    // was "only" a project rule invites treating it as negotiable.
    const text = formatPolicyForAgent(
      resolveEffectivePolicy([
        rule('global', 'a', 'never guess'),
        rule('task', 'b', 'AuthService only'),
      ]),
    )

    expect(text).toBe('1. never guess\n2. AuthService only')
    expect(text).not.toContain('global')
    expect(text).not.toContain('task')
  })

  it('renders an empty policy as an empty string', () => {
    expect(formatPolicyForAgent([])).toBe('')
  })
})

describe('the default ruleset', () => {
  it('is all global scope', () => {
    expect(FORGE_DEFAULT_RULES.every((entry) => entry.scope === 'global')).toBe(true)
  })

  it('has unique keys', () => {
    expect(new Set(FORGE_DEFAULT_RULE_KEYS).size).toBe(FORGE_DEFAULT_RULES.length)
  })

  it('survives resolution intact when nothing overrides it', () => {
    const policy = resolveEffectivePolicy(FORGE_DEFAULT_RULES)

    expect(policy).toHaveLength(FORGE_DEFAULT_RULES.length)
    expect(policy.every((entry) => !isOverridden(entry))).toBe(true)
  })

  it('can be overridden at a narrower scope, but not removed', () => {
    const policy = resolveEffectivePolicy([
      ...FORGE_DEFAULT_RULES,
      rule('project', 'R4', 'migrations may be modified in this project'),
    ])

    // Still every default key: an override replaces a statement, it does not delete
    // the concern.
    expect(policy.map((entry) => entry.key).sort()).toEqual([...FORGE_DEFAULT_RULE_KEYS].sort())

    const overridden = policy.find((entry) => entry.key === 'R4')
    expect(overridden?.scope).toBe('project')
    expect(overridden?.shadowed).toHaveLength(1)
  })
})
