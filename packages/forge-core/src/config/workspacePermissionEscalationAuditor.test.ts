import { describe, expect, it } from 'vitest'
import {
  PermissionEscalationDeniedError,
  WorkspacePermissionEscalationAuditor,
} from './workspacePermissionEscalationAuditor'

describe('WorkspacePermissionEscalationAuditor', () => {
  const root = 'd:/workspace/forge-repo'

  it('approves legitimate capability requests that conform to tier boundaries', () => {
    const auditor = new WorkspacePermissionEscalationAuditor({ workspaceRoot: root })

    const res = auditor.auditCapabilityRequest({
      agentId: 'agent-standard',
      tier: 'STANDARD',
      capability: 'FILE_WRITE',
      targetPath: 'src/main/index.ts',
    })

    expect(res.isApproved).toBe(true)
    expect(res.violations).toHaveLength(0)
    expect(res.auditFingerprint).toMatch(/^audit-[0-9a-f]{16}$/)
  })

  it('detects and rejects insufficient tier capability requests', () => {
    const auditor = new WorkspacePermissionEscalationAuditor({ workspaceRoot: root })

    const res = auditor.auditCapabilityRequest({
      agentId: 'agent-restricted',
      tier: 'RESTRICTED',
      capability: 'SHELL_EXEC',
      targetCommand: 'git status',
    })

    expect(res.isApproved).toBe(false)
    expect(res.violations.some((v) => v.code === 'TIER_INSUFFICIENT')).toBe(true)
  })

  it('detects and blocks path traversal attempts escaping workspace root', () => {
    const auditor = new WorkspacePermissionEscalationAuditor({ workspaceRoot: root })

    const res = auditor.auditCapabilityRequest({
      agentId: 'agent-standard',
      tier: 'STANDARD',
      capability: 'FILE_READ',
      targetPath: '../../../../etc/shadow',
    })

    expect(res.isApproved).toBe(false)
    expect(res.violations.some((v) => v.code === 'PATH_TRAVERSAL_ESCAPE')).toBe(true)
  })

  it('detects and blocks disallowed shell commands for elevated tier', () => {
    const auditor = new WorkspacePermissionEscalationAuditor({
      workspaceRoot: root,
      allowedCommandsByTier: {
        ELEVATED: ['git', 'npm'],
      },
    })

    const res = auditor.auditCapabilityRequest({
      agentId: 'agent-elevated',
      tier: 'ELEVATED',
      capability: 'SHELL_EXEC',
      targetCommand: 'rm -rf /',
    })

    expect(res.isApproved).toBe(false)
    expect(res.violations.some((v) => v.code === 'DISALLOWED_COMMAND')).toBe(true)
  })

  it('detects and blocks unauthorized network outbound hosts', () => {
    const auditor = new WorkspacePermissionEscalationAuditor({
      workspaceRoot: root,
      allowedHostsByTier: {
        ELEVATED: ['api.github.com'],
      },
    })

    const res = auditor.auditCapabilityRequest({
      agentId: 'agent-elevated',
      tier: 'ELEVATED',
      capability: 'NETWORK_FETCH',
      targetHost: 'evil-data-exfil.com',
    })

    expect(res.isApproved).toBe(false)
    expect(res.violations.some((v) => v.code === 'DISALLOWED_HOST')).toBe(true)
  })

  it('throws PermissionEscalationDeniedError fail-closed via assertCapabilityApproved', () => {
    const auditor = new WorkspacePermissionEscalationAuditor({ workspaceRoot: root })

    expect(() =>
      auditor.assertCapabilityApproved({
        agentId: 'agent-rogue',
        tier: 'RESTRICTED',
        capability: 'CONFIG_MUTATE',
      }),
    ).toThrow(PermissionEscalationDeniedError)
  })
})
