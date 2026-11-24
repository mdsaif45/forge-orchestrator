import { z } from 'zod'

/**
 * Row conversion helpers.
 *
 * SQLite stores no JSON, no booleans, and no arrays, so structured domain values
 * are held as text. These helpers are the single place that translation happens,
 * and every read is parsed back through the owning domain schema — a malformed row
 * fails at the boundary with a precise message rather than flowing into the
 * application as a plausible-looking object.
 */

/** Serialises a value for a JSON text column. */
export function toJson(value: unknown): string {
  return JSON.stringify(value)
}

/**
 * Parses a JSON column and validates it against the schema that owns it.
 *
 * `context` names the column, because a validation failure here means the database
 * disagrees with the domain — worth saying exactly where.
 */
export function fromJson<T>(schema: z.ZodType<T>, raw: string, context: string): T {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(`${context}: column does not contain valid JSON`)
  }

  const result = schema.safeParse(parsed)
  if (!result.success) {
    throw new Error(`${context}: ${z.prettifyError(result.error)}`)
  }

  return result.data
}

/**
 * Validates a whole row against a domain schema.
 *
 * Used after assembling a row's columns into the domain shape, so the invariants
 * declared in `src/shared/domain` — a locked decision naming its locker, a question
 * carrying evidence — are enforced on the way out of storage too, not only on the
 * way in.
 */
export function parseRow<T>(schema: z.ZodType<T>, value: unknown, context: string): T {
  const result = schema.safeParse(value)
  if (!result.success) {
    throw new Error(`${context}: ${z.prettifyError(result.error)}`)
  }

  return result.data
}

/** SQLite has no boolean type. */
export function toSqliteBoolean(value: boolean): number {
  return value ? 1 : 0
}

export function fromSqliteBoolean(value: number): boolean {
  return value !== 0
}
