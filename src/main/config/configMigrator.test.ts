import { describe, expect, it } from 'vitest'
import { CURRENT_CONFIG_SCHEMA_VERSION, migrateConfig } from './configMigrator'

describe('configMigrator (CONFIG-010)', () => {
  it('migrates unversioned v0 configuration up to current version', () => {
    const rawLegacy = {
      model: 'qwen2.5-coder:7b',
      provider: 'ollama',
    }

    const report = migrateConfig(rawLegacy)
    expect(report.valid).toBe(true)
    expect(report.fromVersion).toBe(0)
    expect(report.toVersion).toBe(CURRENT_CONFIG_SCHEMA_VERSION)
    expect(report.appliedMigrations.length).toBe(2)

    const migrated = report.migratedConfig
    expect(migrated.version).toBe(CURRENT_CONFIG_SCHEMA_VERSION)
    const models = migrated.models as Record<string, unknown>
    expect(models.provider).toBe('ollama')
    expect(models.default).toBe('qwen2.5-coder:7b')
    expect(migrated.features).toBeDefined()
  })

  it('preserves existing custom user profiles and parameters during migration', () => {
    const v1Config = {
      version: 1,
      models: { provider: 'anthropic', default: 'claude-3-7-sonnet' },
      profiles: {
        testing: { models: { default: 'test-model' } },
      },
    }

    const report = migrateConfig(v1Config)
    expect(report.valid).toBe(true)
    expect(report.fromVersion).toBe(1)
    expect(report.toVersion).toBe(2)
    const migrated = report.migratedConfig
    expect(migrated.profiles).toEqual(v1Config.profiles)
  })

  it('detects and issues warnings for deprecated legacy configuration keys', () => {
    const legacyConfig = {
      version: 1,
      legacyProvider: 'openai',
      customEngine: 'legacy-dag',
    }

    const report = migrateConfig(legacyConfig)
    expect(report.valid).toBe(true)
    expect(report.warnings.length).toBe(2)
    expect(report.warnings[0]).toContain('legacyProvider')
    expect(report.warnings[1]).toContain('customEngine')
  })

  it('fails closed when configuration version is newer than supported target (A2)', () => {
    const futureConfig = {
      version: 999,
      futureField: 'unknown',
    }

    const report = migrateConfig(futureConfig)
    expect(report.valid).toBe(false)
    expect(report.error).toContain('newer than supported target')
  })
})
