import type { TestCounts } from '@shared/domain'

/**
 * Best-effort extraction of test counts from a runner's own summary line.
 *
 * **These counts never decide anything.** The exit code is the verdict (A3); this
 * exists so a human reading the evidence, or a correction packet fed back to an
 * agent, carries "3 of 214 failed" rather than "exit 1". A parser that guesses
 * wrong must therefore degrade to `null`, never to a fabricated zero — a zero here
 * would read as "no failures" and quietly contradict the exit code.
 *
 * Formats are matched by keyword rather than by position, because the orderings are
 * not stable. Vitest prints `1 failed | 2 passed | 1 skipped (4)` on a mixed run but
 * `19 passed (19)` when nothing fails, so a parser reading the first number as the
 * total is wrong on one of the two. Both shapes were captured from real runs rather
 * than recalled.
 */
export function parseTestCounts(stdout: string, stderr: string): TestCounts | null {
  const text = `${stdout}\n${stderr}`

  // Ordered by specificity: a project may print output that resembles a second
  // runner's summary, and the first confident match wins.
  return parseVitestOrJest(text) ?? parseDotnet(text) ?? parseGoTest(text) ?? parsePytest(text)
}

/**
 * Vitest and Jest, whose summary lines are close enough to share a parser.
 *
 * ```
 * Tests  19 passed (19)
 * Tests  1 failed | 2 passed | 1 skipped (4)
 * Tests:  1 failed, 2 passed, 4 total          <- jest
 * ```
 *
 * The parenthesised or `total`-labelled figure is preferred over a sum, because a
 * runner that reports a category this parser does not know about (`todo`) would
 * otherwise produce a total smaller than reality.
 */
function parseVitestOrJest(text: string): TestCounts | null {
  const line = lastMatch(text, /^\s*Tests:?\s+(.+)$/gm)
  if (line === null) return null

  const passed = labelledCount(line, 'passed')
  const failed = labelledCount(line, 'failed')
  const skipped = labelledCount(line, /skipped|pending/)

  const parenthesised = /\((\d+)\)\s*$/.exec(line)
  const labelledTotal = labelledCount(line, 'total')
  const total =
    parenthesised?.[1] !== undefined
      ? Number(parenthesised[1])
      : (labelledTotal ?? sumOf([passed, failed, skipped]))

  if (passed === null && failed === null && total === null) return null

  return { total, passed, failed, skipped }
}

/**
 * `dotnet test`.
 *
 * ```
 * Passed!  - Failed:     0, Passed:    12, Skipped:     0, Total:    12
 * Failed!  - Failed:     2, Passed:    10, Skipped:     1, Total:    13
 * ```
 */
function parseDotnet(text: string): TestCounts | null {
  if (!/-\s*Failed:\s*\d+/.test(text)) return null

  const failed = labelledCountPrefixed(text, 'Failed')
  const passed = labelledCountPrefixed(text, 'Passed')
  const skipped = labelledCountPrefixed(text, 'Skipped')
  const total = labelledCountPrefixed(text, 'Total')

  if (total === null && passed === null && failed === null) return null

  return { total: total ?? sumOf([passed, failed, skipped]), passed, failed, skipped }
}

/**
 * `go test`, which reports per-package results and no aggregate count.
 *
 * Only the pass/fail shape is available, so the counts stay null and this exists to
 * avoid a later parser matching Go output by accident.
 */
function parseGoTest(text: string): TestCounts | null {
  if (!/^(ok|FAIL|---\s+(FAIL|PASS)):/m.test(text) && !/^(ok|FAIL)\s+\S+/m.test(text)) return null

  const passed = countOccurrences(text, /^\s*---\s+PASS:/gm)
  const failed = countOccurrences(text, /^\s*---\s+FAIL:/gm)
  const skipped = countOccurrences(text, /^\s*---\s+SKIP:/gm)

  if (passed === 0 && failed === 0 && skipped === 0) return null

  return { total: passed + failed + skipped, passed, failed, skipped }
}

/**
 * pytest.
 *
 * ```
 * ===== 12 passed, 1 skipped in 0.42s =====
 * ===== 2 failed, 10 passed in 1.1s =====
 * ```
 */
function parsePytest(text: string): TestCounts | null {
  const line = lastMatch(text, /^=+\s*(.*\b(?:passed|failed|error)\b.*?)\s*=+$/gm)
  if (line === null) return null

  const passed = countBefore(line, 'passed')
  const failed = sumOf([countBefore(line, 'failed'), countBefore(line, /errors?/)])
  const skipped = countBefore(line, 'skipped')

  if (passed === null && failed === null) return null

  return { total: sumOf([passed, failed, skipped]), passed, failed, skipped }
}

/** `12 passed` — the count preceding a label. */
function countBefore(text: string, label: string | RegExp): number | null {
  const source = typeof label === 'string' ? label : label.source
  return firstNumber(text, new RegExp(`(\\d+)\\s+(?:${source})\\b`, 'i'))
}

/** Either `12 passed` or `Passed: 12`, since runners disagree on which side wins. */
function labelledCount(text: string, label: string | RegExp): number | null {
  const source = typeof label === 'string' ? label : label.source
  return (
    firstNumber(text, new RegExp(`(\\d+)\\s+(?:${source})\\b`, 'i')) ??
    firstNumber(text, new RegExp(`(?:${source})\\s*[:=]\\s*(\\d+)`, 'i'))
  )
}

/** `Failed:     2` — dotnet's label-first form, which may repeat across lines. */
function labelledCountPrefixed(text: string, label: string): number | null {
  const matches = [...text.matchAll(new RegExp(`\\b${label}:\\s*(\\d+)`, 'gi'))]
  const last = matches[matches.length - 1]
  if (last === undefined) return null
  const value = last[1]
  return value === undefined ? null : Number(value)
}

function firstNumber(text: string, pattern: RegExp): number | null {
  const match = pattern.exec(text)
  if (match === null) return null
  const value = match[1]
  return value === undefined ? null : Number(value)
}

/**
 * The last match of a repeated pattern.
 *
 * Runners print a summary per project or per retry, and the final one is the
 * authoritative aggregate.
 */
function lastMatch(text: string, pattern: RegExp): string | null {
  const matches = [...text.matchAll(pattern)]
  const last = matches[matches.length - 1]
  if (last === undefined) return null
  return last[1] ?? null
}

function countOccurrences(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length
}

/**
 * Sums the known values, or returns null when none are known.
 *
 * A sum of nothing is null rather than zero: reporting zero tests when the parse
 * failed entirely would look like a real, empty run.
 */
function sumOf(values: readonly (number | null)[]): number | null {
  const known = values.filter((value): value is number => value !== null)
  if (known.length === 0) return null
  return known.reduce((total, value) => total + value, 0)
}
