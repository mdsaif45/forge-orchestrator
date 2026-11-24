import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { ProjectId, RunId, RunRecord, StepId, StepRecord, TaskId } from '@shared/domain'
import type { RunStore } from '../db/runStore'
import { profileWorkflowExecution } from './profiler'

describe('profileWorkflowExecution', () => {
  const runId = randomUUID() as RunId
  const taskId = randomUUID() as TaskId
  const projectId = randomUUID() as ProjectId

  const mockRun: RunRecord = {
    id: runId,
    taskId,
    projectId,
    type: 'workflow',
    status: 'completed',
    startedAt: '2026-11-18T10:00:00.000Z',
    finishedAt: '2026-11-18T10:00:10.000Z',
    exitCode: 0,
    summary: 'Workflow finished',
    error: null,
    metadata: { templateId: 'feature' },
  }

  const step1: StepRecord = {
    id: randomUUID() as StepId,
    runId,
    index: 0,
    role: 'step-1-planner',
    runtimeId: null,
    status: 'completed',
    startedAt: '2026-11-18T10:00:00.000Z',
    finishedAt: '2026-11-18T10:00:02.000Z',
    summary: 'Plan completed',
    changeSetId: null,
    evidenceId: null,
  }

  const step2: StepRecord = {
    id: randomUUID() as StepId,
    runId,
    index: 1,
    role: 'step-2-implementer',
    runtimeId: null,
    status: 'completed',
    startedAt: '2026-11-18T10:00:02.000Z',
    finishedAt: '2026-11-18T10:00:08.000Z',
    summary: 'Implementation done',
    changeSetId: null,
    evidenceId: null,
  }

  const step3: StepRecord = {
    id: randomUUID() as StepId,
    runId,
    index: 2,
    role: 'step-3-reviewer',
    runtimeId: null,
    status: 'completed',
    startedAt: '2026-11-18T10:00:08.000Z',
    finishedAt: '2026-11-18T10:00:09.000Z',
    summary: 'Review feedback',
    changeSetId: null,
    evidenceId: null,
  }

  const step4: StepRecord = {
    id: randomUUID() as StepId,
    runId,
    index: 3,
    role: 'step-3-reviewer',
    runtimeId: null,
    status: 'completed',
    startedAt: '2026-11-18T10:00:09.000Z',
    finishedAt: '2026-11-18T10:00:10.000Z',
    summary: 'Review approved',
    changeSetId: null,
    evidenceId: null,
  }

  it('fails closed for non-existent runId', () => {
    const runStore = {
      getRun: vi.fn().mockReturnValue(null),
      listStepsForRun: vi.fn(),
    } as unknown as RunStore

    const report = profileWorkflowExecution(runStore, runId)
    expect(report.valid).toBe(false)
    expect(report.error).toContain('Run not found')
  })

  it('correctly calculates node latencies, bottleneck, and iteration counts', () => {
    const runStore = {
      getRun: vi.fn().mockReturnValue(mockRun),
      listStepsForRun: vi.fn().mockReturnValue([step1, step2, step3, step4]),
    } as unknown as RunStore

    const report = profileWorkflowExecution(runStore, runId)
    expect(report.valid).toBe(true)
    expect(report.totalDurationMs).toBe(10000)
    expect(report.nodeCount).toBe(4)
    expect(report.iterationCycles).toBe(2)
    expect(report.bottleneckNode?.nodeId).toBe('step-2-implementer')
    expect(report.bottleneckNode?.durationMs).toBe(6000)

    expect(report.nodes[0]?.durationMs).toBe(2000)
    expect(report.nodes[1]?.durationMs).toBe(6000)
    expect(report.nodes[2]?.durationMs).toBe(1000)
    expect(report.nodes[3]?.durationMs).toBe(1000)

    expect(report.formattedSummary).toContain('step-2-implementer')
    expect(report.formattedSummary).toContain('[BOTTLENECK]')
  })

  it('handles empty steps gracefully', () => {
    const runStore = {
      getRun: vi.fn().mockReturnValue(mockRun),
      listStepsForRun: vi.fn().mockReturnValue([]),
    } as unknown as RunStore

    const report = profileWorkflowExecution(runStore, runId)
    expect(report.valid).toBe(true)
    expect(report.nodeCount).toBe(0)
    expect(report.bottleneckNode).toBeNull()
  })
})
