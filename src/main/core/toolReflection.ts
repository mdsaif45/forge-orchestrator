/**
 * AGENT-015: Agent dynamic tool schema reflection and runtime capability descriptor.
 * Dynamic reflection and format-agnostic descriptor generation for OpenAI, Anthropic, and Gemini (Axioms A1, A5).
 */

export type ToolParameterType = 'string' | 'number' | 'boolean' | 'array' | 'object'

export interface ToolParameterProperty {
  readonly type: ToolParameterType
  readonly description?: string | undefined
  readonly enum?: readonly string[] | undefined
  readonly default?: unknown
  readonly items?: ToolParameterProperty | undefined
  readonly properties?: Record<string, ToolParameterProperty> | undefined
}

export interface ToolParametersSchema {
  readonly type?: 'object' | undefined
  readonly properties?: Record<string, ToolParameterProperty> | undefined
  readonly required?: readonly string[] | undefined
  readonly additionalProperties?: boolean | undefined
}

export interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters?: ToolParametersSchema | undefined
  readonly execute?: ((args: Record<string, unknown>) => Promise<unknown>) | undefined
}

export interface OpenAIFunctionDefinition {
  readonly type: 'function'
  readonly function: {
    readonly name: string
    readonly description: string
    readonly parameters: {
      readonly type: 'object'
      readonly properties: Record<string, unknown>
      readonly required: readonly string[]
      readonly additionalProperties: boolean
    }
  }
}

export interface AnthropicToolDefinition {
  readonly name: string
  readonly description: string
  readonly input_schema: {
    readonly type: 'object'
    readonly properties: Record<string, unknown>
    readonly required: readonly string[]
  }
}

export interface GeminiFunctionDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: {
    readonly type: 'OBJECT'
    readonly properties: Record<string, unknown>
    readonly required: readonly string[]
  }
}

export interface ToolValidationResult {
  readonly valid: boolean
  readonly toolName: string
  readonly missingRequired: readonly string[]
  readonly typeErrors: readonly string[]
  readonly formattedSummary: string
}

export interface ToolSchemaDescriptor {
  readonly name: string
  readonly description: string
  readonly parameterCount: number
  readonly requiredParameters: readonly string[]
  readonly optionalParameters: readonly string[]
  readonly properties: Record<string, ToolParameterProperty>
  readonly openAI: OpenAIFunctionDefinition
  readonly anthropic: AnthropicToolDefinition
  readonly gemini: GeminiFunctionDefinition
  readonly formattedSummary: string
}

/**
 * Registry providing dynamic reflection and schema conversion for agent tools.
 */
export class AgentToolReflectionRegistry {
  private readonly tools = new Map<string, ToolDefinition>()

  public constructor(options?: { includeDefaults?: boolean }) {
    if (options?.includeDefaults) {
      this.loadDefaults()
    }
  }

  public loadDefaults(): void {
    // Register standard default Forge tools
    this.register({
      name: 'read_file',
      description: 'Read the contents of a file at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Relative or absolute file path.' },
          encoding: { type: 'string', description: 'Text encoding (defaults to utf8).' },
        },
        required: ['path'],
      },
    })
    this.register({
      name: 'write_file',
      description: 'Write content to a file at the given path.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Destination file path.' },
          content: { type: 'string', description: 'Text content to write.' },
        },
        required: ['path', 'content'],
      },
    })
    this.register({
      name: 'run_command',
      description: 'Execute a shell command within the workspace sandbox.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Shell command string to execute.' },
          timeoutMs: { type: 'number', description: 'Execution timeout in milliseconds.' },
        },
        required: ['command'],
      },
    })
  }

  public register(tool: ToolDefinition): void {
    if (!tool.name || tool.name.trim() === '') {
      throw new Error('Tool name must be a non-empty string')
    }
    this.tools.set(tool.name, tool)
  }

  public get(name: string): ToolDefinition | undefined {
    return this.tools.get(name)
  }

  public getDescriptor(name: string): ToolSchemaDescriptor | undefined {
    if (!this.tools.has(name)) return undefined
    return this.reflect(name)
  }

  public listTools(): readonly ToolDefinition[] {
    return Array.from(this.tools.values())
  }

  public listDescriptors(): readonly ToolSchemaDescriptor[] {
    return Array.from(this.tools.keys()).map((k) => this.reflect(k))
  }

  public reflect(toolName?: string): ToolSchemaDescriptor {
    const targetName = toolName ?? this.tools.keys().next().value ?? 'read_file'
    const tool = this.tools.get(targetName)
    if (!tool) {
      throw new Error(`Tool "${targetName}" is not registered in reflection registry`)
    }

    const properties = tool.parameters?.properties ?? {}
    const required = tool.parameters?.required ?? []
    const allKeys = Object.keys(properties)
    const optionalKeys = allKeys.filter((k) => !required.includes(k))

    const openAIProps: Record<string, unknown> = {}
    const anthropicProps: Record<string, unknown> = {}
    const geminiProps: Record<string, unknown> = {}

    for (const [k, prop] of Object.entries(properties)) {
      openAIProps[k] = {
        type: prop.type,
        ...(prop.description ? { description: prop.description } : {}),
        ...(prop.enum ? { enum: prop.enum } : {}),
      }
      anthropicProps[k] = {
        type: prop.type,
        ...(prop.description ? { description: prop.description } : {}),
        ...(prop.enum ? { enum: prop.enum } : {}),
      }
      geminiProps[k] = {
        type: prop.type.toUpperCase(),
        ...(prop.description ? { description: prop.description } : {}),
        ...(prop.enum ? { enum: prop.enum } : {}),
      }
    }

    const openAI: OpenAIFunctionDefinition = {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: {
          type: 'object',
          properties: openAIProps,
          required,
          additionalProperties: tool.parameters?.additionalProperties ?? false,
        },
      },
    }

    const anthropic: AnthropicToolDefinition = {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object',
        properties: anthropicProps,
        required,
      },
    }

    const gemini: GeminiFunctionDefinition = {
      name: tool.name,
      description: tool.description,
      parameters: {
        type: 'OBJECT',
        properties: geminiProps,
        required,
      },
    }

    const lines: string[] = [
      `TOOL REFLECTION: ${tool.name}`,
      `  Description: ${tool.description}`,
      `  Parameters (${String(allKeys.length)}): ${allKeys.length > 0 ? allKeys.join(', ') : '(none)'}`,
      `  Required (${String(required.length)}):   ${required.length > 0 ? required.join(', ') : '(none)'}`,
      `  Optional (${String(optionalKeys.length)}):   ${optionalKeys.length > 0 ? optionalKeys.join(', ') : '(none)'}`,
    ]

    return {
      name: tool.name,
      description: tool.description,
      parameterCount: allKeys.length,
      requiredParameters: required,
      optionalParameters: optionalKeys,
      properties,
      openAI,
      anthropic,
      gemini,
      formattedSummary: lines.join('\n'),
    }
  }

  public validateInvocation(toolName: string, args: unknown): ToolValidationResult {
    const tool = this.tools.get(toolName)
    if (!tool) {
      return {
        valid: false,
        toolName,
        missingRequired: [],
        typeErrors: [`Tool "${toolName}" is not registered`],
        formattedSummary: `ERROR: Tool "${toolName}" is not registered in reflection registry.`,
      }
    }

    if (!args || typeof args !== 'object' || Array.isArray(args)) {
      return {
        valid: false,
        toolName,
        missingRequired: tool.parameters?.required ?? [],
        typeErrors: ['Invocation arguments must be an object'],
        formattedSummary: `ERROR: Invocation arguments for "${toolName}" must be a non-null object.`,
      }
    }

    const raw = args as Record<string, unknown>
    const required = tool.parameters?.required ?? []
    const properties = tool.parameters?.properties ?? {}

    const missingRequired: string[] = []
    const typeErrors: string[] = []

    for (const reqKey of required) {
      if (!(reqKey in raw) || raw[reqKey] === undefined || raw[reqKey] === null) {
        missingRequired.push(reqKey)
      }
    }

    for (const [key, val] of Object.entries(raw)) {
      const prop = properties[key]
      if (!prop) {
        if (tool.parameters?.additionalProperties === false) {
          typeErrors.push(`Unexpected parameter "${key}" (additional properties forbidden)`)
        }
        continue
      }

      if (val === undefined || val === null) {
        continue
      }

      if (prop.type === 'string' && typeof val !== 'string') {
        typeErrors.push(`Parameter "${key}" expected string, got ${typeof val}`)
      } else if (prop.type === 'number' && (typeof val !== 'number' || isNaN(val))) {
        typeErrors.push(`Parameter "${key}" expected number, got ${typeof val}`)
      } else if (prop.type === 'boolean' && typeof val !== 'boolean') {
        typeErrors.push(`Parameter "${key}" expected boolean, got ${typeof val}`)
      } else if (prop.type === 'array' && !Array.isArray(val)) {
        typeErrors.push(`Parameter "${key}" expected array, got ${typeof val}`)
      } else if (prop.type === 'object' && (typeof val !== 'object' || Array.isArray(val))) {
        typeErrors.push(`Parameter "${key}" expected object, got ${typeof val}`)
      }

      if (prop.enum && typeof val === 'string' && !prop.enum.includes(val)) {
        typeErrors.push(`Parameter "${key}" value "${val}" not in enum [${prop.enum.join(', ')}]`)
      }
    }

    const valid = missingRequired.length === 0 && typeErrors.length === 0
    const summaryLines: string[] = [
      `TOOL INVOCATION VALIDATION: ${toolName}`,
      `  Status: ${valid ? 'VALID' : 'INVALID'}`,
    ]
    if (missingRequired.length > 0) {
      summaryLines.push(`  Missing Required: ${missingRequired.join(', ')}`)
    }
    if (typeErrors.length > 0) {
      summaryLines.push(`  Type Errors: ${typeErrors.join('; ')}`)
    }

    return {
      valid,
      toolName,
      missingRequired,
      typeErrors,
      formattedSummary: summaryLines.join('\n'),
    }
  }
}
