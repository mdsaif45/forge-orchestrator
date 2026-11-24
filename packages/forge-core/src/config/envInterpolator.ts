export interface InterpolationOptions {
  /** Custom environment dictionary (defaults to `process.env`). */
  readonly env?: Readonly<Record<string, string | undefined>> | undefined
  /** Maximum recursion depth for nested expressions (default: 10, Axiom A5). */
  readonly maxDepth?: number | undefined
  /** If true, missing variables without default fallbacks throw an error (default: true, Axiom A2). */
  readonly strict?: boolean | undefined
}

export class MissingEnvVariableError extends Error {
  public readonly variableName: string

  constructor(variableName: string) {
    super(
      `Required environment variable "${variableName}" is not defined and has no default fallback`,
    )
    this.name = 'MissingEnvVariableError'
    this.variableName = variableName
  }
}

export class CircularInterpolationError extends Error {
  constructor(depth: number) {
    super(`Exceeded maximum environment interpolation recursion depth of ${String(depth)}`)
    this.name = 'CircularInterpolationError'
  }
}

/**
 * Regex matching `${VAR_NAME}` and `${VAR_NAME:-default_value}` patterns.
 */
const ENV_INTERPOLATION_REGEX = /\$\{([A-Za-z0-9_]+)(?::?-([^}]*))?\}/g

/**
 * Interpolates environment variables into a template string (Axioms A2, A6).
 */
export function interpolateEnvString(
  template: string,
  options: InterpolationOptions = {},
  currentDepth = 0,
): string {
  const maxDepth = options.maxDepth ?? 10
  if (currentDepth > maxDepth) {
    throw new CircularInterpolationError(maxDepth)
  }

  const env = options.env ?? process.env
  const strict = options.strict ?? true

  const result = template.replace(
    ENV_INTERPOLATION_REGEX,
    (_fullMatch, varName: string, fallback: string | undefined) => {
      const val = env[varName]

      if (val !== undefined && val !== '') {
        return val
      }

      if (fallback !== undefined) {
        return fallback
      }

      if (strict) {
        throw new MissingEnvVariableError(varName)
      }

      return ''
    },
  )

  // If replacements occurred and still contains expression, recursively resolve
  if (result !== template && /\$\{([A-Za-z0-9_]+)(?::?-([^}]*))?\}/.test(result)) {
    return interpolateEnvString(result, options, currentDepth + 1)
  }

  return result
}

/**
 * Recursively traverses and interpolates strings across nested objects and arrays (Axiom A6).
 */
export function interpolateConfigTree<T>(input: T, options: InterpolationOptions = {}): T {
  if (typeof input === 'string') {
    return interpolateEnvString(input, options) as T
  }

  if (Array.isArray(input)) {
    return input.map((item: unknown) => interpolateConfigTree(item, options)) as T
  }

  if (input !== null && typeof input === 'object') {
    const copy: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
      copy[key] = interpolateConfigTree(value, options)
    }
    return copy as T
  }

  return input
}
