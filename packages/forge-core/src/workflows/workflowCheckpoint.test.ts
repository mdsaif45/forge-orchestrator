import { describe, expect, it } from 'vitest'
import {
  createWorkflowCheckpoint,
  planWorkflowResume,
  type WorkflowDAG,
} from './workflowCheckpoint'

describe('workflowCheckpoint (WORK-019)', () => {
  const sampleDAG: WorkflowDAG = {
    id: 'build-and-test',
    name: 'Build & Test Pipeline',
    nodes: [
      { id: 'lint' },
      { id: 'typecheck' },
      { id: 'unit-tests', dependencies: ['typecheck'] },
      { id: 'e2e-tests', dependencies: ['lint', 'unit-tests'] },
    ],
  }

  it('creates an immutable checkpoint with cryptographic checksum', () => {
    const checkpoint = createWorkflowCheckpoint('run-123', sampleDAG, ['lint', 'typecheck'], {
      lint: { passed: true },
      typecheck: { passed: true },
    })

    expect(checkpoint.runId).toBe('run-123')
    expect(checkpoint.graphId).toBe('build-and-test')
    expect(checkpoint.completedNodeIds).toEqual(['lint', 'typecheck'])
    expect(typeof checkpoint.checksum).toBe('string')
    expect(checkpoint.checksum.length).toBe(64)
  })

  it('plans DAG resumption identifying frontier nodes ready to execute', () => {
    const checkpoint = createWorkflowCheckpoint('run-123', sampleDAG, ['lint', 'typecheck'])
    const plan = planWorkflowResume(checkpoint, sampleDAG)

    expect(plan.valid).toBe(true)
    expect(plan.completedCount).toBe(2)
    expect(plan.pendingCount).toBe(2)
    // 'unit-tests' requires 'typecheck' (which is done), so it is on the frontier
    // 'e2e-tests' requires 'lint' AND 'unit-tests' (not done), so it is not on the frontier
    expect(plan.pendingFrontierNodeIds).toEqual(['unit-tests'])
    expect(plan.remainingNodeIds).toEqual(['unit-tests', 'e2e-tests'])
  })

  it('fails closed when checkpoint checksum is corrupted or modified (A2)', () => {
    const checkpoint = createWorkflowCheckpoint('run-123', sampleDAG, ['lint'])
    const tampered = {
      ...checkpoint,
      checksum: 'bad-checksum-000000000000000000000000000000000000000000000000000000000',
    }

    const plan = planWorkflowResume(tampered, sampleDAG)
    expect(plan.valid).toBe(false)
    expect(plan.error).toContain('checksum mismatch')
  })

  it('fails closed when checkpoint references node not in DAG', () => {
    const checkpoint = createWorkflowCheckpoint('run-123', sampleDAG, ['unknown-node'])
    const plan = planWorkflowResume(checkpoint, sampleDAG)
    expect(plan.valid).toBe(false)
    expect(plan.error).toContain('references unknown node')
  })
})
