/**
 * BENCH-001: Empirical Multi-Agent Reproducible Benchmark Harness.
 *
 * Executes deterministic tasks across isolated synthetic git repository fixtures
 * on disk without network dependencies, independently inspects physical git state
 * and filesystem changes against ground-truth assertions, guarantees sandbox teardown,
 * and computes reproducible pass/fail scorecard metrics and evidence digests (A1, A3, A6).
 */

import { createHash, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, isAbsolute, join, normalize, relative, resolve } from 'node:path'
import { COMMITTED_BENCHMARK_BASELINE } from '../benchmarks/benchmarkHarness'
import { runGit } from '../git/exec'
import { GitService } from '../git/gitService'

export type ScenarioCategory =
  'BUG_FIX' | 'REFACTOR' | 'SECURITY_PATCH' | 'FEATURE' | 'TEST_SYNTHESIS'

export type PhysicalAssertionType =
  | 'file_exists'
  | 'file_contains'
  | 'file_not_contains'
  | 'file_matches_sha256'
  | 'changed_files_include'
  | 'changed_files_exclude'

export interface BenchmarkScenarioFile {
  readonly relativePath: string
  readonly content: string
}

export interface PhysicalDiffAssertion {
  readonly type: PhysicalAssertionType
  readonly targetPath: string
  readonly expectedValue?: string | undefined
}

export interface TaskScenario {
  readonly scenarioId: string
  readonly title: string
  readonly category: ScenarioCategory
  readonly initialFiles: readonly BenchmarkScenarioFile[]
  readonly taskPrompt: string
  readonly assertions: readonly PhysicalDiffAssertion[]
  readonly maxDurationMs?: number | undefined
  readonly expectedMinChangedFiles?: number | undefined
}

export interface BenchmarkWorkspaceContext {
  readonly scenarioId: string
  readonly workspaceDir: string
  readonly initialHeadSha: string
  readonly taskPrompt: string
}

export interface BenchmarkTaskExecutorResult {
  readonly ok: boolean
  readonly agentId?: string | undefined
  readonly summary?: string | undefined
  readonly error?: string | undefined
  readonly tokenUsage?: number | undefined
}

export type BenchmarkTaskExecutor = (
  ctx: BenchmarkWorkspaceContext,
) => Promise<BenchmarkTaskExecutorResult> | BenchmarkTaskExecutorResult

export interface BenchmarkHarnessConfig {
  readonly suiteName?: string | undefined
  readonly workspaceParentDir?: string | undefined
  readonly cleanupWorkspaces?: boolean | undefined
  readonly baselineTotalSeconds?: number | undefined
}

export interface AssertionOutcome {
  readonly assertion: PhysicalDiffAssertion
  readonly passed: boolean
  readonly actualDetail: string
}

export interface ScenarioRunReport {
  readonly scenarioId: string
  readonly title: string
  readonly category: ScenarioCategory
  readonly passed: boolean
  readonly executorOk: boolean
  readonly durationMs: number
  readonly initialHeadSha: string
  readonly changedFiles: readonly string[]
  readonly assertionsPassed: number
  readonly assertionsTotal: number
  readonly assertionOutcomes: readonly AssertionOutcome[]
  readonly tokenUsage: number
  readonly workspaceCleanedUp: boolean
  readonly evidenceDigest: string
  readonly error?: string | undefined
}

export interface EmpiricalScorecardMetrics {
  readonly totalScenarios: number
  readonly passedScenarios: number
  readonly failedScenarios: number
  readonly passRatePercent: number
  readonly totalAssertions: number
  readonly passedAssertions: number
  readonly assertionFidelityPercent: number
  readonly totalDurationMs: number
  readonly averageScenarioDurationMs: number
  readonly totalTokensUsed: number
  readonly baselineTotalSeconds: number
  readonly speedupRatioVsBaseline: number
  readonly regressionDetected: boolean
}

export interface BenchmarkResult {
  readonly runId: string
  readonly suiteName: string
  readonly executedAt: string
  readonly scorecard: EmpiricalScorecardMetrics
  readonly scenarios: readonly ScenarioRunReport[]
  readonly suiteEvidenceDigest: string
  readonly overallVerdict: 'PASS' | 'REGRESSION_FAIL'
}

export type EmpiricalBenchmarkResult = BenchmarkResult

export class BenchmarkFixtureValidationError extends Error {
  constructor(scenarioId: string, details: string) {
    super(`Invalid benchmark scenario "${scenarioId}": ${details}`)
    this.name = 'BenchmarkFixtureValidationError'
  }
}

export class BenchmarkExecutionError extends Error {
  constructor(scenarioId: string, details: string) {
    super(`Benchmark execution failure for "${scenarioId}": ${details}`)
    this.name = 'BenchmarkExecutionError'
  }
}

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function normalizeRelativePath(rawPath: string): string {
  return rawPath
    .split('\\')
    .join('/')
    .replace(/^\.\/+/, '')
}

function assertSafeWorkspacePath(
  scenarioId: string,
  workspaceDir: string,
  candidatePath: string,
): string {
  if (!candidatePath || candidatePath.trim().length === 0) {
    throw new BenchmarkFixtureValidationError(scenarioId, 'File path cannot be empty')
  }
  if (isAbsolute(candidatePath) || /^[a-zA-Z]:[/\\]/.test(candidatePath)) {
    throw new BenchmarkFixtureValidationError(
      scenarioId,
      `Absolute paths are prohibited in benchmark fixtures: "${candidatePath}"`,
    )
  }
  const normalized = normalize(candidatePath)
  const resolved = resolve(workspaceDir, normalized)
  const rel = relative(workspaceDir, resolved)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) {
    throw new BenchmarkFixtureValidationError(
      scenarioId,
      `Path escapes isolated benchmark workspace: "${candidatePath}"`,
    )
  }
  return resolved
}

function validateScenarioDefinition(scenario: TaskScenario): void {
  if (!scenario.scenarioId || scenario.scenarioId.trim().length === 0) {
    throw new BenchmarkFixtureValidationError('(unknown)', 'scenarioId cannot be empty')
  }
  if (scenario.initialFiles.length === 0) {
    throw new BenchmarkFixtureValidationError(
      scenario.scenarioId,
      'initialFiles must contain at least one fixture file',
    )
  }
  if (scenario.assertions.length === 0) {
    throw new BenchmarkFixtureValidationError(
      scenario.scenarioId,
      'assertions must contain at least one physical verification assertion',
    )
  }
}

function evaluateSingleAssertion(
  scenarioId: string,
  workspaceDir: string,
  changedFilesSet: ReadonlySet<string>,
  assertion: PhysicalDiffAssertion,
): AssertionOutcome {
  const normalizedTarget = normalizeRelativePath(assertion.targetPath)
  const targetAbsPath = assertSafeWorkspacePath(scenarioId, workspaceDir, assertion.targetPath)

  switch (assertion.type) {
    case 'file_exists': {
      const exists = existsSync(targetAbsPath)
      return {
        assertion,
        passed: exists,
        actualDetail: exists
          ? `File "${normalizedTarget}" present on disk`
          : `Missing file "${normalizedTarget}"`,
      }
    }
    case 'file_contains': {
      if (!existsSync(targetAbsPath)) {
        return {
          assertion,
          passed: false,
          actualDetail: `Missing target file "${normalizedTarget}"`,
        }
      }
      const text = readFileSync(targetAbsPath, 'utf8')
      const expected = assertion.expectedValue ?? ''
      const passed = text.includes(expected)
      return {
        assertion,
        passed,
        actualDetail: passed
          ? `File "${normalizedTarget}" contains expected substring`
          : `Expected substring "${expected}" not found in "${normalizedTarget}"`,
      }
    }
    case 'file_not_contains': {
      if (!existsSync(targetAbsPath)) {
        return {
          assertion,
          passed: false,
          actualDetail: `Missing target file "${normalizedTarget}"`,
        }
      }
      const text = readFileSync(targetAbsPath, 'utf8')
      const forbidden = assertion.expectedValue ?? ''
      const passed = !text.includes(forbidden)
      return {
        assertion,
        passed,
        actualDetail: passed
          ? `File "${normalizedTarget}" does not contain forbidden pattern`
          : `Forbidden pattern "${forbidden}" still present in "${normalizedTarget}"`,
      }
    }
    case 'file_matches_sha256': {
      if (!existsSync(targetAbsPath)) {
        return {
          assertion,
          passed: false,
          actualDetail: `Missing target file "${normalizedTarget}"`,
        }
      }
      const actualHash = sha256Hex(readFileSync(targetAbsPath))
      const expectedHash = assertion.expectedValue ?? ''
      const passed = actualHash === expectedHash
      return {
        assertion,
        passed,
        actualDetail: passed
          ? `SHA-256 verified (${actualHash.slice(0, 12)}...)`
          : `SHA-256 mismatch: expected ${expectedHash}, got ${actualHash}`,
      }
    }
    case 'changed_files_include': {
      const passed = changedFilesSet.has(normalizedTarget)
      return {
        assertion,
        passed,
        actualDetail: passed
          ? `Physical git changes include "${normalizedTarget}"`
          : `File "${normalizedTarget}" was not modified in git working tree`,
      }
    }
    case 'changed_files_exclude': {
      const passed = !changedFilesSet.has(normalizedTarget)
      return {
        assertion,
        passed,
        actualDetail: passed
          ? `File "${normalizedTarget}" remained untouched`
          : `Unexpected modification to "${normalizedTarget}"`,
      }
    }
  }
}

export function createDefaultBenchmarkScenarios(): readonly TaskScenario[] {
  return [
    {
      scenarioId: 'bench-null-guard-01',
      title: 'Fix empty-array division by zero guard in math utility',
      category: 'BUG_FIX',
      initialFiles: [
        {
          relativePath: 'src/math.ts',
          content: [
            'export function average(values: readonly number[]): number {',
            '  const total = values.reduce((acc, n) => acc + n, 0)',
            '  return total / values.length',
            '}',
            '',
          ].join('\n'),
        },
        {
          relativePath: 'src/constants.ts',
          content: 'export const APP_NAME = "forge-bench"\n',
        },
      ],
      taskPrompt: 'Guard average() against empty arrays so it returns 0 instead of NaN.',
      expectedMinChangedFiles: 1,
      assertions: [
        { type: 'file_exists', targetPath: 'src/math.ts' },
        { type: 'file_contains', targetPath: 'src/math.ts', expectedValue: 'values.length === 0' },
        { type: 'changed_files_include', targetPath: 'src/math.ts' },
        { type: 'changed_files_exclude', targetPath: 'src/constants.ts' },
      ],
    },
    {
      scenarioId: 'bench-secret-redact-02',
      title: 'Enforce credential redaction placeholder in config logger',
      category: 'SECURITY_PATCH',
      initialFiles: [
        {
          relativePath: 'src/configLogger.ts',
          content: [
            'export function formatConfigEntry(key: string, value: string): string {',
            '  return `${key}=${value}`',
            '}',
            '',
          ].join('\n'),
        },
      ],
      taskPrompt: 'Redact secret keys containing TOKEN or SECRET to output ***REDACTED***.',
      expectedMinChangedFiles: 1,
      assertions: [
        { type: 'file_exists', targetPath: 'src/configLogger.ts' },
        {
          type: 'file_contains',
          targetPath: 'src/configLogger.ts',
          expectedValue: '***REDACTED***',
        },
        { type: 'changed_files_include', targetPath: 'src/configLogger.ts' },
      ],
    },
  ]
}

/**
 * Deterministic offline task executor for default benchmark fixtures and CLI verification.
 */
export function runDefaultBenchmarkExecutor(
  ctx: BenchmarkWorkspaceContext,
): BenchmarkTaskExecutorResult {
  if (ctx.scenarioId === 'bench-null-guard-01') {
    const mathPath = join(ctx.workspaceDir, 'src/math.ts')
    writeFileSync(
      mathPath,
      [
        'export function average(values: readonly number[]): number {',
        '  if (values.length === 0) return 0',
        '  const total = values.reduce((acc, n) => acc + n, 0)',
        '  return total / values.length',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    return {
      ok: true,
      agentId: 'forge-deterministic-solver',
      summary: 'Added empty-array guard in src/math.ts',
      tokenUsage: 420,
    }
  }

  if (ctx.scenarioId === 'bench-secret-redact-02') {
    const loggerPath = join(ctx.workspaceDir, 'src/configLogger.ts')
    writeFileSync(
      loggerPath,
      [
        'export function formatConfigEntry(key: string, value: string): string {',
        '  const masked = /TOKEN|SECRET/i.test(key) ? "***REDACTED***" : value',
        '  return `${key}=${masked}`',
        '}',
        '',
      ].join('\n'),
      'utf8',
    )
    return {
      ok: true,
      agentId: 'forge-deterministic-solver',
      summary: 'Redacted secret config values in src/configLogger.ts',
      tokenUsage: 510,
    }
  }

  return {
    ok: false,
    error: `No built-in solver registered for scenario "${ctx.scenarioId}"`,
  }
}

export class EmpiricalBenchmarkHarness {
  private readonly suiteName: string
  private readonly workspaceParentDir: string
  private readonly cleanupWorkspaces: boolean
  private readonly baselineTotalSeconds: number

  constructor(config: BenchmarkHarnessConfig = {}) {
    this.suiteName = config.suiteName ?? 'forge-empirical-suite'
    this.workspaceParentDir = config.workspaceParentDir ?? tmpdir()
    this.cleanupWorkspaces = config.cleanupWorkspaces ?? true
    this.baselineTotalSeconds = config.baselineTotalSeconds ?? COMMITTED_BENCHMARK_BASELINE.total
  }

  /**
   * Executes an array of reproducible scenarios in isolated synthetic git repositories
   * and returns an aggregated empirical scorecard with physical evidence digests.
   */
  async runSuite(
    scenarios: readonly TaskScenario[],
    executor: BenchmarkTaskExecutor,
  ): Promise<BenchmarkResult> {
    if (scenarios.length === 0) {
      throw new BenchmarkFixtureValidationError('(suite)', 'At least one scenario is required')
    }

    const runId = `bench-${randomUUID().slice(0, 10)}`
    const executedAt = new Date().toISOString()
    const reports: ScenarioRunReport[] = []

    for (const scenario of scenarios) {
      const report = await this.runSingleScenario(scenario, executor)
      reports.push(report)
    }

    const totalScenarios = reports.length
    const passedScenarios = reports.filter((r) => r.passed).length
    const failedScenarios = totalScenarios - passedScenarios
    const passRatePercent = Number(((passedScenarios / totalScenarios) * 100).toFixed(2))

    const totalAssertions = reports.reduce((sum, r) => sum + r.assertionsTotal, 0)
    const passedAssertions = reports.reduce((sum, r) => sum + r.assertionsPassed, 0)
    const assertionFidelityPercent =
      totalAssertions > 0 ? Number(((passedAssertions / totalAssertions) * 100).toFixed(2)) : 100

    const totalDurationMs = reports.reduce((sum, r) => sum + r.durationMs, 0)
    const averageScenarioDurationMs = Math.round(totalDurationMs / totalScenarios)
    const totalTokensUsed = reports.reduce((sum, r) => sum + r.tokenUsage, 0)
    const totalSeconds = Math.max(0.001, totalDurationMs / 1000)
    const speedupRatioVsBaseline = Number((this.baselineTotalSeconds / totalSeconds).toFixed(2))
    const regressionDetected = failedScenarios > 0

    const suiteEvidenceDigest = sha256Hex(
      reports.map((r) => `${r.scenarioId}:${String(r.passed)}:${r.evidenceDigest}`).join('|'),
    )

    return {
      runId,
      suiteName: this.suiteName,
      executedAt,
      scorecard: {
        totalScenarios,
        passedScenarios,
        failedScenarios,
        passRatePercent,
        totalAssertions,
        passedAssertions,
        assertionFidelityPercent,
        totalDurationMs,
        averageScenarioDurationMs,
        totalTokensUsed,
        baselineTotalSeconds: this.baselineTotalSeconds,
        speedupRatioVsBaseline,
        regressionDetected,
      },
      scenarios: reports,
      suiteEvidenceDigest,
      overallVerdict: failedScenarios === 0 ? 'PASS' : 'REGRESSION_FAIL',
    }
  }

  /**
   * Provisions a synthetic git repository for `scenario`, runs `executor`, audits physical
   * changes against ground-truth assertions, and ensures workspace cleanup in `finally`.
   */
  async runSingleScenario(
    scenario: TaskScenario,
    executor: BenchmarkTaskExecutor,
  ): Promise<ScenarioRunReport> {
    validateScenarioDefinition(scenario)

    const workspaceDir = mkdtempSync(join(this.workspaceParentDir, 'forge-bench-'))
    const startMs = Date.now()

    try {
      // 1. Seed fixture files with path-traversal protection
      for (const file of scenario.initialFiles) {
        const targetAbs = assertSafeWorkspacePath(
          scenario.scenarioId,
          workspaceDir,
          file.relativePath,
        )
        mkdirSync(dirname(targetAbs), { recursive: true })
        writeFileSync(targetAbs, file.content, 'utf8')
      }

      // 2. Initialize isolated synthetic git repository with deterministic identity
      await runGit(['init'], { cwd: workspaceDir })
      await runGit(['add', '-A'], { cwd: workspaceDir })
      await runGit(
        [
          '-c',
          'user.name=Forge Benchmark',
          '-c',
          'user.email=bench@forge.local',
          'commit',
          '-m',
          `seed benchmark fixture: ${scenario.scenarioId}`,
        ],
        { cwd: workspaceDir },
      )
      const headRes = await runGit(['rev-parse', 'HEAD'], { cwd: workspaceDir })
      const initialHeadSha = headRes.stdout.trim()

      // 3. Validate assertion paths eagerly before execution
      for (const assertion of scenario.assertions) {
        assertSafeWorkspacePath(scenario.scenarioId, workspaceDir, assertion.targetPath)
      }

      // 4. Execute agent/solver against isolated workspace
      let execResult: BenchmarkTaskExecutorResult
      try {
        execResult = await executor({
          scenarioId: scenario.scenarioId,
          workspaceDir,
          initialHeadSha,
          taskPrompt: scenario.taskPrompt,
        })
      } catch (err) {
        execResult = {
          ok: false,
          error: err instanceof Error ? err.message : String(err),
        }
      }

      // 5. Independently inspect physical git working tree (Axiom A3)
      const gitService = new GitService({ repositoryPath: workspaceDir })
      const gitStatus = await gitService.status()
      const changedFiles = Array.from(
        new Set([
          ...gitStatus.entries.map((e) => normalizeRelativePath(e.path)),
          ...gitStatus.untracked.map((p) => normalizeRelativePath(p)),
        ]),
      ).sort()
      const changedSet = new Set(changedFiles)

      const assertionOutcomes = scenario.assertions.map((a) =>
        evaluateSingleAssertion(scenario.scenarioId, workspaceDir, changedSet, a),
      )
      const assertionsPassed = assertionOutcomes.filter((o) => o.passed).length
      const assertionsTotal = assertionOutcomes.length

      const durationMs = Math.max(1, Date.now() - startMs)
      const minChangedOk =
        scenario.expectedMinChangedFiles === undefined ||
        changedFiles.length >= scenario.expectedMinChangedFiles
      const withinDuration =
        scenario.maxDurationMs === undefined || durationMs <= scenario.maxDurationMs

      const passed =
        execResult.ok && assertionsPassed === assertionsTotal && minChangedOk && withinDuration

      const evidencePayload = [
        scenario.scenarioId,
        initialHeadSha,
        changedFiles.join(','),
        assertionOutcomes.map((o) => `${o.assertion.type}:${String(o.passed)}`).join('|'),
      ].join(':')
      const evidenceDigest = sha256Hex(evidencePayload)

      const errMessages: string[] = []
      if (!execResult.ok) {
        errMessages.push(execResult.error ?? 'Task executor returned ok=false')
      }
      if (!minChangedOk) {
        errMessages.push(
          `Expected at least ${String(scenario.expectedMinChangedFiles)} changed file(s), observed ${String(changedFiles.length)}`,
        )
      }
      if (!withinDuration) {
        errMessages.push(
          `Duration ${String(durationMs)}ms exceeded budget ${String(scenario.maxDurationMs)}ms`,
        )
      }
      for (const outcome of assertionOutcomes) {
        if (!outcome.passed) {
          errMessages.push(outcome.actualDetail)
        }
      }

      return {
        scenarioId: scenario.scenarioId,
        title: scenario.title,
        category: scenario.category,
        passed,
        executorOk: execResult.ok,
        durationMs,
        initialHeadSha,
        changedFiles,
        assertionsPassed,
        assertionsTotal,
        assertionOutcomes,
        tokenUsage: execResult.tokenUsage ?? 0,
        workspaceCleanedUp: this.cleanupWorkspaces,
        evidenceDigest,
        ...(errMessages.length > 0 ? { error: errMessages.join('; ') } : {}),
      }
    } finally {
      if (this.cleanupWorkspaces) {
        try {
          rmSync(workspaceDir, { recursive: true, force: true })
        } catch {
          // Best-effort temp sandbox cleanup
        }
      }
    }
  }
}
