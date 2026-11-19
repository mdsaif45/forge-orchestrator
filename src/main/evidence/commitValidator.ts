export const ALLOWED_COMMIT_TYPES: readonly string[] = [
  'feat',
  'fix',
  'docs',
  'style',
  'refactor',
  'perf',
  'test',
  'build',
  'ci',
  'chore',
  'revert',
]

export interface CommitFooter {
  readonly token: string
  readonly value: string
}

export interface CommitValidationResult {
  readonly valid: boolean
  readonly type?: string | undefined
  readonly scope?: string | undefined
  readonly subject?: string | undefined
  readonly isBreaking: boolean
  readonly body?: string | undefined
  readonly footers: readonly CommitFooter[]
  readonly errors: readonly string[]
  readonly formattedSummary: string
}

const CONVENTIONAL_HEADER_REGEX =
  /^(?<type>[a-z]+)(?:\((?<scope>[a-zA-Z0-9_.-]+)\))?(?<breaking>!)?:\s+(?<subject>[^\r\n]+)$/

/**
 * Validates a git commit message against Conventional Commits 1.0.0 and character ceilings (Axioms A3, A5).
 */
export function validateCommitMessage(rawMessage: string): CommitValidationResult {
  const trimmed = rawMessage.trim()
  const errors: string[] = []

  if (!trimmed) {
    return {
      valid: false,
      isBreaking: false,
      footers: [],
      errors: ['Commit message cannot be empty'],
      formattedSummary: 'COMMIT VALIDATION FAILED: Empty message',
    }
  }

  const lines = trimmed.split(/\r?\n/)
  const header = lines[0] ?? ''

  // 1. Header length constraint (Axiom A5)
  if (header.length > 100) {
    errors.push(
      `Commit header exceeds maximum length of 100 characters (actual: ${String(header.length)})`,
    )
  }

  // 2. Conventional regex match
  const match = CONVENTIONAL_HEADER_REGEX.exec(header)
  if (!match?.groups) {
    errors.push(
      'Commit header does not match Conventional Commits format "<type>(<scope>): <subject>"',
    )
    return {
      valid: false,
      isBreaking: false,
      footers: [],
      errors,
      formattedSummary: `COMMIT VALIDATION FAILED:\n  • ${errors.join('\n  • ')}`,
    }
  }

  const type = match.groups.type ?? ''
  const scope = match.groups.scope
  const breakingFlag = match.groups.breaking === '!'
  const subject = match.groups.subject ?? ''

  // 3. Allowed type check
  if (!ALLOWED_COMMIT_TYPES.includes(type)) {
    errors.push(`Unknown commit type "${type}". Allowed types: ${ALLOWED_COMMIT_TYPES.join(', ')}`)
  }

  // 4. Subject style checks
  if (subject.endsWith('.')) {
    errors.push('Commit subject description should not end with a period')
  }

  // 5. Body & Footer parsing
  let body: string | undefined
  const footers: CommitFooter[] = []
  let hasBreakingFooter = false

  if (lines.length > 1) {
    const rawBodyLines: string[] = []
    let inFooters = false

    for (let i = 1; i < lines.length; i++) {
      const line = lines[i] ?? ''
      // Blank line before footers
      if (line.trim() === '') {
        if (rawBodyLines.length > 0) rawBodyLines.push('')
        continue
      }

      // Check footer: "TOKEN: VALUE" or "BREAKING CHANGE: VALUE" or "TOKEN #VALUE"
      const footerColonMatch = /^(BREAKING(?: |-)CHANGE|[a-zA-Z0-9_-]+): (.+)$/.exec(line.trim())
      const footerHashMatch = /^([a-zA-Z0-9_-]+) #([0-9a-zA-Z_-]+)$/.exec(line.trim())

      if ((footerColonMatch || footerHashMatch) && (inFooters || i >= lines.length - 3)) {
        inFooters = true
        if (footerColonMatch) {
          const token = footerColonMatch[1] ?? ''
          const value = footerColonMatch[2] ?? ''
          if (token === 'BREAKING CHANGE' || token === 'BREAKING-CHANGE') {
            hasBreakingFooter = true
          }
          footers.push({ token, value })
        } else if (footerHashMatch) {
          const token = footerHashMatch[1] ?? ''
          const value = `#${footerHashMatch[2] ?? ''}`
          footers.push({ token, value })
        }
      } else {
        rawBodyLines.push(line)
      }
    }

    const joinedBody = rawBodyLines.join('\n').trim()
    if (joinedBody.length > 0) {
      body = joinedBody
    }
  }

  const isBreaking = breakingFlag || hasBreakingFooter
  const valid = errors.length === 0

  const summaryLines: string[] = [
    valid
      ? `COMMIT VALIDATION PASSED: [${type}${scope ? `(${scope})` : ''}] ${subject}${isBreaking ? ' (BREAKING CHANGE)' : ''}`
      : `COMMIT VALIDATION FAILED:\n  • ${errors.join('\n  • ')}`,
  ]

  return {
    valid,
    type,
    scope,
    subject,
    isBreaking,
    body,
    footers,
    errors,
    formattedSummary: summaryLines.join('\n'),
  }
}
