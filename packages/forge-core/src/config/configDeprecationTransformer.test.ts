import { describe, it, expect } from 'vitest'
import {
  transformDeprecatedConfig,
  auditConfigDeprecations,
  type DeprecationRule,
} from './configDeprecationTransformer'

describe('configDeprecationTransformer (CONFIG-018)', () => {
  it('identifies and modernizes deprecated flat snake_case properties into camelCase and nested paths', () => {
    const legacyConfig = {
      timeout_ms: 15000,
      max_retries: 5,
      telemetry_enabled: false,
      log_level: 'debug',
      customSetting: 'preserved',
    }

    const report = transformDeprecatedConfig(legacyConfig)

    expect(report.isUpToDate).toBe(false)
    expect(report.deprecationCount).toBe(4)
    expect(report.transformedConfig.timeoutMs).toBe(15000)
    expect(report.transformedConfig.maxRetries).toBe(5)
    expect((report.transformedConfig.telemetry as Record<string, unknown>).enabled).toBe(false)
    expect((report.transformedConfig.logging as Record<string, unknown>).level).toBe('debug')
    expect(report.transformedConfig.customSetting).toBe('preserved')
    expect(report.formattedSummary).toContain('Found 4 deprecated key(s)')
  })

  it('reports isUpToDate true when no deprecated keys exist', () => {
    const modernConfig = {
      timeoutMs: 10000,
      telemetry: { enabled: true },
    }

    const report = transformDeprecatedConfig(modernConfig)
    expect(report.isUpToDate).toBe(true)
    expect(report.deprecationCount).toBe(0)
    expect(report.advisories).toHaveLength(0)
    expect(report.formattedSummary).toContain('Configuration conforms to current schema')
  })

  it('supports custom deprecation rules with transformations', () => {
    const customConfig = {
      legacyPort: '8080',
    }

    const customRules: DeprecationRule[] = [
      {
        deprecatedKey: 'legacyPort',
        modernKey: 'server.port',
        sinceVersion: '1.0.0',
        advisory: 'Convert legacyPort string to server.port number',
        transform: (val) => parseInt(String(val), 10),
      },
    ]

    const report = transformDeprecatedConfig(customConfig, customRules)
    expect(report.isUpToDate).toBe(false)
    expect((report.transformedConfig.server as Record<string, unknown>).port).toBe(8080)
  })

  it('auditConfigDeprecations returns only advisories without altering input', () => {
    const config = { read_only_mode: true }
    const advisories = auditConfigDeprecations(config)

    expect(advisories).toHaveLength(1)
    expect(advisories[0]?.deprecatedKey).toBe('read_only_mode')
    expect(advisories[0]?.modernKey).toBe('sandbox.readOnly')
  })
})
