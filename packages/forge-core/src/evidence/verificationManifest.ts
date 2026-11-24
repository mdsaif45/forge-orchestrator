/**
 * EVIDENCE-007: Automated reproducible verification manifest generator.
 * Produces cryptographic, standalone audit proofs of execution correctness (Axioms A1, A3).
 */

import { createHash } from 'node:crypto'

export interface ManifestFileEntry {
  readonly path: string
  readonly sha256: string
}

export interface ManifestCommandEntry {
  readonly command: string
  readonly exitCode: number
  readonly passed: boolean
}

export interface ManifestCriterionEntry {
  readonly id: string
  readonly kind: string
  readonly passed: boolean
}

export interface VerificationManifestInput {
  readonly runId: string
  readonly gitHeadSha: string
  readonly baselineSha?: string | undefined
  readonly files: readonly ManifestFileEntry[]
  readonly commands: readonly ManifestCommandEntry[]
  readonly criteria: readonly ManifestCriterionEntry[]
  readonly timestamp?: string | undefined
}

export interface VerificationManifest {
  readonly manifestVersion: string
  readonly runId: string
  readonly gitHeadSha: string
  readonly baselineSha: string | null
  readonly createdAt: string
  readonly files: readonly ManifestFileEntry[]
  readonly commands: readonly ManifestCommandEntry[]
  readonly criteria: readonly ManifestCriterionEntry[]
  readonly summary: {
    readonly totalFiles: number
    readonly totalCommands: number
    readonly allCommandsPassed: boolean
    readonly totalCriteria: number
    readonly allCriteriaPassed: boolean
  }
  readonly fingerprint: string
}

export interface ManifestIntegrityReport {
  readonly valid: boolean
  readonly runId: string
  readonly expectedFingerprint: string
  readonly computedFingerprint: string
  readonly formattedSummary: string
  readonly error?: string | undefined
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function computeManifestFingerprint(
  manifest: Omit<VerificationManifest, 'fingerprint'>,
): string {
  const canonicalData = {
    manifestVersion: manifest.manifestVersion,
    runId: manifest.runId,
    gitHeadSha: manifest.gitHeadSha,
    baselineSha: manifest.baselineSha,
    createdAt: manifest.createdAt,
    files: [...manifest.files].sort((a, b) => a.path.localeCompare(b.path)),
    commands: [...manifest.commands].sort((a, b) => a.command.localeCompare(b.command)),
    criteria: [...manifest.criteria].sort((a, b) => a.id.localeCompare(b.id)),
    summary: manifest.summary,
  }
  return sha256(JSON.stringify(canonicalData))
}

/**
 * Builds a reproducible, cryptographic verification manifest for a run (Axiom A3).
 */
export function generateVerificationManifest(
  input: VerificationManifestInput,
): VerificationManifest {
  const createdAt = input.timestamp ?? new Date().toISOString()
  const sortedFiles = [...input.files].sort((a, b) => a.path.localeCompare(b.path))
  const sortedCommands = [...input.commands].sort((a, b) => a.command.localeCompare(b.command))
  const sortedCriteria = [...input.criteria].sort((a, b) => a.id.localeCompare(b.id))

  const allCommandsPassed = sortedCommands.every((c) => c.passed)
  const allCriteriaPassed = sortedCriteria.every((c) => c.passed)

  const partialManifest: Omit<VerificationManifest, 'fingerprint'> = {
    manifestVersion: '1.0.0',
    runId: input.runId,
    gitHeadSha: input.gitHeadSha,
    baselineSha: input.baselineSha ?? null,
    createdAt,
    files: sortedFiles,
    commands: sortedCommands,
    criteria: sortedCriteria,
    summary: {
      totalFiles: sortedFiles.length,
      totalCommands: sortedCommands.length,
      allCommandsPassed,
      totalCriteria: sortedCriteria.length,
      allCriteriaPassed,
    },
  }

  const fingerprint = computeManifestFingerprint(partialManifest)

  return {
    ...partialManifest,
    fingerprint,
  }
}

/**
 * Verifies that a manifest's cryptographic fingerprint matches its physical contents (Axiom A3).
 */
export function verifyManifestIntegrity(manifest: VerificationManifest): ManifestIntegrityReport {
  const { fingerprint, ...rest } = manifest
  const computed = computeManifestFingerprint(rest)

  if (fingerprint !== computed) {
    const err = 'Manifest fingerprint mismatch: cryptographic evidence has been tampered with'
    return {
      valid: false,
      runId: manifest.runId,
      expectedFingerprint: fingerprint,
      computedFingerprint: computed,
      formattedSummary: `VERIFICATION MANIFEST CORRUPTED: ${err}`,
      error: err,
    }
  }

  return {
    valid: true,
    runId: manifest.runId,
    expectedFingerprint: fingerprint,
    computedFingerprint: computed,
    formattedSummary: `VERIFICATION MANIFEST VALID: Run ${manifest.runId} verified (SHA-256: ${fingerprint.slice(0, 16)}...)`,
  }
}
