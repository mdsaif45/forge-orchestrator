/**
 * What these tests claim: a reviewer cannot approve a change the evidence contradicts.
 *
 * The asymmetry under test is deliberate and worth stating, because it looks
 * inconsistent until you price the two mistakes:
 *
 *   reviewer says FAIL  -> believed. a false FAIL costs one iteration.
 *   reviewer says PASS  -> checked. a false PASS closes a workflow over a red build.
 *
 * So a favourable claim gets scrutiny that an unfavourable one does not.
 */

import { describe, expect, it } from 'vitest'
import { assessReview, correctionConstraints, reviewReportSchema, type Finding } from './review'
import type { CriterionResult } from './completion'

const CHANGE_SET_ID = '11111111-1111-4111-8111-111111111111'
const STEP_ID = '22222222-2222-4222-8222-222222222222'
const NOW = '2026-08-19T00:00:00.000Z'

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: 'blocker',
    file: 'src/math.ts',
    line: 12,
    issue: 'The constant is still wrong',
    requiredChange: 'Set answer to 42',
    ...overrides,
  }
}

function review(overrides: Partial<Parameters<typeof reviewReportSchema.parse>[0]> = {}) {
  return reviewReportSchema.parse({
    changeSetId: CHANGE_SET_ID,
    stepId: STEP_ID,
    claimedVerdict: 'pass',
    findings: [],
    summary: 'Looks good',
    reviewedAt: NOW,
    ...(overrides as Record<string, unknown>),
  })
}

function criterion(overrides: Partial<CriterionResult> = {}): CriterionResult {
  return {
    kind: 'tests',
    description: 'the test suite passes',
    verdict: 'pass',
    reason: '`npm test` exited 0',
    evidenceId: null,
    ...overrides,
  }
}

describe('a reviewer claiming PASS on failing evidence', () => {
  it('is overridden to FAIL', () => {
    const outcome = assessReview(review({ claimedVerdict: 'pass' }), [
      criterion({ verdict: 'fail', reason: '`npm test` exited 1' }),
    ])

    // The definition of done for this issue: a reviewer claiming PASS on a red build
    // does not close the workflow.
    expect(outcome.verdict).toBe('fail')
    expect(outcome.overridden).toBe(true)
    expect(outcome.reason).toContain('cannot approve a change the evidence contradicts')
  })

  it('names the failing criterion in the correction, so the fix is actionable', () => {
    const outcome = assessReview(review(), [
      criterion({ verdict: 'fail', description: 'the build succeeds', reason: 'exited 2' }),
    ])

    expect(outcome.corrections.join('\n')).toContain('the build succeeds')
    expect(outcome.corrections.join('\n')).toContain('exited 2')
  })

  it('records UNKNOWN, not PASS, when a criterion could not be verified', () => {
    const outcome = assessReview(review(), [
      criterion({ verdict: 'unknown', reason: 'Forge ran no tests command' }),
    ])

    // Not a failure — nothing is known to be broken — but not an approval either.
    // `unknown` is what keeps the workflow from advancing (#35).
    expect(outcome.verdict).toBe('unknown')
    expect(outcome.overridden).toBe(true)
  })

  it('is overridden when the reviewer files a blocker alongside its own PASS', () => {
    const outcome = assessReview(
      review({ claimedVerdict: 'pass', findings: [finding({ severity: 'blocker' })] }),
      [criterion()],
    )

    // Self-contradiction, resolved pessimistically: the finding is concrete and the
    // verdict is a summary.
    expect(outcome.verdict).toBe('fail')
    expect(outcome.overridden).toBe(true)
  })

  it('is not overridden by a nit', () => {
    const outcome = assessReview(
      review({ claimedVerdict: 'pass', findings: [finding({ severity: 'nit' })] }),
      [criterion()],
    )

    // Otherwise a reviewer with opinions about naming could loop the workflow until
    // the iteration cap.
    expect(outcome.verdict).toBe('pass')
    expect(outcome.overridden).toBe(false)
  })
})

describe('a reviewer claiming FAIL', () => {
  it('is believed without checking the evidence', () => {
    const outcome = assessReview(
      review({ claimedVerdict: 'fail', findings: [finding()], summary: 'Still wrong' }),
      // Every criterion passes, and it still fails.
      [criterion({ verdict: 'pass' })],
    )

    // Nobody argues a change into being good. A false FAIL costs an iteration; the
    // asymmetry is priced deliberately.
    expect(outcome.verdict).toBe('fail')
    expect(outcome.overridden).toBe(false)
  })

  it('carries every finding forward, not only the blocking ones', () => {
    const outcome = assessReview(
      review({
        claimedVerdict: 'fail',
        findings: [finding({ severity: 'nit', issue: 'Name is unclear' }), finding()],
      }),
      [criterion()],
    )

    // A minor noted alongside a blocker is cheapest to fix in the same pass.
    expect(outcome.corrections).toHaveLength(2)
  })

  it('orders findings most severe first', () => {
    const outcome = assessReview(
      review({
        claimedVerdict: 'fail',
        findings: [
          finding({ severity: 'nit', issue: 'nit issue' }),
          finding({ severity: 'blocker', issue: 'blocker issue' }),
          finding({ severity: 'minor', issue: 'minor issue' }),
        ],
      }),
      [],
    )

    expect(outcome.corrections[0]).toContain('blocker issue')
    expect(outcome.corrections[2]).toContain('nit issue')
  })

  it('refuses a failing review that names no finding', () => {
    // A fail with nothing to act on would re-run the same work and rely on the
    // iteration cap to stop it.
    expect(() => review({ claimedVerdict: 'fail', findings: [] })).toThrow(
      /must name at least one finding/,
    )
  })
})

describe('a clean pass', () => {
  it('passes when the reviewer and every criterion agree', () => {
    const outcome = assessReview(review(), [criterion(), criterion({ kind: 'build' })])

    expect(outcome.verdict).toBe('pass')
    expect(outcome.overridden).toBe(false)
    expect(outcome.corrections).toEqual([])
  })

  it('passes with no criteria supplied, and says so rather than implying they were met', () => {
    const outcome = assessReview(review(), [])

    expect(outcome.verdict).toBe('pass')
    expect(outcome.reason).not.toContain('criteria are met')
  })
})

describe('findings as instructions', () => {
  it('includes the file and line when the finding has them', () => {
    const outcome = assessReview(
      review({ claimedVerdict: 'fail', findings: [finding({ file: 'src/a.ts', line: 7 })] }),
      [],
    )

    expect(outcome.corrections[0]).toContain('src/a.ts:7')
  })

  it('omits a location when the finding is about the change as a whole', () => {
    const outcome = assessReview(
      review({
        claimedVerdict: 'fail',
        findings: [finding({ file: null, line: null, issue: 'No tests were added' })],
      }),
      [],
    )

    expect(outcome.corrections[0]).toContain('No tests were added')
    expect(outcome.corrections[0]).not.toContain('(')
  })

  it('keeps the issue and the required change distinct', () => {
    const outcome = assessReview(
      review({
        claimedVerdict: 'fail',
        findings: [finding({ issue: 'Off by one', requiredChange: 'Use <= not <' })],
      }),
      [],
    )

    // Two readers: the issue explains the problem, the required change is what the
    // next agent is instructed to do. One prose blob would force it to infer both.
    expect(outcome.corrections[0]).toContain('Off by one')
    expect(outcome.corrections[0]).toContain('Use <= not <')
  })
})

describe('correction constraints', () => {
  it('keeps the original constraints ahead of the new instructions', () => {
    const outcome = assessReview(review({ claimedVerdict: 'fail', findings: [finding()] }), [])
    const constraints = correctionConstraints(['Do not touch migrations'], outcome)

    // A correction must not quietly widen its remit: whatever bounded the first
    // attempt still bounds the fix.
    expect(constraints[0]).toBe('Do not touch migrations')
    expect(constraints.join('\n')).toContain('Set answer to 42')
  })

  it('tells the correcting agent not to refactor adjacent code', () => {
    const outcome = assessReview(review({ claimedVerdict: 'fail', findings: [finding()] }), [])

    expect(correctionConstraints([], outcome).join('\n')).toContain('Do not refactor adjacent')
  })
})
