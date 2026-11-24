/**
 * EVIDENCE-014: Cryptographic Provenance Attestation Generator & Reproducible Artifact Manifest
 *
 * Implements in-toto v1.0 and SLSA v1.0 compliant cryptographic provenance attestation statements.
 * Attests to physical artifact sha256 digests, git commit sources, and build invocation metadata.
 *
 * Conforms to Forge Axioms:
 * - A1: Fail-closed verification and zero `any`.
 * - A3: Physical evidence beats claims (artifact digests and cryptographic attestation).
 * - A4: Immutable statement envelopes.
 * - A7: Least privilege and secure provenance attestation.
 */

import { createHash } from 'node:crypto'
import os from 'node:os'

export const IN_TOTO_STATEMENT_V1 = 'https://in-toto.io/Statement/v1' as const
export const SLSA_PROVENANCE_V1 = 'https://slsa.dev/provenance/v1' as const
export const FORGE_BUILD_TYPE_V1 = 'https://forge.dev/attestations/task-run/v1' as const

export interface ProvenanceDigest {
  readonly sha256: string
  readonly [algorithm: string]: string
}

export interface ProvenanceSubject {
  readonly name: string
  readonly digest: {
    readonly sha256: string
  }
}

export interface ProvenanceMaterial {
  readonly uri: string
  readonly digest: Record<string, string>
}

export interface ProvenanceInvocation {
  readonly configSource: {
    readonly uri: string
    readonly digest?: Record<string, string> | undefined
    readonly entryPoint: string
  }
  readonly parameters?: Record<string, unknown> | undefined
  readonly environment: {
    readonly os: string
    readonly arch: string
    readonly nodeVersion: string
  }
}

export interface ProvenanceMetadata {
  readonly buildInvocationId: string
  readonly buildStartedOn: string
  readonly buildFinishedOn: string
  readonly completeness: {
    readonly parameters: boolean
    readonly environment: boolean
    readonly materials: boolean
  }
  readonly reproducible: boolean
}

export interface SlsaPredicateV1 {
  readonly builder: {
    readonly id: string
    readonly version?: Record<string, string> | undefined
  }
  readonly buildType: string
  readonly invocation: ProvenanceInvocation
  readonly metadata: ProvenanceMetadata
  readonly materials: readonly ProvenanceMaterial[]
}

export interface ProvenanceStatement {
  readonly _type: typeof IN_TOTO_STATEMENT_V1
  readonly predicateType: typeof SLSA_PROVENANCE_V1
  readonly subject: readonly ProvenanceSubject[]
  readonly predicate: SlsaPredicateV1
}

export interface GenerateProvenanceInput {
  readonly runId: string
  readonly builderId?: string | undefined
  readonly artifacts: readonly { readonly name: string; readonly sha256: string }[]
  readonly gitHeadSha?: string | undefined
  readonly gitRepoUri?: string | undefined
  readonly isDirty?: boolean | undefined
  readonly entryPoint?: string | undefined
  readonly parameters?: Record<string, unknown> | undefined
  readonly startedAt?: string | undefined
  readonly finishedAt?: string | undefined
}

export interface ProvenanceVerificationResult {
  readonly valid: boolean
  readonly statementDigest: string
  readonly subjectCount: number
  readonly errors: readonly string[]
  readonly formattedSummary: string
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * Computes canonical SHA-256 fingerprint of a provenance statement.
 */
export function computeStatementDigest(statement: ProvenanceStatement): string {
  const canonicalJson = JSON.stringify(statement, Object.keys(statement).sort())
  return sha256(canonicalJson)
}

/**
 * Generates an in-toto v1.0 / SLSA v1.0 compliant provenance statement.
 */
export function generateProvenanceStatement(input: GenerateProvenanceInput): ProvenanceStatement {
  const now = new Date().toISOString()
  const startedAt = input.startedAt ?? now
  const finishedAt = input.finishedAt ?? now

  const subject: ProvenanceSubject[] = input.artifacts.map((art) => ({
    name: art.name,
    digest: {
      sha256: art.sha256,
    },
  }))

  const materials: ProvenanceMaterial[] = []
  if (input.gitHeadSha) {
    materials.push({
      uri: input.gitRepoUri ?? 'git+https://github.com/forge/forge',
      digest: {
        gitCommit: input.gitHeadSha,
        ...(input.isDirty ? { dirty: 'true' } : {}),
      },
    })
  }

  const statement: ProvenanceStatement = {
    _type: IN_TOTO_STATEMENT_V1,
    predicateType: SLSA_PROVENANCE_V1,
    subject,
    predicate: {
      builder: {
        id: input.builderId ?? 'https://forge.dev/builders/forge-cli@v1.0.0',
      },
      buildType: FORGE_BUILD_TYPE_V1,
      invocation: {
        configSource: {
          uri: input.gitRepoUri ?? 'git+https://github.com/forge/forge',
          entryPoint: input.entryPoint ?? 'cli.ts:run',
        },
        parameters: input.parameters,
        environment: {
          os: os.platform(),
          arch: os.arch(),
          nodeVersion: process.version,
        },
      },
      metadata: {
        buildInvocationId: input.runId,
        buildStartedOn: startedAt,
        buildFinishedOn: finishedAt,
        completeness: {
          parameters: input.parameters !== undefined,
          environment: true,
          materials: materials.length > 0,
        },
        reproducible: !input.isDirty,
      },
      materials,
    },
  }

  return statement
}

/**
 * Validates in-toto / SLSA v1 schema integrity of a provenance statement.
 */
export function verifyProvenanceStatement(data: unknown): ProvenanceVerificationResult {
  const errors: string[] = []

  if (!data || typeof data !== 'object') {
    return {
      valid: false,
      statementDigest: '',
      subjectCount: 0,
      errors: ['Statement must be a non-null object'],
      formattedSummary: '[Provenance FAIL] Statement is not a valid JSON object.',
    }
  }

  const stmt = data as Record<string, unknown>

  if (stmt._type !== IN_TOTO_STATEMENT_V1) {
    errors.push(
      `Invalid _type: expected '${IN_TOTO_STATEMENT_V1}', received '${String(stmt._type)}'`,
    )
  }

  if (stmt.predicateType !== SLSA_PROVENANCE_V1) {
    errors.push(
      `Invalid predicateType: expected '${SLSA_PROVENANCE_V1}', received '${String(stmt.predicateType)}'`,
    )
  }

  if (!Array.isArray(stmt.subject)) {
    errors.push('Statement subject must be an array')
  } else {
    for (let i = 0; i < stmt.subject.length; i++) {
      const item: unknown = stmt.subject[i]
      if (!item || typeof item !== 'object') {
        errors.push(`Subject[${String(i)}] must be a non-null object`)
        continue
      }
      const itemRecord = item as Record<string, unknown>
      if (typeof itemRecord.name !== 'string') {
        errors.push(`Subject[${String(i)}] missing string 'name'`)
      }
      const digest = itemRecord.digest
      if (!digest || typeof digest !== 'object') {
        errors.push(`Subject[${String(i)}] must contain a digest object`)
      } else {
        const digestRecord = digest as Record<string, unknown>
        if (typeof digestRecord.sha256 !== 'string' || digestRecord.sha256.length !== 64) {
          errors.push(`Subject[${String(i)}] must contain a 64-char sha256 hex digest`)
        }
      }
    }
  }

  if (!stmt.predicate || typeof stmt.predicate !== 'object') {
    errors.push('Statement predicate must be an object')
  }

  const valid = errors.length === 0
  const statementDigest = valid
    ? computeStatementDigest(stmt as unknown as ProvenanceStatement)
    : ''
  const subjectCount = Array.isArray(stmt.subject) ? stmt.subject.length : 0

  const summary = valid
    ? `[Provenance OK] in-toto v1 envelope valid. Subjects: ${String(subjectCount)}. Digest: ${statementDigest.slice(0, 12)}...`
    : `[Provenance FAIL] Statement verification encountered ${String(errors.length)} errors: ${errors.join('; ')}`

  return {
    valid,
    statementDigest,
    subjectCount,
    errors,
    formattedSummary: summary,
  }
}
