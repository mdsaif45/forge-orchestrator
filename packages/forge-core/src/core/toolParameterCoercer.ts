export type ParameterPrimitiveType =
  'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object'

export interface ParameterPropertySchema {
  readonly type: ParameterPrimitiveType
  readonly description?: string | undefined
  readonly required?: boolean | undefined
  readonly default?: unknown
  readonly items?: ParameterPropertySchema | undefined
  readonly properties?: Record<string, ParameterPropertySchema> | undefined
  readonly enum?: readonly (string | number | boolean)[] | undefined
}

export interface ToolParametersSchema {
  readonly type?: 'object' | undefined
  readonly properties?: Record<string, ParameterPropertySchema> | undefined
  readonly required?: readonly string[] | undefined
  readonly additionalProperties?: boolean | undefined
}

export interface ToolCoercionResult {
  readonly valid: boolean
  readonly coercedParams: Record<string, unknown>
  readonly errors: readonly string[]
  readonly strippedKeys: readonly string[]
  readonly formattedSummary: string
}

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype'])

function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

function safeFormatValue(val: unknown): string {
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    return String(val)
  }
  if (val === null) return 'null'
  if (val === undefined) return 'undefined'
  return JSON.stringify(val)
}

function coerceValue(
  val: unknown,
  schema: ParameterPropertySchema,
  path: string,
  errors: string[],
): unknown {
  if (val === undefined || val === null) {
    if (schema.default !== undefined) {
      return schema.default
    }
    return val
  }

  switch (schema.type) {
    case 'boolean': {
      if (typeof val === 'boolean') return val
      if (typeof val === 'string') {
        const lower = val.trim().toLowerCase()
        if (lower === 'true' || lower === '1') return true
        if (lower === 'false' || lower === '0') return false
      }
      if (typeof val === 'number') {
        if (val === 1) return true
        if (val === 0) return false
      }
      errors.push(
        `Property "${path}" expected boolean, got ${typeof val} (${safeFormatValue(val)})`,
      )
      return val
    }

    case 'integer': {
      if (typeof val === 'number') {
        if (Number.isInteger(val)) return val
        errors.push(`Property "${path}" expected integer, got non-integer number ${String(val)}`)
        return val
      }
      if (typeof val === 'string') {
        const trimmed = val.trim()
        if (/^-?\d+$/.test(trimmed)) {
          const parsed = parseInt(trimmed, 10)
          if (!Number.isNaN(parsed) && Number.isSafeInteger(parsed)) return parsed
        }
      }
      errors.push(
        `Property "${path}" expected integer, got ${typeof val} (${safeFormatValue(val)})`,
      )
      return val
    }

    case 'number': {
      if (typeof val === 'number') {
        if (!Number.isNaN(val) && Number.isFinite(val)) return val
        errors.push(`Property "${path}" expected finite number, got ${String(val)}`)
        return val
      }
      if (typeof val === 'string') {
        const trimmed = val.trim()
        if (/^-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(trimmed)) {
          const parsed = parseFloat(trimmed)
          if (!Number.isNaN(parsed) && Number.isFinite(parsed)) return parsed
        }
      }
      errors.push(`Property "${path}" expected number, got ${typeof val} (${safeFormatValue(val)})`)
      return val
    }

    case 'string': {
      if (typeof val === 'string') return val
      if (typeof val === 'number' || typeof val === 'boolean') {
        return String(val)
      }
      errors.push(`Property "${path}" expected string, got ${typeof val}`)
      return val
    }

    case 'array': {
      let arrayValue: unknown[] | undefined
      if (Array.isArray(val)) {
        arrayValue = val
      } else if (typeof val === 'string') {
        const trimmed = val.trim()
        if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
          try {
            const parsed = JSON.parse(trimmed) as unknown
            if (Array.isArray(parsed)) arrayValue = parsed
          } catch {
            // Fall through to error
          }
        }
      }

      if (!arrayValue) {
        errors.push(`Property "${path}" expected array, got ${typeof val}`)
        return val
      }

      const itemsSchema = schema.items
      if (itemsSchema) {
        return arrayValue.map((item, idx) =>
          coerceValue(item, itemsSchema, `${path}[${String(idx)}]`, errors),
        )
      }
      return arrayValue
    }

    case 'object': {
      let objValue: Record<string, unknown> | undefined
      if (isPlainObject(val)) {
        objValue = val
      } else if (typeof val === 'string') {
        const trimmed = val.trim()
        if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
          try {
            const parsed = JSON.parse(trimmed) as unknown
            if (isPlainObject(parsed)) objValue = parsed
          } catch {
            // Fall through to error
          }
        }
      }

      if (!objValue) {
        errors.push(`Property "${path}" expected object, got ${typeof val}`)
        return val
      }

      if (schema.properties) {
        const coercedObj: Record<string, unknown> = {}
        for (const [propKey, propSchema] of Object.entries(schema.properties)) {
          if (FORBIDDEN_KEYS.has(propKey)) continue
          if (propKey in objValue) {
            coercedObj[propKey] = coerceValue(
              objValue[propKey],
              propSchema,
              `${path}.${propKey}`,
              errors,
            )
          } else if (propSchema.default !== undefined) {
            coercedObj[propKey] = propSchema.default
          }
        }
        return coercedObj
      }
      return objValue
    }

    default:
      return val
  }
}

/**
 * Coerces and validates raw tool invocation arguments against a parameter schema (Axioms A2, A5, A7).
 */
export function coerceToolParameters(
  rawArgs: unknown,
  schema: ToolParametersSchema = {},
): ToolCoercionResult {
  const errors: string[] = []
  const strippedKeys: string[] = []

  let input: Record<string, unknown>
  if (typeof rawArgs === 'string') {
    const trimmed = rawArgs.trim()
    if (!trimmed) {
      input = {}
    } else {
      try {
        const parsed = JSON.parse(trimmed) as unknown
        if (isPlainObject(parsed)) {
          input = parsed
        } else {
          return {
            valid: false,
            coercedParams: {},
            errors: ['Raw tool arguments JSON must parse to an object'],
            strippedKeys: [],
            formattedSummary: 'TOOL PARAMETERS REJECTED: Not an object',
          }
        }
      } catch (err) {
        return {
          valid: false,
          coercedParams: {},
          errors: [
            `Failed to parse tool arguments JSON: ${err instanceof Error ? err.message : String(err)}`,
          ],
          strippedKeys: [],
          formattedSummary: 'TOOL PARAMETERS REJECTED: Invalid JSON',
        }
      }
    }
  } else if (isPlainObject(rawArgs)) {
    input = rawArgs
  } else if (rawArgs === null || rawArgs === undefined) {
    input = {}
  } else {
    return {
      valid: false,
      coercedParams: {},
      errors: [`Tool arguments must be an object or JSON string, received ${typeof rawArgs}`],
      strippedKeys: [],
      formattedSummary: 'TOOL PARAMETERS REJECTED: Invalid root type',
    }
  }

  const properties = schema.properties ?? {}
  const coerced: Record<string, unknown> = {}

  // Filter out prototype pollution and unknown keys
  for (const [key, value] of Object.entries(input)) {
    if (FORBIDDEN_KEYS.has(key)) {
      strippedKeys.push(key)
      continue
    }

    const propSchema = properties[key]
    if (propSchema) {
      const coercedVal = coerceValue(value, propSchema, key, errors)

      if (propSchema.enum && coercedVal !== undefined && coercedVal !== null) {
        const validEnum = propSchema.enum.includes(coercedVal as string | number | boolean)
        if (!validEnum) {
          errors.push(
            `Property "${key}" value ${safeFormatValue(coercedVal)} is not in allowed enum [${propSchema.enum.join(', ')}]`,
          )
        }
      }

      coerced[key] = coercedVal
    } else if (schema.additionalProperties === true) {
      coerced[key] = value
    } else {
      strippedKeys.push(key)
    }
  }

  // Supply defaults for missing properties
  for (const [key, propSchema] of Object.entries(properties)) {
    if (FORBIDDEN_KEYS.has(key)) continue
    if (!(key in coerced) && propSchema.default !== undefined) {
      coerced[key] = propSchema.default
    }
  }

  // Validate required properties
  const required = schema.required ?? []
  for (const reqKey of required) {
    if (!(reqKey in coerced) || coerced[reqKey] === undefined || coerced[reqKey] === null) {
      errors.push(`Missing required parameter "${reqKey}"`)
    }
  }

  const valid = errors.length === 0
  const formattedSummary = valid
    ? `TOOL PARAMETERS VALID: ${String(Object.keys(coerced).length)} parameter(s) accepted` +
      (strippedKeys.length > 0 ? ` (${String(strippedKeys.length)} stripped)` : '')
    : `TOOL PARAMETERS REJECTED: ${String(errors.length)} validation error(s):\n  - ${errors.join('\n  - ')}`

  return {
    valid,
    coercedParams: coerced,
    errors,
    strippedKeys,
    formattedSummary,
  }
}
