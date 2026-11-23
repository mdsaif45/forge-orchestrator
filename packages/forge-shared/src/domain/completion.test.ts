/**
 * What these tests claim: an unverifiable criterion never reads as a pass.
 *
 * That single property is why this module exists. Every other assertion here is in
 * service of it, because the failure mode is silent: a criterion nobody could check
 * looks exactly like a criterion that passed, if the only question asked is "did
 * anything fail?".
 *
 * The evaluator is pure, so these are plain unit tests with hand-built inputs.
 */

import { describe, expect, it } from 'vitest'
import { assessCompletion } from './completion'
import { evidenceArtifactSchema, type EvidenceArtifact } from './evidence'
import { agentReportSchema, type AgentReport } from './runtime'
import { taskSchema, type CompletionCriterion, type Task } from './task'
import type { ReconcileResult } from './reconcile'

const TASK_ID = '11111111-1111-4111-8111-111111111111'
const WORKFLOW_ID = '22222222-2222-4222-8222-222222222222'
const STEP_ID = '33333333-3333-4333-8333-333333333333'
const NOW = '2026-08-19T00:00:00.000Z'

let artifactCounter = 0

function criterion(overrides: Partial<CompletionCriterion> = {}): CompletionCriterion {
  return { kind: 'tests', description: 'the test suite passes', params: {}, ...overrides }
}

function task(criteria: readonly CompletionCriterion[]): Task {
  return taskSchema.parse({
    id: TASK_ID,
    objective: 'Do the thing',
    constraints: [],
    completionCriteria: criteria,
    scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
    lockedDecisionIds: [],
    correctsTaskId: null,
    createdAt: NOW,
  })
}

function artifact(overrides: Partial<EvidenceArtifact> = {}): EvidenceArtifact {
  artifactCounter += 1
  return evidenceArtifactSchema.parse({
    id: `4444444${String(artifactCounter % 10)}-4444-4444-8444-444444444444`,
    workflowId: WORKFLOW_ID,
    stepId: STEP_ID,
    kind: 'tests',
    command: 'npm test',
    cwd: '/repo',
    outcome: 'completed',
    exitCode: 0,
    durationMs: 100,
    stdout: '',
    stderr: '',
    truncated: false,
    counts: null,
    failure: null,
    recordedAt: NOW,
    ...overrides,
  })
}

function report(overrides: Partial<AgentReport> = {}): AgentReport {
  return agentReportSchema.parse({
    status: 'completed',
    summary: 'Did it',
    filesChanged: [],
    commandsRun: [],
    testsRun: false,
    openQuestions: [],
    assumptions: [],
    ...overrides,
  })
}

function reconciliation(overrides: Partial<ReconcileResult> = {}): ReconcileResult {
  return { discrepancies: [], outOfScope: [], claimAccurate: true, inScope: true, ...overrides }
}

describe('unknown is never a pass', () => {
  it('reports unknown when no build was run', () => {
    const assessment = assessCompletion({
      task: task([criterion({ kind: 'build', description: 'the build succeeds' })]),
      evidence: [],
    })

    // The whole point. "Nothing to build, therefore fine" is indistinguishable from
    // "the build never ran", and only one of those is a pass.
    expect(assessment.verdict).toBe('unknown')
    expect(assessment.verdict).not.toBe('pass')
    expect(assessment.unknown).toHaveLength(1)
  })

  it('reports unknown when no tests were run', () => {
    const assessment = assessCompletion({ task: task([criterion()]), evidence: [] })

    expect(assessment.verdict).toBe('unknown')
    expect(assessment.results[0]?.reason).toContain('no tests command')
  })

  it('reports unknown when the diff was never reconciled', () => {
    const assessment = assessCompletion({
      task: task([criterion({ kind: 'diff-scope', description: 'no out-of-scope edits' })]),
      evidence: [],
    })

    expect(assessment.verdict).toBe('unknown')
  })

  it('reports unknown when there is no report to check for assumptions', () => {
    const assessment = assessCompletion({
      task: task([criterion({ kind: 'no-assumptions', description: 'no assumptions recorded' })]),
      evidence: [],
    })

    // An absent report is not evidence of a clean one.
    expect(assessment.verdict).toBe('unknown')
  })

  it('reports unknown when no review has happened', () => {
    const assessment = assessCompletion({
      task: task([criterion({ kind: 'reviewer-verdict', description: 'a reviewer approves' })]),
      evidence: [],
    })

    expect(assessment.verdict).toBe('unknown')
  })

  it('propagates a reviewer who could not decide, rather than collapsing it', () => {
    const assessment = assessCompletion({
      task: task([criterion({ kind: 'reviewer-verdict', description: 'a reviewer approves' })]),
      evidence: [],
      reviewVerdict: 'unknown',
    })

    // A reviewer who could not decide has not approved anything.
    expect(assessment.verdict).toBe('unknown')
    expect(assessment.results[0]?.reason).toContain('could not reach a verdict')
  })

  it('reports unknown when a task defines no criteria at all', () => {
    // `taskSchema` requires one, so this is built by hand: an empty list means
    // something upstream is broken, and "done because nothing was asked" is the
    // worst possible answer.
    const assessment = assessCompletion({
      task: { ...task([criterion()]), completionCriteria: [] },
      evidence: [],
    })

    expect(assessment.verdict).toBe('unknown')
    expect(assessment.summary).toContain('no completion criteria')
  })

  it('says plainly in the finding that an unknown is not a pass', () => {
    const assessment = assessCompletion({ task: task([criterion()]), evidence: [] })

    expect(assessment.findings.join('\n')).toContain('not a pass')
  })
})

describe('a criterion backed by evidence', () => {
  it('passes on exit zero', () => {
    const assessment = assessCompletion({
      task: task([criterion()]),
      evidence: [artifact({ exitCode: 0 })],
    })

    expect(assessment.verdict).toBe('pass')
    expect(assessment.findings).toEqual([])
    expect(assessment.results[0]?.evidenceId).not.toBeNull()
  })

  it('fails on a non-zero exit', () => {
    const assessment = assessCompletion({
      task: task([criterion()]),
      evidence: [artifact({ exitCode: 1 })],
    })

    expect(assessment.verdict).toBe('fail')
    expect(assessment.results[0]?.reason).toContain('exited 1')
  })

  it('fails a run that never finished rather than calling it unknown', () => {
    const assessment = assessCompletion({
      task: task([criterion()]),
      evidence: [
        artifact({ outcome: 'timeout', exitCode: null, failure: 'no result within 400ms' }),
      ],
    })

    // A command that ran and hung is a failure, not an absence of evidence — the
    // distinction matters because an unknown says "check it again" while this says
    // "the command is broken".
    expect(assessment.verdict).toBe('fail')
    expect(assessment.results[0]?.reason).toContain('did not finish')
  })

  it('uses the most recent run of a kind, so a correction supersedes its predecessor', () => {
    const assessment = assessCompletion({
      task: task([criterion()]),
      evidence: [artifact({ exitCode: 1 }), artifact({ exitCode: 0 })],
    })

    expect(assessment.verdict).toBe('pass')
  })
})

describe('a custom command criterion', () => {
  it('passes when the named command was run and succeeded', () => {
    const assessment = assessCompletion({
      task: task([
        criterion({
          kind: 'custom-command',
          description: 'the linter is clean',
          params: { command: 'npm run lint' },
        }),
      ]),
      evidence: [artifact({ kind: 'custom-command', command: 'npm run lint', exitCode: 0 })],
    })

    expect(assessment.verdict).toBe('pass')
  })

  it('is unknown when the named command was never run', () => {
    const assessment = assessCompletion({
      task: task([
        criterion({
          kind: 'custom-command',
          description: 'the linter is clean',
          params: { command: 'npm run lint' },
        }),
      ]),
      // A different command ran. That says nothing about the linter.
      evidence: [artifact({ kind: 'tests', command: 'npm test', exitCode: 0 })],
    })

    expect(assessment.verdict).toBe('unknown')
  })

  it('is unknown when the criterion names no command', () => {
    const assessment = assessCompletion({
      task: task([criterion({ kind: 'custom-command', description: 'something', params: {} })]),
      evidence: [],
    })

    expect(assessment.verdict).toBe('unknown')
  })
})

describe('scope, assumptions and review', () => {
  it('fails when paths were changed outside the scope policy', () => {
    const assessment = assessCompletion({
      task: task([criterion({ kind: 'diff-scope', description: 'no out-of-scope edits' })]),
      evidence: [],
      reconciliation: reconciliation({ inScope: false, outOfScope: ['package.json'] }),
    })

    expect(assessment.verdict).toBe('fail')
    expect(assessment.results[0]?.reason).toContain('package.json')
  })

  it('fails when the report records an assumption', () => {
    const assessment = assessCompletion({
      task: task([criterion({ kind: 'no-assumptions', description: 'no assumptions recorded' })]),
      evidence: [],
      report: report({ assumptions: ['assumed the API returns 404'] }),
    })

    expect(assessment.verdict).toBe('fail')
    expect(assessment.results[0]?.reason).toContain('R1')
  })

  it('passes a clean report and an approving reviewer', () => {
    const assessment = assessCompletion({
      task: task([
        criterion({ kind: 'no-assumptions', description: 'no assumptions recorded' }),
        criterion({ kind: 'reviewer-verdict', description: 'a reviewer approves' }),
      ]),
      evidence: [],
      report: report(),
      reviewVerdict: 'pass',
    })

    expect(assessment.verdict).toBe('pass')
  })
})

describe('file-exists', () => {
  it('passes when every required path is present', () => {
    const assessment = assessCompletion({
      task: task([
        criterion({
          kind: 'file-exists',
          description: 'the migration was generated',
          params: { paths: ['src/db/migrations/0002.sql'] },
        }),
      ]),
      evidence: [],
      existingPaths: ['src/db/migrations/0002.sql', 'src/index.ts'],
    })

    expect(assessment.verdict).toBe('pass')
  })

  it('fails and names what is missing', () => {
    const assessment = assessCompletion({
      task: task([
        criterion({
          kind: 'file-exists',
          description: 'the migration was generated',
          params: { paths: ['a.sql', 'b.sql'] },
        }),
      ]),
      evidence: [],
      existingPaths: ['a.sql'],
    })

    expect(assessment.verdict).toBe('fail')
    expect(assessment.results[0]?.reason).toContain('b.sql')
  })

  it('is unknown when the repository was never inspected', () => {
    const assessment = assessCompletion({
      task: task([
        criterion({
          kind: 'file-exists',
          description: 'a file exists',
          params: { paths: ['a.sql'] },
        }),
      ]),
      evidence: [],
    })

    expect(assessment.verdict).toBe('unknown')
  })
})

describe('combining criteria', () => {
  it('passes only when every criterion passed', () => {
    const assessment = assessCompletion({
      task: task([
        criterion({ kind: 'build', description: 'the build succeeds' }),
        criterion({ kind: 'tests', description: 'the tests pass' }),
      ]),
      evidence: [
        artifact({ kind: 'build', command: 'npm run build', exitCode: 0 }),
        artifact({ kind: 'tests', exitCode: 0 }),
      ],
    })

    expect(assessment.verdict).toBe('pass')
  })

  it('does not pass when one criterion is merely unverifiable', () => {
    const assessment = assessCompletion({
      task: task([
        criterion({ kind: 'tests', description: 'the tests pass' }),
        criterion({ kind: 'reviewer-verdict', description: 'a reviewer approves' }),
      ]),
      evidence: [artifact({ exitCode: 0 })],
    })

    // One genuine pass plus one unchecked criterion is not a pass overall.
    expect(assessment.verdict).toBe('unknown')
  })

  it('reports fail ahead of unknown, while still counting the unknowns', () => {
    const assessment = assessCompletion({
      task: task([
        criterion({ kind: 'tests', description: 'the tests pass' }),
        criterion({ kind: 'reviewer-verdict', description: 'a reviewer approves' }),
      ]),
      evidence: [artifact({ exitCode: 1 })],
    })

    // A failure is actionable now; an unknown needs a different kind of fix. Both are
    // surfaced so neither hides the other.
    expect(assessment.verdict).toBe('fail')
    expect(assessment.summary).toContain('1 unverifiable')
    expect(assessment.findings).toHaveLength(2)
  })

  it('gives every criterion a reason, including the ones that passed', () => {
    const assessment = assessCompletion({
      task: task([criterion()]),
      evidence: [artifact({ exitCode: 0 })],
    })

    // A pass with no stated reason is an assertion; with one it is legible (A7).
    expect(assessment.results.every((result) => result.reason.length > 0)).toBe(true)
  })
})

describe('extended declarative criteria evaluators (CRIT-002)', () => {
  describe('file-forbidden', () => {
    it('passes when no changed files match forbidden patterns', () => {
      const assessment = assessCompletion({
        task: task([
          criterion({
            kind: 'file-forbidden',
            description: 'forbidden config files are not modified',
            params: { patterns: ['*.env*', '.env', 'package-lock.json'] },
          }),
        ]),
        evidence: [],
        changedFiles: [
          {
            path: 'src/main.ts',
            changeType: 'modified',
            previousPath: null,
            insertions: 5,
            deletions: 2,
          },
        ],
      })

      expect(assessment.verdict).toBe('pass')
      expect(assessment.results[0]?.reason).toContain('No changed files match')
    })

    it('fails when a changed file matches a forbidden pattern', () => {
      const assessment = assessCompletion({
        task: task([
          criterion({
            kind: 'file-forbidden',
            description: 'forbidden config files are not modified',
            params: { patterns: ['*.env*'] },
          }),
        ]),
        evidence: [],
        changedFiles: [
          {
            path: '.env.production',
            changeType: 'modified',
            previousPath: null,
            insertions: 1,
            deletions: 0,
          },
        ],
      })

      expect(assessment.verdict).toBe('fail')
      expect(assessment.results[0]?.reason).toContain('.env.production')
    })

    it('returns unknown when no diff was captured', () => {
      const assessment = assessCompletion({
        task: task([
          criterion({
            kind: 'file-forbidden',
            description: 'forbidden files check',
            params: { patterns: ['*.key'] },
          }),
        ]),
        evidence: [],
      })

      expect(assessment.verdict).toBe('unknown')
      expect(assessment.results[0]?.reason).toContain('diff was not captured')
    })
  })

  describe('max-diff-lines', () => {
    it('passes when diff lines are within ceiling', () => {
      const assessment = assessCompletion({
        task: task([
          criterion({
            kind: 'max-diff-lines',
            description: 'diff is compact',
            params: { maxLines: 50 },
          }),
        ]),
        evidence: [],
        changedFiles: [
          {
            path: 'src/index.ts',
            changeType: 'modified',
            previousPath: null,
            insertions: 20,
            deletions: 10,
          },
        ],
      })

      expect(assessment.verdict).toBe('pass')
      expect(assessment.results[0]?.reason).toContain('within allowed limit of 50')
    })

    it('fails when diff lines exceed ceiling', () => {
      const assessment = assessCompletion({
        task: task([
          criterion({
            kind: 'max-diff-lines',
            description: 'diff is compact',
            params: { maxLines: 25 },
          }),
        ]),
        evidence: [],
        changedFiles: [
          {
            path: 'src/index.ts',
            changeType: 'modified',
            previousPath: null,
            insertions: 20,
            deletions: 10,
          },
        ],
      })

      expect(assessment.verdict).toBe('fail')
      expect(assessment.results[0]?.reason).toContain('exceeded ceiling of 25')
    })
  })

  describe('artifact-regex', () => {
    it('passes when expected regex matches in evidence artifact stdout', () => {
      const assessment = assessCompletion({
        task: task([
          criterion({
            kind: 'artifact-regex',
            description: 'test report shows 0 failed',
            params: { pattern: '0 failed', artifactKind: 'tests', mustMatch: true },
          }),
        ]),
        evidence: [
          artifact({
            kind: 'tests',
            stdout: 'Tests: 15 passed, 0 failed, 15 total',
          }),
        ],
      })

      expect(assessment.verdict).toBe('pass')
      expect(assessment.results[0]?.reason).toContain('matched in evidence artifact')
    })

    it('fails when expected regex does not match in evidence artifact', () => {
      const assessment = assessCompletion({
        task: task([
          criterion({
            kind: 'artifact-regex',
            description: 'test report shows 0 failed',
            params: { pattern: '0 failed', artifactKind: 'tests', mustMatch: true },
          }),
        ]),
        evidence: [
          artifact({
            kind: 'tests',
            stdout: 'Tests: 12 passed, 3 failed, 15 total',
          }),
        ],
      })

      expect(assessment.verdict).toBe('fail')
      expect(assessment.results[0]?.reason).toContain('was not found')
    })

    it('fails when forbidden pattern is detected with mustMatch: false', () => {
      const assessment = assessCompletion({
        task: task([
          criterion({
            kind: 'artifact-regex',
            description: 'no memory leaks reported',
            params: { pattern: 'FATAL ERROR:.*heap out of memory', mustMatch: false },
          }),
        ]),
        evidence: [
          artifact({
            kind: 'tests',
            stderr:
              'FATAL ERROR: Ineffective mark-compacts near heap limit Allocation failed - JavaScript heap out of memory',
          }),
        ],
      })

      expect(assessment.verdict).toBe('fail')
      expect(assessment.results[0]?.reason).toContain('Forbidden pattern')
    })
  })
})
