/**
 * EVIDENCE-012: Build and test log ANSI escape code stripper and diagnostic failure extractor.
 * Strips raw terminal formatting and extracts structured failure records from compiler/test output (Axioms A1, A3).
 */

export interface DiagnosticFailure {
  readonly category:
    'test_assertion' | 'type_error' | 'compiler_error' | 'runtime_exception' | 'generic'
  readonly file?: string | undefined
  readonly line?: number | undefined
  readonly column?: number | undefined
  readonly testName?: string | undefined
  readonly message: string
  readonly snippet?: string | undefined
}

export interface LogSanitizationResult {
  readonly cleanLog: string
  readonly removedAnsiSequences: number
  readonly totalLines: number
  readonly failureCount: number
  readonly failures: readonly DiagnosticFailure[]
  readonly formattedSummary: string
}

/* eslint-disable no-control-regex */
// ANSI Escape sequences: CSI, OSC, 2-byte escape sequences, carriage returns
const ANSI_REGEX = /[\u001b\u009b][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><]/g
const OSC_REGEX = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g
/* eslint-enable no-control-regex */

/**
 * Strips ANSI color codes, cursor sequences, and control artifacts from terminal output.
 */
export function stripAnsiCodes(rawText: string): { cleanText: string; count: number } {
  let count = 0

  const withoutOsc = rawText.replace(OSC_REGEX, () => {
    count++
    return ''
  })

  const clean = withoutOsc.replace(ANSI_REGEX, () => {
    count++
    return ''
  })

  // Normalize line endings
  const normalized = clean.replace(/\r\n/g, '\n').replace(/\r/g, '\n')

  return {
    cleanText: normalized,
    count,
  }
}

/**
 * Parses structured diagnostic failures from sanitized plaintext logs.
 */
export function extractDiagnosticFailures(cleanText: string): DiagnosticFailure[] {
  const failures: DiagnosticFailure[] = []
  const lines = cleanText.split('\n')

  // TypeScript compiler error: file.ts(12,34): error TS2345: Message
  const tsErrorRegex =
    /^([a-zA-Z0-9_\-./\\]+\.(?:ts|tsx|js|jsx))\((\d+),(\d+)\):\s*error\s*(TS\d+):\s*(.+)$/

  // GCC / Clang / Rust compiler error: file.rs:12:34: error: Message
  const genericCompilerRegex =
    /^([a-zA-Z0-9_\-./\\]+\.[a-zA-Z0-9]+):(\d+):(\d+):\s*(?:error|fatal):\s*(.+)$/

  // Vitest / Jest test failure marker: FAIL src/test.ts > suite > test name
  const vitestFailRegex = /^\s*FAIL\s+(.+?)(?:\s*>\s*(.+))?$/

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i]
    if (!rawLine) continue
    const line = rawLine.trim()

    // 1. TypeScript errors
    const tsMatch = tsErrorRegex.exec(line)
    if (tsMatch) {
      failures.push({
        category: 'type_error',
        file: tsMatch[1],
        line: Number(tsMatch[2]),
        column: Number(tsMatch[3]),
        message: `[${tsMatch[4] ?? ''}] ${tsMatch[5] ?? ''}`,
      })
      continue
    }

    // 2. Generic compiler errors
    const compilerMatch = genericCompilerRegex.exec(line)
    if (compilerMatch) {
      failures.push({
        category: 'compiler_error',
        file: compilerMatch[1],
        line: Number(compilerMatch[2]),
        column: Number(compilerMatch[3]),
        message: compilerMatch[4] ?? '',
      })
      continue
    }

    // 3. Test assertion failure headers
    const testMatch = vitestFailRegex.exec(line)
    if (testMatch) {
      const file = testMatch[1]?.trim()
      const testName = testMatch[2]?.trim()

      // Look ahead for AssertionError message
      let message = `Test failure in ${file ?? 'unknown file'}`
      let snippet: string | undefined

      for (let j = i + 1; j < Math.min(lines.length, i + 8); j++) {
        const nextLine = lines[j]?.trim() ?? ''
        if (/^(AssertionError|Error):/i.test(nextLine)) {
          message = nextLine
          if (lines[j + 1]?.trim()) {
            snippet = lines[j + 1]?.trim()
          }
          break
        }
      }

      failures.push({
        category: 'test_assertion',
        file,
        testName,
        message,
        snippet,
      })
      continue
    }

    // 4. Runtime unhandled exception / panic
    if (/^(uncaught exception|panic:|fatal error:)/i.test(line)) {
      failures.push({
        category: 'runtime_exception',
        message: line,
      })
    }
  }

  return failures
}

/**
 * Sanitizes a process execution log, stripping ANSI codes and extracting failure diagnostics.
 */
export function sanitizeExecutionLog(rawLog: string): LogSanitizationResult {
  const { cleanText, count } = stripAnsiCodes(rawLog)
  const lines = cleanText.split('\n')
  const failures = extractDiagnosticFailures(cleanText)

  const summary =
    failures.length === 0
      ? `✓ Clean log (${String(lines.length)} lines, stripped ${String(count)} ANSI sequences, 0 failures).`
      : `✗ Found ${String(failures.length)} diagnostic failure(s) in log (${String(lines.length)} lines, stripped ${String(count)} ANSI sequences).`

  return {
    cleanLog: cleanText,
    removedAnsiSequences: count,
    totalLines: lines.length,
    failureCount: failures.length,
    failures,
    formattedSummary: summary,
  }
}
