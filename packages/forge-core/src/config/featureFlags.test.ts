import { describe, expect, it } from 'vitest'
import { isFeatureEnabled, resolveFeatureFlags, type ForgeFeatureFlags } from './featureFlags'

describe('WorkspaceFeatureFlags (CONFIG-009)', () => {
  it('resolves deterministic defaults when no configuration is provided', () => {
    const report = resolveFeatureFlags({}, {})
    expect(report.valid).toBe(true)
    expect(report.flags.toolCaching).toBe(true)
    expect(report.flags.solutionMemory).toBe(true)
    expect(report.flags.parallelExecution).toBe(true)
    expect(report.flags.secretScanning).toBe(true)
    expect(report.flags.strictCommitCheck).toBe(false)
    expect(report.overriddenFromConfig).toEqual([])
    expect(report.overriddenFromEnv).toEqual([])
  })

  it('applies configuration overrides correctly', () => {
    const userConfig: Partial<ForgeFeatureFlags> = {
      toolCaching: false,
      strictCommitCheck: true,
    }

    const report = resolveFeatureFlags(userConfig, {})
    expect(report.flags.toolCaching).toBe(false)
    expect(report.flags.strictCommitCheck).toBe(true)
    expect(report.overriddenFromConfig).toContain('toolCaching')
    expect(report.overriddenFromConfig).toContain('strictCommitCheck')
  })

  it('prefers environment variable overrides over configuration', () => {
    const userConfig: Partial<ForgeFeatureFlags> = {
      parallelExecution: false,
    }
    const env = {
      FORGE_FEATURE_PARALLEL_EXECUTION: 'true',
      FORGE_FEATURE_STRICT_COMMIT_CHECK: '1',
    }

    const report = resolveFeatureFlags(userConfig, env)
    expect(report.flags.parallelExecution).toBe(true)
    expect(report.flags.strictCommitCheck).toBe(true)
    expect(report.overriddenFromEnv).toContain('parallelExecution')
    expect(report.overriddenFromEnv).toContain('strictCommitCheck')
  })

  it('enforces administrative security policy locks (A7)', () => {
    const userConfig: Partial<ForgeFeatureFlags> = {
      secretScanning: false, // Attempt to disable security scanning
    }
    const env = {
      FORGE_FEATURE_SECRET_SCANNING: 'false',
    }

    const report = resolveFeatureFlags(userConfig, env, ['secretScanning'])
    expect(report.flags.secretScanning).toBe(true) // Kept enabled by administrative policy lock
    expect(report.lockedFlags).toContain('secretScanning')
  })

  it('evaluates isFeatureEnabled correctly', () => {
    expect(isFeatureEnabled('toolCaching', {}, {})).toBe(true)
    expect(isFeatureEnabled('strictCommitCheck', {}, {})).toBe(false)
    expect(isFeatureEnabled('strictCommitCheck', { strictCommitCheck: true }, {})).toBe(true)
  })
})
