import { createHash } from 'node:crypto'
import type { RunId } from '@shared/domain'
import type { ArtifactService } from '../artifacts'
import type { ArtifactStore } from '../db/artifactStore'

export interface ArtifactAuditResult {
  readonly artifactId: string
  readonly name: string
  readonly kind: string
  readonly valid: boolean
  readonly recordedHash: string
  readonly computedHash?: string
  readonly recordedSize: number
  readonly actualSize?: number
  readonly error?: 'file_not_found' | 'checksum_mismatch' | 'read_error'
}

export interface ChecksumAuditReport {
  readonly valid: boolean
  readonly runId: string
  readonly totalArtifacts: number
  readonly verifiedCount: number
  readonly tamperedCount: number
  readonly missingCount: number
  readonly results: readonly ArtifactAuditResult[]
}

/**
 * Audits all on-disk artifacts recorded for a run against their authoritative SQLite hashes and sizes.
 * Detects missing, truncated, or tampered artifact files (Axioms A2 and A3).
 */
export async function auditArtifactChecksums(
  artifactService: ArtifactService,
  artifactStore: ArtifactStore,
  runId: string,
): Promise<ChecksumAuditReport> {
  const artifacts = artifactStore.listForRun(runId as RunId)
  if (artifacts.length === 0) {
    return {
      valid: true,
      runId,
      totalArtifacts: 0,
      verifiedCount: 0,
      tamperedCount: 0,
      missingCount: 0,
      results: [],
    }
  }

  const results: ArtifactAuditResult[] = []
  let verifiedCount = 0
  let tamperedCount = 0
  let missingCount = 0

  for (const record of artifacts) {
    let buffer: Buffer | null
    try {
      buffer = await artifactService.readArtifact(record.id)
    } catch {
      buffer = null
    }

    if (!buffer) {
      missingCount++
      results.push({
        artifactId: record.id,
        name: record.name,
        kind: record.kind,
        valid: false,
        recordedHash: record.sha256,
        recordedSize: record.sizeBytes,
        error: 'file_not_found',
      })
      continue
    }

    const computedHash = createHash('sha256').update(buffer).digest('hex')
    const actualSize = buffer.length

    if (computedHash !== record.sha256 || actualSize !== record.sizeBytes) {
      tamperedCount++
      results.push({
        artifactId: record.id,
        name: record.name,
        kind: record.kind,
        valid: false,
        recordedHash: record.sha256,
        computedHash,
        recordedSize: record.sizeBytes,
        actualSize,
        error: 'checksum_mismatch',
      })
    } else {
      verifiedCount++
      results.push({
        artifactId: record.id,
        name: record.name,
        kind: record.kind,
        valid: true,
        recordedHash: record.sha256,
        computedHash,
        recordedSize: record.sizeBytes,
        actualSize,
      })
    }
  }

  const valid = missingCount === 0 && tamperedCount === 0

  return {
    valid,
    runId,
    totalArtifacts: artifacts.length,
    verifiedCount,
    tamperedCount,
    missingCount,
    results,
  }
}
