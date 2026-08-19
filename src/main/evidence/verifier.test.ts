/**
 * What these tests claim: the verification step's verdict comes from what Forge
 * observed, and an agent's report cannot influence it.
 *
 * The `liar` scenario is the case this layer exists for. Reconciliation (#34) already
 * catches its file claims by diffing the worktree; nothing caught its `testsRun: true`
 * claim, because no diff can see whether a test ran. That gap is what #33 closes.
 *
 * The runner is injected here rather than spawning real processes — `runCommand` has
 * its own tests for that — so these assertions are about the verdict logic alone.
 */

import { describe, expect, it } from 'vitest'
import {
  agentReportSchema,
  evidenceIdSchema,
  repositoryIdSchema,
  stepIdSchema,
  taskIdSchema,
  taskSchema,
  workflowIdSchema,
  type AgentReport,
  type CompletionCriterion,
  type EvidenceArtifact,
  type Repository,
  type Task,
} from '@shared/domain'
import { SCENARIOS } from '../runtimes/scenario'
import { verifyStep } from './verifier'
import type { RunCommandInput } from './commandRunner'

const workflowId = workflowIdSchema.parse('11111111-1111-4111-8111-111111111111')
const stepId = stepIdSchema.parse('22222222-2222-4222-8222-222222222222')

function repository(overrides: Partial<Repository> = {}): Repository {
  return {
    id: repositoryIdSchema.parse('33333333-3333-4333-8333-333333333333'),
    absolutePath: '/repo',
    defaultBranch: 'main',
    buildCommand: 'npm run build',
    testCommand: 'npm test',
    tech: [],
    ...overrides,
  }
}

/** A runner that reports whatever the test needs, without spawning anything. */
function stubRunner(results: Readonly<Record<string, { exitCode: number | null }>>) {
  const calls: string[] = []

  const run = (input: RunCommandInput): Promise<EvidenceArtifact> => {
    calls.push(input.command)
    const outcome = results[input.command] ?? { exitCode: 0 }
    const completed = outcome.exitCode !== null

    return Promise.resolve({
      id: evidenceIdSchema.parse(`4444444${String(calls.length)}-4444-4444-8444-444444444444`),
      workflowId,
      stepId,
      kind: input.kind,
      command: input.command,
      cwd: input.cwd,
      outcome: completed ? 'completed' : 'timeout',
      exitCode: outcome.exitCode,
      durationMs: 100,
      stdout: 'output',
      stderr: '',
      truncated: false,
      counts: null,
      failure: completed ? null : 'no result within 1000ms',
      recordedAt: '2026-08-19T00:00:00.000Z',
    } satisfies EvidenceArtifact)
  }

  return { run, calls }
}

function report(overrides: Partial<AgentReport> = {}): AgentReport {
  return agentReportSchema.parse({
    status: 'completed',
    summary: 'Did the thing',
    filesChanged: [],
    commandsRun: [],
    testsRun: false,
    openQuestions: [],
    assumptions: [],
    ...overrides,
  })
}

describe('when the build and tests pass', () => {
  it('passes, having actually run both', async () => {
    const runner = stubRunner({})
    const result = await verifyStep({
      repository: repository(),
      workflowId,
      stepId,
      report: report(),
      run: runner.run,
    })

    expect(result.passed).toBe(true)
    expect(runner.calls).toEqual(['npm run build', 'npm test'])
    expect(result.artifacts).toHaveLength(2)
    expect(result.findings).toEqual([])
  })
})

describe('when the build fails', () => {
  it('fails and does not run the tests', async () => {
    const runner = stubRunner({ 'npm run build': { exitCode: 1 } })
    const result = await verifyStep({
      repository: repository(),
      workflowId,
      stepId,
      report: report(),
      run: runner.run,
    })

    expect(result.passed).toBe(false)
    // Tests against a tree that does not compile produce output about the build
    // failure, which would be noise inside an artifact labelled `tests`.
    expect(runner.calls).toEqual(['npm run build'])
    expect(result.findings.join('\n')).toContain('npm run build')
  })
})

describe('when the tests fail', () => {
  it('fails, and phrases the finding as an instruction to the agent', async () => {
    const runner = stubRunner({ 'npm test': { exitCode: 1 } })
    const result = await verifyStep({
      repository: repository(),
      workflowId,
      stepId,
      report: report(),
      run: runner.run,
    })

    expect(result.passed).toBe(false)
    expect(result.findings.join('\n')).toContain('do not change the command')
  })
})

describe('when a command never finishes', () => {
  it('does not treat a missing exit code as a pass', async () => {
    const runner = stubRunner({ 'npm test': { exitCode: null } })
    const result = await verifyStep({
      repository: repository(),
      workflowId,
      stepId,
      report: report(),
      run: runner.run,
    })

    expect(result.passed).toBe(false)
    expect(result.findings.join('\n')).toContain('did not finish')
  })
})

describe('when nothing is configured to run', () => {
  it('does not pass, because nothing was verified', async () => {
    const runner = stubRunner({})
    const result = await verifyStep({
      repository: repository({ buildCommand: null, testCommand: null }),
      workflowId,
      stepId,
      report: report(),
      run: runner.run,
    })

    // Unverifiable is not the same as verified-good. Treating an absence of evidence
    // as success is precisely the inference axiom A3 forbids.
    expect(result.passed).toBe(false)
    expect(runner.calls).toEqual([])
    expect(result.detail).toContain('nothing could be verified')
  })
})

describe('the liar scenario', () => {
  it('catches the testsRun claim that no diff can see', async () => {
    // Taken from the real fixture rather than restated, so the test tracks the
    // scenario if it changes.
    const liarStep = SCENARIOS.liar.steps[0]
    const liarReport = liarStep?.report ?? null

    expect(liarReport?.testsRun).toBe(true)
    expect(liarReport?.commandsRun).toContain('npm test')

    // Forge runs the tests itself and they fail, while the report says they were run
    // and the work is complete.
    const runner = stubRunner({ 'npm test': { exitCode: 1 } })
    const result = await verifyStep({
      repository: repository(),
      workflowId,
      stepId,
      report: liarReport,
      run: runner.run,
    })

    expect(result.passed).toBe(false)
    expect(result.falseClaims).toHaveLength(1)
    expect(result.falseClaims[0]).toContain('claims tests were run')
    // The lie is surfaced separately from the failure: a failing build is ordinary,
    // an agent reporting tests it never ran is a trust problem.
    expect(result.findings.length).toBeGreaterThan(result.falseClaims.length)
  })

  it('flags a testsRun claim when the project has no test command at all', async () => {
    const runner = stubRunner({})
    const result = await verifyStep({
      repository: repository({ testCommand: null }),
      workflowId,
      stepId,
      report: report({ testsRun: true }),
      run: runner.run,
    })

    // Nothing could have run, so the claim is unverifiable by construction.
    expect(result.falseClaims.join('\n')).toContain('no test command configured')
  })
})

describe('an honest report', () => {
  it('produces no false claims when the evidence agrees', async () => {
    const runner = stubRunner({})
    const result = await verifyStep({
      repository: repository(),
      workflowId,
      stepId,
      report: report({ testsRun: true, commandsRun: ['npm test'] }),
      run: runner.run,
    })

    expect(result.passed).toBe(true)
    expect(result.falseClaims).toEqual([])
  })

  it('does not invent claims when there is no report to check', async () => {
    const runner = stubRunner({ 'npm test': { exitCode: 1 } })
    const result = await verifyStep({
      repository: repository(),
      workflowId,
      stepId,
      report: null,
      run: runner.run,
    })

    expect(result.passed).toBe(false)
    expect(result.falseClaims).toEqual([])
  })
})

describe('the verdict comes from the task criteria (#35)', () => {
  /** A task whose criteria the caller controls. */
  function taskWith(criteria: readonly CompletionCriterion[]): Task {
    return taskSchema.parse({
      id: taskIdSchema.parse('55555555-5555-4555-8555-555555555555'),
      objective: 'Do the thing',
      constraints: [],
      completionCriteria: criteria,
      scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
      lockedDecisionIds: [],
      correctsTaskId: null,
      createdAt: '2026-08-19T00:00:00.000Z',
    })
  }

  it('reports unknown, not pass, when a criterion cannot be checked', async () => {
    const runner = stubRunner({})
    const result = await verifyStep({
      repository: repository(),
      workflowId,
      stepId,
      report: report(),
      // The build and tests both pass, but the task also demands a reviewer verdict
      // and none exists yet.
      task: taskWith([
        { kind: 'tests', description: 'the tests pass', params: {} },
        { kind: 'reviewer-verdict', description: 'a reviewer approves', params: {} },
      ]),
      run: runner.run,
    })

    // The distinction this issue exists for: `passed` is false even though nothing
    // failed, because one criterion went unverified.
    expect(result.verdict).toBe('unknown')
    expect(result.passed).toBe(false)
    expect(result.findings.join('\n')).toContain('not a pass')
  })

  it('passes once every criterion has evidence behind it', async () => {
    const runner = stubRunner({})
    const result = await verifyStep({
      repository: repository(),
      workflowId,
      stepId,
      report: report(),
      task: taskWith([
        { kind: 'build', description: 'the build succeeds', params: {} },
        { kind: 'tests', description: 'the tests pass', params: {} },
        { kind: 'reviewer-verdict', description: 'a reviewer approves', params: {} },
      ]),
      reviewVerdict: 'pass',
      run: runner.run,
    })

    expect(result.verdict).toBe('pass')
    expect(result.passed).toBe(true)
    expect(result.criteria).toHaveLength(3)
  })

  it('fails on a scope violation the criteria asked about', async () => {
    const runner = stubRunner({})
    const result = await verifyStep({
      repository: repository(),
      workflowId,
      stepId,
      report: report(),
      task: taskWith([{ kind: 'diff-scope', description: 'no out-of-scope edits', params: {} }]),
      reconciliation: {
        discrepancies: [],
        outOfScope: ['package.json'],
        claimAccurate: true,
        inScope: false,
      },
      run: runner.run,
    })

    expect(result.verdict).toBe('fail')
    expect(result.findings.join('\n')).toContain('package.json')
  })

  it('falls back to the evidence alone when no task is supplied', async () => {
    const runner = stubRunner({})
    const result = await verifyStep({
      repository: repository(),
      workflowId,
      stepId,
      report: report(),
      run: runner.run,
    })

    // Backwards compatible: a caller that only wants build and test evidence still
    // gets a usable verdict, and "nothing ran" is still not a pass.
    expect(result.verdict).toBe('pass')
    expect(result.criteria).toEqual([])
  })

  it('is unknown when nothing was configured to run and no task defines done', async () => {
    const runner = stubRunner({})
    const result = await verifyStep({
      repository: repository({ buildCommand: null, testCommand: null }),
      workflowId,
      stepId,
      report: report(),
      run: runner.run,
    })

    expect(result.verdict).toBe('unknown')
    expect(result.passed).toBe(false)
  })
})
