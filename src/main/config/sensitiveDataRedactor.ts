/**
 * CONFIG-015: Workspace environment variable obfuscator and sensitive data redaction filter.
 * Prevents accidental credential leaks in diagnostic dumps, command outputs, and run metadata (Axioms A2, A7).
 */

export interface RedactionRule {
  readonly name: string
  readonly pattern: RegExp
  readonly mask: (match: string) => string
}

export interface RedactionAudit {
  readonly sanitizedText: string
  readonly totalRedactions: number
  readonly matchesByRule: Readonly<Record<string, number>>
  readonly formattedSummary: string
}

export interface EnvRedactionOptions {
  readonly customSensitiveKeys?: readonly string[] | undefined
  readonly allowedKeys?: readonly string[] | undefined
  readonly maskValue?: string | undefined
}

export const DEFAULT_REDACTION_RULES: readonly RedactionRule[] = [
  {
    name: 'standard_api_key',
    pattern: /\b(sk-[a-zA-Z0-9_-]{16,})\b/g,
    mask: (val: string) => {
      const prefix = val.slice(0, 7)
      return `${prefix}...[REDACTED_API_KEY]`
    },
  },
  {
    name: 'github_personal_token',
    pattern: /\b(gh[pousr]_[a-zA-Z0-9]{30,}|github_pat_[a-zA-Z0-9_]{50,})\b/g,
    mask: (val: string) => {
      const prefix = val.slice(0, 4)
      return `${prefix}...[REDACTED_GITHUB_TOKEN]`
    },
  },
  {
    name: 'bearer_token',
    pattern: /\b(Bearer\s+)([a-zA-Z0-9_.-]{20,})\b/gi,
    mask: (_val: string) => `Bearer [REDACTED_BEARER_TOKEN]`,
  },
  {
    name: 'jwt_token',
    pattern: /\b(eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]+)\b/g,
    mask: (_val: string) => `[REDACTED_JWT_TOKEN]`,
  },
  {
    name: 'private_key_block',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    mask: (_val: string) => `[REDACTED_PRIVATE_KEY_BLOCK]`,
  },
  {
    name: 'db_connection_url',
    pattern: /([a-zA-Z0-9+]+:\/\/)([^:\s]+):([^@\s]+)@/g,
    mask: (val: string) => val.replace(/(:)([^:@\s]+)(@)/, '$1[REDACTED_PASSWORD]$3'),
  },
]

const DEFAULT_SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /token/i,
  /api[_-]?key/i,
  /credential/i,
  /private[_-]?key/i,
  /auth/i,
  /bearer/i,
]

/**
 * Redacts sensitive credentials, tokens, and private keys from a plaintext string.
 */
export function redactSensitiveString(
  text: string,
  rules: readonly RedactionRule[] = DEFAULT_REDACTION_RULES,
): RedactionAudit {
  let sanitized = text
  let totalRedactions = 0
  const matchesByRule: Record<string, number> = {}

  for (const rule of rules) {
    let ruleMatches = 0
    sanitized = sanitized.replace(rule.pattern, (match) => {
      ruleMatches++
      totalRedactions++
      return rule.mask(match)
    })

    if (ruleMatches > 0) {
      matchesByRule[rule.name] = ruleMatches
    }
  }

  const summary =
    totalRedactions === 0
      ? '✓ No sensitive credentials detected in string.'
      : `🛡 Redacted ${String(totalRedactions)} credential instance(s) across ${String(Object.keys(matchesByRule).length)} rule category(ies).`

  return {
    sanitizedText: sanitized,
    totalRedactions,
    matchesByRule,
    formattedSummary: summary,
  }
}

/**
 * Obfuscates sensitive environment variable entries by key name heuristics and token inspection.
 */
export function redactEnvironmentVariables(
  env: Readonly<Record<string, string>>,
  options: EnvRedactionOptions = {},
): Record<string, string> {
  const allowedSet = new Set(options.allowedKeys ?? [])
  const customKeyPatterns = (options.customSensitiveKeys ?? []).map((k) => new RegExp(k, 'i'))
  const allKeyPatterns = [...DEFAULT_SENSITIVE_KEY_PATTERNS, ...customKeyPatterns]
  const maskValue = options.maskValue ?? '***[REDACTED]***'

  const result: Record<string, string> = {}

  for (const [key, value] of Object.entries(env)) {
    if (allowedSet.has(key)) {
      result[key] = value
      continue
    }

    // Check if key matches sensitive patterns
    const isSensitiveKey = allKeyPatterns.some((p) => p.test(key))
    if (isSensitiveKey) {
      result[key] = maskValue
      continue
    }

    // Check if value itself contains tokens (e.g. inline bearer token or private key)
    const audit = redactSensitiveString(value)
    result[key] = audit.sanitizedText
  }

  return result
}
