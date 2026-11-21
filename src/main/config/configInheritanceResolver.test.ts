import { describe, it, expect } from 'vitest'
import {
  resolveConfigInheritance,
  detectConfigConflicts,
  type ConfigLayer,
} from './configInheritanceResolver'

describe('configInheritanceResolver (CONFIG-017)', () => {
  it('correctly resolves layered configurations in precedence order', () => {
    const layers: ConfigLayer[] = [
      {
        name: 'defaults',
        values: {
          timeoutMs: 5000,
          retries: 3,
          features: {
            cache: true,
            telemetry: false,
          },
        },
      },
      {
        name: 'global',
        values: {
          timeoutMs: 10000,
        },
      },
      {
        name: 'workspace',
        values: {
          features: {
            telemetry: true,
          },
        },
      },
      {
        name: 'cli',
        values: {
          retries: 1,
        },
      },
    ]

    const result = resolveConfigInheritance(layers)

    expect(result.valid).toBe(true)
    expect(result.conflicts).toHaveLength(0)
    expect(result.effectiveConfig).toEqual({
      timeoutMs: 10000, // overridden by global
      retries: 1, // overridden by cli
      features: {
        cache: true, // from defaults
        telemetry: true, // overridden by workspace
      },
    })
    expect(result.originMap.timeoutMs).toBe('global')
    expect(result.originMap.retries).toBe('cli')
    expect(result.originMap['features.telemetry']).toBe('workspace')
  })

  it('detects attempts to override locked administrative properties', () => {
    const layers: ConfigLayer[] = [
      {
        name: 'defaults',
        values: {
          securityLevel: 'strict',
          maxCost: 100,
        },
      },
      {
        name: 'workspace',
        values: {
          securityLevel: 'permissive', // locked violation
          maxCost: 200, // locked violation
        },
      },
    ]

    const result = resolveConfigInheritance(layers, {
      lockedKeys: ['securityLevel', 'maxCost'],
    })

    expect(result.valid).toBe(false)
    expect(result.conflicts).toHaveLength(2)
    expect(result.conflicts[0]?.type).toBe('locked_override')
    expect(result.conflicts[0]?.key).toBe('securityLevel')
    expect(result.formattedSummary).toContain('[Config Inheritance FAIL]')
  })

  it('detects type mismatches across layers', () => {
    const layers: ConfigLayer[] = [
      {
        name: 'defaults',
        values: {
          port: 3000,
        },
      },
      {
        name: 'cli',
        values: {
          port: '3000', // string instead of number
        },
      },
    ]

    const result = resolveConfigInheritance(layers)
    expect(result.valid).toBe(false)
    expect(result.conflicts).toHaveLength(1)
    expect(result.conflicts[0]?.type).toBe('type_mismatch')
    expect(result.conflicts[0]?.message).toContain(
      "Type mismatch on key 'port': 'number' in 'defaults' overridden by 'string' in 'cli'",
    )
  })

  it('detectConfigConflicts returns only conflict details', () => {
    const layers: ConfigLayer[] = [
      {
        name: 'defaults',
        values: { adminLock: true },
      },
      {
        name: 'workspace',
        values: { adminLock: false },
      },
    ]

    const conflicts = detectConfigConflicts(layers, ['adminLock'])
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0]?.key).toBe('adminLock')
  })
})
