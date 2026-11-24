export interface ForgeFeatureFlags {
  readonly toolCaching: boolean
  readonly solutionMemory: boolean
  readonly parallelExecution: boolean
  readonly secretScanning: boolean
  readonly walAutoCheckpoint: boolean
  readonly strictCommitCheck: boolean
  readonly merkleLineage: boolean
  readonly conditionEvaluation: boolean
}

export const DEFAULT_FEATURE_FLAGS: ForgeFeatureFlags = {
  toolCaching: true,
  solutionMemory: true,
  parallelExecution: true,
  secretScanning: true,
  walAutoCheckpoint: true,
  strictCommitCheck: false,
  merkleLineage: true,
  conditionEvaluation: true,
}

export interface FeatureFlagsResolutionReport {
  readonly valid: boolean
  readonly flags: ForgeFeatureFlags
  readonly overriddenFromConfig: readonly string[]
  readonly overriddenFromEnv: readonly string[]
  readonly lockedFlags: readonly string[]
  readonly formattedSummary: string
}

function parseEnvBoolean(val: string | undefined): boolean | undefined {
  if (val === undefined) return undefined
  const lower = val.trim().toLowerCase()
  if (lower === 'true' || lower === '1' || lower === 'yes') return true
  if (lower === 'false' || lower === '0' || lower === 'no') return false
  return undefined
}

function toEnvVarName(key: string): string {
  const snake = key.replace(/([A-Z])/g, '_$1').toUpperCase()
  return `FORGE_FEATURE_${snake}`
}

/**
 * Resolves workspace feature flags across default, configuration, and environment tiers (Axioms A4, A6, A7).
 */
export function resolveFeatureFlags(
  userConfig: Partial<ForgeFeatureFlags> = {},
  env: Record<string, string | undefined> = process.env,
  lockedPolicies: readonly string[] = [],
): FeatureFlagsResolutionReport {
  const resolved: Record<string, boolean> = { ...DEFAULT_FEATURE_FLAGS }
  const overriddenFromConfig: string[] = []
  const overriddenFromEnv: string[] = []
  const lockedFlags: string[] = []

  const flagKeys = Object.keys(DEFAULT_FEATURE_FLAGS) as (keyof ForgeFeatureFlags)[]

  // Apply user config overrides
  for (const key of flagKeys) {
    const cfgVal = userConfig[key]
    if (typeof cfgVal === 'boolean') {
      resolved[key] = cfgVal
      overriddenFromConfig.push(key)
    }
  }

  // Apply environment variable overrides
  for (const key of flagKeys) {
    const envVarName = toEnvVarName(key)
    const envVal = parseEnvBoolean(env[envVarName])
    if (envVal !== undefined) {
      resolved[key] = envVal
      overriddenFromEnv.push(key)
    }
  }

  // Enforce locked security policies (cannot disable security-critical features, Axiom A7)
  for (const locked of lockedPolicies) {
    if (locked in resolved) {
      resolved[locked] = true
      lockedFlags.push(locked)
    }
  }

  const finalFlags = resolved as unknown as ForgeFeatureFlags

  const lines = [
    'WORKSPACE FEATURE FLAGS CAPABILITIES MATRIX:',
    ...flagKeys.map((k) => {
      const state = finalFlags[k] ? 'ENABLED' : 'DISABLED'
      let source = 'default'
      if (overriddenFromEnv.includes(k)) source = 'env'
      else if (overriddenFromConfig.includes(k)) source = 'config'
      if (lockedFlags.includes(k)) source += ' (LOCKED)'
      return `  - ${k.padEnd(22)}: ${state.padEnd(8)} [${source}]`
    }),
  ]

  return {
    valid: true,
    flags: finalFlags,
    overriddenFromConfig,
    overriddenFromEnv,
    lockedFlags,
    formattedSummary: lines.join('\n'),
  }
}

/**
 * Checks if a specific feature flag is currently enabled in the environment (Axioms A4, A7).
 */
export function isFeatureEnabled(
  flagName: keyof ForgeFeatureFlags,
  userConfig?: Partial<ForgeFeatureFlags>,
  env?: Record<string, string | undefined>,
): boolean {
  const report = resolveFeatureFlags(userConfig, env)
  return report.flags[flagName]
}
