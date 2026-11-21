import { describe, expect, it } from 'vitest'
import {
  AgentSubgoalCheckpointEngine,
  type SubgoalCheckpointInput,
} from './agentSubgoalCheckpointEngine'

describe('AgentSubgoalCheckpointEngine', () => {
  const sampleInput: SubgoalCheckpointInput = {
    runId: 'run-alpha',
    subgoalId: 'subgoal-123',
    phase: 'EXECUTION',
    stepIndex: 3,
    tasks: [
      { id: 'task-1', title: 'Parse ast', status: 'COMPLETED' },
      { id: 'task-2', title: 'Generate diff', status: 'COMPLETED' },
      { id: 'task-3', title: 'Run tests', status: 'PENDING' },
    ],
    workingMemorySnapshot: { focusedFile: 'src/main/core/index.ts' },
    completedTurnsCount: 8,
  }

  it('serializes subgoal execution state into versioned payload with valid checksum', () => {
    const engine = new AgentSubgoalCheckpointEngine({ version: 1, clock: () => 1700000000000 })
    const payload = engine.serialize(sampleInput)

    expect(payload.payloadVersion).toBe(1)
    expect(payload.checksum).toBeDefined()
    expect(payload.checksum).toHaveLength(64)
    expect(payload.data.runId).toBe('run-alpha')
    expect(payload.data.subgoalId).toBe('subgoal-123')
    expect(payload.data.stepIndex).toBe(3)
    expect(payload.data.tasks).toHaveLength(3)
  })

  it('deserializes and validates valid checkpoint cleanly', () => {
    const engine = new AgentSubgoalCheckpointEngine()
    const payload = engine.serialize(sampleInput)

    const checkpoint = engine.deserializeAndValidate(payload)
    expect(checkpoint.checkpointId).toBe(payload.data.checkpointId)
    expect(checkpoint.runId).toBe('run-alpha')
    expect(checkpoint.checksum).toBe(payload.checksum)
    expect(checkpoint.workingMemorySnapshot).toEqual({ focusedFile: 'src/main/core/index.ts' })
  })

  it('rejects corrupted or tampered payloads fail-closed', () => {
    const engine = new AgentSubgoalCheckpointEngine()
    const payload = engine.serialize(sampleInput)

    // Tamper with data without updating checksum
    const tampered = {
      ...payload,
      data: {
        ...payload.data,
        phase: 'TAMPERED_PHASE',
      },
    }

    expect(() => engine.deserializeAndValidate(tampered)).toThrow(/CHECKPOINT_TAMPERED/)
    expect(() => engine.deserializeAndValidate('not-valid-json')).toThrow(/CHECKPOINT_CORRUPTED/)
  })

  it('hydrates warm context correctly preserving completed and pending subtasks', () => {
    const engine = new AgentSubgoalCheckpointEngine()
    const payload = engine.serialize(sampleInput)
    const checkpoint = engine.deserializeAndValidate(payload)

    const warmContext = engine.hydrateWarmContext(checkpoint)
    expect(warmContext.resumedStepIndex).toBe(4) // 3 + 1
    expect(warmContext.completedCount).toBe(2)
    expect(warmContext.pendingCount).toBe(1)
    expect(warmContext.canResume).toBe(true)
    expect(warmContext.activeSubtasks).toHaveLength(1)
    expect(warmContext.activeSubtasks[0]?.id).toBe('task-3')
    expect(warmContext.promptContextNote).toContain('WARM SESSION RECOVERY')
  })

  it('formats human-readable summary', () => {
    const engine = new AgentSubgoalCheckpointEngine()
    const payload = engine.serialize(sampleInput)
    const checkpoint = engine.deserializeAndValidate(payload)

    const summary = engine.formatSummary(checkpoint)
    expect(summary).toContain('Subgoal Checkpoint')
    expect(summary).toContain('Run: run-alpha')
    expect(summary).toContain('Tasks (3): 2 completed, 1 remaining')
  })
})
