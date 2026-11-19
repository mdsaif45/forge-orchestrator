import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type Database from 'better-sqlite3'

export interface WalCheckpointResult {
  readonly valid: boolean
  readonly checkpointExecuted: boolean
  readonly sizeBeforeBytes: number
  readonly sizeAfterBytes: number
  readonly reclaimedBytes: number
  readonly busy: number
  readonly log: number
  readonly checkpointed: number
  readonly durationMs: number
  readonly formattedSummary: string
  readonly error?: string | undefined
}

export interface StorageQuotaReport {
  readonly dbSizeBytes: number
  readonly walSizeBytes: number
  readonly shmSizeBytes: number
  readonly artifactsSizeBytes: number
  readonly totalStorageBytes: number
  readonly quotaLimitBytes: number
  readonly usagePercent: number
  readonly quotaExceeded: boolean
  readonly formattedSummary: string
}

function getFileSize(filePath: string): number {
  try {
    if (existsSync(filePath)) {
      return statSync(filePath).size
    }
  } catch {
    // Return 0 if file is inaccessible
  }
  return 0
}

function getDirectorySize(dirPath: string): number {
  let total = 0
  try {
    if (!existsSync(dirPath)) return 0
    const entries = readdirSync(dirPath, { withFileTypes: true })
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name)
      if (entry.isDirectory()) {
        total += getDirectorySize(fullPath)
      } else if (entry.isFile()) {
        total += getFileSize(fullPath)
      }
    }
  } catch {
    // Return accumulated bytes on read failure
  }
  return total
}

/**
 * Truncates and checkpoints SQLite WAL log, reclaiming disk space (Axioms A1, A4, A5).
 */
export function executeWalCheckpoint(
  db: Database.Database,
  dbPath: string,
  options: { force?: boolean | undefined; thresholdBytes?: number | undefined } = {},
): WalCheckpointResult {
  const walPath = `${dbPath}-wal`
  const sizeBeforeBytes = getFileSize(walPath)
  const threshold = options.thresholdBytes ?? 5 * 1024 * 1024 // 5MB default

  if (!options.force && sizeBeforeBytes < threshold) {
    return {
      valid: true,
      checkpointExecuted: false,
      sizeBeforeBytes,
      sizeAfterBytes: sizeBeforeBytes,
      reclaimedBytes: 0,
      busy: 0,
      log: 0,
      checkpointed: 0,
      durationMs: 0,
      formattedSummary: `WAL checkpoint skipped: current WAL (${String(sizeBeforeBytes)} bytes) is below threshold of ${String(threshold)} bytes`,
    }
  }

  const start = Date.now()
  try {
    const rows = db.pragma('wal_checkpoint(TRUNCATE)') as readonly {
      busy: number
      log: number
      checkpointed: number
    }[]
    const first = rows[0] ?? { busy: 0, log: 0, checkpointed: 0 }
    const sizeAfterBytes = getFileSize(walPath)
    const reclaimedBytes = Math.max(0, sizeBeforeBytes - sizeAfterBytes)
    const durationMs = Date.now() - start

    const lines: string[] = [
      `WAL CHECKPOINT (TRUNCATE) COMPLETED (${String(durationMs)}ms):`,
      `  Size Before: ${String(sizeBeforeBytes)} bytes`,
      `  Size After:  ${String(sizeAfterBytes)} bytes`,
      `  Reclaimed:   ${String(reclaimedBytes)} bytes`,
      `  Busy Status: ${String(first.busy)} | Checkpointed: ${String(first.checkpointed)} pages`,
    ]

    return {
      valid: true,
      checkpointExecuted: true,
      sizeBeforeBytes,
      sizeAfterBytes,
      reclaimedBytes,
      busy: first.busy,
      log: first.log,
      checkpointed: first.checkpointed,
      durationMs,
      formattedSummary: lines.join('\n'),
    }
  } catch (error) {
    const durationMs = Date.now() - start
    const msg = error instanceof Error ? error.message : String(error)
    return {
      valid: false,
      checkpointExecuted: false,
      sizeBeforeBytes,
      sizeAfterBytes: sizeBeforeBytes,
      reclaimedBytes: 0,
      busy: -1,
      log: -1,
      checkpointed: -1,
      durationMs,
      formattedSummary: `WAL CHECKPOINT FAILED: ${msg}`,
      error: msg,
    }
  }
}

/**
 * Audits total database and artifact disk footprint against quota thresholds (Axiom A5).
 */
export function auditDatabaseStorageQuota(
  dataDir: string,
  quotaLimitBytes = 1024 * 1024 * 1024, // 1GB default
): StorageQuotaReport {
  const dbFile = join(dataDir, 'forge.db')
  const walFile = join(dataDir, 'forge.db-wal')
  const shmFile = join(dataDir, 'forge.db-shm')
  const artifactsDir = join(dataDir, 'artifacts')

  const dbSizeBytes = getFileSize(dbFile)
  const walSizeBytes = getFileSize(walFile)
  const shmSizeBytes = getFileSize(shmFile)
  const artifactsSizeBytes = getDirectorySize(artifactsDir)

  const totalStorageBytes = dbSizeBytes + walSizeBytes + shmSizeBytes + artifactsSizeBytes
  const usagePercent =
    quotaLimitBytes > 0 ? Math.round((totalStorageBytes / quotaLimitBytes) * 10_000) / 100 : 0
  const quotaExceeded = totalStorageBytes > quotaLimitBytes

  const lines: string[] = [
    `STORAGE QUOTA AUDIT: ${quotaExceeded ? 'EXCEEDED' : 'HEALTHY'}`,
    `  Database File:   ${String(dbSizeBytes)} bytes`,
    `  WAL Journal:     ${String(walSizeBytes)} bytes`,
    `  SHM Index:       ${String(shmSizeBytes)} bytes`,
    `  Artifacts Tree:  ${String(artifactsSizeBytes)} bytes`,
    `  Total Footprint: ${String(totalStorageBytes)} bytes (${String(usagePercent)}% of ${String(quotaLimitBytes)} bytes)`,
  ]

  return {
    dbSizeBytes,
    walSizeBytes,
    shmSizeBytes,
    artifactsSizeBytes,
    totalStorageBytes,
    quotaLimitBytes,
    usagePercent,
    quotaExceeded,
    formattedSummary: lines.join('\n'),
  }
}
