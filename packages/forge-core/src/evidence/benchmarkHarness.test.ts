import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BenchmarkFixtureValidationError,
  createDefaultBenchmarkScenarios,
  EmpiricalBenchmarkHarness,
  runDefaultBenchmarkExecutor,
  type TaskScenario,
} from './benchmarkHarness'

describe('EmpiricalBenchmarkHarness (BENCH-001)', () => {
  const tempDirs: string[] = []

  afterEach(() => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop()
      if (dir) {
        rmSync(dir, { recursive: true, force: true })
      }
    }
  })

  it('executes reproducible fixtures in isolated git sandboxes, verifies physical diffs, and cleans up', async () => {
    const sandboxParent = mkdtempSync(join(tmpdir(), 'forge-bench-parent-'))
    tempDirs.push(sandboxParent)

    const observedWorkspaces: string[] = []
    const harness = new EmpiricalBenchmarkHarness({
      suiteName: 'offline-regression-suite',
      workspaceParentDir: sandboxParent,
      cleanupWorkspaces: true,
    })

    const scenarios = createDefaultBenchmarkScenarios()
    const result = await harness.runSuite(scenarios, (ctx) => {
      observedWorkspaces.push(ctx.workspaceDir)
      expect(existsSync(join(ctx.workspaceDir, '.git'))).toBe(true)
      expect(ctx.initialHeadSha).toMatch(/^[0-9a-f]{40}$/)
      return runDefaultBenchmarkExecutor(ctx)
    })

    expect(result.suiteName).toBe('offline-regression-suite')
    expect(result.overallVerdict).toBe('PASS')
    expect(result.scorecard.totalScenarios).toBe(2)
    expect(result.scorecard.passedScenarios).toBe(2)
    expect(result.scorecard.failedScenarios).toBe(0)
    expect(result.scorecard.passRatePercent).toBe(100)
    expect(result.scorecard.assertionFidelityPercent).toBe(100)
    expect(result.scorecard.totalTokensUsed).toBe(930)
    expect(result.scorecard.regressionDetected).toBe(false)
    expect(result.suiteEvidenceDigest).toHaveLength(64)

    for (const report of result.scenarios) {
      expect(report.passed).toBe(true)
      expect(report.workspaceCleanedUp).toBe(true)
      expect(report.evidenceDigest).toHaveLength(64)
    }

    // Confirm temp workspaces were physically removed after execution
    for (const ws of observedWorkspaces) {
      expect(existsSync(ws)).toBe(false)
    }
  })

  it('detects failed physical assertions, executor exceptions, and file_not_contains/sha256 mismatches fail-closed', async () => {
    const harness = new EmpiricalBenchmarkHarness()
    const failingScenario: TaskScenario = {
      scenarioId: 'bench-fail-verify',
      title: 'Catch incomplete fix leaving TODO marker',
      category: 'BUG_FIX',
      initialFiles: [{ relativePath: 'app.ts', content: '// TODO: fix\nexport const x = 1\n' }],
      taskPrompt: 'Remove TODO marker cleanly.',
      expectedMinChangedFiles: 1,
      assertions: [
        { type: 'file_not_contains', targetPath: 'app.ts', expectedValue: 'TODO' },
        {
          type: 'file_matches_sha256',
          targetPath: 'app.ts',
          expectedValue: '0'.repeat(64),
        },
        { type: 'changed_files_include', targetPath: 'app.ts' },
      ],
    }

    const brokenScenario: TaskScenario = {
      scenarioId: 'bench-executor-crash',
      title: 'Handle solver runtime crash gracefully',
      category: 'REFACTOR',
      initialFiles: [{ relativePath: 'mod.ts', content: 'export const v = 1\n' }],
      taskPrompt: 'Refactor mod.ts',
      assertions: [{ type: 'file_exists', targetPath: 'mod.ts' }],
    }

    const result = await harness.runSuite([failingScenario, brokenScenario], (ctx) => {
      if (ctx.scenarioId === 'bench-fail-verify') {
        // Leave TODO untouched
        writeFileSync(
          join(ctx.workspaceDir, 'app.ts'),
          '// TODO: still broken\nexport const x = 2\n',
        )
        return { ok: true }
      }
      throw new Error('Simulated agent timeout crash')
    })

    expect(result.overallVerdict).toBe('REGRESSION_FAIL')
    expect(result.scorecard.passedScenarios).toBe(0)
    expect(result.scorecard.failedScenarios).toBe(2)
    expect(result.scorecard.regressionDetected).toBe(true)

    const failReport = result.scenarios[0]
    expect(failReport?.passed).toBe(false)
    expect(failReport?.assertionsPassed).toBe(1) // changed_files_include passed, other 2 failed
    expect(failReport?.error).toContain('Forbidden pattern "TODO"')
    expect(failReport?.error).toContain('SHA-256 mismatch')

    const crashReport = result.scenarios[1]
    expect(crashReport?.passed).toBe(false)
    expect(crashReport?.executorOk).toBe(false)
    expect(crashReport?.error).toContain('Simulated agent timeout crash')
  })

  it('rejects empty fixtures and path traversal attempts fail-closed', async () => {
    const harness = new EmpiricalBenchmarkHarness()

    await expect(harness.runSuite([], runDefaultBenchmarkExecutor)).rejects.toThrow(
      BenchmarkFixtureValidationError,
    )

    const traversalScenario: TaskScenario = {
      scenarioId: 'bench-traversal',
      title: 'Escape attempt',
      category: 'SECURITY_PATCH',
      initialFiles: [{ relativePath: '../../etc/passwd', content: 'root:x:0:0' }],
      taskPrompt: 'Should fail immediately',
      assertions: [{ type: 'file_exists', targetPath: 'app.ts' }],
    }

    await expect(
      harness.runSingleScenario(traversalScenario, runDefaultBenchmarkExecutor),
    ).rejects.toThrow(BenchmarkFixtureValidationError)

    const emptyFilesScenario: TaskScenario = {
      scenarioId: 'bench-empty',
      title: 'No files',
      category: 'FEATURE',
      initialFiles: [],
      taskPrompt: 'Empty',
      assertions: [{ type: 'file_exists', targetPath: 'app.ts' }],
    }
    await expect(
      harness.runSingleScenario(emptyFilesScenario, runDefaultBenchmarkExecutor),
    ).rejects.toThrow(BenchmarkFixtureValidationError)

    // Ensure non-deleted parent option leaves workspace inspectable when requested
    const retainParent = mkdtempSync(join(tmpdir(), 'forge-bench-keep-'))
    mkdirSync(retainParent, { recursive: true })
    tempDirs.push(retainParent)
    const keepHarness = new EmpiricalBenchmarkHarness({
      workspaceParentDir: retainParent,
      cleanupWorkspaces: false,
    })
    const [firstDefault] = createDefaultBenchmarkScenarios()
    if (!firstDefault) throw new Error('Expected default scenario')
    const keptReport = await keepHarness.runSingleScenario(
      firstDefault,
      runDefaultBenchmarkExecutor,
    )
    expect(keptReport.passed).toBe(true)
    expect(keptReport.workspaceCleanedUp).toBe(false)
  })
})
