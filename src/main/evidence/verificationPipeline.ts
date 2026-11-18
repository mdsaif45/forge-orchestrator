import { evidencePassed, type StepId, type WorkflowId, type RunId } from '@shared/domain'
import type { ArtifactService } from '../artifacts'
import { runCommand } from './commandRunner'

export interface VerificationStepSpec {
  readonly name: string
  readonly command: string
  readonly timeoutMs?: number | undefined
}

export interface VerificationPipelineInput {
  readonly cwd: string
  readonly workflowId: WorkflowId
  readonly stepId: StepId
  readonly steps: readonly VerificationStepSpec[]
  readonly stopOnFailure?: boolean | undefined
}

export interface VerificationStepResult {
  readonly name: string
  readonly command: string
  readonly status: 'passed' | 'failed' | 'skipped' | 'timed_out'
  readonly exitCode: number | null
  readonly durationMs: number
  readonly stdout: string
  readonly stderr: string
  readonly error?: string | undefined
}

export interface VerificationPipelineReport {
  readonly valid: boolean
  readonly allPassed: boolean
  readonly totalSteps: number
  readonly passedCount: number
  readonly failedCount: number
  readonly skippedCount: number
  readonly durationMs: number
  readonly steps: readonly VerificationStepResult[]
  readonly failureStep?: string | undefined
  readonly formattedSummary: string
}

/**
 * Runs a multi-stage verification pipeline sequentially with fail-closed short-circuiting.
 *
 * Implements Axioms:
 * - A2 (Fail-closed): Pipeline execution immediately short-circuits on first failed stage.
 * - A3 (Physical evidence): Captures raw stdout, stderr, and exit codes directly from execution.
 */
export async function executeVerificationPipeline(
  input: VerificationPipelineInput,
): Promise<VerificationPipelineReport> {
  const { cwd, workflowId, stepId, steps } = input
  const stopOnFailure = input.stopOnFailure !== false

  if (steps.length === 0) {
    return {
      valid: true,
      allPassed: true,
      totalSteps: 0,
      passedCount: 0,
      failedCount: 0,
      skippedCount: 0,
      durationMs: 0,
      steps: [],
      formattedSummary: 'Empty verification pipeline: 0 steps evaluated.',
    }
  }

  const results: VerificationStepResult[] = []
  let allPassed = true
  let firstFailure: string | undefined
  let totalDurationMs = 0
  let isShortCircuited = false

  for (const step of steps) {
    if (isShortCircuited) {
      results.push({
        name: step.name,
        command: step.command,
        status: 'skipped',
        exitCode: null,
        durationMs: 0,
        stdout: '',
        stderr: '',
      })
      continue
    }

    const start = Date.now()
    try {
      const outcome = await runCommand({
        command: step.command,
        cwd,
        kind: 'tests',
        workflowId,
        stepId,
        timeoutMs: step.timeoutMs,
      })

      const elapsed = Date.now() - start
      totalDurationMs += elapsed

      const passed = evidencePassed(outcome)

      if (passed) {
        results.push({
          name: step.name,
          command: step.command,
          status: 'passed',
          exitCode: outcome.exitCode,
          durationMs: elapsed,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
        })
      } else {
        allPassed = false
        const status = outcome.outcome === 'timeout' ? 'timed_out' : 'failed'
        firstFailure ??= step.name
        results.push({
          name: step.name,
          command: step.command,
          status,
          exitCode: outcome.exitCode,
          durationMs: elapsed,
          stdout: outcome.stdout,
          stderr: outcome.stderr,
          error: outcome.failure ?? undefined,
        })

        if (stopOnFailure) {
          isShortCircuited = true
        }
      }
    } catch (err) {
      const elapsed = Date.now() - start
      totalDurationMs += elapsed
      allPassed = false
      firstFailure ??= step.name
      results.push({
        name: step.name,
        command: step.command,
        status: 'failed',
        exitCode: null,
        durationMs: elapsed,
        stdout: '',
        stderr: '',
        error: err instanceof Error ? err.message : String(err),
      })

      if (stopOnFailure) {
        isShortCircuited = true
      }
    }
  }

  const passedCount = results.filter((r) => r.status === 'passed').length
  const failedCount = results.filter(
    (r) => r.status === 'failed' || r.status === 'timed_out',
  ).length
  const skippedCount = results.filter((r) => r.status === 'skipped').length

  const lines: string[] = []
  lines.push('================================================================================')
  lines.push(`Verification Pipeline: ${allPassed ? 'PASSED' : 'FAILED'}`)
  lines.push(
    `Total: ${String(steps.length)} | Passed: ${String(passedCount)} | Failed: ${String(failedCount)} | Skipped: ${String(skippedCount)} | Duration: ${String(totalDurationMs)}ms`,
  )
  lines.push('================================================================================')
  for (const r of results) {
    const statusTag = r.status.toUpperCase().padEnd(9)
    const dur = `${String(r.durationMs)}ms`.padStart(8)
    lines.push(`  [${statusTag}] ${r.name.padEnd(20)} (${r.command}) ${dur}`)
    if (r.error) {
      lines.push(`    Error: ${r.error}`)
    }
  }
  lines.push('================================================================================')

  return {
    valid: true,
    allPassed,
    totalSteps: steps.length,
    passedCount,
    failedCount,
    skippedCount,
    durationMs: totalDurationMs,
    steps: results,
    failureStep: firstFailure,
    formattedSummary: lines.join('\n'),
  }
}

/**
 * Persists the verification pipeline report as an authoritative JSON evidence artifact on disk.
 */
export async function writeVerificationPipelineArtifact(
  artifactService: ArtifactService,
  runId: RunId,
  report: VerificationPipelineReport,
  stepId?: StepId,
): Promise<void> {
  await artifactService.writeArtifact({
    runId,
    stepId: stepId ?? null,
    kind: 'evidence',
    name: 'verification_pipeline_report.json',
    content: JSON.stringify(report, null, 2),
    mimeType: 'application/json',
  })
}
