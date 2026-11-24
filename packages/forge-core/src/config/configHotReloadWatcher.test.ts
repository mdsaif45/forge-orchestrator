import { describe, expect, it } from 'vitest'
import {
  evaluateConfigReload,
  flattenConfig,
  validateCandidateConfig,
} from './configHotReloadWatcher'

describe('configHotReloadWatcher (CONFIG-019)', () => {
  it('validates candidate configuration objects correctly', () => {
    expect(validateCandidateConfig(null).isValid).toBe(false)
    expect(validateCandidateConfig('not-an-object').isValid).toBe(false)
    expect(validateCandidateConfig({ dataDir: 123 }).isValid).toBe(false)
    expect(validateCandidateConfig({ logLevel: 'invalid-level' }).isValid).toBe(false)
    expect(validateCandidateConfig({ logLevel: 'debug', dataDir: '/valid/path' }).isValid).toBe(
      true,
    )
  })

  it('flattens nested configuration objects into dot notation', () => {
    const nested = {
      models: {
        active: 'claude-3-5',
        temperature: 0.2,
      },
      logLevel: 'info',
    }

    const flat = flattenConfig(nested)
    expect(flat.get('models.active')).toBe('claude-3-5')
    expect(flat.get('models.temperature')).toBe(0.2)
    expect(flat.get('logLevel')).toBe('info')
  })

  it('detects hot-reloadable configuration changes without restart required', () => {
    const active = {
      logLevel: 'info',
      telemetry: { enabled: true },
    }
    const candidate = {
      logLevel: 'debug',
      telemetry: { enabled: false },
      newFeature: true,
    }

    const assessment = evaluateConfigReload(active, candidate)
    expect(assessment.isValid).toBe(true)
    expect(assessment.hasChanges).toBe(true)
    expect(assessment.requiresRestart).toBe(false)
    expect(assessment.deltas.length).toBe(3)
    expect(assessment.summary).toContain('HOT RELOADABLE')
  })

  it('flags restart required when critical subsystem keys are modified', () => {
    const active = {
      dataDir: '/var/forge/data',
      logLevel: 'info',
    }
    const candidate = {
      dataDir: '/opt/forge/data', // Modified dataDir triggers restart
      logLevel: 'info',
    }

    const assessment = evaluateConfigReload(active, candidate)
    expect(assessment.isValid).toBe(true)
    expect(assessment.hasChanges).toBe(true)
    expect(assessment.requiresRestart).toBe(true)
    expect(assessment.summary).toContain('RESTART REQUIRED')
  })

  it('fails closed when candidate configuration has invalid schema', () => {
    const active = { logLevel: 'info' }
    const invalidCandidate = { logLevel: 'bogus_level' }

    const assessment = evaluateConfigReload(active, invalidCandidate)
    expect(assessment.isValid).toBe(false)
    expect(assessment.hasChanges).toBe(false)
    expect(assessment.validationErrors.length).toBeGreaterThan(0)
    expect(assessment.summary).toContain('Active configuration preserved')
  })
})
