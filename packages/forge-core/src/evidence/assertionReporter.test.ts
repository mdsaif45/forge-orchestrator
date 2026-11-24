import { describe, expect, it } from 'vitest'
import { AssertionReportAggregator, type TestSuiteAssertion } from './assertionReporter'

describe('AssertionReportAggregator (EVIDENCE-010)', () => {
  const sampleSuitePass: TestSuiteAssertion = {
    name: 'Core Suite',
    durationMs: 1500,
    tests: [
      { name: 'boots headless', classname: 'CoreTest', durationMs: 500, status: 'passed' },
      { name: 'handles data dir', classname: 'CoreTest', durationMs: 1000, status: 'passed' },
    ],
  }

  const sampleSuiteFail: TestSuiteAssertion = {
    name: 'Workflow Suite',
    durationMs: 800,
    tests: [
      { name: 'plans DAG', durationMs: 400, status: 'passed' },
      {
        name: 'rejects cycle',
        durationMs: 300,
        status: 'failed',
        failureMessage: 'Circular dependency detected',
        failureType: 'AssertionError',
        failureDetails: 'expected false to be true',
      },
      { name: 'skipped step', durationMs: 100, status: 'skipped' },
    ],
  }

  it('aggregates multiple test suites and computes metrics', () => {
    const aggregator = new AssertionReportAggregator()
    aggregator.addSuite(sampleSuitePass)
    aggregator.addSuite(sampleSuiteFail)

    const summary = aggregator.summarize('junit')
    expect(summary.valid).toBe(false)
    expect(summary.totalSuites).toBe(2)
    expect(summary.totalTests).toBe(5)
    expect(summary.passedTests).toBe(3)
    expect(summary.failedTests).toBe(1)
    expect(summary.skippedTests).toBe(1)
    expect(summary.passRate).toBe(60)
  })

  it('generates valid JUnit XML with proper escaping and schema structure', () => {
    const aggregator = new AssertionReportAggregator()
    aggregator.addSuite(sampleSuitePass)
    aggregator.addSuite(sampleSuiteFail)

    const xml = aggregator.generateJUnitXml()
    expect(xml).toContain('<?xml version="1.0" encoding="UTF-8"?>')
    expect(xml).toContain('<testsuites tests="5" failures="1" skipped="1"')
    expect(xml).toContain('<testsuite name="Core Suite"')
    expect(xml).toContain('<testcase name="boots headless"')
    expect(xml).toContain('<failure message="Circular dependency detected"')
    expect(xml).toContain('<skipped />')
  })

  it('generates valid TAP v13 report with yaml diagnostics for failures', () => {
    const aggregator = new AssertionReportAggregator()
    aggregator.addSuite(sampleSuitePass)
    aggregator.addSuite(sampleSuiteFail)

    const tap = aggregator.generateTapV13()
    expect(tap).toContain('TAP version 13')
    expect(tap).toContain('1..5')
    expect(tap).toContain('ok 1 - Core Suite > boots headless')
    expect(tap).toContain('not ok 4 - Workflow Suite > rejects cycle')
    expect(tap).toContain('message: "Circular dependency detected"')
    expect(tap).toContain('ok 5 - Workflow Suite > skipped step # SKIP')
  })

  it('escapes XML special characters to prevent corrupted XML output', () => {
    const aggregator = new AssertionReportAggregator()
    aggregator.addSuite({
      name: 'Special & <Chars> "Suite"',
      tests: [
        {
          name: "check <script> & 'quote'",
          status: 'failed',
          failureMessage: 'Expected <foo> & <bar>',
        },
      ],
    })

    const xml = aggregator.generateJUnitXml()
    expect(xml).toContain('&amp;')
    expect(xml).toContain('&lt;Chars&gt;')
    expect(xml).toContain('&quot;Suite&quot;')
    expect(xml).not.toContain('<script>')
  })

  it('reports 100% pass rate and valid status when all tests pass', () => {
    const aggregator = new AssertionReportAggregator()
    aggregator.addSuite(sampleSuitePass)

    const summary = aggregator.summarize('tap')
    expect(summary.valid).toBe(true)
    expect(summary.failedTests).toBe(0)
    expect(summary.passRate).toBe(100)
    expect(summary.formattedSummary).toContain('CLEAN (ALL PASSED)')
  })
})
