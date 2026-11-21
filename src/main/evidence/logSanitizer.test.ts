import { describe, it, expect } from 'vitest'
import { stripAnsiCodes, extractDiagnosticFailures, sanitizeExecutionLog } from './logSanitizer'

describe('LogSanitizer (EVIDENCE-012)', () => {
  it('strips ANSI SGR colors, cursor controls, and OSC hyperlinks', () => {
    const raw =
      '\u001b[31;1mError:\u001b[0m \u001b[32mBuild failed\u001b[0m\r\n\u001b]8;;http://example.com\u0007Click here\u001b]8;;\u0007'
    const res = stripAnsiCodes(raw)

    expect(res.cleanText).toBe('Error: Build failed\nClick here')
    expect(res.count).toBeGreaterThan(0)
  })

  it('extracts TypeScript compiler errors with line and column numbers', () => {
    const raw = `
src/main/core/runner.ts(45,12): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'.
packages/utils/math.ts(10,5): error TS2322: Type 'null' is not assignable to type 'string'.
`
    const failures = extractDiagnosticFailures(raw)
    expect(failures).toHaveLength(2)

    expect(failures[0]?.category).toBe('type_error')
    expect(failures[0]?.file).toBe('src/main/core/runner.ts')
    expect(failures[0]?.line).toBe(45)
    expect(failures[0]?.column).toBe(12)
    expect(failures[0]?.message).toContain('TS2345')

    expect(failures[1]?.category).toBe('type_error')
    expect(failures[1]?.file).toBe('packages/utils/math.ts')
    expect(failures[1]?.line).toBe(10)
    expect(failures[1]?.column).toBe(5)
  })

  it('extracts Vitest test assertion failures with test names and snippets', () => {
    const raw = `
 FAIL  src/main/app.test.ts > AppSuite > renders main window
AssertionError: expected false to be true
  - Expected
  + Received
`
    const failures = extractDiagnosticFailures(raw)
    expect(failures).toHaveLength(1)
    expect(failures[0]?.category).toBe('test_assertion')
    expect(failures[0]?.file).toBe('src/main/app.test.ts')
    expect(failures[0]?.testName).toBe('AppSuite > renders main window')
    expect(failures[0]?.message).toContain('AssertionError: expected false to be true')
    expect(failures[0]?.snippet).toBe('- Expected')
  })

  it('extracts generic compiler and runtime panics', () => {
    const raw = `
src/native/lib.rs:88:14: error: cannot find value 'ctx' in this scope
fatal error: out of memory
`
    const failures = extractDiagnosticFailures(raw)
    expect(failures).toHaveLength(2)
    expect(failures[0]?.category).toBe('compiler_error')
    expect(failures[0]?.file).toBe('src/native/lib.rs')
    expect(failures[0]?.line).toBe(88)

    expect(failures[1]?.category).toBe('runtime_exception')
    expect(failures[1]?.message).toContain('fatal error: out of memory')
  })

  it('produces structured end-to-end log sanitization report', () => {
    const raw = `\u001b[32mStarting build...\u001b[0m\n\u001b[31mFAIL src/test.ts > test1\u001b[0m\nAssertionError: failed\n`
    const report = sanitizeExecutionLog(raw)

    expect(report.cleanLog).not.toContain('\u001b')
    expect(report.removedAnsiSequences).toBeGreaterThan(0)
    expect(report.failureCount).toBe(1)
    expect(report.formattedSummary).toContain('Found 1 diagnostic failure(s)')
  })
})
