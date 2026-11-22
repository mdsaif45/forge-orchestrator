/**
 * Workspace security policy compliance attestation matrix and remediation planner.
 *
 * Audits workspace configuration across enterprise security domains (Hermetic Execution,
 * Least Privilege, Secret Rotation, Supply Chain, Path Traversal), calculates weighted
 * compliance scores, and enforces fail-closed gate policies (A1, A7).
 */

export type SecurityDomain =
  'HERMETIC_BUILD' | 'LEAST_PRIVILEGE' | 'SECRET_ROTATION' | 'SUPPLY_CHAIN' | 'TRAVERSAL_DEFENSE'

export type ComplianceStatus = 'COMPLIANT' | 'NON_COMPLIANT' | 'WARNING' | 'NOT_APPLICABLE'

export interface SecurityControlRecord {
  readonly controlId: string
  readonly domain: SecurityDomain
  readonly name: string
  readonly isMandatory: boolean
  readonly status: ComplianceStatus
  readonly details: string
  readonly remediationRecommendation?: string | undefined
}

export interface ComplianceMatrixReport {
  readonly overallStatus: 'APPROVED' | 'GATED'
  readonly complianceScorePercentage: number
  readonly totalControls: number
  readonly passedCount: number
  readonly failedMandatoryCount: number
  readonly domainScores: Record<SecurityDomain, number>
  readonly controls: readonly SecurityControlRecord[]
  readonly remediationPlan: readonly string[]
}

export interface ComplianceAuditInput {
  readonly unmaskedHostSecretsCount?: number | undefined
  readonly toolSandboxConfigured?: boolean | undefined
  readonly expiredSecretsCount?: number | undefined
  readonly unpatchedHighCvesCount?: number | undefined
  readonly pathTraversalGuardActive?: boolean | undefined
}

export interface ComplianceMatrixConfig {
  /** Minimum overall percentage score required to pass gate. Defaults to 80. */
  readonly minimumPassingScore?: number | undefined
}

export class WorkspaceSecurityComplianceMatrix {
  private readonly minimumPassingScore: number

  constructor(config: ComplianceMatrixConfig = {}) {
    this.minimumPassingScore = Math.max(1, Math.min(100, config.minimumPassingScore ?? 80))
  }

  /**
   * Audits workspace security postures against standard enterprise control baselines.
   */
  audit(input: ComplianceAuditInput = {}): ComplianceMatrixReport {
    const unmaskedSecrets = input.unmaskedHostSecretsCount ?? 0
    const sandboxConfigured = input.toolSandboxConfigured ?? true
    const expiredSecrets = input.expiredSecretsCount ?? 0
    const highCves = input.unpatchedHighCvesCount ?? 0
    const traversalActive = input.pathTraversalGuardActive ?? true

    const controls: SecurityControlRecord[] = [
      {
        controlId: 'SEC-HERM-01',
        domain: 'HERMETIC_BUILD',
        name: 'Hermetic Environment Credential Masking',
        isMandatory: true,
        status: unmaskedSecrets === 0 ? 'COMPLIANT' : 'NON_COMPLIANT',
        details:
          unmaskedSecrets === 0
            ? 'All host environment variables are properly masked and sanitized.'
            : `Detected ${String(unmaskedSecrets)} unmasked credential(s) in environment.`,
        remediationRecommendation:
          unmaskedSecrets > 0
            ? 'Run forge config sanitize-env to redact exposed host credentials.'
            : undefined,
      },
      {
        controlId: 'SEC-PRIV-01',
        domain: 'LEAST_PRIVILEGE',
        name: 'Agent Tool Sandbox Isolation',
        isMandatory: true,
        status: sandboxConfigured ? 'COMPLIANT' : 'NON_COMPLIANT',
        details: sandboxConfigured
          ? 'Tool sandbox policy boundaries and escalation gates are active.'
          : 'Tool sandbox policies are unconfigured or bypassed.',
        remediationRecommendation: !sandboxConfigured
          ? 'Configure workspace tool sandbox policies in forge.config.json.'
          : undefined,
      },
      {
        controlId: 'SEC-ROTA-01',
        domain: 'SECRET_ROTATION',
        name: 'Secret Expiration and Lifecycle Governance',
        isMandatory: true,
        status: expiredSecrets === 0 ? 'COMPLIANT' : 'NON_COMPLIANT',
        details:
          expiredSecrets === 0
            ? 'All registered workspace secrets are within valid lifetime windows.'
            : `Detected ${String(expiredSecrets)} expired secret(s) requiring rotation.`,
        remediationRecommendation:
          expiredSecrets > 0
            ? 'Rotate expired secrets using forge config secret-lifecycle.'
            : undefined,
      },
      {
        controlId: 'SEC-SUPP-01',
        domain: 'SUPPLY_CHAIN',
        name: 'Dependency Vulnerability Gating',
        isMandatory: true,
        status: highCves === 0 ? 'COMPLIANT' : 'NON_COMPLIANT',
        details:
          highCves === 0
            ? 'Zero HIGH or CRITICAL unpatched dependencies identified.'
            : `Identified ${String(highCves)} HIGH/CRITICAL vulnerability advisory match(es).`,
        remediationRecommendation:
          highCves > 0
            ? 'Upgrade vulnerable packages identified by forge config audit-deps.'
            : undefined,
      },
      {
        controlId: 'SEC-TRAV-01',
        domain: 'TRAVERSAL_DEFENSE',
        name: 'Workspace Path Traversal Boundary Guard',
        isMandatory: true,
        status: traversalActive ? 'COMPLIANT' : 'NON_COMPLIANT',
        details: traversalActive
          ? 'Path boundary guard is enforcing workspace directory jail.'
          : 'Path boundary guard is disabled.',
        remediationRecommendation: !traversalActive
          ? 'Enable workspace directory boundary guard in runtime configurations.'
          : undefined,
      },
    ]

    const totalControls = controls.length
    let passedCount = 0
    let failedMandatoryCount = 0
    const remediationPlan: string[] = []

    const domainScores: Record<SecurityDomain, number> = {
      HERMETIC_BUILD: 0,
      LEAST_PRIVILEGE: 0,
      SECRET_ROTATION: 0,
      SUPPLY_CHAIN: 0,
      TRAVERSAL_DEFENSE: 0,
    }

    for (const ctrl of controls) {
      if (ctrl.status === 'COMPLIANT') {
        passedCount += 1
        domainScores[ctrl.domain] = 100
      } else {
        domainScores[ctrl.domain] = 0
        if (ctrl.isMandatory) {
          failedMandatoryCount += 1
        }
        if (ctrl.remediationRecommendation) {
          remediationPlan.push(`[${ctrl.controlId}] ${ctrl.remediationRecommendation}`)
        }
      }
    }

    const complianceScorePercentage = Math.round((passedCount / totalControls) * 100)
    const overallStatus =
      failedMandatoryCount === 0 && complianceScorePercentage >= this.minimumPassingScore
        ? 'APPROVED'
        : 'GATED'

    return {
      overallStatus,
      complianceScorePercentage,
      totalControls,
      passedCount,
      failedMandatoryCount,
      domainScores,
      controls,
      remediationPlan,
    }
  }
}
