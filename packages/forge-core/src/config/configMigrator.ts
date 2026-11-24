/**
 * CONFIG-010: Configuration schema version migration and backward-compatibility manager.
 * Upgrades legacy .forgerc structures to the canonical schema while preserving user profiles (Axioms A2, A4).
 */

export const CURRENT_CONFIG_SCHEMA_VERSION = 2

export interface ConfigMigrationReport {
  readonly valid: boolean
  readonly fromVersion: number
  readonly toVersion: number
  readonly migratedConfig: Record<string, unknown>
  readonly appliedMigrations: readonly string[]
  readonly warnings: readonly string[]
  readonly formattedSummary: string
  readonly error?: string | undefined
}

const DEPRECATED_KEYS = new Set(['legacyProvider', 'legacyModel', 'customEngine', 'executionMode'])

/**
 * Migrates a raw configuration object to the canonical target schema version (Axioms A2, A4).
 */
export function migrateConfig(
  rawConfig: Record<string, unknown>,
  targetVersion: number = CURRENT_CONFIG_SCHEMA_VERSION,
): ConfigMigrationReport {
  const warnings: string[] = []
  const appliedMigrations: string[] = []

  // Check for deprecated keys
  for (const k of Object.keys(rawConfig)) {
    if (DEPRECATED_KEYS.has(k)) {
      warnings.push(`Deprecated key "${k}" detected in configuration`)
    }
  }

  let currentVersion = 0
  if (typeof rawConfig.version === 'number' && Number.isInteger(rawConfig.version)) {
    currentVersion = rawConfig.version
  }
  const initialVersion = currentVersion

  if (currentVersion > targetVersion) {
    const err = `Configuration schema version ${String(currentVersion)} is newer than supported target version ${String(targetVersion)}`
    return {
      valid: false,
      fromVersion: currentVersion,
      toVersion: targetVersion,
      migratedConfig: { ...rawConfig },
      appliedMigrations: [],
      warnings: [...warnings, err],
      formattedSummary: `CONFIG MIGRATION FAILED: ${err}`,
      error: err,
    }
  }

  let config: Record<string, unknown> = JSON.parse(JSON.stringify(rawConfig)) as Record<
    string,
    unknown
  >

  // Migration v0 -> v1 (Add version, normalize models and profiles)
  if (currentVersion < 1 && targetVersion >= 1) {
    const models =
      typeof config.models === 'object' && config.models !== null
        ? (config.models as Record<string, unknown>)
        : {}

    if (!models.provider && typeof config.provider === 'string') {
      models.provider = config.provider
    }

    if (!models.default && typeof config.model === 'string') {
      models.default = config.model
    }

    config = {
      ...config,
      version: 1,
      models,
      profiles:
        typeof config.profiles === 'object' && config.profiles !== null ? config.profiles : {},
    }
    appliedMigrations.push('v0 -> v1 (Normalized model definitions and added profiles)')
    currentVersion = 1
  }

  // Migration v1 -> v2 (Add declarative feature flags container)
  if (currentVersion < 2 && targetVersion >= 2) {
    const existingFeatures =
      typeof config.features === 'object' && config.features !== null
        ? (config.features as Record<string, unknown>)
        : {}

    config = {
      ...config,
      version: 2,
      features: {
        toolCaching: true,
        solutionMemory: true,
        parallelExecution: true,
        secretScanning: true,
        walAutoCheckpoint: true,
        ...existingFeatures,
      },
    }
    appliedMigrations.push('v1 -> v2 (Initialized workspace feature flags matrix)')
    currentVersion = 2
  }

  const lines = [
    `CONFIGURATION SCHEMA MIGRATION: v${String(initialVersion)} -> v${String(currentVersion)}`,
    `  Applied:  ${appliedMigrations.length > 0 ? appliedMigrations.join(', ') : 'None (already up-to-date)'}`,
    `  Warnings: ${warnings.length > 0 ? warnings.join(', ') : 'None'}`,
  ]

  return {
    valid: true,
    fromVersion: initialVersion,
    toVersion: currentVersion,
    migratedConfig: config,
    appliedMigrations,
    warnings,
    formattedSummary: lines.join('\n'),
  }
}
