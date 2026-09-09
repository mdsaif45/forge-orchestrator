import { describe, expect, it } from 'vitest'
import {
  getReadyNodes,
  getTopologicalSort,
  validateWorkflowGraph,
  WorkflowGraphCycleError,
  workflowNodeSchema,
  workflowTemplateV2Schema,
  type WorkflowEdge,
  type WorkflowNode,
} from './workflowGraph'

describe('workflowGraph domain model', () => {
  it('parses valid node schemas with slots and runtime configs', () => {
    const node = workflowNodeSchema.parse({
      id: 'agent-1',
      title: 'Requirements Analyst',
      templateId: 'requirements-analyst',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: {
        agentExecutable: 'claude',
        systemPrompt: 'Analyze user requirements carefully.',
        skills: ['sdlc-analysis'],
        permissionMode: 'developer',
      },
      inputs: [
        {
          name: 'raw_prompt',
          kind: 'user_prompt',
          required: true,
        },
      ],
      outputs: [
        {
          name: 'spec',
          kind: 'final_specification',
          format: 'markdown',
          requiredH1: '# Software Requirements Specification',
          requiredSections: ['1. Overview', '2. Functional Requirements'],
        },
      ],
      position: { x: 100, y: 150 },
    })

    expect(node.id).toBe('agent-1')
    expect(node.outputs[0]?.kind).toBe('final_specification')
    expect(node.outputs[0]?.requiredSections).toHaveLength(2)
  })

  it('parses full template V2 with nodes and edges', () => {
    const template = workflowTemplateV2Schema.parse({
      id: 'cr-sdlc',
      name: 'CR SDLC (Planning -> HLD -> LLD)',
      description: 'Multi-stage engineering pipeline grounded in codebase evidence',
      version: 1,
      status: 'published',
      category: 'Software Engineering',
      nodes: [
        {
          id: 'node-analyst',
          title: 'Requirements Analyst',
          type: 'agent',
          runtimeType: 'forge-native',
          config: {
            providerId: 'ollama',
            modelId: 'qwen2.5',
            skills: ['requirements'],
            permissionMode: 'read-only',
          },
          outputs: [{ name: 'out', kind: 'final_specification', format: 'markdown' }],
        },
        {
          id: 'node-architect',
          title: 'Solution Architect',
          type: 'agent',
          runtimeType: 'cli-agent',
          config: {
            agentExecutable: 'claude',
            skills: ['architecture'],
            permissionMode: 'developer',
          },
          inputs: [{ name: 'spec', kind: 'final_specification', required: true }],
          outputs: [{ name: 'hld', kind: 'solution_architecture', format: 'markdown' }],
        },
      ],
      edges: [
        {
          id: 'edge-1',
          source: 'node-analyst',
          sourceHandle: 'out',
          target: 'node-architect',
          targetHandle: 'spec',
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })

    expect(template.id).toBe('cr-sdlc')
    expect(template.nodes).toHaveLength(2)
    expect(template.edges).toHaveLength(1)
  })

  it('computes topological sort for DAG', () => {
    const nodes: WorkflowNode[] = [
      {
        id: 'A',
        title: 'Node A',
        type: 'agent',
        runtimeType: 'forge-native',
        config: { skills: [], permissionMode: 'developer' },
        inputs: [],
        outputs: [],
      },
      {
        id: 'B',
        title: 'Node B',
        type: 'agent',
        runtimeType: 'forge-native',
        config: { skills: [], permissionMode: 'developer' },
        inputs: [],
        outputs: [],
      },
      {
        id: 'C',
        title: 'Node C',
        type: 'agent',
        runtimeType: 'forge-native',
        config: { skills: [], permissionMode: 'developer' },
        inputs: [],
        outputs: [],
      },
    ]

    const edges: WorkflowEdge[] = [
      { id: 'e1', source: 'A', target: 'B' },
      { id: 'e2', source: 'B', target: 'C' },
    ]

    const order = getTopologicalSort(nodes, edges)
    expect(order).toEqual(['A', 'B', 'C'])
  })

  it('detects cycles and throws WorkflowGraphCycleError', () => {
    const nodes: WorkflowNode[] = [
      {
        id: 'A',
        title: 'Node A',
        type: 'agent',
        runtimeType: 'forge-native',
        config: { skills: [], permissionMode: 'developer' },
        inputs: [],
        outputs: [],
      },
      {
        id: 'B',
        title: 'Node B',
        type: 'agent',
        runtimeType: 'forge-native',
        config: { skills: [], permissionMode: 'developer' },
        inputs: [],
        outputs: [],
      },
    ]

    const edges: WorkflowEdge[] = [
      { id: 'e1', source: 'A', target: 'B' },
      { id: 'e2', source: 'B', target: 'A' },
    ]

    expect(() => {
      validateWorkflowGraph(nodes, edges)
    }).toThrow(WorkflowGraphCycleError)
  })

  it('throws error when edge references non-existent node', () => {
    const nodes: WorkflowNode[] = [
      {
        id: 'A',
        title: 'Node A',
        type: 'agent',
        runtimeType: 'forge-native',
        config: { skills: [], permissionMode: 'developer' },
        inputs: [],
        outputs: [],
      },
    ]

    const edges: WorkflowEdge[] = [{ id: 'e1', source: 'A', target: 'UNKNOWN' }]

    expect(() => {
      validateWorkflowGraph(nodes, edges)
    }).toThrow('Edge "e1" references missing target node "UNKNOWN"')
  })

  it('identifies ready nodes based on completed dependency set', () => {
    const nodes: WorkflowNode[] = [
      {
        id: 'A',
        title: 'A',
        type: 'agent',
        runtimeType: 'forge-native',
        config: { skills: [], permissionMode: 'developer' },
        inputs: [],
        outputs: [],
      },
      {
        id: 'B1',
        title: 'B1',
        type: 'agent',
        runtimeType: 'forge-native',
        config: { skills: [], permissionMode: 'developer' },
        inputs: [],
        outputs: [],
      },
      {
        id: 'B2',
        title: 'B2',
        type: 'agent',
        runtimeType: 'forge-native',
        config: { skills: [], permissionMode: 'developer' },
        inputs: [],
        outputs: [],
      },
      {
        id: 'C',
        title: 'C',
        type: 'agent',
        runtimeType: 'forge-native',
        config: { skills: [], permissionMode: 'developer' },
        inputs: [],
        outputs: [],
      },
    ]

    const edges: WorkflowEdge[] = [
      { id: 'e1', source: 'A', target: 'B1' },
      { id: 'e2', source: 'A', target: 'B2' },
      { id: 'e3', source: 'B1', target: 'C' },
      { id: 'e4', source: 'B2', target: 'C' },
    ]

    // Initially, only A is ready
    let ready = getReadyNodes(nodes, edges, new Set())
    expect(ready.map((n) => n.id)).toEqual(['A'])

    // Once A is completed, both B1 and B2 become ready in parallel
    ready = getReadyNodes(nodes, edges, new Set(['A']))
    expect(ready.map((n) => n.id)).toEqual(['B1', 'B2'])

    // When only B1 is completed, C is NOT ready yet because B2 is still pending
    ready = getReadyNodes(nodes, edges, new Set(['A', 'B1']))
    expect(ready.map((n) => n.id)).toEqual(['B2'])

    // Once both B1 and B2 are completed, C becomes ready
    ready = getReadyNodes(nodes, edges, new Set(['A', 'B1', 'B2']))
    expect(ready.map((n) => n.id)).toEqual(['C'])

    // When all are completed, no nodes are ready
    ready = getReadyNodes(nodes, edges, new Set(['A', 'B1', 'B2', 'C']))
    expect(ready).toHaveLength(0)
  })
})
