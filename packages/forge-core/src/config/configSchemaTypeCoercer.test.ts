import { describe, expect, it } from 'vitest'
import { type ConfigSchema, coerceAndValidateConfig } from './configSchemaTypeCoercer'

describe('coerceAndValidateConfig', () => {
  const testSchema: ConfigSchema = {
    port: { type: 'number', required: true },
    debug: { type: 'boolean', defaultValue: false },
    tags: { type: 'string[]', defaultValue: [] },
    meta: { type: 'json' },
    environment: {
      type: 'string',
      required: true,
      validator: (val) => (val === 'prod' || val === 'dev' ? true : 'Must be prod or dev'),
    },
  }

  it('coerces numbers, booleans, and arrays from string inputs cleanly', () => {
    const raw = {
      port: '8080',
      debug: 'true',
      tags: 'ci, build, release',
      environment: 'dev',
    }

    const result = coerceAndValidateConfig(raw, testSchema)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.coerced.port).toBe(8080)
    expect(result.coerced.debug).toBe(true)
    expect(result.coerced.tags).toEqual(['ci', 'build', 'release'])
    expect(result.coerced.environment).toBe('dev')
  })

  it('parses JSON string representations into structured objects', () => {
    const raw = {
      port: 3000,
      environment: 'prod',
      meta: '{"region": "us-east-1", "retries": 3}',
    }

    const result = coerceAndValidateConfig(raw, testSchema)
    expect(result.valid).toBe(true)
    expect(result.coerced.meta).toEqual({ region: 'us-east-1', retries: 3 })
  })

  it('rejects invalid type values with explicit type mismatch errors', () => {
    const raw = {
      port: 'not-a-number',
      debug: 'maybe',
      meta: '{invalid-json',
      environment: 'staging', // fails custom validator
    }

    const result = coerceAndValidateConfig(raw, testSchema)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(3)

    const portErr = result.errors.find((e) => e.field === 'port')
    expect(portErr?.code).toBe('INVALID_TYPE')

    const debugErr = result.errors.find((e) => e.field === 'debug')
    expect(debugErr?.code).toBe('INVALID_TYPE')

    const envErr = result.errors.find((e) => e.field === 'environment')
    expect(envErr?.code).toBe('CUSTOM_VALIDATION_FAILED')
    expect(envErr?.message).toBe('Must be prod or dev')
  })

  it('flags unknown configuration keys when strict is true', () => {
    const raw = {
      port: 4000,
      environment: 'prod',
      unknownSecret: 'xyz',
      unrecognizedFlag: true,
    }

    const result = coerceAndValidateConfig(raw, testSchema, { strict: true })
    expect(result.valid).toBe(false)
    const unknownErrors = result.errors.filter((e) => e.code === 'UNKNOWN_PROPERTY')
    expect(unknownErrors).toHaveLength(2)
    expect(unknownErrors.map((e) => e.field)).toEqual(['unknownSecret', 'unrecognizedFlag'])
  })

  it('passes clean typed configuration records with zero data mutation and applies defaults', () => {
    const raw = {
      port: 9000,
      environment: 'dev',
    }

    const result = coerceAndValidateConfig(raw, testSchema, { strict: false, allowDefaults: true })
    expect(result.valid).toBe(true)
    expect(result.coerced.port).toBe(9000)
    expect(result.coerced.environment).toBe('dev')
    expect(result.coerced.debug).toBe(false)
    expect(result.coerced.tags).toEqual([])
  })
})
