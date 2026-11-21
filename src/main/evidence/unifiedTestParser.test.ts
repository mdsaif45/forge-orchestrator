import { describe, it, expect } from 'vitest'
import {
  parseJUnitXmlReport,
  parseTapStreamReport,
  parseUniversalTestReport,
} from './unifiedTestParser'

describe('unifiedTestParser (EVIDENCE-013)', () => {
  it('parses multi-suite JUnit XML with passing, failing, and skipped test cases', () => {
    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="Forge Core Suite" time="1.25">
  <testsuite name="AgentSuite" time="0.75" tests="2" failures="1" errors="0" skipped="0">
    <testcase name="should initialize context" classname="AgentSuite" time="0.25" />
    <testcase name="should handle quota limit" classname="AgentSuite" time="0.50">
      <failure message="Quota limit exceeded error">
        <![CDATA[Error: Quota limit exceeded error
            at AgentRuntime.execute (agent.ts:120:15)]]>
      </failure>
    </testcase>
  </testsuite>
  <testsuite name="WorkflowSuite" time="0.50" tests="2" failures="0" errors="0" skipped="1">
    <testcase name="should plan DAG" classname="WorkflowSuite" time="0.30" />
    <testcase name="should test cycle detection" classname="WorkflowSuite" time="0.20">
      <skipped message="Pending integration environment" />
    </testcase>
  </testsuite>
</testsuites>`

    const report = parseJUnitXmlReport(xml)

    expect(report.format).toBe('junit')
    expect(report.totalSuites).toBe(2)
    expect(report.totalTests).toBe(4)
    expect(report.passed).toBe(2)
    expect(report.failed).toBe(1)
    expect(report.skipped).toBe(1)
    expect(report.verdict).toBe('fail')
    expect(report.totalDurationMs).toBe(1250)

    const agentSuite = report.suites[0]
    expect(agentSuite).toBeDefined()
    if (!agentSuite) throw new Error('agentSuite missing')
    expect(agentSuite.name).toBe('AgentSuite')
    expect(agentSuite.tests[1]?.failureMessage).toBe('Quota limit exceeded error')
    expect(agentSuite.tests[1]?.stackTrace).toContain('AgentRuntime.execute')
  })

  it('parses single testsuite JUnit XML directly', () => {
    const xml = `<testsuite name="SingleSuite" time="0.45" tests="2">
      <testcase name="pass_1" time="0.2" />
      <testcase name="pass_2" time="0.25" />
    </testsuite>`

    const report = parseJUnitXmlReport(xml)
    expect(report.verdict).toBe('pass')
    expect(report.totalTests).toBe(2)
    expect(report.passed).toBe(2)
    expect(report.failed).toBe(0)
  })

  it('parses TAP version 13 stream with YAML diagnostic blocks and skip directives', () => {
    const tap = `TAP version 13
# Subtest: CoreEngineTests
1..3
ok 1 - should boot engine # time=45ms
not ok 2 - should validate token signature # time=82ms
  ---
  message: 'Invalid signature digest'
  severity: fail
  stack: |-
    Error: Invalid signature digest
      at TokenVerifier.verify (/src/token.ts:50:11)
  ...
ok 3 - should bypass cache when invalidated # SKIP caching disabled in test env`

    const report = parseTapStreamReport(tap)

    expect(report.format).toBe('tap')
    expect(report.totalTests).toBe(3)
    expect(report.passed).toBe(1)
    expect(report.failed).toBe(1)
    expect(report.skipped).toBe(1)
    expect(report.verdict).toBe('fail')

    const failedTest = report.suites[0]?.tests[1]
    expect(failedTest).toBeDefined()
    if (!failedTest) throw new Error('failedTest missing')
    expect(failedTest.name).toBe('should validate token signature')
    expect(failedTest.failureMessage).toBe('Invalid signature digest')
    expect(failedTest.durationMs).toBe(82)
    expect(failedTest.stackTrace).toContain('TokenVerifier.verify')
  })

  it('auto-detects XML and TAP formats in parseUniversalTestReport', () => {
    const xml = `<testsuite name="autoXml"><testcase name="t1" /></testsuite>`
    const tap = `1..1\nok 1 - tap test`

    const xmlReport = parseUniversalTestReport(xml)
    expect(xmlReport.format).toBe('junit')
    expect(xmlReport.verdict).toBe('pass')

    const tapReport = parseUniversalTestReport(tap)
    expect(tapReport.format).toBe('tap')
    expect(tapReport.verdict).toBe('pass')
  })

  it('handles empty or unrecognized input safely', () => {
    const emptyReport = parseUniversalTestReport('')
    expect(emptyReport.format).toBe('unknown')
    expect(emptyReport.verdict).toBe('pass')
    expect(emptyReport.totalTests).toBe(0)

    const invalidReport = parseUniversalTestReport('some random text without structure')
    expect(invalidReport.format).toBe('unknown')
    expect(invalidReport.verdict).toBe('fail')
  })
})
