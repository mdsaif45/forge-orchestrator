import { describe, expect, it } from 'vitest'
import { auditSecretRotation, type SecretMetadataItem } from './secretRotationSupervisor'

describe('secretRotationSupervisor (CONFIG-020)', () => {
  const referenceTime = '2026-11-21T00:00:00.000Z'

  it('classifies secrets as VALID when well within TTL', () => {
    const secrets: SecretMetadataItem[] = [
      {
        key: 'ANTHROPIC_API_KEY',
        createdAt: '2026-11-01T00:00:00.000Z', // 20 days ago, default 90 TTL
      },
    ]

    const report = auditSecretRotation(secrets, { currentTimeIso: referenceTime })
    expect(report.totalSecrets).toBe(1)
    expect(report.validCount).toBe(1)
    expect(report.requiresImmediateAction).toBe(false)
    expect(report.assessments[0]?.status).toBe('VALID')
    expect(report.assessments[0]?.ageDays).toBe(20)
    expect(report.assessments[0]?.remainingDays).toBe(70)
  })

  it('flags secrets as WARN_EXPIRING when approaching TTL window', () => {
    const secrets: SecretMetadataItem[] = [
      {
        key: 'DATABASE_PASSWORD',
        createdAt: '2026-08-28T00:00:00.000Z', // 85 days ago
        ttlDays: 90,
      },
    ]

    const report = auditSecretRotation(secrets, {
      currentTimeIso: referenceTime,
      warnWindowDays: 7,
    })
    expect(report.expiringSoonCount).toBe(1)
    expect(report.assessments[0]?.status).toBe('WARN_EXPIRING')
    expect(report.assessments[0]?.requiresRotation).toBe(true)
    expect(report.assessments[0]?.remainingDays).toBe(5)
  })

  it('flags expired secrets and triggers requiresImmediateAction', () => {
    const secrets: SecretMetadataItem[] = [
      {
        key: 'OLD_API_KEY',
        createdAt: '2026-01-01T00:00:00.000Z', // ~324 days ago
        ttlDays: 90,
      },
    ]

    const report = auditSecretRotation(secrets, { currentTimeIso: referenceTime })
    expect(report.expiredCount).toBe(1)
    expect(report.requiresImmediateAction).toBe(true)
    expect(report.assessments[0]?.status).toBe('EXPIRED')
    expect(report.summary).toContain('IMMEDIATE ROTATION REQUIRED')
  })

  it('uses lastRotatedAt date when available instead of createdAt', () => {
    const secrets: SecretMetadataItem[] = [
      {
        key: 'ROTATED_KEY',
        createdAt: '2025-01-01T00:00:00.000Z',
        lastRotatedAt: '2026-11-15T00:00:00.000Z', // Rotated 6 days ago
        ttlDays: 30,
      },
    ]

    const report = auditSecretRotation(secrets, { currentTimeIso: referenceTime })
    expect(report.assessments[0]?.ageDays).toBe(6)
    expect(report.assessments[0]?.status).toBe('VALID')
  })

  it('skips empty keys and returns clean summary for empty secret list', () => {
    const report = auditSecretRotation([])
    expect(report.totalSecrets).toBe(0)
    expect(report.requiresImmediateAction).toBe(false)
  })
})
