import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import * as schema from './schema'

export type ForgeDatabase = BetterSQLite3Database<typeof schema>

export interface OpenDatabaseOptions {
  /** A filesystem path, or `:memory:` for tests. */
  readonly file: string
}

/**
 * Opens the database and applies the pragmas Forge depends on.
 *
 * `better-sqlite3@13` ships N-API prebuilds keyed by platform rather than by Node
 * version, so it loads unchanged in both plain Node and Electron. No rebuild step
 * is required — verified against Node's ABI 127 and Electron's 148.
 */
export interface OpenDatabaseResult {
  readonly db: ForgeDatabase
  /** The underlying handle, kept so pragmas can be read back and asserted. */
  readonly sqlite: Database.Database
  readonly close: () => void
}

export function openDatabase({ file }: OpenDatabaseOptions): OpenDatabaseResult {
  const sqlite = new Database(file)

  // Foreign keys are OFF by default in SQLite, per connection. Without this, the
  // cascades declared in the schema silently do nothing.
  sqlite.pragma('foreign_keys = ON')

  // WAL lets a reader run while a writer commits. Forge writes an event on every
  // domain mutation while the UI reads projections, so the default rollback
  // journal would serialise the two.
  if (file !== ':memory:') {
    sqlite.pragma('journal_mode = WAL')
    // NORMAL trades a small durability window on OS crash for far fewer fsyncs.
    // Acceptable because the event log is the recovery mechanism: a lost tail
    // means replaying from the last durable event, not corruption.
    sqlite.pragma('synchronous = NORMAL')
  }

  // Fail fast rather than hang forever if another connection holds a write lock.
  sqlite.pragma('busy_timeout = 5000')

  return {
    db: drizzle(sqlite, { schema }),
    sqlite,
    close: () => {
      sqlite.close()
    },
  }
}

/**
 * Reads the pragmas back, so a test can assert they were actually applied rather
 * than trusting that the calls above had an effect.
 */
export function readPragmas(sqlite: Database.Database): {
  readonly foreignKeys: number
  readonly journalMode: string
} {
  return {
    foreignKeys: Number(sqlite.pragma('foreign_keys', { simple: true })),
    journalMode: String(sqlite.pragma('journal_mode', { simple: true })),
  }
}
