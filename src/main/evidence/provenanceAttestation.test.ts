import { describe, it, expect } from 'vitest'
import {
  generateProvenanceStatement,
  verifyProvenanceStatement,
  computeStatementDigest,
  IN_TOTO_STATEMENT_V1,
  SLSA_PROVENANCE_V1,
  FORGE_BUILD_TYPE_V1,
} from './provenanceAttestation'

describe('provenanceAttestation (EVIDENCE-014)', () => {
  const dummySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'

  describe('generateProvenanceStatement', () => {
    it('creates compliant in-toto and SLSA v1 statement', () => {
      const statement = generateProvenanceStatement({
        runId: 'run-123',
        artifacts: [{ name: 'bundle.js', sha256: dummySha256 }],
        gitHeadSha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
        gitRepoUri: 'https://github.com/org/repo',
        isDirty: false,
        parameters: { target: 'production' },
      })

      expect(statement._type).toBe(IN_TOTO_STATEMENT_V1)
      expect(statement.predicateType).toBe(SLSA_PROVENANCE_V1)
      expect(statement.predicate.buildType).toBe(FORGE_BUILD_TYPE_V1)
      expect(statement.subject).toHaveLength(1)
      expect(statement.subject[0]?.name).toBe('bundle.js')
      expect(statement.subject[0]?.digest.sha256).toBe(dummySha256)
      expect(statement.predicate.metadata.buildInvocationId).toBe('run-123')
      expect(statement.predicate.metadata.reproducible).toBe(true)
      expect(statement.predicate.materials).toHaveLength(1)
      expect(statement.predicate.materials[0]?.digest.gitCommit).toBe(
        'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
      )
    })

    it('marks reproducible false when repository is dirty', () => {
      const statement = generateProvenanceStatement({
        runId: 'run-456',
        artifacts: [{ name: 'dist/index.js', sha256: dummySha256 }],
        gitHeadSha: 'commit123',
        isDirty: true,
      })

      expect(statement.predicate.metadata.reproducible).toBe(false)
      expect(statement.predicate.materials[0]?.digest.dirty).toBe('true')
    })
  })

  describe('verifyProvenanceStatement', () => {
    it('successfully verifies a correctly formed statement', () => {
      const statement = generateProvenanceStatement({
        runId: 'run-verify',
        artifacts: [{ name: 'app.exe', sha256: dummySha256 }],
        gitHeadSha: 'commit456',
      })

      const verification = verifyProvenanceStatement(statement)
      expect(verification.valid).toBe(true)
      expect(verification.subjectCount).toBe(1)
      expect(verification.statementDigest.length).toBe(64)
      expect(verification.formattedSummary).toContain('[Provenance OK]')
    })

    it('fails closed when given non-object data', () => {
      const res = verifyProvenanceStatement(null)
      expect(res.valid).toBe(false)
      expect(res.errors).toContain('Statement must be a non-null object')
    })

    it('detects missing or invalid in-toto/SLSA fields', () => {
      const invalidStatement = {
        _type: 'invalid-type',
        predicateType: 'wrong-slsa',
        subject: [{ name: 123, digest: { sha256: 'short' } }],
      }

      const res = verifyProvenanceStatement(invalidStatement)
      expect(res.valid).toBe(false)
      expect(res.errors.length).toBeGreaterThan(2)
      expect(res.formattedSummary).toContain('[Provenance FAIL]')
    })
  })

  describe('computeStatementDigest', () => {
    it('produces deterministic digests for equivalent statements', () => {
      const stmt = generateProvenanceStatement({
        runId: 'deterministic',
        artifacts: [{ name: 'file.txt', sha256: dummySha256 }],
      })

      const digest1 = computeStatementDigest(stmt)
      const digest2 = computeStatementDigest(stmt)
      expect(digest1).toBe(digest2)
      expect(digest1).toHaveLength(64)
    })
  })
})
