import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  artifactIdSchema,
  assessCompletion,
  evidenceIdSchema,
  repositoryIdSchema,
  stepIdSchema,
  taskIdSchema,
  taskSchema,
  workflowIdSchema,
  type AgentReport,
  type EvidenceArtifact,
  type Repository,
  type Task,
} from '@shared/domain'
import { createForgeCore, type ForgeCore } from '../core/forgeCore'
import { executeDirectTask } from '../core/taskRunner'
import { verifyStep } from './verifier'
import { auditAdversarialEvidence } from './adversarial'

/**
 * VERIFY-003: Adversarial Edge-Case Verifier Test Suite
 *
 * Covers all 13 required adversarial scenarios from Phase 7:
 *  1. false success claim
 *  2. missing evidence
 *  3. contradictory evidence
 *  4. stale evidence
 *  5. nonexistent artifact claim
 *  6. incorrect test-result claim
 *  7. physical diff disagreement
 *  8. policy violation
 *  9. malformed verification input
 * 10. UNKNOWN propagation
 * 11. FAIL precedence
 * 12. successful process + failed verification
 * 13. failed process + misleading PASS claim
 */
describe('VERIFY-003: Adversarial Verifier Suite', () => {
  let tempDir: string
  let repoPath: string
  let core: ForgeCore
  const workflowId = workflowIdSchema.parse('11111111-1111-4111-8111-111111111111')
  const stepId = stepIdSchema.parse('22222222-2222-4222-8222-222222222222')

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'forge-verify003-'))
    repoPath = join(tempDir, 'repo')
    execFileSync('git', ['init', repoPath], { encoding: 'utf8' })
    execFileSync('git', ['config', 'user.name', 'Forge Tester'], { cwd: repoPath })
    execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: repoPath })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoPath })

    writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: 'test-subject' }))
    writeFileSync(join(repoPath, 'README.md'), '# Initial README\n')
    execFileSync('git', ['add', '.'], { cwd: repoPath })
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoPath })

    core = createForgeCore({ dataDir: join(tempDir, 'data') })
  })

  afterEach(async () => {
    await core.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore temp cleanup errors
    }
  })

  function repository(overrides: Partial<Repository> = {}): Repository {
    return {
      id: repositoryIdSchema.parse(randomUUID()),
      absolutePath: repoPath,
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: [],
      ...overrides,
    }
  }

  // 1. False success claim: agent claims completed for task requiring changes, but 0 changes occurred
  it('Scenario 1: rejects false success claim when work is unverified and 0 changes occurred for a task requiring changes', async () => {
    const result = await executeDirectTask(core, {
      workspacePath: repoPath,
      task: 'Fix the critical bug',
      allowedPaths: ['src/**'],
      runTurn: async () => {
        await Promise.resolve()
        // Agent modifies nothing, but claims completed
        return {
          ok: true,
          content: JSON.stringify({
            status: 'completed',
            summary: 'I have completely resolved the bug and everything is working perfectly.',
            filesChanged: [],
            commandsRun: [],
            testsRun: false,
            openQuestions: [],
            assumptions: [],
          }),
          reasoning: 'I pretended to fix it without touching files',
          toolsUsed: [],
          rounds: 1,
          error: null,
          stoppedAtLimit: false,
          plan: {
            capabilities: { tools: true, vision: false, thinking: false, source: 'reported' },
            usedTools: false,
          },
        }
      },
    })

    // Verification must fail; exitCode cannot be 0
    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(result.evidence.passed).toBe(false)
    expect(result.evidence.verdict).toBe('fail')
    expect(result.evidence.falseClaims.length).toBeGreaterThan(0)
    expect(result.evidence.falseClaims.some((c) => c.includes('no physical modifications'))).toBe(
      true,
    )
  })

  // 1b. Legitimate no-change task: observational/research task without modification requirements
  it('Scenario 1b: accepts legitimate observational/research task with zero physical changes when criteria are met', async () => {
    const result = await executeDirectTask(core, {
      workspacePath: repoPath,
      task: 'Investigate the repository structure',
      runTurn: async () => {
        await Promise.resolve()
        return {
          ok: true,
          content: JSON.stringify({
            status: 'completed',
            summary: 'Investigated repository: package.json and README.md are present.',
            filesChanged: [],
            commandsRun: [],
            testsRun: false,
            openQuestions: [],
            assumptions: [],
          }),
          reasoning: 'Read-only observation without file changes',
          toolsUsed: [],
          rounds: 1,
          error: null,
          stoppedAtLimit: false,
          plan: {
            capabilities: { tools: true, vision: false, thinking: false, source: 'reported' },
            usedTools: false,
          },
        }
      },
    })

    expect(result.ok).toBe(true)
    expect(result.exitCode).toBe(0)
    expect(result.evidence.passed).toBe(true)
    expect(result.evidence.verdict).toBe('pass')
    expect(result.evidence.falseClaims).toHaveLength(0)
  })

  // 2. Missing evidence: declared criteria lack evidence -> UNKNOWN != PASS
  it('Scenario 2: evaluates missing evidence as UNKNOWN and never converts UNKNOWN to PASS', async () => {
    const task: Task = taskSchema.parse({
      id: taskIdSchema.parse(randomUUID()),
      objective: 'Implement feature with reviewer signoff',
      constraints: [],
      completionCriteria: [
        { kind: 'no-assumptions', description: 'No assumptions', params: {} },
        { kind: 'reviewer-verdict', description: 'Reviewer approval required', params: {} },
      ],
      scope: { allowedPaths: ['**'], forbiddenPaths: [] },
      lockedDecisionIds: [],
      correctsTaskId: null,
      createdAt: new Date().toISOString(),
    })

    const report: AgentReport = {
      status: 'completed',
      summary: 'Done',
      filesChanged: ['src/app.ts'],
      commandsRun: [],
      testsRun: false,
      openQuestions: [],
      assumptions: [],
    }

    const vResult = await verifyStep({
      repository: repository(),
      workflowId,
      stepId,
      task,
      report,
      // No review verdict provided: evidence is missing
    })

    expect(vResult.verdict).toBe('unknown')
    expect(vResult.passed).toBe(false)
    const revCrit = vResult.criteria.find((c) => c.kind === 'reviewer-verdict')
    expect(revCrit?.verdict).toBe('unknown')
  })

  // 3. Contradictory evidence: exit code 0, but parsed test runner shows failures
  it('Scenario 3: rejects contradictory evidence where exitCode is 0 but test output reported failures', async () => {
    const testArtifact: EvidenceArtifact = {
      id: evidenceIdSchema.parse(randomUUID()),
      workflowId,
      stepId,
      kind: 'tests',
      command: 'npm test',
      cwd: repoPath,
      outcome: 'completed',
      exitCode: 0, // Wrapped exit 0 e.g. "vitest || true"
      durationMs: 400,
      stdout: 'Tests  3 failed | 7 passed (10)',
      stderr: '',
      truncated: false,
      counts: { total: 10, passed: 7, failed: 3, skipped: 0 },
      failure: null,
      recordedAt: new Date().toISOString(),
    }

    const vResult = await verifyStep({
      repository: repository({ testCommand: 'npm test' }),
      workflowId,
      stepId,
      report: {
        status: 'completed',
        summary: 'Tests ran',
        filesChanged: [],
        commandsRun: ['npm test'],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
      },
      run: () => Promise.resolve(testArtifact),
    })

    expect(vResult.passed).toBe(false)
    expect(vResult.verdict).toBe('fail')
    expect(vResult.findings.some((f) => f.includes('failed test(s)'))).toBe(true)
  })

  // 4. Stale evidence: evidence from previous step/workflow
  it('Scenario 4: flags stale evidence from a different step or workflow', () => {
    const previousStepId = stepIdSchema.parse(randomUUID())
    const staleArtifact: EvidenceArtifact = {
      id: evidenceIdSchema.parse(randomUUID()),
      workflowId,
      stepId: previousStepId, // Belongs to previous step
      kind: 'tests',
      command: 'npm test',
      cwd: repoPath,
      outcome: 'completed',
      exitCode: 0,
      durationMs: 300,
      stdout: 'Tests: 1 passed (1)',
      stderr: '',
      truncated: false,
      counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
      failure: null,
      recordedAt: new Date().toISOString(),
    }

    const audit = auditAdversarialEvidence({
      report: null,
      artifacts: [staleArtifact],
      expectedStepId: stepId, // Current step
      expectedWorkflowId: workflowId,
    })

    expect(audit.ok).toBe(false)
    expect(audit.findings.some((f) => f.code === 'stale-evidence')).toBe(true)
    expect(audit.contradictoryEvidence.some((c) => c.includes('stale'))).toBe(true)
  })

  // 5. Nonexistent artifact claim: criterion references dangling artifact ID
  it('Scenario 5: detects criterion referencing nonexistent artifact ID', async () => {
    const missingArtifactId = artifactIdSchema.parse(randomUUID())
    const missingEvidenceId = evidenceIdSchema.parse(randomUUID())

    // Verifying integrity through ArtifactService
    const integrity = await core.artifacts.verifyArtifactIntegrity(missingArtifactId)
    expect(integrity.valid).toBe(false)
    expect(integrity.reason).toContain('does not exist in metadata store')

    // Verifying via auditAdversarialEvidence
    const audit = auditAdversarialEvidence({
      report: null,
      artifacts: [],
      criteria: [
        {
          kind: 'tests',
          description: 'Tests pass',
          verdict: 'pass',
          reason: 'checked',
          evidenceId: missingEvidenceId,
        },
      ],
    })
    expect(audit.ok).toBe(false)
    expect(audit.findings.some((f) => f.code === 'nonexistent-artifact')).toBe(true)
  })

  // 6. Incorrect test-result claim: agent claims tests pass, but test runner failed
  it('Scenario 6: catches incorrect test-result claim when test runner failed', async () => {
    const failingArtifact: EvidenceArtifact = {
      id: evidenceIdSchema.parse(randomUUID()),
      workflowId,
      stepId,
      kind: 'tests',
      command: 'npm test',
      cwd: repoPath,
      outcome: 'completed',
      exitCode: 1,
      durationMs: 500,
      stdout: 'FAIL src/math.test.ts\nExpected 42, received 0',
      stderr: '',
      truncated: false,
      counts: { total: 1, passed: 0, failed: 1, skipped: 0 },
      failure: null,
      recordedAt: new Date().toISOString(),
    }

    const vResult = await verifyStep({
      repository: repository({ testCommand: 'npm test' }),
      workflowId,
      stepId,
      report: {
        status: 'completed',
        summary: 'All tests pass flawlessly',
        filesChanged: ['src/math.ts'],
        commandsRun: ['npm test'],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
      },
      run: () => Promise.resolve(failingArtifact),
    })

    expect(vResult.passed).toBe(false)
    expect(vResult.verdict).toBe('fail')
    expect(vResult.falseClaims.some((c) => c.includes('did not pass'))).toBe(true)
  })

  // 7. Physical diff disagreement: agent claims files changed but git shows no change
  it('Scenario 7: detects physical diff disagreement (claimed-but-unchanged)', async () => {
    const result = await executeDirectTask(core, {
      workspacePath: repoPath,
      task: 'Update documentation in README.md',
      runTurn: async () => {
        await Promise.resolve()
        // Agent claims it modified README.md, but doesn't actually edit it
        return {
          ok: true,
          content: `FORGE_REPORT_BEGIN
{
  "status": "completed",
  "summary": "Updated README.md with detailed instructions",
  "filesChanged": ["README.md"],
  "commandsRun": [],
  "testsRun": false,
  "openQuestions": [],
  "assumptions": []
}
FORGE_REPORT_END`,
          reasoning: 'Claimed file edit without physical write',
          toolsUsed: [],
          rounds: 1,
          error: null,
          stoppedAtLimit: false,
          plan: {
            capabilities: { tools: true, vision: false, thinking: false, source: 'reported' },
            usedTools: false,
          },
        }
      },
    })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(1)
    expect(
      result.discrepancies.some(
        (d) => d.kind === 'claimed-but-unchanged' && d.path === 'README.md',
      ),
    ).toBe(true)
    expect(result.evidence.falseClaims.some((c) => c.includes('README.md'))).toBe(true)
  })

  // 8. Policy violation: agent edits outside allowed scope
  it('Scenario 8: halts on scope policy violation with exit code 2 and status halted', async () => {
    const result = await executeDirectTask(core, {
      workspacePath: repoPath,
      task: 'Edit source file',
      allowedPaths: ['src/**'],
      runTurn: async () => {
        await Promise.resolve()
        // Agent modifies package.json outside allowed scope
        writeFileSync(join(repoPath, 'package.json'), JSON.stringify({ name: 'unauthorized' }))
        return {
          ok: true,
          content: 'Updated package.json',
          reasoning: 'Out of scope edit',
          toolsUsed: [{ name: 'edit_file', ok: true }],
          rounds: 1,
          error: null,
          stoppedAtLimit: false,
          plan: {
            capabilities: { tools: true, vision: false, thinking: false, source: 'reported' },
            usedTools: true,
          },
        }
      },
    })

    expect(result.ok).toBe(false)
    expect(result.exitCode).toBe(2)
    expect(result.outOfScopeFiles).toContain('package.json')
    const runRecord = core.runs.getRun(result.runId)
    expect(runRecord?.status).toBe('halted')
  })

  // 9. Malformed verification input: missing parameters in completion criteria
  it('Scenario 9: gracefully handles malformed verification criteria without throwing', () => {
    const malformedTask: Task = taskSchema.parse({
      id: taskIdSchema.parse(randomUUID()),
      objective: 'Run with malformed criteria',
      constraints: [],
      completionCriteria: [
        { kind: 'custom-command', description: 'Run missing command param', params: {} },
        { kind: 'file-exists', description: 'Missing paths param', params: {} },
      ],
      scope: { allowedPaths: ['**'], forbiddenPaths: [] },
      lockedDecisionIds: [],
      correctsTaskId: null,
      createdAt: new Date().toISOString(),
    })

    const assessment = assessCompletion({
      task: malformedTask,
      evidence: [],
    })

    expect(assessment.verdict).toBe('unknown')
    expect(assessment.findings.length).toBe(2)
    expect(assessment.findings[0]).toContain('names no command')
    expect(assessment.findings[1]).toContain('names no paths')
  })

  // 10. UNKNOWN propagation: when one criterion is unknown, overall verdict is unknown
  it('Scenario 10: propagates UNKNOWN without collapsing to PASS', () => {
    const task: Task = taskSchema.parse({
      id: taskIdSchema.parse(randomUUID()),
      objective: 'Multi-criteria task with unknown',
      constraints: [],
      completionCriteria: [
        { kind: 'no-assumptions', description: 'No assumptions', params: {} },
        { kind: 'reviewer-verdict', description: 'Reviewer approval', params: {} },
      ],
      scope: { allowedPaths: ['**'], forbiddenPaths: [] },
      lockedDecisionIds: [],
      correctsTaskId: null,
      createdAt: new Date().toISOString(),
    })

    const report: AgentReport = {
      status: 'completed',
      summary: 'Clean',
      filesChanged: [],
      commandsRun: [],
      testsRun: false,
      openQuestions: [],
      assumptions: [],
    }

    const assessment = assessCompletion({
      task,
      evidence: [],
      report,
      // reviewer-verdict is not provided -> unknown
    })

    expect(assessment.verdict).toBe('unknown')
    expect(assessment.results.find((c) => c.kind === 'no-assumptions')?.verdict).toBe('pass')
    expect(assessment.results.find((c) => c.kind === 'reviewer-verdict')?.verdict).toBe('unknown')
  })

  // 11. FAIL precedence: fail strictly outranks unknown
  it('Scenario 11: enforces FAIL precedence where fail outranks unknown', () => {
    const failedArtifact: EvidenceArtifact = {
      id: evidenceIdSchema.parse(randomUUID()),
      workflowId,
      stepId,
      kind: 'tests',
      command: 'npm test',
      cwd: repoPath,
      outcome: 'completed',
      exitCode: 1,
      durationMs: 200,
      stdout: 'Tests failed',
      stderr: '',
      truncated: false,
      counts: null,
      failure: null,
      recordedAt: new Date().toISOString(),
    }

    const task: Task = taskSchema.parse({
      id: taskIdSchema.parse(randomUUID()),
      objective: 'Task with fail and unknown',
      constraints: [],
      completionCriteria: [
        { kind: 'tests', description: 'Tests pass', params: {} },
        { kind: 'reviewer-verdict', description: 'Reviewer verdict', params: {} },
      ],
      scope: { allowedPaths: ['**'], forbiddenPaths: [] },
      lockedDecisionIds: [],
      correctsTaskId: null,
      createdAt: new Date().toISOString(),
    })

    const assessment = assessCompletion({
      task,
      evidence: [failedArtifact],
      // reviewer-verdict is undefined -> unknown
      // tests artifact has exitCode 1 -> fail
    })

    // FAIL strictly outranks UNKNOWN
    expect(assessment.verdict).toBe('fail')
  })

  // 12. Successful process exit with failed verification: exit 0 but required output file is missing
  it('Scenario 12: fails verification when process exits 0 but required output file is missing', () => {
    const buildArtifact: EvidenceArtifact = {
      id: evidenceIdSchema.parse(randomUUID()),
      workflowId,
      stepId,
      kind: 'build',
      command: 'npm run build',
      cwd: repoPath,
      outcome: 'completed',
      exitCode: 0, // Build exited 0
      durationMs: 500,
      stdout: 'Build completed successfully',
      stderr: '',
      truncated: false,
      counts: null,
      failure: null,
      recordedAt: new Date().toISOString(),
    }

    const task: Task = taskSchema.parse({
      id: taskIdSchema.parse(randomUUID()),
      objective: 'Build and check output file presence',
      constraints: [],
      completionCriteria: [
        { kind: 'build', description: 'Build succeeds', params: {} },
        {
          kind: 'file-exists',
          description: 'Bundle exists',
          params: { paths: ['dist/bundle.js'] },
        },
      ],
      scope: { allowedPaths: ['**'], forbiddenPaths: [] },
      lockedDecisionIds: [],
      correctsTaskId: null,
      createdAt: new Date().toISOString(),
    })

    const assessment = assessCompletion({
      task,
      evidence: [buildArtifact],
      existingPaths: ['src/index.ts'], // dist/bundle.js is NOT present
    })

    expect(assessment.verdict).toBe('fail')
    const fileCrit = assessment.results.find((c) => c.kind === 'file-exists')
    expect(fileCrit?.verdict).toBe('fail')
    expect(fileCrit?.reason).toContain('Missing: dist/bundle.js')
  })

  // 13. Failed process exit with misleading PASS claim: exit 1 with stdout claiming pass
  it('Scenario 13: rejects misleading pass claim when process exit code is 1', () => {
    const misleadingArtifact: EvidenceArtifact = {
      id: evidenceIdSchema.parse(randomUUID()),
      workflowId,
      stepId,
      kind: 'tests',
      command: 'npm test',
      cwd: repoPath,
      outcome: 'completed',
      exitCode: 1, // Exit code is 1 (e.g. unhandled rejection or post-test error)
      durationMs: 300,
      stdout: 'All 150 tests passed! Success! 0 failed.',
      stderr: 'UnhandledPromiseRejection: connection refused at teardown',
      truncated: false,
      counts: null,
      failure: null,
      recordedAt: new Date().toISOString(),
    }

    const task: Task = taskSchema.parse({
      id: taskIdSchema.parse(randomUUID()),
      objective: 'Execute test suite',
      constraints: [],
      completionCriteria: [{ kind: 'tests', description: 'Tests pass', params: {} }],
      scope: { allowedPaths: ['**'], forbiddenPaths: [] },
      lockedDecisionIds: [],
      correctsTaskId: null,
      createdAt: new Date().toISOString(),
    })

    const assessment = assessCompletion({
      task,
      evidence: [misleadingArtifact],
    })

    expect(assessment.verdict).toBe('fail')
    const testCrit = assessment.results.find((c) => c.kind === 'tests')
    expect(testCrit?.verdict).toBe('fail')
    expect(testCrit?.reason).toContain('exited 1')
  })
})
