import { describe, expect, it } from 'vitest'
import { AgentToolReflectionRegistry, type ToolDefinition } from './toolReflection'

describe('AgentToolReflectionRegistry (AGENT-015)', () => {
  const sampleTool: ToolDefinition = {
    name: 'read_file',
    description: 'Reads content from a target file path.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Relative path to file' },
        offset: { type: 'number', description: 'Byte offset' },
        encoding: { type: 'string', enum: ['utf8', 'base64'] },
      },
      required: ['path'],
      additionalProperties: false,
    },
  }

  it('registers tool definitions and lists registered tools', () => {
    const registry = new AgentToolReflectionRegistry()
    registry.register(sampleTool)

    expect(registry.get('read_file')).toBeDefined()
    expect(registry.listTools()).toHaveLength(1)
    expect(registry.listTools()[0]?.name).toBe('read_file')
  })

  it('reflects schema and generates OpenAI, Anthropic, and Gemini format definitions', () => {
    const registry = new AgentToolReflectionRegistry()
    registry.register(sampleTool)

    const descriptor = registry.reflect('read_file')
    expect(descriptor.name).toBe('read_file')
    expect(descriptor.parameterCount).toBe(3)
    expect(descriptor.requiredParameters).toEqual(['path'])
    expect(descriptor.optionalParameters).toContain('offset')
    expect(descriptor.optionalParameters).toContain('encoding')

    // OpenAI format
    expect(descriptor.openAI.type).toBe('function')
    expect(descriptor.openAI.function.name).toBe('read_file')
    expect(descriptor.openAI.function.parameters.required).toEqual(['path'])

    // Anthropic format
    expect(descriptor.anthropic.name).toBe('read_file')
    expect(descriptor.anthropic.input_schema.type).toBe('object')

    // Gemini format
    expect(descriptor.gemini.name).toBe('read_file')
    expect(descriptor.gemini.parameters.type).toBe('OBJECT')
  })

  it('validates successful tool invocation arguments', () => {
    const registry = new AgentToolReflectionRegistry()
    registry.register(sampleTool)

    const res = registry.validateInvocation('read_file', {
      path: 'src/index.ts',
      offset: 100,
      encoding: 'utf8',
    })

    expect(res.valid).toBe(true)
    expect(res.missingRequired).toHaveLength(0)
    expect(res.typeErrors).toHaveLength(0)
  })

  it('fails validation on missing required parameters', () => {
    const registry = new AgentToolReflectionRegistry()
    registry.register(sampleTool)

    const res = registry.validateInvocation('read_file', {
      offset: 50,
    })

    expect(res.valid).toBe(false)
    expect(res.missingRequired).toContain('path')
  })

  it('fails validation on parameter type mismatches and enum violations', () => {
    const registry = new AgentToolReflectionRegistry()
    registry.register(sampleTool)

    const res = registry.validateInvocation('read_file', {
      path: 12345, // should be string
      encoding: 'unsupported-format', // not in enum
      unknownField: true, // additionalProperties false
    })

    expect(res.valid).toBe(false)
    expect(res.typeErrors.some((e) => e.includes('expected string'))).toBe(true)
    expect(res.typeErrors.some((e) => e.includes('not in enum'))).toBe(true)
    expect(res.typeErrors.some((e) => e.includes('additional properties forbidden'))).toBe(true)
  })
})
