/**
 * Pure canonical JSON serializer.
 *
 * Guarantees that semantically identical JSON objects produce identical strings
 * regardless of key insertion order. Preserves explicit array element ordering.
 *
 * Adheres to ADR-004 Rule 1: Pure domain module with zero dependencies on Node.js built-ins.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }

  if (Array.isArray(value)) {
    return `[${value.map((element: unknown) => canonicalizeJson(element)).join(',')}]`
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const entries = keys.map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`)
  return `{${entries.join(',')}}`
}

/**
 * Safely canonicalizes a string if it represents valid JSON, or returns the string unchanged.
 */
export function tryCanonicalizeJsonString(raw: string): string {
  const trimmed = raw.trim()
  if (
    (trimmed.startsWith('{') && trimmed.endsWith('}')) ||
    (trimmed.startsWith('[') && trimmed.endsWith(']'))
  ) {
    try {
      const parsed: unknown = JSON.parse(trimmed)
      return canonicalizeJson(parsed)
    } catch {
      return trimmed
    }
  }
  return trimmed
}
