import { describe, expect, it } from 'vitest'
import type { WorkflowTemplateV2 } from '@shared/domain'
import { validateTemplateGraph } from './validation'

describe('validateTemplateGraph', () => {
  it('validates a standard linear DAG template successfully', () => {
    const template: WorkflowTemplateV2 = {
      id: 'test-linear',
      name: 'Test Linear',
      description: 'Simple linear workflow',
      version: 1,
      status: 'published',
      category: 'Test',
      nodes: [
        {
          id: 'start',
          title: 'Start',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'developer', role: 'planner' },
          inputs: [],
          outputs: [],
        },
        {
          id: 'middle',
          title: 'Middle',
          type: 'agent',
          runtimeType: 'cli-agent',
          config: { skills: [], permissionMode: 'developer', role: 'implementer' },
          inputs: [],
          outputs: [],
        },
        {
          id: 'end',
          title: 'End',
          type: 'verification',
          runtimeType: 'forge-engine',
          config: { skills: [], permissionMode: 'read-only' },
          inputs: [],
          outputs: [],
        },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'middle' },
        { id: 'e2', source: 'middle', target: 'end' },
      ],
      createdAt: '2026-11-18T00:00:00Z',
      updatedAt: '2026-11-18T00:00:00Z',
    }

    const result = validateTemplateGraph(template)
    expect(result.valid).toBe(true)
    expect(result.errors).toHaveLength(0)
    expect(result.topologicalOrder).toEqual(['start', 'middle', 'end'])
    expect(result.metrics.nodeCount).toBe(3)
    expect(result.metrics.edgeCount).toBe(2)
    expect(result.metrics.terminalCount).toBe(1)
  })

  it('rejects a graph with a forward cycle', () => {
    const cyclicTemplate: WorkflowTemplateV2 = {
      id: 'test-cycle',
      name: 'Cyclic Graph',
      description: 'Contains a cycle',
      version: 1,
      status: 'published',
      category: 'Test',
      nodes: [
        {
          id: 'n1',
          title: 'Node 1',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'developer', role: 'planner' },
          inputs: [],
          outputs: [],
        },
        {
          id: 'n2',
          title: 'Node 2',
          type: 'agent',
          runtimeType: 'cli-agent',
          config: { skills: [], permissionMode: 'developer', role: 'implementer' },
          inputs: [],
          outputs: [],
        },
      ],
      edges: [
        { id: 'e1', source: 'n1', target: 'n2' },
        { id: 'e2', source: 'n2', target: 'n1' }, // forward cycle!
      ],
      createdAt: '2026-11-18T00:00:00Z',
      updatedAt: '2026-11-18T00:00:00Z',
    }

    const result = validateTemplateGraph(cyclicTemplate)
    expect(result.valid).toBe(false)
    expect(result.errors.some((e) => e.includes('Cycle detected') || e.includes('cycle'))).toBe(
      true,
    )
  })

  it('handles feedback edges and reports feedbackLoopCount', () => {
    const loopTemplate: WorkflowTemplateV2 = {
      id: 'test-loop',
      name: 'Loop Graph',
      description: 'Contains a feedback loop',
      version: 1,
      status: 'published',
      category: 'Test',
      nodes: [
        {
          id: 'implement',
          title: 'Implement',
          type: 'agent',
          runtimeType: 'cli-agent',
          config: { skills: [], permissionMode: 'developer', role: 'implementer' },
          inputs: [],
          outputs: [],
        },
        {
          id: 'review',
          title: 'Review Router',
          type: 'router',
          runtimeType: 'forge-engine',
          config: { skills: [], permissionMode: 'read-only' },
          inputs: [],
          outputs: [],
        },
        {
          id: 'done',
          title: 'Done Gate',
          type: 'user_gate',
          runtimeType: 'human',
          config: { skills: [], permissionMode: 'read-only' },
          inputs: [],
          outputs: [],
        },
      ],
      edges: [
        { id: 'e1', source: 'implement', target: 'review' },
        { id: 'e2', source: 'review', target: 'done', isDefault: true },
        {
          id: 'e-loop',
          source: 'review',
          target: 'implement',
          isFeedback: true,
          condition: {
            mode: 'all',
            predicates: [
              {
                ref: 'review.verdict',
                operator: 'eq',
                value: 'reject',
              },
            ],
          },
        },
      ],
      loopPolicy: {
        maxIterations: 3,
        maxRepeatedStates: 1,
        maxNodeAttempts: 5,
      },
      createdAt: '2026-11-18T00:00:00Z',
      updatedAt: '2026-11-18T00:00:00Z',
    }

    const result = validateTemplateGraph(loopTemplate)
    expect(result.valid).toBe(true)
    expect(result.metrics.feedbackLoopCount).toBe(1)
    expect(result.topologicalOrder).toEqual(['implement', 'review', 'done'])
  })

  it('rejects an invalid schema', () => {
    const invalid = { id: '', nodes: [] }
    const result = validateTemplateGraph(invalid)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
  })
})
