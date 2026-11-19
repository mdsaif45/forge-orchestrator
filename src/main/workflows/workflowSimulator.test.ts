import { describe, it, expect } from 'vitest'
import { simulateWorkflowExecution, type WorkflowSimulationDAG } from './workflowSimulator'

describe('Workflow DAG Execution Simulator & Critical Path Analyzer (WORK-020)', () => {
  it('fails closed when DAG contains no nodes', () => {
    const report = simulateWorkflowExecution({ id: 'empty-dag', nodes: [] })
    expect(report.valid).toBe(false)
    expect(report.error).toContain('DAG contains no nodes')
  })

  it('fails closed when DAG contains cycles', () => {
    const dag: WorkflowSimulationDAG = {
      id: 'cyclic-dag',
      nodes: [
        { id: 'nodeA', dependencies: ['nodeB'] },
        { id: 'nodeB', dependencies: ['nodeA'] },
      ],
    }

    const report = simulateWorkflowExecution(dag)
    expect(report.valid).toBe(false)
    expect(report.error).toContain('Cycle detected')
  })

  it('fails closed when DAG references missing dependencies', () => {
    const dag: WorkflowSimulationDAG = {
      id: 'broken-dag',
      nodes: [{ id: 'nodeA', dependencies: ['missingNode'] }],
    }

    const report = simulateWorkflowExecution(dag)
    expect(report.valid).toBe(false)
    expect(report.error).toContain('Missing dependency')
  })

  it('simulates linear and parallel DAGs calculating accurate critical path and stage concurrency', () => {
    const dag: WorkflowSimulationDAG = {
      id: 'feature-pipeline',
      nodes: [
        { id: 'plan', estimatedDurationMs: 500 },
        { id: 'workerA', estimatedDurationMs: 1000, dependencies: ['plan'] },
        { id: 'workerB', estimatedDurationMs: 2000, dependencies: ['plan'] },
        { id: 'review', estimatedDurationMs: 800, dependencies: ['workerA', 'workerB'] },
      ],
    }

    const report = simulateWorkflowExecution(dag)
    expect(report.valid).toBe(true)
    expect(report.totalNodes).toBe(4)
    // Stages: [plan], [workerA, workerB], [review] = 3 stages
    expect(report.parallelStages.length).toBe(3)
    expect(report.maxConcurrentWorkers).toBe(2)
    // Critical path: plan (500) -> workerB (2000) -> review (800) = 3300ms
    expect(report.criticalPathDurationMs).toBe(3300)
    expect(report.criticalPathNodeIds).toEqual(['plan', 'workerB', 'review'])

    const workerANode = report.nodes.find((n) => n.id === 'workerA')
    const workerBNode = report.nodes.find((n) => n.id === 'workerB')
    expect(workerANode?.isCriticalPath).toBe(false)
    expect(workerBNode?.isCriticalPath).toBe(true)
  })
})
