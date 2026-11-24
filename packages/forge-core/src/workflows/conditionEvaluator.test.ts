import { describe, expect, it } from 'vitest'
import { evaluateConditionExpression, type WorkflowConditionContext } from './conditionEvaluator'

describe('WorkflowConditionEvaluator (WORK-018)', () => {
  const context: WorkflowConditionContext = {
    exitCode: 0,
    iteration: 2,
    verdict: 'ACCEPT',
    node: {
      state: 'completed',
      retries: 1,
    },
    artifacts: {
      lint: { status: 'passed', issues: 0 },
      tests: { failed: 0, passed: 12 },
    },
  }

  it('evaluates boolean equality and relational operators accurately', () => {
    expect(evaluateConditionExpression('exitCode == 0', context).result).toBe(true)
    expect(evaluateConditionExpression('exitCode != 0', context).result).toBe(false)
    expect(evaluateConditionExpression('iteration > 1', context).result).toBe(true)
    expect(evaluateConditionExpression('iteration <= 2', context).result).toBe(true)
    expect(evaluateConditionExpression("verdict == 'ACCEPT'", context).result).toBe(true)
  })

  it('resolves nested context paths with dot notation', () => {
    expect(evaluateConditionExpression("node.state == 'completed'", context).result).toBe(true)
    expect(evaluateConditionExpression("artifacts.lint.status == 'passed'", context).result).toBe(
      true,
    )
    expect(evaluateConditionExpression('artifacts.tests.failed == 0', context).result).toBe(true)
  })

  it('evaluates logical AND, OR, and NOT with correct precedence', () => {
    expect(
      evaluateConditionExpression(
        "exitCode == 0 && verdict == 'ACCEPT' && artifacts.tests.failed == 0",
        context,
      ).result,
    ).toBe(true)

    expect(evaluateConditionExpression('exitCode != 0 || iteration == 2', context).result).toBe(
      true,
    )

    expect(evaluateConditionExpression('!(exitCode == 0)', context).result).toBe(false)
  })

  it('evaluates membership operator in with literal arrays', () => {
    expect(evaluateConditionExpression("verdict in ['ACCEPT', 'MERGE']", context).result).toBe(true)

    expect(
      evaluateConditionExpression("verdict in ['REJECT', 'CHANGES_REQUESTED']", context).result,
    ).toBe(false)
  })

  it('fails closed safely on syntax errors or invalid tokens (A2, A7)', () => {
    const invalidSyntax = evaluateConditionExpression('exitCode === && 0', context)
    expect(invalidSyntax.valid).toBe(false)
    expect(invalidSyntax.result).toBe(false)
    expect(invalidSyntax.error).toBeDefined()

    const unterminatedString = evaluateConditionExpression("verdict == 'ACCEPT", context)
    expect(unterminatedString.valid).toBe(false)
    expect(unterminatedString.result).toBe(false)
  })

  it('blocks prototype pollution attempts safely (A7)', () => {
    const polluted = evaluateConditionExpression('__proto__.polluted == true', context)
    expect(polluted.valid).toBe(true)
    expect(polluted.result).toBe(false)
  })
})
