import { readFileSync } from 'node:fs'
import { findForgeConfigFile, loadForgeConfig, type ForgeConfig } from './forgeConfig'

/**
 * CONFIG-012: Configuration schema drift auditor and undocumented key detector.
 * Compares .forgerc against canonical schema and profile defaults, flagging deprecated keys, typos, and mismatches (Axioms A2, A7).
 */

export type ConfigDriftSeverity = 'info' | 'warning' | 'error'
export type ConfigDriftType =
  'undocumented_key' | 'deprecated_key' | 'type_mismatch' | 'profile_divergence'

export interface ConfigDriftIssue {
  readonly path: string
  readonly type: ConfigDriftType
  readonly severity: ConfigDriftSeverity
  readonly message: string
  readonly currentValue?: unknown
  readonly suggestedKey?: string | undefined
  readonly canonicalExample?: string | undefined
}

export interface ConfigDriftReport {
  readonly valid: boolean
  readonly configPath: string | null
  readonly activeProfile: string
  readonly issuesCount: number
  readonly errorsCount: number
  readonly warningsCount: number
  readonly hasDrift: boolean
  readonly issues: readonly ConfigDriftIssue[]
  readonly formattedSummary: string
}

export interface ConfigDriftOptions {
  readonly searchFrom?: string | undefined
  readonly explicitPath?: string | undefined
  readonly profile?: string | undefined
  readonly rawConfig?: Record<string, unknown> | undefined
}

const KNOWN_TOP_LEVEL_KEYS: readonly string[] = [
  'dataDir',
  'defaultRuntime',
  'logLevel',
  'telemetry',
  'activeProfile',
  'profiles',
  'security',
  'customRuntimes',
  'providers',
  'version',
]

const KNOWN_SECURITY_KEYS: readonly string[] = [
  'allowExecutionOutsideWorkspace',
  'maxExecutionTimeMs',
]

const KNOWN_PROVIDER_KEYS: readonly string[] = ['endpoint', 'model', 'apiKeyEnv']

const DEPRECATED_KEYS_MAP: Record<string, { replacement: string; example: string }> = {
  runtime: { replacement: 'defaultRuntime', example: 'defaultRuntime: "custom:agent"' },
  model: {
    replacement: 'providers.<provider>.model',
    example: 'providers: { ollama: { model: "qwen2.5-coder:7b" } }',
  },
  endpoint: {
    replacement: 'providers.<provider>.endpoint',
    example: 'providers: { ollama: { endpoint: "http://localhost:11434" } }',
  },
  apiKey: { replacement: 'secretVault (A7)', example: 'forge config vault set <key>' },
  timeout: {
    replacement: 'security.maxExecutionTimeMs',
    example: 'security: { maxExecutionTimeMs: 600000 }',
  },
}

/**
 * Calculates Levenshtein distance between two strings to detect typos.
 */
function levenshteinDistance(a: string, b: string): number {
  const m = a.length
  const n = b.length
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) {
    const row = dp[i]
    if (row) row[0] = i
  }
  const firstRow = dp[0]
  if (firstRow) {
    for (let j = 0; j <= n; j++) {
      firstRow[j] = j
    }
  }
  for (let i = 1; i <= m; i++) {
    const currRow = dp[i]
    const prevRow = dp[i - 1]
    if (!currRow || !prevRow) continue
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      const prevRowJ = prevRow[j] ?? 0
      const currRowJ1 = currRow[j - 1] ?? 0
      const prevRowJ1 = prevRow[j - 1] ?? 0
      currRow[j] = Math.min(prevRowJ + 1, currRowJ1 + 1, prevRowJ1 + cost)
    }
  }
  const lastRow = dp[m]
  return lastRow ? (lastRow[n] ?? 0) : 0
}

function findBestSuggestion(unknownKey: string, knownKeys: readonly string[]): string | undefined {
  const normUnknown = unknownKey.toLowerCase()
  let bestMatch: string | undefined
  let minDistance = 3

  for (const candidate of knownKeys) {
    const dist = levenshteinDistance(normUnknown, candidate.toLowerCase())
    if (dist < minDistance) {
      minDistance = dist
      bestMatch = candidate
    }
  }
  return bestMatch
}

/**
 * Strips comments from JSONC before parsing.
 */
function stripComments(content: string): string {
  return content
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^\\:])\/\/.*$/gm, '$1')
    .trim()
}

/**
 * Audits a configuration tree for schema drift, undocumented properties, and deprecated settings (Axioms A2, A7).
 */
export function auditConfigDrift(options: ConfigDriftOptions = {}): ConfigDriftReport {
  let raw: Record<string, unknown> = {}
  let configPath: string | null = null

  if (options.rawConfig) {
    raw = options.rawConfig
  } else {
    configPath = findForgeConfigFile(options.searchFrom, options.explicitPath)
    if (configPath) {
      try {
        const text = readFileSync(configPath, 'utf8')
        const cleaned = stripComments(text)
        if (cleaned) {
          raw = JSON.parse(cleaned) as Record<string, unknown>
        }
      } catch {
        raw = {}
      }
    }
  }

  const loadedConfig: ForgeConfig = loadForgeConfig({
    searchFrom: options.searchFrom,
    explicitPath: options.explicitPath,
    profile: options.profile,
  })

  const activeProfile = options.profile ?? loadedConfig.activeProfile ?? 'default'
  const issues: ConfigDriftIssue[] = []

  // 1. Inspect top-level keys
  for (const key of Object.keys(raw)) {
    if (key in DEPRECATED_KEYS_MAP) {
      const dep = DEPRECATED_KEYS_MAP[key]
      issues.push({
        path: key,
        type: 'deprecated_key',
        severity: 'warning',
        message: `Deprecated property "${key}". Use "${dep?.replacement ?? ''}" instead.`,
        currentValue: raw[key],
        suggestedKey: dep?.replacement,
        canonicalExample: dep?.example,
      })
      continue
    }

    if (!KNOWN_TOP_LEVEL_KEYS.includes(key)) {
      const suggestion = findBestSuggestion(key, KNOWN_TOP_LEVEL_KEYS)
      issues.push({
        path: key,
        type: 'undocumented_key',
        severity: 'warning',
        message: `Undocumented configuration property "${key}".${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
        currentValue: raw[key],
        suggestedKey: suggestion,
      })
    }
  }

  // 2. Validate types of known top-level fields
  if ('telemetry' in raw && typeof raw.telemetry !== 'boolean') {
    issues.push({
      path: 'telemetry',
      type: 'type_mismatch',
      severity: 'error',
      message: `Property "telemetry" must be a boolean (received ${typeof raw.telemetry}).`,
      currentValue: raw.telemetry,
      canonicalExample: 'telemetry: false',
    })
  }

  if (
    'logLevel' in raw &&
    typeof raw.logLevel === 'string' &&
    !['debug', 'info', 'warn', 'error'].includes(raw.logLevel)
  ) {
    issues.push({
      path: 'logLevel',
      type: 'type_mismatch',
      severity: 'error',
      message: `Property "logLevel" must be one of "debug", "info", "warn", "error" (received "${raw.logLevel}").`,
      currentValue: raw.logLevel,
      canonicalExample: 'logLevel: "info"',
    })
  }

  // 3. Inspect security sub-keys
  if (raw.security && typeof raw.security === 'object' && !Array.isArray(raw.security)) {
    const sec = raw.security as Record<string, unknown>
    for (const sKey of Object.keys(sec)) {
      if (!KNOWN_SECURITY_KEYS.includes(sKey)) {
        const suggestion = findBestSuggestion(sKey, KNOWN_SECURITY_KEYS)
        issues.push({
          path: `security.${sKey}`,
          type: 'undocumented_key',
          severity: 'warning',
          message: `Undocumented security property "security.${sKey}".${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
          currentValue: sec[sKey],
          suggestedKey: suggestion,
        })
      }
    }
  }

  // 4. Inspect providers sub-keys
  if (raw.providers && typeof raw.providers === 'object' && !Array.isArray(raw.providers)) {
    const provs = raw.providers as Record<string, unknown>
    for (const [pName, pVal] of Object.entries(provs)) {
      if (pVal && typeof pVal === 'object' && !Array.isArray(pVal)) {
        const pObj = pVal as Record<string, unknown>
        for (const pKey of Object.keys(pObj)) {
          if (!KNOWN_PROVIDER_KEYS.includes(pKey)) {
            const suggestion = findBestSuggestion(pKey, KNOWN_PROVIDER_KEYS)
            issues.push({
              path: `providers.${pName}.${pKey}`,
              type: 'undocumented_key',
              severity: 'warning',
              message: `Undocumented provider property "providers.${pName}.${pKey}".${suggestion ? ` Did you mean "${suggestion}"?` : ''}`,
              currentValue: pObj[pKey],
              suggestedKey: suggestion,
            })
          }
        }
      }
    }
  }

  // 5. Inspect active profile divergence
  if (
    activeProfile !== 'default' &&
    raw.profiles &&
    typeof raw.profiles === 'object' &&
    !Array.isArray(raw.profiles)
  ) {
    const profiles = raw.profiles as Record<string, unknown>
    const prof = profiles[activeProfile]
    if (prof && typeof prof === 'object' && !Array.isArray(prof)) {
      const pObj = prof as Record<string, unknown>
      for (const [key, pVal] of Object.entries(pObj)) {
        if (key in raw && raw[key] !== pVal && typeof pVal !== 'object') {
          const formattedPVal = typeof pVal === 'string' ? pVal : JSON.stringify(pVal)
          const formattedRawVal = typeof raw[key] === 'string' ? raw[key] : JSON.stringify(raw[key])
          issues.push({
            path: `profiles.${activeProfile}.${key}`,
            type: 'profile_divergence',
            severity: 'info',
            message: `Profile "${activeProfile}" overrides base property "${key}": "${formattedPVal}" (base: "${formattedRawVal}").`,
            currentValue: pVal,
          })
        }
      }
    }
  }

  const errorsCount = issues.filter((i) => i.severity === 'error').length
  const warningsCount = issues.filter((i) => i.severity === 'warning').length
  const hasDrift = issues.length > 0

  const lines: string[] = [
    'CONFIGURATION SCHEMA DRIFT AUDIT (CONFIG-012):',
    `  Config Path:    ${configPath ?? '(in-memory / none)'}`,
    `  Active Profile: ${activeProfile}`,
    `  Total Issues:   ${String(issues.length)} (errors: ${String(errorsCount)}, warnings: ${String(warningsCount)})`,
    `  Drift Detected: ${hasDrift ? 'YES' : 'NO'}`,
  ]

  for (const issue of issues) {
    const badge =
      issue.severity === 'error' ? '[ERROR]' : issue.severity === 'warning' ? '[WARN]' : '[INFO]'
    lines.push(`  • ${badge} ${issue.path}: ${issue.message}`)
    if (issue.canonicalExample) {
      lines.push(`      Example: ${issue.canonicalExample}`)
    }
  }

  return {
    valid: errorsCount === 0,
    configPath,
    activeProfile,
    issuesCount: issues.length,
    errorsCount,
    warningsCount,
    hasDrift,
    issues,
    formattedSummary: lines.join('\n'),
  }
}
