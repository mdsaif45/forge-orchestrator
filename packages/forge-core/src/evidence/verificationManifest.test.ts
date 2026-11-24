import { describe, expect, it } from 'vitest'
import {
  generateVerificationManifest,
  verifyManifestIntegrity,
  type VerificationManifestInput,
} from './verificationManifest'

describe('verificationManifest (EVIDENCE-007)', () => {
  const sampleInput: VerificationManifestInput = {
    runId: '123e4567-e89b-12d3-a456-426614174000',
    gitHeadSha: '8748f6e7293b1e77d54d2417730e227a9726b2e3',
    baselineSha: 'aaa7522f77e48b88d22d1134a974b6c310323984',
    timestamp: '2026-11-19T03:00:00.000Z',
    files: [
      { path: 'src/main/core/index.ts', sha256: 'abc123456789' },
      { path: 'package.json', sha256: 'fed987654321' },
    ],
    commands: [
      { command: 'npm run typecheck', exitCode: 0, passed: true },
      { command: 'npm run test', exitCode: 0, passed: true },
    ],
    criteria: [
      { id: 'crit-1', kind: 'exit_code', passed: true },
      { id: 'crit-2', kind: 'test_pass', passed: true },
    ],
  }

  it('generates a deterministic verification manifest with cryptographic fingerprint', () => {
    const manifest1 = generateVerificationManifest(sampleInput)
    const manifest2 = generateVerificationManifest(sampleInput)

    expect(manifest1.manifestVersion).toBe('1.0.0')
    expect(manifest1.runId).toBe(sampleInput.runId)
    expect(manifest1.gitHeadSha).toBe(sampleInput.gitHeadSha)
    expect(manifest1.summary.totalFiles).toBe(2)
    expect(manifest1.summary.allCommandsPassed).toBe(true)
    expect(manifest1.summary.allCriteriaPassed).toBe(true)
    expect(manifest1.fingerprint).toBe(manifest2.fingerprint)
  })

  it('verifies manifest integrity successfully on untampered bundle', () => {
    const manifest = generateVerificationManifest(sampleInput)
    const report = verifyManifestIntegrity(manifest)

    expect(report.valid).toBe(true)
    expect(report.expectedFingerprint).toBe(manifest.fingerprint)
    expect(report.computedFingerprint).toBe(manifest.fingerprint)
  })

  it('detects tampering immediately when file checksum is modified (A3)', () => {
    const manifest = generateVerificationManifest(sampleInput)
    const tampered = {
      ...manifest,
      files: [{ path: 'package.json', sha256: 'tampered-hash-000' }],
    }

    const report = verifyManifestIntegrity(tampered)
    expect(report.valid).toBe(false)
    expect(report.error).toContain('fingerprint mismatch')
  })

  it('detects tampering when criteria status is forged', () => {
    const manifest = generateVerificationManifest({
      ...sampleInput,
      criteria: [{ id: 'crit-1', kind: 'exit_code', passed: false }],
    })
    // Attacker flips passed: true without recomputing fingerprint
    const forged = {
      ...manifest,
      summary: { ...manifest.summary, allCriteriaPassed: true },
    }

    const report = verifyManifestIntegrity(forged)
    expect(report.valid).toBe(false)
    expect(report.error).toContain('fingerprint mismatch')
  })
})
