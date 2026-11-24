import type Database from 'better-sqlite3'

export interface DatabaseIntegrityReport {
  readonly valid: boolean
  readonly integrityCheckPassed: boolean
  readonly foreignKeyErrors: readonly string[]
  readonly orphanedRunSteps: number
  readonly orphanedRunEvents: number
  readonly orphanedArtifacts: number
  readonly totalOrphans: number
  readonly formattedSummary: string
}

export interface DatabasePruneResult {
  readonly valid: boolean
  readonly prunedSteps: number
  readonly prunedEvents: number
  readonly prunedArtifacts: number
  readonly totalPruned: number
  readonly formattedSummary: string
}

/**
 * Audits relational and structural integrity of the SQLite database (Axioms A1, A4).
 */
export function auditDatabaseIntegrity(db: Database.Database): DatabaseIntegrityReport {
  // 1. Run PRAGMA integrity_check
  const integrityRows = db.pragma('integrity_check') as readonly {
    integrity_check: string
  }[]
  const integrityCheckPassed =
    integrityRows.length === 1 && integrityRows[0]?.integrity_check.toLowerCase() === 'ok'

  // 2. Run PRAGMA foreign_key_check
  const fkRows = db.pragma('foreign_key_check') as readonly Record<string, unknown>[]
  const foreignKeyErrors: string[] = fkRows.map(
    (row, idx) =>
      `[${String(idx + 1)}] Table "${String(row.table)}" rowid ${String(row.rowid)} violates FK to "${String(row.parent)}"`,
  )

  // 3. Relational orphan counts
  let orphanedRunSteps = 0
  let orphanedRunEvents = 0
  let orphanedArtifacts = 0

  try {
    const stepRow = db
      .prepare('SELECT count(*) as count FROM run_steps WHERE run_id NOT IN (SELECT id FROM runs)')
      .get() as { count: number } | undefined
    orphanedRunSteps = stepRow?.count ?? 0
  } catch {
    // Table may not exist yet
  }

  try {
    const eventRow = db
      .prepare('SELECT count(*) as count FROM run_events WHERE run_id NOT IN (SELECT id FROM runs)')
      .get() as { count: number } | undefined
    orphanedRunEvents = eventRow?.count ?? 0
  } catch {
    // Table may not exist yet
  }

  try {
    const artRow = db
      .prepare('SELECT count(*) as count FROM artifacts WHERE run_id NOT IN (SELECT id FROM runs)')
      .get() as { count: number } | undefined
    orphanedArtifacts = artRow?.count ?? 0
  } catch {
    // Table may not exist yet
  }

  const totalOrphans = orphanedRunSteps + orphanedRunEvents + orphanedArtifacts
  const valid = integrityCheckPassed && foreignKeyErrors.length === 0 && totalOrphans === 0

  const lines: string[] = [
    `DATABASE INTEGRITY & ORPHAN AUDIT: ${valid ? 'PASSED' : 'FAILED'}`,
    `  PRAGMA integrity_check: ${integrityCheckPassed ? 'OK' : 'CORRUPTED'}`,
    `  Foreign Key Violations:  ${String(foreignKeyErrors.length)}`,
    `  Orphaned Run Steps:      ${String(orphanedRunSteps)}`,
    `  Orphaned Run Events:     ${String(orphanedRunEvents)}`,
    `  Orphaned Artifacts:      ${String(orphanedArtifacts)}`,
  ]

  if (foreignKeyErrors.length > 0) {
    lines.push('\nForeign Key Violations:')
    lines.push(...foreignKeyErrors.map((e) => `  ${e}`))
  }

  return {
    valid,
    integrityCheckPassed,
    foreignKeyErrors,
    orphanedRunSteps,
    orphanedRunEvents,
    orphanedArtifacts,
    totalOrphans,
    formattedSummary: lines.join('\n'),
  }
}

/**
 * Safely removes orphaned child records that reference non-existent runs (Axiom A1).
 */
export function pruneOrphanedDatabaseRecords(db: Database.Database): DatabasePruneResult {
  let prunedSteps = 0
  let prunedEvents = 0
  let prunedArtifacts = 0

  try {
    const info = db.prepare('DELETE FROM run_steps WHERE run_id NOT IN (SELECT id FROM runs)').run()
    prunedSteps = info.changes
  } catch {
    // Ignore
  }

  try {
    const info = db
      .prepare('DELETE FROM run_events WHERE run_id NOT IN (SELECT id FROM runs)')
      .run()
    prunedEvents = info.changes
  } catch {
    // Ignore
  }

  try {
    const info = db.prepare('DELETE FROM artifacts WHERE run_id NOT IN (SELECT id FROM runs)').run()
    prunedArtifacts = info.changes
  } catch {
    // Ignore
  }

  const totalPruned = prunedSteps + prunedEvents + prunedArtifacts

  return {
    valid: true,
    prunedSteps,
    prunedEvents,
    prunedArtifacts,
    totalPruned,
    formattedSummary: `✓ Pruned ${String(totalPruned)} orphaned database records (${String(prunedSteps)} steps, ${String(prunedEvents)} events, ${String(prunedArtifacts)} artifacts).`,
  }
}
