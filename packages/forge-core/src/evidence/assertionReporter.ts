/**
 * EVIDENCE-010: Verification assertion result aggregator and JUnit/TAP reporter.
 * Harmonizes heterogeneous verification outputs and serializes standard JUnit XML and TAP v13 (Axioms A1, A3).
 */

export type TestAssertionStatus = 'passed' | 'failed' | 'skipped'

export interface TestCaseAssertion {
  readonly name: string
  readonly classname?: string | undefined
  readonly durationMs?: number | undefined
  readonly status: TestAssertionStatus
  readonly failureMessage?: string | undefined
  readonly failureType?: string | undefined
  readonly failureDetails?: string | undefined
}

export interface TestSuiteAssertion {
  readonly name: string
  readonly durationMs?: number | undefined
  readonly tests: readonly TestCaseAssertion[]
  readonly timestamp?: string | undefined
}

export interface AssertionReportSummary {
  readonly valid: boolean
  readonly format: 'junit' | 'tap'
  readonly totalSuites: number
  readonly totalTests: number
  readonly passedTests: number
  readonly failedTests: number
  readonly skippedTests: number
  readonly passRate: number
  readonly totalDurationMs: number
  readonly content: string
  readonly formattedSummary: string
}

function escapeXml(unsafe: string): string {
  return unsafe
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

/**
 * Aggregates verification assertions and serializes JUnit XML or TAP v13 reports.
 */
export class AssertionReportAggregator {
  private readonly suites: TestSuiteAssertion[] = []

  public addSuite(suite: TestSuiteAssertion): void {
    this.suites.push(suite)
  }

  public addAssertion(test: TestCaseAssertion, suiteName = 'default'): void {
    const existing = this.suites.find((s) => s.name === suiteName)
    if (existing) {
      // Cast readonly to mutable array for append
      ;(existing.tests as TestCaseAssertion[]).push(test)
    } else {
      this.suites.push({
        name: suiteName,
        tests: [test],
      })
    }
  }

  public getSuites(): readonly TestSuiteAssertion[] {
    return this.suites
  }

  public toJUnitXml(): string {
    return this.generateJUnitXml()
  }

  public toTap(): string {
    return this.generateTapV13()
  }

  public getSummary(format: 'junit' | 'tap' = 'junit'): AssertionReportSummary {
    return this.summarize(format)
  }

  public generateJUnitXml(): string {
    let totalTests = 0
    let totalFailures = 0
    let totalSkipped = 0
    let totalDurationMs = 0

    for (const suite of this.suites) {
      for (const t of suite.tests) {
        totalTests++
        if (t.status === 'failed') totalFailures++
        if (t.status === 'skipped') totalSkipped++
        totalDurationMs += t.durationMs ?? 0
      }
    }

    const durationSeconds = (totalDurationMs / 1000).toFixed(3)
    const xmlLines: string[] = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      `<testsuites tests="${String(totalTests)}" failures="${String(totalFailures)}" skipped="${String(totalSkipped)}" time="${durationSeconds}">`,
    ]

    for (const suite of this.suites) {
      let suiteFailures = 0
      let suiteSkipped = 0
      let suiteDurationMs = suite.durationMs ?? 0

      for (const t of suite.tests) {
        if (t.status === 'failed') suiteFailures++
        if (t.status === 'skipped') suiteSkipped++
        if (suite.durationMs === undefined) suiteDurationMs += t.durationMs ?? 0
      }

      const suiteDurationSec = (suiteDurationMs / 1000).toFixed(3)
      xmlLines.push(
        `  <testsuite name="${escapeXml(suite.name)}" tests="${String(suite.tests.length)}" failures="${String(suiteFailures)}" skipped="${String(suiteSkipped)}" time="${suiteDurationSec}">`,
      )

      for (const test of suite.tests) {
        const testDurationSec = ((test.durationMs ?? 0) / 1000).toFixed(3)
        const classAttr = test.classname ? ` classname="${escapeXml(test.classname)}"` : ''

        if (test.status === 'passed') {
          xmlLines.push(
            `    <testcase name="${escapeXml(test.name)}"${classAttr} time="${testDurationSec}" />`,
          )
        } else if (test.status === 'skipped') {
          xmlLines.push(
            `    <testcase name="${escapeXml(test.name)}"${classAttr} time="${testDurationSec}">`,
            '      <skipped />',
            '    </testcase>',
          )
        } else {
          const typeAttr = test.failureType ? ` type="${escapeXml(test.failureType)}"` : ''
          const msgAttr = test.failureMessage ? ` message="${escapeXml(test.failureMessage)}"` : ''
          xmlLines.push(
            `    <testcase name="${escapeXml(test.name)}"${classAttr} time="${testDurationSec}">`,
            `      <failure${msgAttr}${typeAttr}>${test.failureDetails ? escapeXml(test.failureDetails) : ''}</failure>`,
            '    </testcase>',
          )
        }
      }

      xmlLines.push('  </testsuite>')
    }

    xmlLines.push('</testsuites>')
    return xmlLines.join('\n')
  }

  public generateTapV13(): string {
    const allTests: { suiteName: string; test: TestCaseAssertion }[] = []
    for (const suite of this.suites) {
      for (const t of suite.tests) {
        allTests.push({ suiteName: suite.name, test: t })
      }
    }

    const lines: string[] = ['TAP version 13', `1..${String(allTests.length)}`]

    for (let i = 0; i < allTests.length; i++) {
      const item = allTests[i]
      if (!item) continue
      const { suiteName, test } = item
      const testNum = i + 1
      const fullName = `${suiteName} > ${test.name}`

      if (test.status === 'passed') {
        lines.push(`ok ${String(testNum)} - ${fullName}`)
      } else if (test.status === 'skipped') {
        lines.push(`ok ${String(testNum)} - ${fullName} # SKIP`)
      } else {
        lines.push(`not ok ${String(testNum)} - ${fullName}`)
        if (test.failureMessage || test.failureType || test.failureDetails) {
          lines.push('  ---')
          if (test.failureMessage)
            lines.push(`  message: "${test.failureMessage.replace(/"/g, '\\"')}"`)
          if (test.failureType) lines.push(`  severity: fail (${test.failureType})`)
          if (test.failureDetails) {
            lines.push('  data: |')
            for (const dLine of test.failureDetails.split('\n')) {
              lines.push(`    ${dLine}`)
            }
          }
          lines.push('  ...')
        }
      }
    }

    return lines.join('\n')
  }

  public summarize(format: 'junit' | 'tap' = 'junit'): AssertionReportSummary {
    let totalTests = 0
    let passedTests = 0
    let failedTests = 0
    let skippedTests = 0
    let totalDurationMs = 0

    for (const suite of this.suites) {
      for (const t of suite.tests) {
        totalTests++
        if (t.status === 'passed') passedTests++
        if (t.status === 'failed') failedTests++
        if (t.status === 'skipped') skippedTests++
        totalDurationMs += t.durationMs ?? 0
      }
    }

    const content = format === 'junit' ? this.generateJUnitXml() : this.generateTapV13()
    const passRate = totalTests > 0 ? (passedTests / totalTests) * 100 : 100
    const valid = failedTests === 0

    const summaryLines: string[] = [
      `VERIFICATION ASSERTION REPORT (${format.toUpperCase()} v${format === 'junit' ? 'XML' : '13'}):`,
      `  Suites:        ${String(this.suites.length)}`,
      `  Total Tests:   ${String(totalTests)}`,
      `  Passed:        ${String(passedTests)}`,
      `  Failed:        ${String(failedTests)}`,
      `  Skipped:       ${String(skippedTests)}`,
      `  Pass Rate:     ${passRate.toFixed(1)}%`,
      `  Duration:      ${String(totalDurationMs)}ms`,
      `  Status:        ${valid ? 'CLEAN (ALL PASSED)' : 'FAILURES DETECTED'}`,
    ]

    return {
      valid,
      format,
      totalSuites: this.suites.length,
      totalTests,
      passedTests,
      failedTests,
      skippedTests,
      passRate,
      totalDurationMs,
      content,
      formattedSummary: summaryLines.join('\n'),
    }
  }
}
