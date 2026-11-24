import { describe, expect, it } from 'vitest'
import { auditConfigDrift } from './configDrift'

describe('configDrift (CONFIG-012)', () => {
  it('reports clean audit for valid canonical configuration', () => {
    const report = auditConfigDrift({
      rawConfig: {
        dataDir: '/var/forge/data',
        defaultRuntime: 'forge-native-agent',
        logLevel: 'debug',
        telemetry: false,
      },
    })

    expect(report.valid).toBe(true)
    expect(report.hasDrift).toBe(false)
    expect(report.issuesCount).toBe(0)
    expect(report.formattedSummary).toContain('Total Issues:   0')
  })

  it('detects deprecated configuration keys and suggests modern alternatives', () => {
    const report = auditConfigDrift({
      rawConfig: {
        runtime: 'custom:agent',
        timeout: 60000,
      },
    })

    expect(report.valid).toBe(true)
    expect(report.hasDrift).toBe(true)

    const runtimeIssue = report.issues.find((i) => i.path === 'runtime')
    expect(runtimeIssue?.type).toBe('deprecated_key')
    expect(runtimeIssue?.suggestedKey).toBe('defaultRuntime')

    const timeoutIssue = report.issues.find((i) => i.path === 'timeout')
    expect(timeoutIssue?.type).toBe('deprecated_key')
    expect(timeoutIssue?.suggestedKey).toBe('security.maxExecutionTimeMs')
  })

  it('detects undocumented keys and provides typo suggestions via Levenshtein distance', () => {
    const report = auditConfigDrift({
      rawConfig: {
        data_dir: '/opt/forge', // typo of dataDir
        telemetri: true, // typo of telemetry
        unknownRandomProp: 'test',
      },
    })

    expect(report.hasDrift).toBe(true)

    const dataDirIssue = report.issues.find((i) => i.path === 'data_dir')
    expect(dataDirIssue?.type).toBe('undocumented_key')
    expect(dataDirIssue?.suggestedKey).toBe('dataDir')

    const telemetriIssue = report.issues.find((i) => i.path === 'telemetri')
    expect(telemetriIssue?.suggestedKey).toBe('telemetry')

    const randomIssue = report.issues.find((i) => i.path === 'unknownRandomProp')
    expect(randomIssue?.type).toBe('undocumented_key')
  })

  it('flags type mismatches as errors and fails validity (Axiom A2)', () => {
    const report = auditConfigDrift({
      rawConfig: {
        telemetry: 'disabled', // should be boolean
        logLevel: 'super-verbose', // should be enum
      },
    })

    expect(report.valid).toBe(false)
    expect(report.errorsCount).toBe(2)

    const telemetryIssue = report.issues.find((i) => i.path === 'telemetry')
    expect(telemetryIssue?.severity).toBe('error')
    expect(telemetryIssue?.type).toBe('type_mismatch')

    const logLevelIssue = report.issues.find((i) => i.path === 'logLevel')
    expect(logLevelIssue?.severity).toBe('error')
  })

  it('detects active profile divergence from base settings', () => {
    const report = auditConfigDrift({
      profile: 'production',
      rawConfig: {
        logLevel: 'debug',
        activeProfile: 'production',
        profiles: {
          production: {
            logLevel: 'error',
          },
        },
      },
    })

    expect(report.hasDrift).toBe(true)
    const divergence = report.issues.find((i) => i.type === 'profile_divergence')
    expect(divergence).toBeDefined()
    expect(divergence?.path).toBe('profiles.production.logLevel')
    expect(divergence?.severity).toBe('info')
    expect(divergence?.message).toContain('overrides base property "logLevel": "error"')
  })
})
