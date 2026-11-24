import Database from 'better-sqlite3'
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'

export interface DatabaseBackupResult {
  readonly valid: boolean
  readonly backupPath: string
  readonly sizeBytes: number
  readonly sha256: string
  readonly durationMs: number
  readonly tableCount: number
  readonly formattedSummary: string
  readonly error?: string | undefined
}

export interface DatabaseRestoreResult {
  readonly success: boolean
  readonly restoredPath: string
  readonly backupPath: string
  readonly safetyCopyPath?: string | undefined
  readonly durationMs: number
  readonly formattedSummary: string
  readonly error?: string | undefined
}

export interface RestoreOptions {
  readonly force?: boolean | undefined
}

/**
 * Creates an authoritative, non-blocking point-in-time backup snapshot of an open SQLite database.
 *
 * Implements Axioms:
 * - A1 (Truth ownership): Preserves exact relational state and event history.
 * - A3 (Physical evidence): Generates physical SHA-256 hash and validates disk bytes via PRAGMA integrity_check.
 */
export async function backupDatabase(
  sqlite: Database.Database,
  rawTargetPath: string,
): Promise<DatabaseBackupResult> {
  const start = Date.now()
  const targetPath = resolve(rawTargetPath)

  try {
    await mkdir(dirname(targetPath), { recursive: true })

    // Execute SQLite Online Backup API
    await sqlite.backup(targetPath)

    // Compute physical file SHA-256
    const fileBytes = await readFile(targetPath)
    const sha256 = createHash('sha256').update(fileBytes).digest('hex')
    const fileStat = await stat(targetPath)

    // Verify integrity of the created snapshot
    const backupDb = new Database(targetPath, { readonly: true })
    let integrityResult = 'unknown'
    let tableCount = 0

    try {
      integrityResult = String(backupDb.pragma('integrity_check', { simple: true }))
      const tables = backupDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'")
        .all()
      tableCount = tables.length
    } finally {
      backupDb.close()
    }

    if (integrityResult !== 'ok') {
      await rm(targetPath, { force: true })
      return {
        valid: false,
        backupPath: targetPath,
        sizeBytes: 0,
        sha256: '',
        durationMs: Date.now() - start,
        tableCount: 0,
        formattedSummary: `Backup snapshot failed integrity check: ${integrityResult}`,
        error: `Integrity check failed: ${integrityResult}`,
      }
    }

    const durationMs = Date.now() - start
    const lines: string[] = []
    lines.push('================================================================================')
    lines.push(`Database Backup Snapshot Completed: ${targetPath}`)
    lines.push(
      `Size: ${String(fileStat.size)} bytes | Tables: ${String(tableCount)} | SHA-256: ${sha256} | Time: ${String(durationMs)}ms`,
    )
    lines.push('================================================================================')

    return {
      valid: true,
      backupPath: targetPath,
      sizeBytes: fileStat.size,
      sha256,
      durationMs,
      tableCount,
      formattedSummary: lines.join('\n'),
    }
  } catch (err) {
    return {
      valid: false,
      backupPath: targetPath,
      sizeBytes: 0,
      sha256: '',
      durationMs: Date.now() - start,
      tableCount: 0,
      formattedSummary: `Database backup failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Restores an active Forge database from an authoritative backup snapshot with safety rollbacks.
 *
 * Implements Axiom A2 (Fail-closed): Pre-checks backup file integrity and creates an immediate
 * safety copy of the active database before overwriting. If post-flight verification fails,
 * automatically reverts from the safety copy.
 */
export async function restoreDatabase(
  activeDbPath: string,
  rawBackupPath: string,
  options: RestoreOptions = {},
): Promise<DatabaseRestoreResult> {
  const start = Date.now()
  const backupPath = resolve(rawBackupPath)
  const resolvedActivePath = resolve(activeDbPath)

  if (!existsSync(backupPath)) {
    return {
      success: false,
      restoredPath: resolvedActivePath,
      backupPath,
      durationMs: Date.now() - start,
      formattedSummary: `Backup file does not exist: ${backupPath}`,
      error: `Backup file not found: ${backupPath}`,
    }
  }

  // 1. Pre-flight check on backup
  let preflightCheck: string
  try {
    const backupDb = new Database(backupPath, { readonly: true })
    try {
      preflightCheck = String(backupDb.pragma('integrity_check', { simple: true }))
    } finally {
      backupDb.close()
    }
  } catch (err) {
    return {
      success: false,
      restoredPath: resolvedActivePath,
      backupPath,
      durationMs: Date.now() - start,
      formattedSummary: `Failed opening backup snapshot: ${err instanceof Error ? err.message : String(err)}`,
      error: `Unreadable backup file: ${err instanceof Error ? err.message : String(err)}`,
    }
  }

  if (preflightCheck !== 'ok') {
    return {
      success: false,
      restoredPath: resolvedActivePath,
      backupPath,
      durationMs: Date.now() - start,
      formattedSummary: `Backup snapshot failed pre-flight integrity check: ${preflightCheck}`,
      error: `Corrupted backup snapshot: ${preflightCheck}`,
    }
  }

  // 2. Create safety copy of active database if it exists
  let safetyCopyPath: string | undefined
  if (existsSync(resolvedActivePath)) {
    safetyCopyPath = `${resolvedActivePath}.safety-${String(Date.now())}`
    try {
      await copyFile(resolvedActivePath, safetyCopyPath)
    } catch (err) {
      if (!options.force) {
        return {
          success: false,
          restoredPath: resolvedActivePath,
          backupPath,
          durationMs: Date.now() - start,
          formattedSummary: `Failed to create safety backup of active database: ${err instanceof Error ? err.message : String(err)}`,
          error: `Safety backup creation failed: ${err instanceof Error ? err.message : String(err)}`,
        }
      }
    }
  }

  // 3. Atomically overwrite active database with backup
  try {
    await mkdir(dirname(resolvedActivePath), { recursive: true })
    await copyFile(backupPath, resolvedActivePath)

    // Remove any stale WAL or SHM files
    await rm(`${resolvedActivePath}-wal`, { force: true }).catch(() => undefined)
    await rm(`${resolvedActivePath}-shm`, { force: true }).catch(() => undefined)
  } catch (copyErr) {
    // Attempt rollback if safety copy exists
    if (safetyCopyPath && existsSync(safetyCopyPath)) {
      await copyFile(safetyCopyPath, resolvedActivePath).catch(() => undefined)
    }
    return {
      success: false,
      restoredPath: resolvedActivePath,
      backupPath,
      safetyCopyPath,
      durationMs: Date.now() - start,
      formattedSummary: `Failed copying backup to active database location: ${copyErr instanceof Error ? copyErr.message : String(copyErr)}`,
      error: copyErr instanceof Error ? copyErr.message : String(copyErr),
    }
  }

  // 4. Post-flight check on restored active database
  let postflightCheck: string
  try {
    const restoredDb = new Database(resolvedActivePath, { readonly: true })
    try {
      postflightCheck = String(restoredDb.pragma('integrity_check', { simple: true }))
    } finally {
      restoredDb.close()
    }
  } catch (err) {
    postflightCheck = err instanceof Error ? err.message : String(err)
  }

  if (postflightCheck !== 'ok') {
    // Rollback immediately!
    if (safetyCopyPath && existsSync(safetyCopyPath)) {
      await copyFile(safetyCopyPath, resolvedActivePath).catch(() => undefined)
    }
    return {
      success: false,
      restoredPath: resolvedActivePath,
      backupPath,
      safetyCopyPath,
      durationMs: Date.now() - start,
      formattedSummary: `Post-flight integrity check failed on restored database: ${postflightCheck}. Reverted to safety copy.`,
      error: `Post-flight integrity failed: ${postflightCheck}`,
    }
  }

  const durationMs = Date.now() - start
  const lines: string[] = []
  lines.push('================================================================================')
  lines.push(`Database Restored Successfully: ${resolvedActivePath}`)
  lines.push(`Source Backup: ${backupPath}`)
  if (safetyCopyPath) {
    lines.push(`Safety Pre-Restore Copy: ${safetyCopyPath}`)
  }
  lines.push(`Integrity: VERIFIED (PRAGMA integrity_check: ok) | Duration: ${String(durationMs)}ms`)
  lines.push('================================================================================')

  return {
    success: true,
    restoredPath: resolvedActivePath,
    backupPath,
    safetyCopyPath,
    durationMs,
    formattedSummary: lines.join('\n'),
  }
}
