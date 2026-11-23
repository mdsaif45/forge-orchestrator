import { describe, expect, it } from 'vitest'
import { limitRuleKey, resolveLimits } from './limitRules'
import type { ResolvableRule } from './policy'
import type { RuleScope } from './enums'

/**
 * Limits resolved through the rules chain.
 *
 * The point of routing them through the rules engine rather than a parallel settings
 * mechanism is that there is one inheritance implementation, and an overridden limit is
 * visible with its provenance like any other rule. These tests cover the part that is
 * genuinely new: turning a rule's prose statement into a validated limit, and refusing to
 * do so silently when it cannot.
 */

function rule(scope: RuleScope, key: string, statement: string): ResolvableRule {
  return { scope, key, statement, source: 'test' }
}

describe('resolving limits', () => {
  it('keeps the defaults when nothing overrides them', () => {
    const { limits, overrides, problems } = resolveLimits([])

    expect(limits.maxIterations).toBe(5)
    expect(limits.stopOn.unexpectedFileModification).toBe(true)
    expect(overrides).toEqual([])
    expect(problems).toEqual([])
  })

  it('applies a project override', () => {
    const { limits, overrides } = resolveLimits([
      rule('project', limitRuleKey('maxIterations'), '3'),
    ])

    expect(limits.maxIterations).toBe(3)
    expect(overrides).toEqual([{ key: 'limit.maxIterations', scope: 'project', value: '3' }])
  })

  it('lets the narrower scope win, using the same precedence as every other rule', () => {
    // The reason for reusing the rules engine: precedence is decided in one place.
    const { limits } = resolveLimits([
      rule('global', limitRuleKey('maxIterations'), '5'),
      rule('project', limitRuleKey('maxIterations'), '3'),
      rule('workflow', limitRuleKey('maxIterations'), '2'),
    ])

    expect(limits.maxIterations).toBe(2)
  })

  it('reports which scope set each override, for the settings screen', () => {
    const { overrides } = resolveLimits([
      rule('global', limitRuleKey('maxIterations'), '9'),
      rule('workflow', limitRuleKey('maxIterations'), '2'),
    ])

    expect(overrides).toEqual([{ key: 'limit.maxIterations', scope: 'workflow', value: '2' }])
  })

  it('applies a stop-on toggle', () => {
    const { limits } = resolveLimits([rule('project', limitRuleKey('stopOn.buildFailure'), 'true')])

    expect(limits.stopOn.buildFailure).toBe(true)
    // The untouched toggles keep their defaults rather than being reset.
    expect(limits.stopOn.unexpectedFileModification).toBe(true)
  })

  it('leaves other limits at their defaults when one is overridden', () => {
    const { limits } = resolveLimits([rule('project', limitRuleKey('maxRetries'), '0')])

    expect(limits.maxRetries).toBe(0)
    expect(limits.maxIterations).toBe(5)
    expect(limits.retryDelayMs).toBe(5000)
  })

  it('ignores rules that are not limits', () => {
    const { limits, problems } = resolveLimits([
      rule('global', 'R1', 'Never guess.'),
      rule('project', limitRuleKey('maxIterations'), '4'),
    ])

    expect(limits.maxIterations).toBe(4)
    expect(problems).toEqual([])
  })
})

describe('rejecting a value it cannot understand', () => {
  it('reports a non-numeric limit rather than silently keeping the default', () => {
    // A project that meant to cap iterations at three and typed "three" must not quietly
    // run with five.
    const { problems } = resolveLimits([rule('project', limitRuleKey('maxIterations'), 'three')])

    expect(problems).toHaveLength(1)
    expect(problems.at(0)?.key).toBe('limit.maxIterations')
    expect(problems.at(0)?.detail).toMatch(/whole number/)
  })

  it('rejects an empty value rather than reading it as zero', () => {
    // `Number('')` is 0, which would be a far stranger run than a reported error.
    const { problems } = resolveLimits([rule('project', limitRuleKey('maxIterations'), '')])

    expect(problems).toHaveLength(1)
  })

  it('rejects a fractional limit', () => {
    expect(
      resolveLimits([rule('project', limitRuleKey('maxRetries'), '1.5')]).problems,
    ).toHaveLength(1)
  })

  it('rejects a toggle that is not a boolean', () => {
    const { problems } = resolveLimits([rule('project', limitRuleKey('stopOn.testFailure'), 'yes')])

    expect(problems.at(0)?.detail).toMatch(/true.*false/)
  })

  it('reports an unknown limit key, listing the known ones', () => {
    // A typo that silently does nothing is how a user comes to believe a limit is set when
    // it is not.
    const { problems } = resolveLimits([rule('project', 'limit.maxIterationz', '3')])

    expect(problems).toHaveLength(1)
    expect(problems.at(0)?.detail).toContain('limit.maxIterations')
  })

  it('degrades to the defaults when a value is a number but not a valid limit', () => {
    // Zero iterations would make a workflow unrunnable. Reported and defaulted, rather
    // than accepted.
    const { limits, problems } = resolveLimits([
      rule('project', limitRuleKey('maxIterations'), '0'),
    ])

    expect(problems.length).toBeGreaterThan(0)
    expect(limits.maxIterations).toBe(5)
  })

  it('keeps a valid override even when another rule is malformed', () => {
    // One bad rule must not discard a good one; both are reported on their own terms.
    const { problems } = resolveLimits([
      rule('project', limitRuleKey('maxIterations'), '3'),
      rule('project', limitRuleKey('stopOn.buildFailure'), 'perhaps'),
    ])

    expect(problems).toHaveLength(1)
    expect(problems.at(0)?.key).toBe('limit.stopOn.buildFailure')
  })
})
