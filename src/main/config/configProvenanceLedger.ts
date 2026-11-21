/**
 * Copyright (c) 2026 Forge Authors
 * Technology: TypeScript / Node.js
 * Architecture: Workspace Configuration Snapshot Rollback & Provenance Ledger (CONFIG-024)
 * Axioms Enforced:
 *  - A1: Bugs are bounded & fail-closed (invalid checksums or broken ledger chains reject rollback).
 *  - A2: Explicit validation of configuration state and snapshot lineage.
 *  - A3: Physical evidence beats claims (cryptographic hash chains verify ledger integrity).
 *  - A4: Decisions lock (snapshots are immutable and append-only).
 *  - A7: Least privilege & security (author attribution and provenance tracking).
 */

import { createHash, randomUUID } from 'node:crypto'

export interface ConfigSnapshot {
  readonly snapshotId: string
  readonly timestamp: number
  readonly isoTimestamp: string
  readonly author: string
  readonly reason: string
  readonly parentChecksum: string | null
  readonly checksum: string
  readonly configState: Record<string, unknown>
  readonly tags?: readonly string[] | undefined
}

export interface ConfigDiffEntry {
  readonly path: string
  readonly changeType: 'ADDED' | 'MODIFIED' | 'REMOVED'
  readonly oldValue: unknown
  readonly newValue: unknown
}

export interface LedgerIntegrityReport {
  readonly valid: boolean
  readonly totalSnapshots: number
  readonly brokenAtIndex?: number
  readonly error?: string
}

export interface RecordSnapshotOptions {
  readonly author: string
  readonly reason: string
  readonly configState: Record<string, unknown>
  readonly tags?: readonly string[] | undefined
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const sortedKeys = Object.keys(obj).sort()
  const entries = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
  return `{${entries.join(',')}}`
}

function computeSnapshotHash(
  parentChecksum: string | null,
  author: string,
  reason: string,
  configState: Record<string, unknown>,
): string {
  const content = canonicalize({
    parentChecksum,
    author: author.trim(),
    reason: reason.trim(),
    configState,
  })
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

export class ConfigProvenanceLedger {
  private readonly snapshots: ConfigSnapshot[] = []

  public constructor(initialSnapshots?: readonly ConfigSnapshot[]) {
    if (initialSnapshots && initialSnapshots.length > 0) {
      for (const s of initialSnapshots) {
        this.snapshots.push(s)
      }
    }
  }

  /**
   * Records a new configuration snapshot into the append-only ledger.
   */
  public recordSnapshot(options: RecordSnapshotOptions): ConfigSnapshot {
    if (!options.author || options.author.trim().length === 0) {
      throw new Error('[CONFIG-024] Snapshot author must not be empty')
    }
    if (!options.reason || options.reason.trim().length === 0) {
      throw new Error('[CONFIG-024] Snapshot reason must not be empty')
    }

    const parent = this.getLatestSnapshot()
    const parentChecksum = parent ? parent.checksum : null
    const checksum = computeSnapshotHash(
      parentChecksum,
      options.author,
      options.reason,
      options.configState,
    )

    const now = Date.now()
    const snapshot: ConfigSnapshot = {
      snapshotId: `snap-${String(now)}-${randomUUID().slice(0, 8)}`,
      timestamp: now,
      isoTimestamp: new Date(now).toISOString(),
      author: options.author.trim(),
      reason: options.reason.trim(),
      parentChecksum,
      checksum,
      configState: JSON.parse(JSON.stringify(options.configState)) as Record<string, unknown>,
      ...(options.tags ? { tags: [...options.tags] } : {}),
    }

    this.snapshots.push(snapshot)
    return snapshot
  }

  /**
   * Retrieves a snapshot by ID.
   */
  public getSnapshot(snapshotId: string): ConfigSnapshot | null {
    return this.snapshots.find((s) => s.snapshotId === snapshotId) ?? null
  }

  /**
   * Returns the most recent snapshot in the ledger.
   */
  public getLatestSnapshot(): ConfigSnapshot | null {
    return this.snapshots.length > 0 ? (this.snapshots[this.snapshots.length - 1] ?? null) : null
  }

  /**
   * Lists all snapshots in chronological order.
   */
  public listSnapshots(): readonly ConfigSnapshot[] {
    return [...this.snapshots]
  }

  /**
   * Rolls back configuration to a target historical snapshot by appending a new rollback snapshot.
   * Preserves append-only ledger integrity (A4).
   */
  public rollbackTo(targetSnapshotId: string, author: string, reason: string): ConfigSnapshot {
    const target = this.getSnapshot(targetSnapshotId)
    if (!target) {
      throw new Error(
        `[CONFIG-024] Cannot rollback: Target snapshot '${targetSnapshotId}' not found in ledger`,
      )
    }

    // Verify current ledger integrity before executing rollback (fail-closed A1)
    const verification = this.verifyLedgerIntegrity()
    if (!verification.valid) {
      throw new Error(
        `[CONFIG-024] Cannot rollback: Ledger integrity corrupted (${verification.error ?? 'unknown error'})`,
      )
    }

    return this.recordSnapshot({
      author,
      reason: `Rollback to ${targetSnapshotId}: ${reason}`,
      configState: target.configState,
      tags: ['rollback', `reverted-to:${targetSnapshotId}`],
    })
  }

  /**
   * Verifies the cryptographic hash chain and content integrity of the entire ledger.
   */
  public verifyLedgerIntegrity(): LedgerIntegrityReport {
    if (this.snapshots.length === 0) {
      return { valid: true, totalSnapshots: 0 }
    }

    for (let i = 0; i < this.snapshots.length; i++) {
      const current = this.snapshots[i]
      if (!current) continue

      const expectedParent = i === 0 ? null : (this.snapshots[i - 1]?.checksum ?? null)

      if (current.parentChecksum !== expectedParent) {
        return {
          valid: false,
          totalSnapshots: this.snapshots.length,
          brokenAtIndex: i,
          error: `Parent checksum mismatch at index ${String(i)}: expected '${expectedParent ?? 'null'}', got '${current.parentChecksum ?? 'null'}'`,
        }
      }

      const recomputedHash = computeSnapshotHash(
        current.parentChecksum,
        current.author,
        current.reason,
        current.configState,
      )

      if (recomputedHash !== current.checksum) {
        return {
          valid: false,
          totalSnapshots: this.snapshots.length,
          brokenAtIndex: i,
          error: `Checksum tampering detected at index ${String(i)}: expected '${recomputedHash}', got '${current.checksum}'`,
        }
      }
    }

    return {
      valid: true,
      totalSnapshots: this.snapshots.length,
    }
  }

  /**
   * Computes differences between two snapshots.
   */
  public diffSnapshots(sourceSnapshotId: string, targetSnapshotId: string): ConfigDiffEntry[] {
    const source = this.getSnapshot(sourceSnapshotId)
    const target = this.getSnapshot(targetSnapshotId)

    if (!source) {
      throw new Error(`[CONFIG-024] Source snapshot '${sourceSnapshotId}' not found`)
    }
    if (!target) {
      throw new Error(`[CONFIG-024] Target snapshot '${targetSnapshotId}' not found`)
    }

    const diffs: ConfigDiffEntry[] = []
    const allKeys = new Set([
      ...Object.keys(source.configState),
      ...Object.keys(target.configState),
    ])

    for (const key of Array.from(allKeys).sort()) {
      const hasOld = Object.prototype.hasOwnProperty.call(source.configState, key)
      const hasNew = Object.prototype.hasOwnProperty.call(target.configState, key)
      const oldVal = source.configState[key]
      const newVal = target.configState[key]

      if (!hasOld && hasNew) {
        diffs.push({
          path: key,
          changeType: 'ADDED',
          oldValue: undefined,
          newValue: newVal,
        })
      } else if (hasOld && !hasNew) {
        diffs.push({
          path: key,
          changeType: 'REMOVED',
          oldValue: oldVal,
          newValue: undefined,
        })
      } else if (JSON.stringify(oldVal) !== JSON.stringify(newVal)) {
        diffs.push({
          path: key,
          changeType: 'MODIFIED',
          oldValue: oldVal,
          newValue: newVal,
        })
      }
    }

    return diffs
  }

  /**
   * Serializes the entire provenance ledger to a JSON string.
   */
  public exportLedgerJson(): string {
    return JSON.stringify(this.snapshots, null, 2)
  }

  /**
   * Imports snapshots from JSON string into a new verified ledger.
   */
  public static importLedgerJson(jsonStr: string): ConfigProvenanceLedger {
    const parsed = JSON.parse(jsonStr) as ConfigSnapshot[]
    if (!Array.isArray(parsed)) {
      throw new Error('[CONFIG-024] Invalid ledger JSON: expected array of snapshots')
    }
    const ledger = new ConfigProvenanceLedger(parsed)
    const report = ledger.verifyLedgerIntegrity()
    if (!report.valid) {
      throw new Error(
        `[CONFIG-024] Imported ledger failed integrity verification: ${report.error ?? 'unknown error'}`,
      )
    }
    return ledger
  }
}
