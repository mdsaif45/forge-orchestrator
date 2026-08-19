/**
 * What these tests claim: parsed test counts are either right or absent, never
 * invented.
 *
 * These counts decide nothing — the exit code is the verdict — so the failure mode
 * that matters is a parser returning a confident zero where it should return null. A
 * zero reads as "no failures" and would quietly contradict the exit code sitting
 * next to it.
 *
 * The vitest fixtures below were captured from real runs rather than written from
 * memory, which is how the ordering difference surfaced: a passing run prints
 * `19 passed (19)` while a mixed run prints `1 failed | 2 passed | 1 skipped (4)`.
 * A parser reading the first number as the total is wrong on exactly one of those.
 */

import { describe, expect, it } from 'vitest'
import { parseTestCounts } from './testParsers'

describe('vitest output', () => {
  it('reads a run where everything passed', () => {
    const counts = parseTestCounts(
      [' Test Files  1 passed (1)', '      Tests  19 passed (19)', '   Start at  06:35:36'].join(
        '\n',
      ),
      '',
    )

    expect(counts).toEqual({ total: 19, passed: 19, failed: null, skipped: null })
  })

  it('reads a mixed run regardless of the order the categories appear in', () => {
    const counts = parseTestCounts(
      [' Test Files  1 failed (1)', '      Tests  1 failed | 2 passed | 1 skipped (4)'].join('\n'),
      '',
    )

    // The total comes from the parenthesised figure rather than a sum, so a category
    // this parser does not know about would not silently shrink the total.
    expect(counts).toEqual({ total: 4, passed: 2, failed: 1, skipped: 1 })
  })

  it('prefers the last summary when a run prints more than one', () => {
    const counts = parseTestCounts(
      ['      Tests  1 failed | 1 passed (2)', '      Tests  5 passed (5)'].join('\n'),
      '',
    )

    expect(counts?.total).toBe(5)
    expect(counts?.failed).toBeNull()
  })
})

describe('jest output', () => {
  it('reads the comma-separated form with an explicit total', () => {
    const counts = parseTestCounts('Tests:       1 failed, 2 passed, 4 total', '')

    expect(counts).toEqual({ total: 4, passed: 2, failed: 1, skipped: null })
  })

  it('counts pending as skipped', () => {
    const counts = parseTestCounts('Tests:       1 pending, 3 passed, 4 total', '')

    expect(counts?.skipped).toBe(1)
  })
})

describe('dotnet test output', () => {
  it('reads a passing run', () => {
    const counts = parseTestCounts(
      'Passed!  - Failed:     0, Passed:    12, Skipped:     0, Total:    12, Duration: 1 s',
      '',
    )

    expect(counts).toEqual({ total: 12, passed: 12, failed: 0, skipped: 0 })
  })

  it('reads a failing run', () => {
    const counts = parseTestCounts(
      'Failed!  - Failed:     2, Passed:    10, Skipped:     1, Total:    13',
      '',
    )

    expect(counts).toEqual({ total: 13, passed: 10, failed: 2, skipped: 1 })
  })
})

describe('pytest output', () => {
  it('reads a passing run', () => {
    const counts = parseTestCounts('===== 12 passed, 1 skipped in 0.42s =====', '')

    expect(counts).toEqual({ total: 13, passed: 12, failed: null, skipped: 1 })
  })

  it('folds errors in with failures', () => {
    const counts = parseTestCounts('===== 2 failed, 1 error, 10 passed in 1.1s =====', '')

    // An error and a failure are both "did not pass" for the purpose of a summary
    // line; the raw output is kept for anyone who needs the distinction.
    expect(counts?.failed).toBe(3)
  })
})

describe('go test output', () => {
  it('counts per-test result lines, since go prints no aggregate', () => {
    const counts = parseTestCounts(
      [
        '=== RUN   TestOne',
        '--- PASS: TestOne (0.00s)',
        '=== RUN   TestTwo',
        '--- FAIL: TestTwo (0.01s)',
        '--- SKIP: TestThree (0.00s)',
        'FAIL',
        'FAIL\texample.com/pkg\t0.015s',
      ].join('\n'),
      '',
    )

    expect(counts).toEqual({ total: 3, passed: 1, failed: 1, skipped: 1 })
  })
})

describe('output a parser cannot read', () => {
  it('returns null rather than a fabricated zero', () => {
    // The important case. A zero here would read as "nothing failed" and contradict
    // whatever the exit code says.
    expect(parseTestCounts('Building...\nDone in 4.2s\n', '')).toBeNull()
  })

  it('returns null for empty output', () => {
    expect(parseTestCounts('', '')).toBeNull()
  })

  it('reads a summary that arrived on stderr', () => {
    // Runners disagree about which stream a summary belongs on, so both are searched.
    const counts = parseTestCounts('', '      Tests  7 passed (7)')

    expect(counts?.passed).toBe(7)
  })
})
