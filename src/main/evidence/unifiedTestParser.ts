/**
 * EVIDENCE-013: JUnit XML and TAP Test Results Structured Parser
 *
 * Parses test execution outputs across diverse testing frameworks (Jest, Vitest,
 * Pytest, node:test, Go test, Cargo test) in either JUnit XML format or TAP (Test
 * Anything Protocol) streams into a unified, structured assertion matrix.
 *
 * Conforms to Forge Axioms:
 * - A1: Fail-closed verification and strict typing (zero `any`).
 * - A3: Physical evidence over claims - inspects actual machine-readable test outputs.
 * - A5: Bounded processing and formatted summaries.
 */

export interface TestCaseResult {
  readonly name: string
  readonly suite: string
  readonly status: 'passed' | 'failed' | 'skipped'
  readonly durationMs: number
  readonly failureMessage?: string | undefined
  readonly stackTrace?: string | undefined
}

export interface TestSuiteResult {
  readonly name: string
  readonly total: number
  readonly passed: number
  readonly failed: number
  readonly skipped: number
  readonly durationMs: number
  readonly tests: readonly TestCaseResult[]
}

export interface UnifiedTestReport {
  readonly format: 'junit' | 'tap' | 'unknown'
  readonly totalSuites: number
  readonly totalTests: number
  readonly passed: number
  readonly failed: number
  readonly skipped: number
  readonly totalDurationMs: number
  readonly suites: readonly TestSuiteResult[]
  readonly verdict: 'pass' | 'fail'
  readonly formattedSummary: string
}

function decodeXmlEntities(val: string): string {
  return val
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
}

function stripCdata(val: string): string {
  return val.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
}

interface RawSuiteMatch {
  attributes: string
  body: string
}

interface RawCaseMatch {
  attributes: string
  body: string
}

/**
 * Parses JUnit XML format test reports into a UnifiedTestReport.
 */
export function parseJUnitXmlReport(xmlContent: string): UnifiedTestReport {
  const suites: TestSuiteResult[] = []

  // Extract <testsuite> elements: either self-closing or paired
  const suiteRegex = /<testsuite\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testsuite>)/gi
  const parsedSuites: RawSuiteMatch[] = []

  let suiteMatch: RegExpExecArray | null
  while ((suiteMatch = suiteRegex.exec(xmlContent)) !== null) {
    parsedSuites.push({
      attributes: suiteMatch[1] ?? '',
      body: suiteMatch[2] ?? '',
    })
  }

  // If no <testsuite> tag found but <testcase> tags exist, treat root as default suite
  if (parsedSuites.length === 0 && /<testcase\b/i.test(xmlContent)) {
    parsedSuites.push({
      attributes: '',
      body: xmlContent,
    })
  }

  for (const rawSuite of parsedSuites) {
    const nameMatch = /\bname="([^"]*)"/i.exec(rawSuite.attributes)
    const suiteName = nameMatch?.[1] ? decodeXmlEntities(nameMatch[1]) : 'default'

    const timeMatch = /\btime="([^"]*)"/i.exec(rawSuite.attributes)
    const suiteDurationSec = timeMatch?.[1] ? parseFloat(timeMatch[1]) : 0
    const suiteDurationMs = isNaN(suiteDurationSec) ? 0 : Math.round(suiteDurationSec * 1000)

    // Extract testcase elements
    const testCases: TestCaseResult[] = []
    const caseRegex = /<testcase\b([^>]*?)(?:\/>|>([\s\S]*?)<\/testcase>)/gi
    const caseMatches: RawCaseMatch[] = []

    let caseMatch: RegExpExecArray | null
    while ((caseMatch = caseRegex.exec(rawSuite.body)) !== null) {
      caseMatches.push({
        attributes: caseMatch[1] ?? '',
        body: caseMatch[2] ?? '',
      })
    }

    for (const rawCase of caseMatches) {
      const caseNameMatch = /\bname="([^"]*)"/i.exec(rawCase.attributes)
      const caseClassMatch = /\bclassname="([^"]*)"/i.exec(rawCase.attributes)
      const caseTimeMatch = /\btime="([^"]*)"/i.exec(rawCase.attributes)

      const testName = caseNameMatch?.[1] ? decodeXmlEntities(caseNameMatch[1]) : 'unnamed-test'
      const testClass = caseClassMatch?.[1] ? decodeXmlEntities(caseClassMatch[1]) : suiteName
      const caseDurationSec = caseTimeMatch?.[1] ? parseFloat(caseTimeMatch[1]) : 0
      const caseDurationMs = isNaN(caseDurationSec) ? 0 : Math.round(caseDurationSec * 1000)

      let status: 'passed' | 'failed' | 'skipped' = 'passed'
      let failureMessage: string | undefined
      let stackTrace: string | undefined

      // Check failure / error
      const failMatch = /<(failure|error)\b([^>]*?)(?:\/>|>([\s\S]*?)<\/\1>)/i.exec(rawCase.body)
      if (failMatch) {
        status = 'failed'
        const attrPart = failMatch[2] ?? ''
        const bodyPart = failMatch[3] ?? ''

        const msgMatch = /\bmessage="([^"]*)"/i.exec(attrPart)
        if (msgMatch?.[1]) {
          failureMessage = decodeXmlEntities(msgMatch[1])
        }

        const cleanedBody = stripCdata(bodyPart).trim()
        if (cleanedBody) {
          failureMessage ??= cleanedBody.split('\n')[0]
          stackTrace = cleanedBody
        }
      } else if (/<skipped\b/i.test(rawCase.body) || /<skipped\b/i.test(rawCase.attributes)) {
        status = 'skipped'
      }

      testCases.push({
        name: testName,
        suite: testClass,
        status,
        durationMs: caseDurationMs,
        ...(failureMessage !== undefined ? { failureMessage } : {}),
        ...(stackTrace !== undefined ? { stackTrace } : {}),
      })
    }

    const total = testCases.length
    const passed = testCases.filter((t) => t.status === 'passed').length
    const failed = testCases.filter((t) => t.status === 'failed').length
    const skipped = testCases.filter((t) => t.status === 'skipped').length

    suites.push({
      name: suiteName,
      total,
      passed,
      failed,
      skipped,
      durationMs: suiteDurationMs,
      tests: testCases,
    })
  }

  const totalSuites = suites.length
  const totalTests = suites.reduce((acc, s) => acc + s.total, 0)
  const passed = suites.reduce((acc, s) => acc + s.passed, 0)
  const failed = suites.reduce((acc, s) => acc + s.failed, 0)
  const skipped = suites.reduce((acc, s) => acc + s.skipped, 0)
  const totalDurationMs = suites.reduce((acc, s) => acc + s.durationMs, 0)
  const verdict: 'pass' | 'fail' = failed === 0 ? 'pass' : 'fail'

  const formattedSummary =
    `[JUnit XML Report] Verdict: ${verdict.toUpperCase()} | ` +
    `Suites: ${String(totalSuites)} | Tests: ${String(totalTests)} (Passed: ${String(passed)}, Failed: ${String(failed)}, Skipped: ${String(skipped)}) | ` +
    `Duration: ${String(totalDurationMs)}ms`

  return {
    format: 'junit',
    totalSuites,
    totalTests,
    passed,
    failed,
    skipped,
    totalDurationMs,
    suites,
    verdict,
    formattedSummary,
  }
}

/**
 * Parses TAP (Test Anything Protocol) version 12/13/14 stream into a UnifiedTestReport.
 */
export function parseTapStreamReport(tapContent: string): UnifiedTestReport {
  const lines = tapContent.split(/\r?\n/)
  const tests: TestCaseResult[] = []

  let currentSuite = 'TAP Test Suite'
  let currentTest: TestCaseResult | null = null
  let inYamlBlock = false
  let yamlLines: string[] = []

  for (const rawLine of lines) {
    const line = rawLine.trim()

    // Subtest header check
    const subtestMatch = /^#\s*Subtest:\s*(.+)$/i.exec(line)
    if (subtestMatch?.[1]) {
      currentSuite = subtestMatch[1].trim()
      continue
    }

    // YAML diagnostic block delimiter
    if (line === '---') {
      inYamlBlock = true
      yamlLines = []
      continue
    }
    if (line === '...' && inYamlBlock) {
      inYamlBlock = false
      if (currentTest?.status === 'failed') {
        const stackText = yamlLines.join('\n').trim()
        const messageMatch = /message:\s*['"]?([^'"]+)['"]?/i.exec(stackText)
        const failureMessage = messageMatch?.[1] ? messageMatch[1] : stackText.split('\n')[0]
        // Update current test with diagnostic details
        const idx = tests.findIndex((t) => t === currentTest)
        if (idx !== -1 && currentTest) {
          tests[idx] = {
            ...currentTest,
            failureMessage,
            stackTrace: stackText,
          }
        }
      }
      continue
    }
    if (inYamlBlock) {
      yamlLines.push(line)
      continue
    }

    // ok / not ok line
    const testLineMatch =
      /^(ok|not ok)\s+(\d+)?\s*(.*?)(?:#\s*(SKIP|TODO|skip|todo)\b\s*(.*))?$/i.exec(line)
    if (testLineMatch?.[1]) {
      const okStatus = testLineMatch[1].toLowerCase()
      let rawName = testLineMatch[3]?.trim() ?? `test-${String(tests.length + 1)}`
      const directive = testLineMatch[4]?.toUpperCase()
      const directiveReason = testLineMatch[5]?.trim()

      let status: 'passed' | 'failed' | 'skipped' = okStatus === 'ok' ? 'passed' : 'failed'
      if (directive === 'SKIP' || directive === 'TODO') {
        status = 'skipped'
      }

      // Check duration e.g. "test name # time=12.34ms"
      let durationMs = 0
      const timeMatch = /#\s*time=([\d.]+)\s*(ms|s)/i.exec(line)
      if (timeMatch?.[1] && timeMatch[2]) {
        const val = parseFloat(timeMatch[1])
        durationMs = timeMatch[2].toLowerCase() === 's' ? Math.round(val * 1000) : Math.round(val)
      }

      // Clean comment suffixes and leading hyphens from rawName
      rawName = rawName
        .replace(/#.*$/, '')
        .replace(/^[-–—\s]+/, '')
        .trim()

      const testCase: TestCaseResult = {
        name: rawName,
        suite: currentSuite,
        status,
        durationMs,
        ...(directiveReason !== undefined ? { failureMessage: directiveReason } : {}),
      }

      currentTest = testCase
      tests.push(testCase)
    }
  }

  const passed = tests.filter((t) => t.status === 'passed').length
  const failed = tests.filter((t) => t.status === 'failed').length
  const skipped = tests.filter((t) => t.status === 'skipped').length
  const totalDurationMs = tests.reduce((acc, t) => acc + t.durationMs, 0)

  const suite: TestSuiteResult = {
    name: currentSuite,
    total: tests.length,
    passed,
    failed,
    skipped,
    durationMs: totalDurationMs,
    tests,
  }

  const verdict: 'pass' | 'fail' = failed === 0 ? 'pass' : 'fail'
  const formattedSummary =
    `[TAP Stream Report] Verdict: ${verdict.toUpperCase()} | ` +
    `Suites: 1 | Tests: ${String(tests.length)} (Passed: ${String(passed)}, Failed: ${String(failed)}, Skipped: ${String(skipped)}) | ` +
    `Duration: ${String(totalDurationMs)}ms`

  return {
    format: 'tap',
    totalSuites: tests.length > 0 ? 1 : 0,
    totalTests: tests.length,
    passed,
    failed,
    skipped,
    totalDurationMs,
    suites: tests.length > 0 ? [suite] : [],
    verdict,
    formattedSummary,
  }
}

/**
 * Universal auto-detecting test report parser.
 */
export function parseUniversalTestReport(
  content: string,
  formatHint?: 'junit' | 'tap' | 'auto',
): UnifiedTestReport {
  const trimmed = content.trim()
  if (!trimmed) {
    return {
      format: 'unknown',
      totalSuites: 0,
      totalTests: 0,
      passed: 0,
      failed: 0,
      skipped: 0,
      totalDurationMs: 0,
      suites: [],
      verdict: 'pass',
      formattedSummary: '[Empty Test Report] No tests found.',
    }
  }

  const hint = formatHint ?? 'auto'

  if (hint === 'junit') {
    return parseJUnitXmlReport(trimmed)
  }
  if (hint === 'tap') {
    return parseTapStreamReport(trimmed)
  }

  // Auto-detection
  if (trimmed.startsWith('<') || trimmed.includes('<testcase')) {
    return parseJUnitXmlReport(trimmed)
  }

  if (/^(TAP version|1\.\.\d+|ok\b|not ok\b)/m.test(trimmed)) {
    return parseTapStreamReport(trimmed)
  }

  return {
    format: 'unknown',
    totalSuites: 0,
    totalTests: 0,
    passed: 0,
    failed: 1,
    skipped: 0,
    totalDurationMs: 0,
    suites: [],
    verdict: 'fail',
    formattedSummary: '[Unknown Test Report Format] Unable to determine test format from contents.',
  }
}
