import { describe, expect, it } from 'vitest'
import {
  agentReportSchema,
  evidenceIdSchema,
  stepIdSchema,
  taskIdSchema,
  taskSchema,
  workflowIdSchema,
  type AgentReport,
  type CriterionResult,
  type EvidenceArtifact,
  type ReconcileResult,
  type Task,
} from '@shared/domain'
import { auditAdversarialEvidence } from './adversarial'

const workflowId = workflowIdSchema.parse('11111111-1111-4111-8111-111111111111')
const stepId = stepIdSchema.parse('22222222-2222-4222-8222-222222222222')

function defaultTask(overrides: Partial<Task> = {}): Task {
  return taskSchema.parse({
    id: taskIdSchema.parse('33333333-3333-4333-8333-333333333333'),
    objective: 'Implement feature',
    constraints: [],
    completionCriteria: [{ kind: 'tests', description: 'Tests pass', params: {} }],
    scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
    lockedDecisionIds: [],
    correctsTaskId: null,
    createdAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  })
}

function defaultReport(overrides: Partial<AgentReport> = {}): AgentReport {
  return agentReportSchema.parse({
    status: 'completed',
    summary: 'Work finished',
    filesChanged: ['src/index.ts'],
    commandsRun: ['npm test'],
    testsRun: true,
    openQuestions: [],
    assumptions: [],
    ...overrides,
  })
}

function defaultArtifact(overrides: Partial<EvidenceArtifact> = {}): EvidenceArtifact {
  return {
    id: evidenceIdSchema.parse('44444444-4444-4444-8444-444444444444'),
    workflowId,
    stepId,
    kind: 'tests',
    command: 'npm test',
    cwd: '/repo',
    outcome: 'completed',
    exitCode: 0,
    durationMs: 250,
    stdout: 'Tests: 5 passed (5)',
    stderr: '',
    truncated: false,
    counts: { total: 5, passed: 5, failed: 0, skipped: 0 },
    failure: null,
    recordedAt: '2026-08-19T00:00:00.000Z',
    ...overrides,
  }
}

describe('auditAdversarialEvidence', () => {
  it('passes on clean, honest evidence that agrees with physical reality', () => {
    const task = defaultTask()
    const report = defaultReport()
    const artifact = defaultArtifact()
    const reconciliation: ReconcileResult = {
      discrepancies: [],
      outOfScope: [],
      claimAccurate: true,
      inScope: true,
    }
    const criteria: CriterionResult[] = [
      {
        kind: 'tests',
        description: 'Tests pass',
        verdict: 'pass',
        reason: 'exit 0',
        evidenceId: artifact.id,
      },
    ]

    const result = auditAdversarialEvidence({
      task,
      report,
      artifacts: [artifact],
      reconciliation,
      criteria,
      expectedStepId: stepId,
      expectedWorkflowId: workflowId,
    })

    expect(result.ok).toBe(true)
    expect(result.findings).toHaveLength(0)
    expect(result.falseClaims).toHaveLength(0)
    expect(result.contradictoryEvidence).toHaveLength(0)
  })

  it('detects contradictory evidence when exitCode is 0 but test parser parsed failed tests', () => {
    const artifact = defaultArtifact({
      outcome: 'completed',
      exitCode: 0,
      counts: { total: 10, passed: 8, failed: 2, skipped: 0 },
      stdout: 'Tests: 2 failed | 8 passed (10)',
    })

    const result = auditAdversarialEvidence({
      report: defaultReport(),
      artifacts: [artifact],
    })

    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'contradictory-evidence')).toBe(true)
    expect(result.findings.some((f) => f.message.includes('reported 2 failed test(s)'))).toBe(true)
    expect(result.contradictoryEvidence.length).toBeGreaterThan(0)
  })

  it('detects contradictory evidence when exitCode is non-zero despite test runner output claiming pass', () => {
    const artifact = defaultArtifact({
      outcome: 'completed',
      exitCode: 1, // e.g. unhandled rejection or process crashed after reporter
      counts: { total: 10, passed: 10, failed: 0, skipped: 0 },
      stdout: 'Tests: 10 passed (10)',
    })

    const result = auditAdversarialEvidence({
      report: defaultReport(),
      artifacts: [artifact],
    })

    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'contradictory-evidence')).toBe(true)
    expect(
      result.findings.some((f) => f.message.includes('exited with non-zero code 1, despite')),
    ).toBe(true)
  })

  it('detects stale evidence when artifact belongs to another step or workflow', () => {
    const otherStepId = stepIdSchema.parse('55555555-5555-4555-8555-555555555555')
    const otherWorkflowId = workflowIdSchema.parse('66666666-6666-4666-8666-666666666666')
    const artifact = defaultArtifact({ stepId: otherStepId, workflowId: otherWorkflowId })

    const result = auditAdversarialEvidence({
      report: defaultReport(),
      artifacts: [artifact],
      expectedStepId: stepId,
      expectedWorkflowId: workflowId,
    })

    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'stale-evidence')).toBe(true)
    expect(result.findings.some((f) => f.message.includes('belongs to step'))).toBe(true)
    expect(result.findings.some((f) => f.message.includes('belongs to workflow'))).toBe(true)
  })

  it('detects nonexistent artifact ID cited in criterion results', () => {
    const missingArtifactId = evidenceIdSchema.parse('77777777-7777-4777-8777-777777777777')
    const criteria: CriterionResult[] = [
      {
        kind: 'tests',
        description: 'Tests pass',
        verdict: 'pass',
        reason: 'exit 0',
        evidenceId: missingArtifactId,
      },
    ]

    const result = auditAdversarialEvidence({
      report: defaultReport(),
      artifacts: [defaultArtifact()],
      criteria,
    })

    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'nonexistent-artifact')).toBe(true)
    expect(result.findings.some((f) => f.message.includes(missingArtifactId))).toBe(true)
  })

  it('detects physical diff disagreement (claimed-but-unchanged)', () => {
    const reconciliation: ReconcileResult = {
      discrepancies: [
        {
          path: 'src/ghost.ts',
          kind: 'claimed-but-unchanged',
          detail: 'reported as changed but no change',
        },
      ],
      outOfScope: [],
      claimAccurate: false,
      inScope: true,
    }

    const result = auditAdversarialEvidence({
      report: defaultReport({ filesChanged: ['src/ghost.ts'] }),
      artifacts: [defaultArtifact()],
      reconciliation,
    })

    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'diff-disagreement')).toBe(true)
    expect(result.falseClaims.some((c) => c.includes('src/ghost.ts'))).toBe(true)
  })

  it('detects scope policy violations with halt severity', () => {
    const reconciliation: ReconcileResult = {
      discrepancies: [
        {
          path: 'secret.env',
          kind: 'outside-scope',
          detail: 'forbidden',
        },
      ],
      outOfScope: ['secret.env'],
      claimAccurate: true,
      inScope: false,
    }

    const result = auditAdversarialEvidence({
      report: defaultReport(),
      artifacts: [defaultArtifact()],
      reconciliation,
    })

    expect(result.ok).toBe(false)
    const finding = result.findings.find((f) => f.code === 'policy-violation')
    expect(finding).toBeDefined()
    expect(finding?.severity).toBe('halt')
  })

  it('detects false success claims when agent reports completed but tests or build failed', () => {
    const failedTestArtifact = defaultArtifact({
      outcome: 'completed',
      exitCode: 1,
      counts: { total: 5, passed: 4, failed: 1, skipped: 0 },
    })

    const result = auditAdversarialEvidence({
      report: defaultReport({ status: 'completed', testsRun: true }),
      artifacts: [failedTestArtifact],
    })

    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'false-success')).toBe(true)
    expect(result.falseClaims.some((c) => c.includes('did not pass'))).toBe(true)
  })

  it('detects false success claims when agent claims completed for a task requiring changes but 0 changes occurred', () => {
    const emptyReconcile: ReconcileResult = {
      discrepancies: [],
      outOfScope: [],
      claimAccurate: true,
      inScope: true,
    }

    const taskWithScope = defaultTask({
      scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
    })

    const result = auditAdversarialEvidence({
      task: taskWithScope,
      report: defaultReport({ status: 'completed', filesChanged: [] }),
      artifacts: [],
      reconciliation: emptyReconcile,
      criteria: [],
    })

    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'false-success')).toBe(true)
    expect(result.falseClaims.some((c) => c.includes('no physical modifications were made'))).toBe(
      true,
    )
  })

  it('detects false success claims when agent claimed filesChanged but physical diff shows 0 changes', () => {
    const emptyReconcile: ReconcileResult = {
      discrepancies: [],
      outOfScope: [],
      claimAccurate: false,
      inScope: true,
    }

    const result = auditAdversarialEvidence({
      report: defaultReport({ status: 'completed', filesChanged: ['src/index.ts'] }),
      artifacts: [],
      reconciliation: emptyReconcile,
      physicalFilesChanged: [],
    })

    expect(result.ok).toBe(false)
    expect(result.findings.some((f) => f.code === 'false-success')).toBe(true)
    expect(result.falseClaims.some((c) => c.includes('zero changes'))).toBe(true)
  })

  it('allows legitimate observational/research task with zero physical changes when criteria are met', () => {
    const researchTask = defaultTask({
      completionCriteria: [{ kind: 'no-assumptions', description: 'No assumptions', params: {} }],
      scope: { allowedPaths: [], forbiddenPaths: [] },
    })

    const emptyReconcile: ReconcileResult = {
      discrepancies: [],
      outOfScope: [],
      claimAccurate: true,
      inScope: true,
    }

    const result = auditAdversarialEvidence({
      task: researchTask,
      report: defaultReport({
        status: 'completed',
        summary: 'Investigation complete: no code changes required',
        filesChanged: [],
        commandsRun: [],
        testsRun: false,
      }),
      artifacts: [],
      reconciliation: emptyReconcile,
      criteria: [
        {
          kind: 'no-assumptions',
          description: 'No assumptions',
          verdict: 'pass',
          reason: 'The report records no assumptions',
          evidenceId: null,
        },
      ],
      physicalFilesChanged: [],
    })

    expect(result.ok).toBe(true)
    expect(result.findings).toHaveLength(0)
    expect(result.falseClaims).toHaveLength(0)
  })

  it('flags unverified criteria as missing evidence warnings', () => {
    const criteria: CriterionResult[] = [
      {
        kind: 'reviewer-verdict',
        description: 'Reviewer approves',
        verdict: 'unknown',
        reason: 'No review has been performed yet',
        evidenceId: null,
      },
    ]

    const result = auditAdversarialEvidence({
      report: defaultReport(),
      artifacts: [defaultArtifact()],
      criteria,
    })

    // Warnings for unknown criteria do not fail the audit by themselves, but are tracked
    expect(result.findings.some((f) => f.code === 'missing-evidence')).toBe(true)
    expect(result.findings.some((f) => f.message.includes('Unverified criterion'))).toBe(true)
  })
})
