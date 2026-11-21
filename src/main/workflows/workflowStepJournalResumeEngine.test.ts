import { describe, it, expect } from 'vitest'
import {
  WorkflowStepJournalResumeEngine,
  type NodeDefinitionForResume,
} from './workflowStepJournalResumeEngine'

describe('WorkflowStepJournalResumeEngine (WORK-034)', () => {
  it('records step executions with deterministic input digests', () => {
    const engine = new WorkflowStepJournalResumeEngine()

    const rec = engine.recordStepExecution({
      runId: 'run-1',
      stepId: 'step-build',
      idempotencyKey: 'idem-build-1',
      status: 'COMPLETED',
      inputData: { compiler: 'tsc', target: 'es2022' },
      outputData: { exitCode: 0, artifactsGenerated: 5 },
      durationMs: 120,
    })

    expect(rec.runId).toBe('run-1')
    expect(rec.stepId).toBe('step-build')
    expect(rec.inputDigest).toHaveLength(64)
    expect(rec.outputData).toEqual({ exitCode: 0, artifactsGenerated: 5 })

    const found = engine.getStepRecord('run-1', 'step-build')
    expect(found).not.toBeNull()
    expect(found?.durationMs).toBe(120)
  })

  it('generates a resume plan that replays completed steps and schedules new ones', () => {
    const engine = new WorkflowStepJournalResumeEngine()

    engine.recordStepExecution({
      runId: 'run-resume',
      stepId: 'step-1',
      idempotencyKey: 'k1',
      status: 'COMPLETED',
      inputData: { param: 'alpha' },
      outputData: { result: 'done-1' },
    })

    engine.recordStepExecution({
      runId: 'run-resume',
      stepId: 'step-2',
      idempotencyKey: 'k2',
      status: 'FAILED',
      inputData: { param: 'beta' },
    })

    const nodes: NodeDefinitionForResume[] = [
      { id: 'step-1', idempotencyKey: 'k1', inputData: { param: 'alpha' } },
      { id: 'step-2', idempotencyKey: 'k2', inputData: { param: 'beta' } },
      { id: 'step-3', idempotencyKey: 'k3', inputData: { param: 'gamma' } },
    ]

    const plan = engine.evaluateResumePlan('run-resume', nodes)

    expect(plan.totalNodes).toBe(3)
    expect(plan.replayedNodesCount).toBe(1)
    expect(plan.nodesToExecuteCount).toBe(2)
    expect(plan.isFullyResumable).toBe(true)

    expect(plan.steps[0]).toEqual({
      stepId: 'step-1',
      action: 'REPLAY_OUTPUT',
      reason: 'Step previously succeeded with matching input digest and idempotency key',
      replayData: { result: 'done-1' },
    })

    expect(plan.steps[1]?.action).toBe('EXECUTE')
    expect(plan.steps[1]?.reason).toContain('Previous execution was not completed')

    expect(plan.steps[2]?.action).toBe('EXECUTE')
    expect(plan.steps[2]?.reason).toContain('Step has no prior execution record')
  })

  it('invalidates replay and forces execution when input data has changed', () => {
    const engine = new WorkflowStepJournalResumeEngine()

    engine.recordStepExecution({
      runId: 'run-drift',
      stepId: 'step-deploy',
      idempotencyKey: 'k-deploy',
      status: 'COMPLETED',
      inputData: { env: 'staging', version: '1.0.0' },
      outputData: { deployed: true },
    })

    const nodes: NodeDefinitionForResume[] = [
      {
        id: 'step-deploy',
        idempotencyKey: 'k-deploy',
        inputData: { env: 'staging', version: '1.0.1' }, // Changed input
      },
    ]

    const plan = engine.evaluateResumePlan('run-drift', nodes)
    expect(plan.replayedNodesCount).toBe(0)
    expect(plan.nodesToExecuteCount).toBe(1)
    expect(plan.steps[0]?.action).toBe('EXECUTE')
    expect(plan.steps[0]?.reason).toContain('Step input data has changed')
  })

  it('invalidates replay when idempotency key mismatches', () => {
    const engine = new WorkflowStepJournalResumeEngine()

    engine.recordStepExecution({
      runId: 'run-key',
      stepId: 'step-auth',
      idempotencyKey: 'old-key',
      status: 'COMPLETED',
      inputData: { role: 'admin' },
    })

    const nodes: NodeDefinitionForResume[] = [
      { id: 'step-auth', idempotencyKey: 'new-key', inputData: { role: 'admin' } },
    ]

    const plan = engine.evaluateResumePlan('run-key', nodes)
    expect(plan.steps[0]?.action).toBe('EXECUTE')
    expect(plan.steps[0]?.reason).toContain('Idempotency key changed')
  })

  it('clears run journal records cleanly', () => {
    const engine = new WorkflowStepJournalResumeEngine()

    engine.recordStepExecution({
      runId: 'run-purge',
      stepId: 'step-1',
      idempotencyKey: 'k1',
      status: 'COMPLETED',
      inputData: null,
    })

    expect(engine.listStepRecords('run-purge')).toHaveLength(1)
    engine.clearRunJournal('run-purge')
    expect(engine.listStepRecords('run-purge')).toHaveLength(0)
  })
})
