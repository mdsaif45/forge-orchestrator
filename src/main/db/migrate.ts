import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { sql } from 'drizzle-orm'
import type { ForgeDatabase } from './connection'

/**
 * Applies the committed migrations, forward only.
 *
 * Deliberately not `drizzle-orm/better-sqlite3/migrator`: that reads the migration
 * folder from disk at runtime, which means shipping `src/main/db/migrations` as an
 * unpacked resource and keeping its path correct in dev, in the bundle, and inside
 * an installer. Reading the same SQL and tracking the applied version ourselves is
 * a few lines and removes a packaging failure mode — and the failure mode matters,
 * because a missing migration folder would surface as "no such table" at first use.
 *
 * The applied version is recorded in `schema_meta`, so a second run is a no-op.
 */

const VERSION_KEY = 'migration_version'

export interface Migration {
  readonly tag: string
  readonly sql: string
}

/**
 * Reads migrations from a directory, ordered by filename.
 *
 * drizzle-kit names them `0000_initial.sql`, `0001_…`, so lexical order is
 * application order.
 */
export function loadMigrations(directory: string): readonly Migration[] {
  return readdirSync(directory)
    .filter((name) => name.endsWith('.sql'))
    .sort()
    .map((name) => ({
      tag: name.replace(/\.sql$/, ''),
      sql: readFileSync(join(directory, name), 'utf8'),
    }))
}

/**
 * Applies every migration not yet recorded as applied.
 *
 * Each migration runs inside a transaction together with the version bump, so a
 * failure part-way leaves the database at the previous version rather than in a
 * half-migrated state that neither version describes.
 */
export function runMigrations(db: ForgeDatabase, migrations: readonly Migration[]): number {
  // Bootstrapped outside the migration files: the tracking table must exist before
  // there is anywhere to record that a migration ran.
  db.run(
    sql`CREATE TABLE IF NOT EXISTS schema_meta (key text PRIMARY KEY NOT NULL, value text NOT NULL)`,
  )

  const applied = readAppliedCount(db)
  let count = applied

  for (const migration of migrations.slice(applied)) {
    db.transaction((tx) => {
      // drizzle-kit separates statements with this marker; better-sqlite3's `run`
      // takes one statement at a time.
      for (const statement of splitStatements(migration.sql)) {
        tx.run(sql.raw(statement))
      }

      count += 1
      tx.run(
        sql`INSERT INTO schema_meta (key, value) VALUES (${VERSION_KEY}, ${String(count)})
            ON CONFLICT(key) DO UPDATE SET value = ${String(count)}`,
      )
    })
  }

  return count - applied
}

/** How many migrations this database has already had applied. */
export function readAppliedCount(db: ForgeDatabase): number {
  const rows = db.all<{ value: string }>(
    sql`SELECT value FROM schema_meta WHERE key = ${VERSION_KEY}`,
  )
  const first = rows.at(0)
  if (first === undefined) return 0

  const parsed = Number.parseInt(first.value, 10)
  return Number.isNaN(parsed) ? 0 : parsed
}

function splitStatements(migrationSql: string): readonly string[] {
  return migrationSql
    .split('--> statement-breakpoint')
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0)
}
