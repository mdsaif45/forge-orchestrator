import { describe, expect, it } from 'vitest'
import {
  WorkspaceSecretLifecycleGovernor,
  type RotationPolicy,
} from './workspaceSecretLifecycleGovernor'

describe('WorkspaceSecretLifecycleGovernor (CONFIG-027)', () => {
  it('registers a secret and grants access to active current version', () => {
    const governor = new WorkspaceSecretLifecycleGovernor()
    const now = 1_000_000

    const record = governor.registerSecret('OPENAI_API_KEY', {}, now)
    expect(record.secretName).toBe('OPENAI_API_KEY')
    expect(record.currentVersion).toBe(1)
    expect(record.state).toBe('active')

    const decision = governor.evaluateAccess('OPENAI_API_KEY', 1, 'agentTurn', now + 1000)
    expect(decision.allowed).toBe(true)
    expect(decision.state).toBe('active')
    expect(decision.rotationRequired).toBe(false)
  })

  it('supports staged dual-key rotation: permits both versions during grace period', () => {
    const policy: Partial<RotationPolicy> = {
      maxLifetimeMs: 10_000,
      gracePeriodMs: 3000,
      warningThresholdMs: 2000,
    }
    const governor = new WorkspaceSecretLifecycleGovernor()
    const now = 1_000_000

    governor.registerSecret('ANTHROPIC_KEY', policy, now)

    // Start rotation at now + 5000
    const rotating = governor.startRotation('ANTHROPIC_KEY', now + 5000)
    expect(rotating.currentVersion).toBe(2)
    expect(rotating.previousVersion).toBe(1)
    expect(rotating.state).toBe('in_rotation')

    // During grace period (at now + 6000), BOTH version 1 and 2 must be allowed
    const accV1 = governor.evaluateAccess('ANTHROPIC_KEY', 1, 'agent', now + 6000)
    expect(accV1.allowed).toBe(true)

    const accV2 = governor.evaluateAccess('ANTHROPIC_KEY', 2, 'agent', now + 6000)
    expect(accV2.allowed).toBe(true)

    // Past grace period (at now + 9000), version 1 must be retired
    const accV1Expired = governor.evaluateAccess('ANTHROPIC_KEY', 1, 'agent', now + 9000)
    expect(accV1Expired.allowed).toBe(false)
    expect(accV1Expired.reason).toContain('retired')
  })

  it('transitions state to deprecated when maxLifetime is exceeded', () => {
    const policy: Partial<RotationPolicy> = {
      maxLifetimeMs: 5000,
      warningThresholdMs: 1000,
    }
    const governor = new WorkspaceSecretLifecycleGovernor()
    const now = 1_000_000

    governor.registerSecret('SLACK_WEBHOOK', policy, now)

    // Access after 6000ms -> should flag rotationRequired and deprecated
    const decision = governor.evaluateAccess('SLACK_WEBHOOK', 1, 'notifier', now + 6000)
    expect(decision.allowed).toBe(true)
    expect(decision.state).toBe('deprecated')
    expect(decision.rotationRequired).toBe(true)
  })

  it('fails closed when secret is hard-revoked', () => {
    const governor = new WorkspaceSecretLifecycleGovernor()
    const now = 1_000_000

    governor.registerSecret('COMPROMISED_KEY', {}, now)
    governor.revokeSecret('COMPROMISED_KEY', 'Credential leak detected on public repo', now + 100)

    const decision = governor.evaluateAccess('COMPROMISED_KEY', 1, 'agent', now + 200)
    expect(decision.allowed).toBe(false)
    expect(decision.state).toBe('revoked')
    expect(decision.reason).toContain('Credential leak detected')
  })

  it('generates a comprehensive forensic lifecycle audit summary', () => {
    const governor = new WorkspaceSecretLifecycleGovernor()
    const now = 1_000_000

    governor.registerSecret('SEC1', { maxLifetimeMs: 10_000, warningThresholdMs: 3000 }, now)
    governor.registerSecret('SEC2', { maxLifetimeMs: 2000 }, now)
    governor.registerSecret('SEC3', {}, now)
    governor.revokeSecret('SEC3', 'Decommissioned', now)

    // At now + 4000, SEC2 is deprecated (past 2000ms), SEC1 is active
    const audit = governor.auditLifecycle(now + 4000)

    expect(audit.totalSecrets).toBe(3)
    expect(audit.revokedCount).toBe(1)
    expect(audit.deprecatedCount).toBe(1)
    expect(audit.violationsCount).toBe(1)
    expect(audit.records.length).toBe(3)
  })
})
