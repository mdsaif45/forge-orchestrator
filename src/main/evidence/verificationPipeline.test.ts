import { describe, expect, it, vi, beforeEach } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { EvidenceId, RunId, StepId, WorkflowId } from '@shared/domain'
import type { ArtifactService } from '../artifacts'
import {
  executeVerificationPipeline,
  writeVerificationPipelineArtifact,
  type VerificationStepSpec,
} from './verificationPipeline'
import * as commandRunner from './commandRunner'

describe('executeVerificationPipeline', () => {
  const workflowId = randomUUID() as WorkflowId
  const stepId = randomUUID() as StepId
  const cwd = process.cwd()

  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it('runs all steps and reports success when all pass', async () => {
    vi.spyOn(commandRunner, 'runCommand').mockResolvedValue({
      id: randomUUID() as EvidenceId,
      workflowId,
      stepId,
      kind: 'tests',
      command: 'npm run lint',
      cwd,
      exitCode: 0,
      outcome: 'completed',
      stdout: 'All lint checks passed',
      stderr: '',
      truncated: false,
      failure: null,
      counts: null,
      durationMs: 100,
      recordedAt: new Date().toISOString(),
    })

    const steps: VerificationStepSpec[] = [
      { name: 'lint', command: 'npm run lint' },
      { name: 'typecheck', command: 'npm run typecheck' },
    ]

    const report = await executeVerificationPipeline({
      cwd,
      workflowId,
      stepId,
      steps,
    })

    expect(report.valid).toBe(true)
    expect(report.allPassed).toBe(true)
    expect(report.totalSteps).toBe(2)
    expect(report.passedCount).toBe(2)
    expect(report.failedCount).toBe(0)
    expect(report.skippedCount).toBe(0)
    expect(report.failureStep).toBeUndefined()
    expect(report.formattedSummary).toContain('PASSED')
  })

  it('short-circuits immediately on first failure (Fail-closed A2)', async () => {
    const runSpy = vi.spyOn(commandRunner, 'runCommand')
    runSpy.mockResolvedValueOnce({
      id: randomUUID() as EvidenceId,
      workflowId,
      stepId,
      kind: 'tests',
      command: 'npm run format:check',
      cwd,
      exitCode: 0,
      outcome: 'completed',
      stdout: 'Formatted cleanly',
      stderr: '',
      truncated: false,
      failure: null,
      counts: null,
      durationMs: 50,
      recordedAt: new Date().toISOString(),
    })
    runSpy.mockResolvedValueOnce({
      id: randomUUID() as EvidenceId,
      workflowId,
      stepId,
      kind: 'tests',
      command: 'npm run lint',
      cwd,
      exitCode: 1,
      outcome: 'completed',
      stdout: '',
      stderr: 'Lint error on line 42',
      truncated: false,
      failure: 'Lint failed with exit code 1',
      counts: null,
      durationMs: 80,
      recordedAt: new Date().toISOString(),
    })

    const steps: VerificationStepSpec[] = [
      { name: 'format', command: 'npm run format:check' },
      { name: 'lint', command: 'npm run lint' },
      { name: 'test', command: 'npm test' },
    ]

    const report = await executeVerificationPipeline({
      cwd,
      workflowId,
      stepId,
      steps,
      stopOnFailure: true,
    })

    expect(report.valid).toBe(true)
    expect(report.allPassed).toBe(false)
    expect(report.passedCount).toBe(1)
    expect(report.failedCount).toBe(1)
    expect(report.skippedCount).toBe(1)
    expect(report.failureStep).toBe('lint')
    expect(report.steps[2]?.status).toBe('skipped')
    expect(runSpy).toHaveBeenCalledTimes(2) // 3rd step was not run!
  })

  it('handles empty steps gracefully', async () => {
    const report = await executeVerificationPipeline({
      cwd,
      workflowId,
      stepId,
      steps: [],
    })
    expect(report.valid).toBe(true)
    expect(report.allPassed).toBe(true)
    expect(report.totalSteps).toBe(0)
  })

  it('writes verification pipeline artifact using ArtifactService', async () => {
    const writeArtifact = vi.fn().mockResolvedValue({ id: 'art-1' })
    const mockService = {
      writeArtifact,
    } as unknown as ArtifactService

    const runId = randomUUID() as RunId
    const report = await executeVerificationPipeline({
      cwd,
      workflowId,
      stepId,
      steps: [],
    })

    await writeVerificationPipelineArtifact(mockService, runId, report, stepId)

    expect(writeArtifact).toHaveBeenCalledWith({
      runId,
      stepId,
      kind: 'evidence',
      name: 'verification_pipeline_report.json',
      content: JSON.stringify(report, null, 2),
      mimeType: 'application/json',
    })
  })
})
