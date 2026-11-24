import { describe, expect, it } from 'vitest'
import { WorkspaceSecurityComplianceMatrix } from './workspaceSecurityComplianceMatrix'

describe('WorkspaceSecurityComplianceMatrix', () => {
  it('approves compliance matrix with 100% score when all postures are clean', () => {
    const matrix = new WorkspaceSecurityComplianceMatrix()
    const report = matrix.audit({
      unmaskedHostSecretsCount: 0,
      toolSandboxConfigured: true,
      expiredSecretsCount: 0,
      unpatchedHighCvesCount: 0,
      pathTraversalGuardActive: true,
    })

    expect(report.overallStatus).toBe('APPROVED')
    expect(report.complianceScorePercentage).toBe(100)
    expect(report.passedCount).toBe(5)
    expect(report.failedMandatoryCount).toBe(0)
    expect(report.remediationPlan).toHaveLength(0)
    expect(report.domainScores.HERMETIC_BUILD).toBe(100)
    expect(report.domainScores.LEAST_PRIVILEGE).toBe(100)
    expect(report.domainScores.SECRET_ROTATION).toBe(100)
    expect(report.domainScores.SUPPLY_CHAIN).toBe(100)
    expect(report.domainScores.TRAVERSAL_DEFENSE).toBe(100)
  })

  it('gates execution and emits remediation item when host secrets are unmasked', () => {
    const matrix = new WorkspaceSecurityComplianceMatrix()
    const report = matrix.audit({
      unmaskedHostSecretsCount: 3,
    })

    expect(report.overallStatus).toBe('GATED')
    expect(report.failedMandatoryCount).toBe(1)
    expect(report.domainScores.HERMETIC_BUILD).toBe(0)

    const hermCtrl = report.controls.find((c) => c.controlId === 'SEC-HERM-01')
    expect(hermCtrl?.status).toBe('NON_COMPLIANT')
    expect(report.remediationPlan[0]).toContain('[SEC-HERM-01]')
    expect(report.remediationPlan[0]).toContain('forge config sanitize-env')
  })

  it('gates execution when tool sandbox is unconfigured or disabled', () => {
    const matrix = new WorkspaceSecurityComplianceMatrix()
    const report = matrix.audit({
      toolSandboxConfigured: false,
    })

    expect(report.overallStatus).toBe('GATED')
    expect(report.failedMandatoryCount).toBe(1)
    expect(report.domainScores.LEAST_PRIVILEGE).toBe(0)

    const privCtrl = report.controls.find((c) => c.controlId === 'SEC-PRIV-01')
    expect(privCtrl?.status).toBe('NON_COMPLIANT')
    expect(report.remediationPlan.some((p) => p.includes('[SEC-PRIV-01]'))).toBe(true)
  })

  it('gates execution when critical CVEs are unpatched', () => {
    const matrix = new WorkspaceSecurityComplianceMatrix()
    const report = matrix.audit({
      unpatchedHighCvesCount: 2,
    })

    expect(report.overallStatus).toBe('GATED')
    expect(report.failedMandatoryCount).toBe(1)
    expect(report.domainScores.SUPPLY_CHAIN).toBe(0)

    const suppCtrl = report.controls.find((c) => c.controlId === 'SEC-SUPP-01')
    expect(suppCtrl?.status).toBe('NON_COMPLIANT')
    expect(report.remediationPlan.some((p) => p.includes('[SEC-SUPP-01]'))).toBe(true)
  })
})
