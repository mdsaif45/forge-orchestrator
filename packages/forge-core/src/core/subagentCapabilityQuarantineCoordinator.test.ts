import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  QuarantineAccessDeniedError,
  QuarantinePolicyError,
  SubagentCapabilityQuarantineCoordinator,
} from './subagentCapabilityQuarantineCoordinator'

describe('SubagentCapabilityQuarantineCoordinator (AGENT-033)', () => {
  it('enforces quarantine zone capabilities and sandbox path fences fail-closed', () => {
    const coordinator = new SubagentCapabilityQuarantineCoordinator({
      policy: { enableExpirationTimers: false },
    })
    const sandboxRoot = resolve('/tmp/forge-sandbox-zone')

    const lease = coordinator.issueLease({
      subagentId: 'ext-agent-1',
      zone: 'SANDBOXED',
      requestedCapabilities: ['FILE_READ', 'FILE_WRITE', 'NETWORK_EGRESS', 'SECRET_ACCESS'],
      allowedPaths: [sandboxRoot],
    })

    expect(lease.status).toBe('ACTIVE')
    expect(lease.grantedCapabilities).toEqual(['FILE_READ', 'FILE_WRITE'])
    expect(lease.deniedCapabilities).toEqual(['NETWORK_EGRESS', 'SECRET_ACCESS'])

    expect(
      coordinator.evaluateAccess(lease.leaseId, 'FILE_READ', resolve(sandboxRoot, 'src/main.ts'))
        .allowed,
    ).toBe(true)

    const escaped = coordinator.evaluateAccess(
      lease.leaseId,
      'FILE_WRITE',
      resolve(sandboxRoot, '../outside.ts'),
    )
    expect(escaped.allowed).toBe(false)
    expect(escaped.reason).toContain('escapes lease sandbox boundaries')

    expect(() => {
      coordinator.assertAccess(lease.leaseId, 'NETWORK_EGRESS')
    }).toThrow(QuarantineAccessDeniedError)
    expect(coordinator.evaluateAccess('missing-lease', 'FILE_READ').leaseStatus).toBe('MISSING')

    coordinator.dispose()
  })

  it('expires capability leases automatically via timers and blocks expired renewals', async () => {
    const realCoordinator = new SubagentCapabilityQuarantineCoordinator({
      policy: { defaultLeaseTtlMs: 30, maxLeaseTtlMs: 1_000, enableExpirationTimers: true },
    })

    const timerLease = realCoordinator.issueLease({
      subagentId: 'timed-agent',
      zone: 'STRICT',
      requestedCapabilities: ['FILE_READ'],
    })
    expect(realCoordinator.evaluateAccess(timerLease.leaseId, 'FILE_READ').allowed).toBe(true)

    await new Promise<void>((r) => {
      setTimeout(r, 60)
    })

    const afterExpiry = realCoordinator.evaluateAccess(timerLease.leaseId, 'FILE_READ')
    expect(afterExpiry.allowed).toBe(false)
    expect(afterExpiry.leaseStatus).toBe('EXPIRED')

    const deniedRenewal = realCoordinator.renewLease(timerLease.leaseId, {
      progressScore: 0.5,
      summary: 'Attempted late renewal',
      evidenceDigest: 'sha256:abcdef1234',
    })
    expect(deniedRenewal.approved).toBe(false)
    expect(deniedRenewal.status).toBe('DENIED_EXPIRED')

    realCoordinator.dispose()
  })

  it('authorizes explicit lease renewal upon verified progress and enforces renewal caps', () => {
    let now = 5_000
    const coordinator = new SubagentCapabilityQuarantineCoordinator({
      policy: {
        defaultLeaseTtlMs: 10_000,
        maxLeaseTtlMs: 60_000,
        maxRenewals: 2,
        minProgressDeltaPerRenewal: 0.1,
        requireAttestationDigest: true,
        enableExpirationTimers: false,
      },
      clock: () => now,
    })

    const lease = coordinator.issueLease({
      subagentId: 'renew-agent',
      zone: 'ELEVATED',
      requestedCapabilities: ['FILE_READ', 'PROCESS_SPAWN'],
      initialProgressScore: 0.1,
    })

    // Missing evidence digest fails attestation gate
    const missingDigest = coordinator.renewLease(lease.leaseId, {
      progressScore: 0.3,
      summary: 'Progressed AST extraction',
    })
    expect(missingDigest.approved).toBe(false)
    expect(missingDigest.status).toBe('DENIED_INVALID_ATTESTATION')

    // Insufficient progress delta fails gate
    const staleProgress = coordinator.renewLease(lease.leaseId, {
      progressScore: 0.12,
      summary: 'Minor loop iteration',
      evidenceDigest: 'sha256:11223344',
    })
    expect(staleProgress.approved).toBe(false)
    expect(staleProgress.status).toBe('DENIED_INSUFFICIENT_PROGRESS')

    // Valid renewals extend expiry up to maxRenewals = 2
    now += 4_000
    const renewal1 = coordinator.renewLease(lease.leaseId, {
      progressScore: 0.45,
      summary: 'Synthesized patch module',
      evidenceDigest: 'sha256:deadbeef01',
      requestedExtensionMs: 20_000,
    })
    expect(renewal1.approved).toBe(true)
    expect(renewal1.status).toBe('RENEWED')
    expect(renewal1.newExpiresAtMs).toBe(29_000)
    expect(renewal1.renewalCount).toBe(1)

    now += 5_000
    const renewal2 = coordinator.renewLease(lease.leaseId, {
      progressScore: 0.85,
      summary: 'Verified all unit assertions',
      evidenceDigest: 'sha256:deadbeef02',
    })
    expect(renewal2.approved).toBe(true)
    expect(renewal2.renewalCount).toBe(2)

    // 3rd renewal blocked by maxRenewals
    const renewal3 = coordinator.renewLease(lease.leaseId, {
      progressScore: 0.99,
      summary: 'Extra extension request',
      evidenceDigest: 'sha256:deadbeef03',
    })
    expect(renewal3.approved).toBe(false)
    expect(renewal3.status).toBe('DENIED_MAX_RENEWALS')

    coordinator.dispose()
  })

  it('quarantines subagents immediately, fences access/renewals, and validates policy bounds', () => {
    const coordinator = new SubagentCapabilityQuarantineCoordinator({
      policy: { enableExpirationTimers: false },
    })

    expect(
      () => new SubagentCapabilityQuarantineCoordinator({ policy: { defaultLeaseTtlMs: 0 } }),
    ).toThrow(QuarantinePolicyError)

    const lease = coordinator.issueLease({
      subagentId: 'rogue-agent',
      zone: 'SANDBOXED',
      requestedCapabilities: ['FILE_READ', 'FILE_WRITE'],
    })

    const fenced = coordinator.quarantineSubagent('rogue-agent', 'Attempted credential read')
    expect(fenced).toBe(1)
    expect(coordinator.evaluateAccess(lease.leaseId, 'FILE_READ').allowed).toBe(false)
    expect(coordinator.evaluateAccess(lease.leaseId, 'FILE_READ').leaseStatus).toBe('QUARANTINED')

    const deniedWhileQuarantined = coordinator.renewLease(lease.leaseId, {
      progressScore: 0.6,
      summary: 'Attempted renewal',
      evidenceDigest: 'sha256:99887766',
    })
    expect(deniedWhileQuarantined.status).toBe('DENIED_QUARANTINED')

    // Issuing new lease while quarantined is forbidden
    expect(() =>
      coordinator.issueLease({
        subagentId: 'rogue-agent',
        zone: 'STRICT',
        requestedCapabilities: ['FILE_READ'],
      }),
    ).toThrow(QuarantinePolicyError)

    expect(() => coordinator.releaseFromQuarantine('rogue-agent', 'ab')).toThrow(
      QuarantinePolicyError,
    )
    expect(coordinator.releaseFromQuarantine('rogue-agent', 'auth-override-2026')).toBe(true)

    // Old fenced lease stays closed even after release; fresh lease required
    expect(coordinator.evaluateAccess(lease.leaseId, 'FILE_READ').allowed).toBe(false)
    const freshLease = coordinator.issueLease({
      subagentId: 'rogue-agent',
      zone: 'STRICT',
      requestedCapabilities: ['FILE_READ'],
    })
    expect(coordinator.evaluateAccess(freshLease.leaseId, 'FILE_READ').allowed).toBe(true)
    expect(coordinator.revokeLease(freshLease.leaseId)).toBe(true)
    expect(coordinator.evaluateAccess(freshLease.leaseId, 'FILE_READ').leaseStatus).toBe('REVOKED')

    const snap = coordinator.getSnapshot()
    expect(snap.snapshotDigest).toHaveLength(64)
    expect(snap.metrics.totalIssued).toBe(2)
    expect(snap.metrics.totalQuarantined).toBe(1)

    coordinator.dispose()
  })
})
