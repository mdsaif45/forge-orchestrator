export type SecretSeverity = 'critical' | 'high' | 'medium'

export interface SecretViolation {
  readonly rule: string
  readonly severity: SecretSeverity
  readonly filePath?: string | undefined
  readonly line?: number | undefined
  readonly redactedMatch: string
  readonly entropy?: number | undefined
}

export interface SecretScanResult {
  readonly valid: boolean
  readonly hasLeaks: boolean
  readonly violations: readonly SecretViolation[]
  readonly formattedSummary: string
}

export interface SecretPattern {
  readonly name: string
  readonly severity: SecretSeverity
  readonly regex: RegExp
}

const BUILTIN_SECRET_PATTERNS: readonly SecretPattern[] = [
  {
    name: 'Private Cryptographic Key',
    severity: 'critical',
    regex: /-----BEGIN\s+(?:RSA|OPENSSH|EC|DSA|PGP)?\s*PRIVATE KEY-----/i,
  },
  {
    name: 'AWS Access Key ID',
    severity: 'critical',
    regex: /\b(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}\b/,
  },
  {
    name: 'OpenAI API Key',
    severity: 'critical',
    regex: /\bsk-(?:proj-|admin-|live-)?[a-zA-Z0-9_-]{24,}\b/,
  },
  {
    name: 'AI Model Service Key (sk-ant)',
    severity: 'critical',
    regex: /\bsk-ant-[a-zA-Z0-9_-]{24,}\b/,
  },
  {
    name: 'GitHub Access Token',
    severity: 'critical',
    regex: /\bgh[pousr]_[A-Za-z0-9_]{36,}\b/,
  },
  {
    name: 'JSON Web Token (JWT)',
    severity: 'high',
    regex: /\beyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]+\b/,
  },
  {
    name: 'Database URI with Credentials',
    severity: 'critical',
    regex: /(?:postgres|postgresql|mysql|mongodb|redis):\/\/[a-zA-Z0-9_]+:[^@\s]+@[a-zA-Z0-9.-]+/i,
  },
]

/**
 * Calculates Shannon entropy (bits per character) of a string to detect high-entropy keys (Axiom A7).
 */
export function calculateShannonEntropy(str: string): number {
  if (!str) return 0
  const len = str.length
  const freq = new Map<string, number>()

  for (let i = 0; i < len; i++) {
    const char = str[i]
    if (char) {
      freq.set(char, (freq.get(char) ?? 0) + 1)
    }
  }

  let entropy = 0
  for (const count of freq.values()) {
    const p = count / len
    entropy -= p * Math.log2(p)
  }

  return Math.round(entropy * 100) / 100
}

/**
 * Redacts secret string to prevent leaking sensitive values in diagnostic logs.
 */
export function redactSecret(secret: string): string {
  if (secret.length <= 6) return '******'
  const prefix = secret.slice(0, 3)
  const suffix = secret.slice(-2)
  return `${prefix}****${suffix}`
}

/**
 * Scans arbitrary text content for sensitive credential patterns and high-entropy strings (Axioms A3, A7).
 */
export function scanTextForSecretLeaks(text: string, filePath?: string): SecretScanResult {
  const violations: SecretViolation[] = []
  const lines = text.split(/\r?\n/)

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const lineText = lines[lineIdx]
    if (!lineText) continue

    // 1. Pattern checks
    for (const pattern of BUILTIN_SECRET_PATTERNS) {
      const match = pattern.regex.exec(lineText)
      if (match?.[0]) {
        violations.push({
          rule: pattern.name,
          severity: pattern.severity,
          filePath,
          line: lineIdx + 1,
          redactedMatch: redactSecret(match[0]),
        })
      }
    }

    // 2. High-entropy token checks (base64 or hex tokens > 28 chars with entropy > 4.5)
    const tokenRegex = /\b[A-Za-z0-9+/=_-]{32,}\b/g
    let tokenMatch: RegExpExecArray | null
    while ((tokenMatch = tokenRegex.exec(lineText)) !== null) {
      const rawToken = tokenMatch[0]
      if (
        !rawToken.includes('//') &&
        !rawToken.startsWith('http') &&
        !rawToken.includes('node_modules')
      ) {
        const entropy = calculateShannonEntropy(rawToken)
        if (entropy >= 4.6) {
          violations.push({
            rule: 'High-Entropy Secret Token',
            severity: 'high',
            filePath,
            line: lineIdx + 1,
            redactedMatch: redactSecret(rawToken),
            entropy,
          })
        }
      }
    }
  }

  const hasLeaks = violations.length > 0
  const summaryLines: string[] = [
    hasLeaks
      ? `SECRET LEAK AUDIT: FAILED (${String(violations.length)} potential credential leak(s) detected)`
      : 'SECRET LEAK AUDIT: PASSED (No credential leaks detected)',
  ]

  if (hasLeaks) {
    for (const v of violations) {
      const loc = v.filePath
        ? `${v.filePath}:${String(v.line ?? 0)}`
        : `line ${String(v.line ?? 0)}`
      const entropyInfo = v.entropy ? ` (entropy: ${String(v.entropy)})` : ''
      summaryLines.push(
        `  • [${v.severity.toUpperCase()}] ${v.rule} at ${loc}: ${v.redactedMatch}${entropyInfo}`,
      )
    }
  }

  return {
    valid: !hasLeaks,
    hasLeaks,
    violations,
    formattedSummary: summaryLines.join('\n'),
  }
}

/**
 * Scans unified git diff text, inspecting only added lines (`+`) to prevent commits from leaking secrets.
 */
export function scanDiffForSecretLeaks(diffText: string): SecretScanResult {
  const diffLines = diffText.split(/\r?\n/)
  const violations: SecretViolation[] = []
  let currentFile: string | undefined

  for (let i = 0; i < diffLines.length; i++) {
    const line = diffLines[i]
    if (!line) continue

    if (line.startsWith('diff --git ')) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line)
      currentFile = match?.[2] ? match[2].replace(/\\/g, '/') : undefined
      continue
    }

    // Only scan newly added code lines (+)
    if (line.startsWith('+') && !line.startsWith('+++')) {
      const addition = line.slice(1)
      const scan = scanTextForSecretLeaks(addition, currentFile)
      for (const v of scan.violations) {
        violations.push({
          ...v,
          line: i + 1,
        })
      }
    }
  }

  const hasLeaks = violations.length > 0
  const summaryLines: string[] = [
    hasLeaks
      ? `DIFF SECRET AUDIT: FAILED (${String(violations.length)} potential credential leak(s) in changeset)`
      : 'DIFF SECRET AUDIT: PASSED (No credential leaks detected in changeset)',
  ]

  if (hasLeaks) {
    for (const v of violations) {
      const loc = v.filePath
        ? `${v.filePath}:diff-line-${String(v.line ?? 0)}`
        : `diff-line-${String(v.line ?? 0)}`
      summaryLines.push(`  • [${v.severity.toUpperCase()}] ${v.rule} at ${loc}: ${v.redactedMatch}`)
    }
  }

  return {
    valid: !hasLeaks,
    hasLeaks,
    violations,
    formattedSummary: summaryLines.join('\n'),
  }
}
