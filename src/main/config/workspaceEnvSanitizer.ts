export interface EnvSanitizerConfig {
  blockedPrefixes?: string[] | undefined
  blockedPatterns?: string[] | undefined
  requiredKeys?: string[] | undefined
  customAllowlist?: string[] | undefined
}

export interface EnvSanitizationReport {
  originalCount: number
  retainedCount: number
  strippedKeys: string[]
  missingRequiredKeys: string[]
  sanitizedEnv: Record<string, string>
}

const DEFAULT_BLOCKED_PREFIXES: readonly string[] = [
  'AWS_',
  'GITHUB_',
  'AZURE_',
  'GCP_',
  'GOOGLE_',
  'SLACK_',
  'STRIPE_',
]

const DEFAULT_BLOCKED_PATTERNS: readonly RegExp[] = [
  /SECRET/i,
  /TOKEN/i,
  /PASSWORD/i,
  /PRIVATE_KEY/i,
  /AUTH_KEY/i,
  /API_KEY/i,
]

const DEFAULT_REQUIRED_KEYS: readonly string[] = [
  'PATH',
  'Path',
  'TEMP',
  'TMP',
  'SYSTEMROOT',
  'SystemRoot',
  'HOME',
  'USERPROFILE',
]

export class WorkspaceEnvSanitizer {
  public static maskSecret(value: string): string {
    if (!value || value.length === 0) {
      return ''
    }
    if (value.length <= 8) {
      return '[REDACTED]'
    }
    const prefix = value.slice(0, 3)
    const suffix = value.slice(-3)
    return `${prefix}***${suffix}`
  }

  public sanitize(
    inboundEnv: Record<string, string | undefined>,
    config?: EnvSanitizerConfig,
  ): EnvSanitizationReport {
    const blockedPrefixes = config?.blockedPrefixes ?? DEFAULT_BLOCKED_PREFIXES
    const blockedPatterns = config?.blockedPatterns
      ? config.blockedPatterns.map((p) => new RegExp(p, 'i'))
      : DEFAULT_BLOCKED_PATTERNS
    const requiredKeys = config?.requiredKeys ?? DEFAULT_REQUIRED_KEYS
    const allowlist = new Set((config?.customAllowlist ?? []).map((k) => k.toUpperCase()))

    const strippedKeys: string[] = []
    const sanitizedEnv: Record<string, string> = {}

    const entries = Object.entries(inboundEnv)
    const originalCount = entries.length

    for (const [key, value] of entries) {
      if (value === undefined) {
        continue
      }

      const upperKey = key.toUpperCase()

      // Allowlist overrides blocks
      if (allowlist.has(upperKey)) {
        sanitizedEnv[key] = value
        continue
      }

      // Check blocked prefixes
      const hasBlockedPrefix = blockedPrefixes.some((prefix) =>
        upperKey.startsWith(prefix.toUpperCase()),
      )

      // Check blocked regex patterns
      const hasBlockedPattern = blockedPatterns.some((pattern) => pattern.test(key))

      if (hasBlockedPrefix || hasBlockedPattern) {
        strippedKeys.push(key)
      } else {
        sanitizedEnv[key] = value
      }
    }

    // Check required system baseline keys
    const missingRequiredKeys: string[] = []
    const availableUpperKeys = new Set(Object.keys(sanitizedEnv).map((k) => k.toUpperCase()))

    // For standard groups like PATH/Path, TEMP/TMP, HOME/USERPROFILE, ensure at least one equivalent exists
    const canonicalGroups: string[][] = [
      ['PATH'],
      ['TEMP', 'TMP'],
      ['HOME', 'USERPROFILE'],
      ['SYSTEMROOT'],
    ]

    for (const group of canonicalGroups) {
      // If any key from the group was specified in requiredKeys, verify at least one candidate is in sanitizedEnv
      const groupInRequirements = group.some((g) => requiredKeys.some((r) => r.toUpperCase() === g))
      if (groupInRequirements) {
        const satisfied = group.some((g) => availableUpperKeys.has(g))
        if (!satisfied) {
          const primaryKey = group[0]
          if (primaryKey) {
            missingRequiredKeys.push(primaryKey)
          }
        }
      }
    }

    strippedKeys.sort()
    missingRequiredKeys.sort()

    return {
      originalCount,
      retainedCount: Object.keys(sanitizedEnv).length,
      strippedKeys,
      missingRequiredKeys,
      sanitizedEnv,
    }
  }
}
