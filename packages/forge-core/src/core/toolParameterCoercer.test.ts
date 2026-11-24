import { describe, expect, it } from 'vitest'
import { coerceToolParameters, type ToolParametersSchema } from './toolParameterCoercer'

describe('ToolParameterCoercer (AGENT-011)', () => {
  const schema: ToolParametersSchema = {
    type: 'object',
    properties: {
      dryRun: { type: 'boolean', default: false },
      count: { type: 'integer' },
      ratio: { type: 'number' },
      command: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      options: {
        type: 'object',
        properties: {
          verbose: { type: 'boolean' },
        },
      },
      status: {
        type: 'string',
        enum: ['pending', 'running', 'completed'],
      },
    },
    required: ['command', 'count'],
  }

  it('coerces stringified booleans, integers, numbers, and JSON arrays/objects', () => {
    const rawArgs = {
      command: 'test-runner',
      count: '42',
      dryRun: 'true',
      ratio: '3.1415',
      tags: '["alpha", "beta"]',
      options: '{"verbose": "1"}',
      status: 'completed',
    }

    const result = coerceToolParameters(rawArgs, schema)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.coercedParams.command).toBe('test-runner')
    expect(result.coercedParams.count).toBe(42)
    expect(result.coercedParams.dryRun).toBe(true)
    expect(result.coercedParams.ratio).toBe(3.1415)
    expect(result.coercedParams.tags).toEqual(['alpha', 'beta'])
    expect(result.coercedParams.options).toEqual({ verbose: true })
    expect(result.coercedParams.status).toBe('completed')
  })

  it('strips unknown properties and prototype pollution attempts (A7)', () => {
    const rawArgs = {
      command: 'run',
      count: 10,
      __proto__: { polluted: true },
      unknownSecret: 'malicious',
      extraParam: 123,
    }

    const result = coerceToolParameters(rawArgs, schema)
    expect(result.valid).toBe(true)
    expect(result.coercedParams.command).toBe('run')
    expect(result.coercedParams.count).toBe(10)
    expect(result.strippedKeys).toContain('unknownSecret')
    expect(result.strippedKeys).toContain('extraParam')
    expect(result.coercedParams.unknownSecret).toBeUndefined()
  })

  it('fails closed when required properties are missing (A2)', () => {
    const rawArgs = {
      dryRun: true,
    }

    const result = coerceToolParameters(rawArgs, schema)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Missing required parameter "command"')
    expect(result.errors).toContain('Missing required parameter "count"')
  })

  it('fails closed on non-coercible types and invalid enums (A2)', () => {
    const rawArgs = {
      command: 'run',
      count: 'not-a-number',
      dryRun: 'maybe',
      status: 'invalid-status',
    }

    const result = coerceToolParameters(rawArgs, schema)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThanOrEqual(3)
  })

  it('parses raw JSON string input correctly', () => {
    const jsonString = JSON.stringify({
      command: 'build',
      count: '5',
      dryRun: '0',
    })

    const result = coerceToolParameters(jsonString, schema)
    expect(result.valid).toBe(true)
    expect(result.coercedParams.command).toBe('build')
    expect(result.coercedParams.count).toBe(5)
    expect(result.coercedParams.dryRun).toBe(false)
  })
})
