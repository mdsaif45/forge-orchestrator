import { openDatabase, type ForgeDatabase, type OpenDatabaseResult } from './connection'
import { MIGRATIONS } from './migrations.generated'
import { runMigrations } from './migrate'

export {
  openDatabase,
  readPragmas,
  type ForgeDatabase,
  type OpenDatabaseResult,
} from './connection'
export { loadMigrations, readAppliedCount, runMigrations, type Migration } from './migrate'
export {
  planResume,
  resumeDecisionSchema,
  WorkflowStore,
  type ResumeDecision,
  type ResumePlan,
  type StartWorkflowInput,
} from './workflowStore'
export * as schema from './schema'
export { MIGRATIONS } from './migrations.generated'

/**
 * Opens the database and brings it up to date.
 *
 * Idempotent: a second call on an already-migrated file applies nothing. The
 * `applied` count is returned so startup can log whether it did work, which turns
 * "did the migration run?" into an observation rather than an assumption.
 */
export function initialiseDatabase(file: string): {
  readonly db: ForgeDatabase
  readonly sqlite: OpenDatabaseResult['sqlite']
  readonly close: () => void
  readonly applied: number
} {
  const { db, sqlite, close } = openDatabase({ file })

  try {
    const applied = runMigrations(db, MIGRATIONS)
    return { db, sqlite, close, applied }
  } catch (error) {
    // Leaving the handle open on a failed migration would hold a lock on a
    // database the app cannot use.
    close()
    throw error
  }
}
