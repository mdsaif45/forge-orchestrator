import type {
  AgentReport,
  CriterionResult,
  EvidenceArtifact,
  ReconcileResult,
  StepId,
  Task,
  WorkflowId,
} from '@shared/domain'
import { evidencePassed, summariseEvidence } from '@shared/domain'

/**
 * Adversarial finding codes representing specific deceptive, contradictory,
 * or insufficient agent evidence patterns (VERIFY-003).
 */
export type AdversarialFindingCode =
  | 'false-success'
  | 'missing-evidence'
  | 'contradictory-evidence'
  | 'stale-evidence'
  | 'nonexistent-artifact'
  | 'diff-disagreement'
  | 'policy-violation'
  | 'malformed-input'
  | 'unknown-coercion'

export interface AdversarialFinding {
  readonly code: AdversarialFindingCode
  readonly message: string
  readonly severity: 'fail' | 'halt' | 'warning'
}

export interface AdversarialAuditInput {
  readonly task?: Task | undefined
  readonly report: AgentReport | null
  readonly artifacts: readonly EvidenceArtifact[]
  readonly reconciliation?: ReconcileResult | undefined
  readonly criteria?: readonly CriterionResult[] | undefined
  readonly expectedStepId?: StepId | undefined
  readonly expectedWorkflowId?: WorkflowId | undefined
  readonly physicalFilesChanged?: readonly string[] | undefined
}

export interface AdversarialAuditResult {
  readonly ok: boolean
  readonly findings: readonly AdversarialFinding[]
  readonly falseClaims: readonly string[]
  readonly contradictoryEvidence: readonly string[]
}

/**
 * Independently audits verification inputs, physical artifacts, and agent claims
 * to detect adversarial edge cases, contradictions, and boundary regressions (VERIFY-003).
 *
 * Enforces Axiom A1 (Forge owns truth), Axiom A2 (UNKNOWN != ASSUME), and Axiom A3 (Evidence > claims).
 */
export function auditAdversarialEvidence(input: AdversarialAuditInput): AdversarialAuditResult {
  const findings: AdversarialFinding[] = []
  const falseClaims: string[] = []
  const contradictoryEvidence: string[] = []

  const { task, report, artifacts, reconciliation, criteria, expectedStepId, expectedWorkflowId } =
    input

  // 1. Audit Stale Evidence: artifacts claiming to belong to a different step or workflow
  for (const artifact of artifacts) {
    if (expectedStepId !== undefined && artifact.stepId !== expectedStepId) {
      const msg = `Artifact ${artifact.id} for command \`${artifact.command}\` is stale: belongs to step ${artifact.stepId}, not current step ${expectedStepId}`
      findings.push({ code: 'stale-evidence', message: msg, severity: 'fail' })
      contradictoryEvidence.push(msg)
    }
    if (expectedWorkflowId !== undefined && artifact.workflowId !== expectedWorkflowId) {
      const msg = `Artifact ${artifact.id} for command \`${artifact.command}\` is stale: belongs to workflow ${artifact.workflowId}, not current workflow ${expectedWorkflowId}`
      findings.push({ code: 'stale-evidence', message: msg, severity: 'fail' })
      contradictoryEvidence.push(msg)
    }
  }

  // 2. Audit Contradictory Evidence: process exit code 0 vs parsed test failures
  for (const artifact of artifacts) {
    if (artifact.outcome === 'completed' && artifact.exitCode === 0) {
      if (
        artifact.counts !== null &&
        artifact.counts.failed !== null &&
        artifact.counts.failed > 0
      ) {
        const msg = `Contradictory evidence: \`${artifact.command}\` exited with code 0, but output reported ${String(artifact.counts.failed)} failed test(s)`
        findings.push({ code: 'contradictory-evidence', message: msg, severity: 'fail' })
        contradictoryEvidence.push(msg)
      }
    }
    if (artifact.outcome === 'completed' && artifact.exitCode !== 0) {
      // Process failed, but output claimed pass
      if (
        artifact.counts !== null &&
        artifact.counts.failed === 0 &&
        artifact.counts.passed !== null &&
        artifact.counts.passed > 0
      ) {
        const msg = `Contradictory evidence: \`${artifact.command}\` exited with non-zero code ${String(artifact.exitCode)}, despite test runner output indicating passed tests`
        findings.push({ code: 'contradictory-evidence', message: msg, severity: 'fail' })
        contradictoryEvidence.push(msg)
      }
    }
  }

  // 3. Audit Nonexistent Artifact References in Criteria Results
  if (criteria !== undefined) {
    const knownArtifactIds = new Set<string>(artifacts.map((a) => a.id))
    for (const criterion of criteria) {
      if (criterion.evidenceId !== null && !knownArtifactIds.has(criterion.evidenceId)) {
        const msg = `Criterion "${criterion.description}" references nonexistent evidence artifact ID: ${criterion.evidenceId}`
        findings.push({ code: 'nonexistent-artifact', message: msg, severity: 'fail' })
      }
    }
  }

  // 4. Audit Physical Diff Disagreements and Scope Policy Breaches
  if (reconciliation !== undefined) {
    if (!reconciliation.inScope) {
      const msg = `Scope policy violation: ${String(reconciliation.outOfScope.length)} file(s) modified outside task boundaries (${reconciliation.outOfScope.join(', ')})`
      findings.push({ code: 'policy-violation', message: msg, severity: 'halt' })
    }

    const claimedUnchanged = reconciliation.discrepancies.filter(
      (d) => d.kind === 'claimed-but-unchanged',
    )
    for (const d of claimedUnchanged) {
      const msg = `Discrepancy: ${d.path} was reported changed by agent, but physical repository diff shows no changes`
      findings.push({ code: 'diff-disagreement', message: msg, severity: 'fail' })
      falseClaims.push(msg)
    }
  }

  // 5. Audit False Success Claims
  if (report !== null && report.status === 'completed') {
    const testEvidence = artifacts.find((a) => a.kind === 'tests')
    const buildEvidence = artifacts.find((a) => a.kind === 'build')

    if (report.testsRun && testEvidence !== undefined && !evidencePassed(testEvidence)) {
      const msg = `The report claims tests were run and the work is complete, but Forge ran \`${testEvidence.command}\` and it did not pass (${summariseEvidence(testEvidence)}). Fix the failures rather than reporting success.`
      findings.push({ code: 'false-success', message: msg, severity: 'fail' })
      falseClaims.push(msg)
    }

    if (buildEvidence !== undefined && !evidencePassed(buildEvidence)) {
      const msg = `The report claims the work is completed, but the build failed (${summariseEvidence(buildEvidence)}). Fix the build errors.`
      findings.push({ code: 'false-success', message: msg, severity: 'fail' })
      falseClaims.push(msg)
    }

    const hasPhysicalInspection =
      input.physicalFilesChanged !== undefined || reconciliation !== undefined

    if (hasPhysicalInspection) {
      const hasPhysicalChanges =
        (input.physicalFilesChanged !== undefined && input.physicalFilesChanged.length > 0) ||
        (reconciliation !== undefined &&
          (reconciliation.discrepancies.some((d) => d.kind === 'changed-but-unclaimed') ||
            reconciliation.outOfScope.length > 0 ||
            (reconciliation.claimAccurate && report.filesChanged.length > 0)))

      const requiresChanges =
        (task?.completionCriteria.some(
          (c) => c.kind === 'file-exists' || c.kind === 'diff-scope',
        ) ??
          false) ||
        (task?.scope.allowedPaths !== undefined && task.scope.allowedPaths.length > 0)

      // Task contract explicitly required changes, but 0 changes occurred and 0 verification commands ran
      if (requiresChanges && !hasPhysicalChanges && artifacts.length === 0) {
        const msg =
          'Agent claimed completion for a task requiring changes, but no physical modifications were made'
        findings.push({ code: 'false-success', message: msg, severity: 'fail' })
        falseClaims.push(msg)
      }

      // Agent claimed to modify files, but physical git diff shows no changes (claimed-but-unchanged)
      if (report.filesChanged.length > 0 && !hasPhysicalChanges) {
        const msg = `Agent claimed to have modified ${String(report.filesChanged.length)} file(s), but physical repository diff shows zero changes`
        findings.push({ code: 'false-success', message: msg, severity: 'fail' })
        falseClaims.push(msg)
      }
    }
  }

  // 6. Audit Malformed Verification Input
  // In accordance with Axiom A2 and completion evaluation contracts, 0 criteria yields UNKNOWN, not FAIL.
  if (task !== undefined) {
    if (task.completionCriteria.length === 0) {
      findings.push({
        code: 'malformed-input',
        message: 'Task specifies zero completion criteria (at least one is required)',
        severity: 'warning',
      })
    }
  }

  // 7. Audit UNKNOWN Coercion: ensure no unknown criterion is converted into pass
  if (criteria !== undefined) {
    const unknownCriteria = criteria.filter((c) => c.verdict === 'unknown')
    if (unknownCriteria.length > 0) {
      for (const u of unknownCriteria) {
        findings.push({
          code: 'missing-evidence',
          message: `Unverified criterion: "${u.description}" (${u.reason})`,
          severity: 'warning',
        })
      }
    }
  }

  const hasFails = findings.some((f) => f.severity === 'fail' || f.severity === 'halt')

  return {
    ok: !hasFails,
    findings,
    falseClaims,
    contradictoryEvidence,
  }
}
