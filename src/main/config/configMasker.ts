const DEFAULT_SENSITIVE_KEY_PATTERNS: readonly RegExp[] = [
  /api[_-]?key/i,
  /auth(?:orization)?[_-]?(?:token|header)?/i,
  /pass(?:word|phrase)/i,
  /secret/i,
  /token/i,
  /private[_-]?key/i,
  /credential/i,
]

/**
 * Checks whether a given property key name is considered sensitive (Axioms A2, A7).
 */
export function isSensitiveKey(key: string, customKeys: readonly string[] = []): boolean {
  const normalized = key.toLowerCase()
  if (customKeys.some((ck) => ck.toLowerCase() === normalized)) {
    return true
  }
  return DEFAULT_SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key))
}

/**
 * Redacts a secret string value to mask sensitive tokens while keeping short anchors.
 */
export function maskSecretValue(value: unknown): string {
  if (typeof value !== 'string') {
    return '[MASKED]'
  }
  if (value.length <= 6) {
    return '******'
  }
  const prefix = value.slice(0, 3)
  const suffix = value.slice(-2)
  return `${prefix}****${suffix}`
}

export interface MaskConfigOptions {
  /** Optional custom sensitive property keys to mask. */
  readonly customSensitiveKeys?: readonly string[] | undefined
  /** Maximum recursion depth to prevent infinite loops (default: 10, Axiom A5). */
  readonly maxDepth?: number | undefined
}

/**
 * Deeply traverses and masks sensitive credentials in arbitrary configuration trees (Axioms A2, A7).
 */
export function maskSensitiveConfig<T>(
  input: T,
  options: MaskConfigOptions = {},
  currentDepth = 0,
): T {
  const maxDepth = options.maxDepth ?? 10
  if (currentDepth > maxDepth || input === null || typeof input !== 'object') {
    return input
  }

  if (Array.isArray(input)) {
    const list = input as readonly unknown[]
    return list.map((item: unknown) =>
      maskSensitiveConfig(item, options, currentDepth + 1),
    ) as unknown as T
  }

  const result: Record<string, unknown> = {}
  const obj = input as Record<string, unknown>

  for (const [key, value] of Object.entries(obj)) {
    if (isSensitiveKey(key, options.customSensitiveKeys)) {
      result[key] = maskSecretValue(value)
    } else if (value !== null && typeof value === 'object') {
      result[key] = maskSensitiveConfig(value, options, currentDepth + 1)
    } else {
      result[key] = value
    }
  }

  return result as T
}
