import { describe, it, expect } from 'vitest'
import { planTopologicalWaves, type WorkflowNodeDefinition } from './topologicalWavePlanner'

describe('TopologicalWavePlanner (WORK-025)', () => {
  it('handles empty graphs cleanly', () => {
    const res = planTopologicalWaves([])
    expect(res.totalWaves).toBe(0)
    expect(res.waves).toEqual([])
    expect(res.hasCycles).toBe(false)
  })

  it('partitions simple linear pipelines into 1-node waves', () => {
    const nodes: WorkflowNodeDefinition[] = [
      { id: 'build', dependencies: [] },
      { id: 'test', dependencies: ['build'] },
      { id: 'deploy', dependencies: ['test'] },
    ]

    const res = planTopologicalWaves(nodes)
    expect(res.totalWaves).toBe(3)
    expect(res.waves[0]?.nodeIds).toEqual(['build'])
    expect(res.waves[1]?.nodeIds).toEqual(['test'])
    expect(res.waves[2]?.nodeIds).toEqual(['deploy'])
    expect(res.maxParallelWidth).toBe(1)
    expect(res.criticalPath).toEqual(['build', 'test', 'deploy'])
  })

  it('detects parallel sibling branches and levelizes into concurrency waves', () => {
    // A -> B, A -> C, B -> D, C -> D, plus independent E
    const nodes: WorkflowNodeDefinition[] = [
      { id: 'A', dependencies: [] },
      { id: 'E', dependencies: [] },
      { id: 'B', dependencies: ['A'] },
      { id: 'C', dependencies: ['A'] },
      { id: 'D', dependencies: ['B', 'C'] },
    ]

    const res = planTopologicalWaves(nodes)
    expect(res.hasCycles).toBe(false)
    expect(res.totalWaves).toBe(3)

    // Wave 0: A and E have in-degree 0
    expect(res.waves[0]?.nodeIds).toEqual(['A', 'E'])
    // Wave 1: B and C unblocked once A completes
    expect(res.waves[1]?.nodeIds).toEqual(['B', 'C'])
    // Wave 2: D unblocked once B and C complete
    expect(res.waves[2]?.nodeIds).toEqual(['D'])

    expect(res.maxParallelWidth).toBe(2)
  })

  it('identifies and reports circular dependency cycles', () => {
    const nodes: WorkflowNodeDefinition[] = [
      { id: 'A', dependencies: ['C'] },
      { id: 'B', dependencies: ['A'] },
      { id: 'C', dependencies: ['B'] },
      { id: 'D', dependencies: [] },
    ]

    const res = planTopologicalWaves(nodes)
    expect(res.hasCycles).toBe(true)
    expect(res.cycleNodes).toContain('A')
    expect(res.cycleNodes).toContain('B')
    expect(res.cycleNodes).toContain('C')
    expect(res.formattedSummary).toContain('circular dependency cycle')
  })

  it('computes longest critical path based on node durations', () => {
    const nodes: WorkflowNodeDefinition[] = [
      { id: 'init', dependencies: [], estimatedDurationMs: 100 },
      { id: 'fast_path', dependencies: ['init'], estimatedDurationMs: 50 },
      { id: 'slow_path', dependencies: ['init'], estimatedDurationMs: 500 },
      { id: 'finish', dependencies: ['fast_path', 'slow_path'], estimatedDurationMs: 100 },
    ]

    const res = planTopologicalWaves(nodes)
    expect(res.criticalPath).toEqual(['init', 'slow_path', 'finish'])
  })
})
