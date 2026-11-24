export type ConfigFieldType = 'string' | 'number' | 'boolean' | 'string[]' | 'json'

export interface ConfigFieldSchema {
  type: ConfigFieldType
  required?: boolean
  defaultValue?: unknown
  description?: string
  validator?: (val: unknown) => boolean | string
}

export type ConfigSchema = Record<string, ConfigFieldSchema>

export interface CoerceOptions {
  strict?: boolean
  allowDefaults?: boolean
}

export interface ConfigValidationError {
  field: string
  code:
    | 'MISSING_REQUIRED'
    | 'INVALID_TYPE'
    | 'INVALID_FORMAT'
    | 'CUSTOM_VALIDATION_FAILED'
    | 'UNKNOWN_PROPERTY'
  message: string
}

export interface CoerceResult {
  valid: boolean
  coerced: Record<string, unknown>
  errors: ConfigValidationError[]
  warnings: string[]
}

export function coerceAndValidateConfig(
  raw: Record<string, unknown>,
  schema: ConfigSchema,
  options: CoerceOptions = {},
): CoerceResult {
  const strict = options.strict ?? false
  const allowDefaults = options.allowDefaults ?? true

  const coerced: Record<string, unknown> = {}
  const errors: ConfigValidationError[] = []
  const warnings: string[] = []

  // Check for unknown properties in strict mode
  if (strict) {
    for (const key of Object.keys(raw)) {
      if (!(key in schema)) {
        errors.push({
          field: key,
          code: 'UNKNOWN_PROPERTY',
          message: `Unknown configuration property "${key}" in strict mode`,
        })
      }
    }
  }

  // Iterate over schema fields
  for (const [field, fieldSchema] of Object.entries(schema)) {
    let value = raw[field]

    if (value === undefined || value === null) {
      if (allowDefaults && fieldSchema.defaultValue !== undefined) {
        value = fieldSchema.defaultValue
      } else if (fieldSchema.required) {
        errors.push({
          field,
          code: 'MISSING_REQUIRED',
          message: `Required configuration field "${field}" is missing`,
        })
        continue
      } else {
        // Optional and absent
        continue
      }
    }

    // Coerce value based on fieldSchema.type
    try {
      const coercedVal = coerceValue(field, value, fieldSchema.type)

      // If custom validator provided
      if (fieldSchema.validator) {
        const valRes = fieldSchema.validator(coercedVal)
        if (typeof valRes === 'string') {
          errors.push({
            field,
            code: 'CUSTOM_VALIDATION_FAILED',
            message: valRes,
          })
          continue
        } else if (!valRes) {
          errors.push({
            field,
            code: 'CUSTOM_VALIDATION_FAILED',
            message: `Custom validation failed for field "${field}"`,
          })
          continue
        }
      }

      coerced[field] = coercedVal
    } catch (err) {
      errors.push({
        field,
        code: 'INVALID_TYPE',
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return {
    valid: errors.length === 0,
    coerced,
    errors,
    warnings,
  }
}

function coerceValue(field: string, val: unknown, type: ConfigFieldType): unknown {
  switch (type) {
    case 'string':
      if (typeof val === 'string') return val
      return String(val)

    case 'number': {
      if (typeof val === 'number') {
        if (!Number.isFinite(val)) {
          throw new Error(`Field "${field}" must be a finite number`)
        }
        return val
      }
      if (typeof val === 'string') {
        const trimmed = val.trim()
        if (trimmed === '') {
          throw new Error(`Field "${field}" cannot be empty for number type`)
        }
        const parsed = Number(trimmed)
        if (Number.isNaN(parsed) || !Number.isFinite(parsed)) {
          throw new Error(`Field "${field}" could not be coerced to number: "${val}"`)
        }
        return parsed
      }
      throw new Error(
        `Field "${field}" cannot be converted to number: unsupported type ${typeof val}`,
      )
    }

    case 'boolean': {
      if (typeof val === 'boolean') return val
      if (typeof val === 'string') {
        const lower = val.trim().toLowerCase()
        if (lower === 'true' || lower === '1' || lower === 'yes' || lower === 'on') {
          return true
        }
        if (lower === 'false' || lower === '0' || lower === 'no' || lower === 'off') {
          return false
        }
        throw new Error(`Field "${field}" cannot be coerced to boolean: "${val}"`)
      }
      if (typeof val === 'number') {
        if (val === 1) return true
        if (val === 0) return false
        throw new Error(`Field "${field}" numeric boolean must be 0 or 1, got ${String(val)}`)
      }
      throw new Error(
        `Field "${field}" cannot be converted to boolean: unsupported type ${typeof val}`,
      )
    }

    case 'string[]': {
      if (Array.isArray(val)) {
        return val.map((item) => String(item).trim()).filter(Boolean)
      }
      if (typeof val === 'string') {
        return val
          .split(/[,;]/)
          .map((s) => s.trim())
          .filter(Boolean)
      }
      throw new Error(
        `Field "${field}" cannot be converted to string array: unsupported type ${typeof val}`,
      )
    }

    case 'json': {
      if (typeof val === 'object' && val !== null) {
        return val
      }
      if (typeof val === 'string') {
        try {
          return JSON.parse(val)
        } catch {
          throw new Error(`Field "${field}" contains invalid JSON string`)
        }
      }
      throw new Error(`Field "${field}" cannot be parsed as JSON: unsupported type ${typeof val}`)
    }
  }
}
