import { describe, expect, it } from 'vitest'
import {
  compileLinearTemplateToGraph,
  FEATURE_IMPLEMENTATION,
  type WorkflowTemplateV2,
} from '@shared/domain'
import { planWorkflowExecution } from './planner'

describe('planWorkflowExecution', () => {
  it('computes topological stages and ASCII diagram for compiled FEATURE_IMPLEMENTATION', () => {
    const template = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const plan = planWorkflowExecution(template)

    expect(plan.valid).toBe(true)
    expect(plan.templateId).toBe('compiled-feature')
    expect(plan.totalNodes).toBe(5)
    expect(plan.stageCount).toBe(5)
    expect(plan.stages).toHaveLength(5)

    // Stage order: step-1-planner -> step-2-user -> step-3-implementer -> step-4-system -> step-5-reviewer
    expect(plan.stages[0]?.nodeIds).toEqual(['step-1-planner'])
    expect(plan.stages[1]?.nodeIds).toEqual(['step-2-user'])
    expect(plan.stages[2]?.nodeIds).toEqual(['step-3-implementer'])
    expect(plan.stages[3]?.nodeIds).toEqual(['step-4-system'])
    expect(plan.stages[4]?.nodeIds).toEqual(['step-5-reviewer'])

    // Reviewer node has feedback loop to implementer
    const reviewerNode = plan.nodes.find((n) => n.id === 'step-5-reviewer')
    expect(reviewerNode).toBeDefined()
    expect(reviewerNode!.feedbackTargets).toContain('step-3-implementer')

    // Diagram contains template info and stages
    expect(plan.asciiDiagram).toContain('Workflow Execution Plan: compiled-feature')
    expect(plan.asciiDiagram).toContain('[Stage 0]')
    expect(plan.asciiDiagram).toContain('[Stage 4]')
    expect(plan.asciiDiagram).toContain('──(feedback)──> step-3-implementer')
  })

  it('rejects invalid schema template gracefully', () => {
    const plan = planWorkflowExecution({ id: 123, invalid: true })
    expect(plan.valid).toBe(false)
    expect(plan.errors).toBeDefined()
    expect(plan.errors!.length).toBeGreaterThan(0)
    expect(plan.asciiDiagram).toContain('schema validation failed')
  })

  it('detects forward cycles and fails closed', () => {
    const cyclicTemplate: WorkflowTemplateV2 = {
      id: 'cyclic-dag',
      name: 'Cyclic DAG',
      description: 'Test Cyclic DAG',
      version: 1,
      status: 'published',
      category: 'Test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [
        {
          id: 'node-a',
          title: 'Node A',
          type: 'agent',
          runtimeType: 'cli-agent',
          inputs: [],
          outputs: [],
          config: { skills: [], permissionMode: 'developer' },
        },
        {
          id: 'node-b',
          title: 'Node B',
          type: 'agent',
          runtimeType: 'cli-agent',
          inputs: [],
          outputs: [],
          config: { skills: [], permissionMode: 'developer' },
        },
      ],
      edges: [
        {
          id: 'e1',
          source: 'node-a',
          target: 'node-b',
          isFeedback: false,
        },
        {
          id: 'e2',
          source: 'node-b',
          target: 'node-a',
          isFeedback: false,
        },
      ],
    }

    const plan = planWorkflowExecution(cyclicTemplate)
    expect(plan.valid).toBe(false)
    expect(plan.errors).toContain('Cycle detected in forward execution graph.')
  })

  it('correctly handles parallel branches at the same stage', () => {
    const parallelTemplate: WorkflowTemplateV2 = {
      id: 'parallel-dag',
      name: 'Parallel Branches',
      description: 'Test Parallel Branches',
      version: 1,
      status: 'published',
      category: 'Test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [
        {
          id: 'start',
          title: 'Start',
          type: 'agent',
          runtimeType: 'cli-agent',
          inputs: [],
          outputs: [],
          config: { skills: [], permissionMode: 'developer' },
        },
        {
          id: 'branch-1',
          title: 'Branch 1',
          type: 'agent',
          runtimeType: 'cli-agent',
          inputs: [],
          outputs: [],
          config: { skills: [], permissionMode: 'developer' },
        },
        {
          id: 'branch-2',
          title: 'Branch 2',
          type: 'agent',
          runtimeType: 'cli-agent',
          inputs: [],
          outputs: [],
          config: { skills: [], permissionMode: 'developer' },
        },
        {
          id: 'merge',
          title: 'Merge',
          type: 'verification',
          runtimeType: 'forge-engine',
          inputs: [],
          outputs: [],
          config: { skills: [], permissionMode: 'read-only' },
        },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'branch-1', isFeedback: false },
        { id: 'e2', source: 'start', target: 'branch-2', isFeedback: false },
        { id: 'e3', source: 'branch-1', target: 'merge', isFeedback: false },
        { id: 'e4', source: 'branch-2', target: 'merge', isFeedback: false },
      ],
    }

    const plan = planWorkflowExecution(parallelTemplate)
    expect(plan.valid).toBe(true)
    expect(plan.stageCount).toBe(3)
    expect(plan.stages[0]?.nodeIds).toEqual(['start'])
    expect(plan.stages[1]?.nodeIds).toEqual(['branch-1', 'branch-2'])
    expect(plan.stages[2]?.nodeIds).toEqual(['merge'])
  })
})
