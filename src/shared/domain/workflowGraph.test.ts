import { describe, expect, it } from 'vitest'
import {
  getReadyNodes,
  getTopologicalSort,
  getLoopBody,
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

  it('allows feedback edges without causing forward DAG cycle errors', () => {
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

    // Forward path: A -> B -> C. Feedback path: C -> B (isFeedback: true)
    const edges: WorkflowEdge[] = [
      { id: 'e1', source: 'A', target: 'B' },
      { id: 'e2', source: 'B', target: 'C' },
      { id: 'feedback-1', source: 'C', target: 'B', isFeedback: true },
    ]

    expect(() => {
      validateWorkflowGraph(nodes, edges)
    }).not.toThrow()
    const sort = getTopologicalSort(nodes, edges)
    expect(sort).toEqual(['A', 'B', 'C'])

    // getReadyNodes should ignore feedback edges so B is not blocked by C initially
    const readyInitial = getReadyNodes(nodes, edges, new Set())
    expect(readyInitial.map((n) => n.id)).toEqual(['A'])

    const readyAfterA = getReadyNodes(nodes, edges, new Set(['A']))
    expect(readyAfterA.map((n) => n.id)).toEqual(['B'])
  })

  it('rejects feedback edges targeting a node that does not precede the source topologically', () => {
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

    // Forward path: A -> B. Feedback path claiming A -> B (forward direction!)
    const edges: WorkflowEdge[] = [
      { id: 'e1', source: 'A', target: 'B' },
      { id: 'invalid-fb', source: 'A', target: 'B', isFeedback: true },
    ]

    expect(() => {
      validateWorkflowGraph(nodes, edges)
    }).toThrow(
      /Feedback edge "invalid-fb" targets node "B" which does not precede source node "A" topologically/i,
    )
  })
})

describe('getLoopBody (WORK-003 Slice 2B Pure Helper)', () => {
  const makeNode = (id: string, type: 'agent' | 'router' = 'agent'): WorkflowNode => ({
    id,
    title: id,
    type,
    runtimeType: type === 'router' ? 'forge-engine' : 'forge-native',
    config: { skills: [], permissionMode: type === 'router' ? 'read-only' : 'developer' },
    inputs: [],
    outputs: [],
  })

  it('computes exact loop body for a linear loop A -> B -> C -> B', () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C')]
    const edges: WorkflowEdge[] = [
      { id: 'e1', source: 'A', target: 'B' },
      { id: 'e2', source: 'B', target: 'C' },
      { id: 'fb', source: 'C', target: 'B', isFeedback: true },
    ]

    const loopBody = getLoopBody(nodes, edges, 'C', 'B')
    expect(Array.from(loopBody).sort()).toEqual(['B', 'C'])
    expect(loopBody.has('A')).toBe(false)
  })

  it('computes exact loop body for a diamond loop B -> (D1, D2) -> C -> B', () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('D1'), makeNode('D2'), makeNode('C')]
    const edges: WorkflowEdge[] = [
      { id: 'e1', source: 'A', target: 'B' },
      { id: 'e2', source: 'B', target: 'D1' },
      { id: 'e3', source: 'B', target: 'D2' },
      { id: 'e4', source: 'D1', target: 'C' },
      { id: 'e5', source: 'D2', target: 'C' },
      { id: 'fb', source: 'C', target: 'B', isFeedback: true },
    ]

    const loopBody = getLoopBody(nodes, edges, 'C', 'B')
    expect(Array.from(loopBody).sort()).toEqual(['B', 'C', 'D1', 'D2'])
    expect(loopBody.has('A')).toBe(false)
  })

  it('excludes branches reachable from target that cannot reach source', () => {
    const nodes = [makeNode('B'), makeNode('C'), makeNode('ExitBranch')]
    const edges: WorkflowEdge[] = [
      { id: 'e1', source: 'B', target: 'C' },
      { id: 'e2', source: 'B', target: 'ExitBranch' },
      { id: 'fb', source: 'C', target: 'B', isFeedback: true },
    ]

    const loopBody = getLoopBody(nodes, edges, 'C', 'B')
    expect(Array.from(loopBody).sort()).toEqual(['B', 'C'])
    expect(loopBody.has('ExitBranch')).toBe(false)
  })

  it('returns empty set if target cannot reach source in forward graph', () => {
    const nodes = [makeNode('B'), makeNode('C')]
    const edges: WorkflowEdge[] = [{ id: 'fb', source: 'C', target: 'B', isFeedback: true }]

    const loopBody = getLoopBody(nodes, edges, 'C', 'B')
    expect(loopBody.size).toBe(0)
  })
})

describe('WORK-003 Slice 2B Static Topology Validation', () => {
  const makeNode = (id: string, type: 'agent' | 'router' = 'agent'): WorkflowNode => ({
    id,
    title: id,
    type,
    runtimeType: type === 'router' ? 'forge-engine' : 'forge-native',
    config: { skills: [], permissionMode: type === 'router' ? 'read-only' : 'developer' },
    inputs: [],
    outputs: [],
  })

  // TC-2B-VAL-01: valid feedback loop + exit
  it('TC-2B-VAL-01: passes validation for valid feedback loop with forward exit', () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('R', 'router'), makeNode('Exit')]
    const edges: WorkflowEdge[] = [
      { id: 'e-ab', source: 'A', target: 'B' },
      { id: 'e-br', source: 'B', target: 'R' },
      {
        id: 'e-fb',
        source: 'R',
        target: 'B',
        isFeedback: true,
        condition: {
          mode: 'all',
          predicates: [{ ref: 'context.retry', operator: 'eq', value: 'true' }],
        },
      },
      { id: 'e-exit', source: 'R', target: 'Exit', isDefault: true },
    ]

    expect(() => {
      validateWorkflowGraph(nodes, edges)
    }).not.toThrow()
  })

  // TC-2B-VAL-02: self-loop rejected
  it('TC-2B-VAL-02: rejects self-loop feedback edge', () => {
    const nodes = [makeNode('A')]
    const edges: WorkflowEdge[] = [{ id: 'self-fb', source: 'A', target: 'A', isFeedback: true }]

    expect(() => {
      validateWorkflowGraph(nodes, edges)
    }).toThrow('Feedback edge "self-fb" cannot target itself ("A")')
  })

  // TC-2B-VAL-03: invalid topological direction rejected
  it('TC-2B-VAL-03: rejects feedback edge targeting a node that does not precede source', () => {
    const nodes = [makeNode('A'), makeNode('B')]
    const edges: WorkflowEdge[] = [
      { id: 'e-ab', source: 'A', target: 'B' },
      { id: 'bad-fb', source: 'A', target: 'B', isFeedback: true },
    ]

    expect(() => {
      validateWorkflowGraph(nodes, edges)
    }).toThrow(
      'Feedback edge "bad-fb" targets node "B" which does not precede source node "A" topologically',
    )
  })

  // TC-2B-VAL-04: empty/infinite topology rejected (target cannot reach source in forward graph)
  it('TC-2B-VAL-04: rejects feedback edge with empty loop body where target cannot reach source', () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C')]
    // A -> B and separate node C, feedback from C -> A where C cannot be reached from A
    const edges: WorkflowEdge[] = [
      { id: 'e-ab', source: 'A', target: 'B' },
      { id: 'bad-fb', source: 'C', target: 'A', isFeedback: true },
    ]

    expect(() => {
      validateWorkflowGraph(nodes, edges)
    }).toThrow(
      'Feedback edge "bad-fb" from "C" to "A" does not form a valid loop body; target cannot reach source in forward graph',
    )
  })

  // TC-2B-VAL-05: nested loop rejected
  it('TC-2B-VAL-05: rejects nested loops where one loop body is subset of another', () => {
    const nodes = [makeNode('A'), makeNode('B'), makeNode('C'), makeNode('D')]
    // Outer: B -> C -> D -> B
    // Inner: C -> D -> C (nested!)
    const edges: WorkflowEdge[] = [
      { id: 'e-ab', source: 'A', target: 'B' },
      { id: 'e-bc', source: 'B', target: 'C' },
      { id: 'e-cd', source: 'C', target: 'D' },
      { id: 'fb-outer', source: 'D', target: 'B', isFeedback: true },
      { id: 'fb-inner', source: 'D', target: 'C', isFeedback: true },
    ]

    expect(() => {
      validateWorkflowGraph(nodes, edges)
    }).toThrow(
      'Nested loops are not supported in workflow graph: feedback edge "fb-outer" nests with "fb-inner"',
    )
  })

  // TC-2B-VAL-06: overlapping loop rejected
  it('TC-2B-VAL-06: rejects overlapping loops with distinct heads that share intermediate nodes', () => {
    const nodes = [
      makeNode('B1'),
      makeNode('B2'),
      makeNode('Shared'),
      makeNode('S1'),
      makeNode('S2'),
    ]
    // Loop 1: B1 -> Shared -> S1 -> B1
    // Loop 2: B2 -> Shared -> S2 -> B2
    const edges: WorkflowEdge[] = [
      { id: 'e-b1-sh', source: 'B1', target: 'Shared' },
      { id: 'e-b2-sh', source: 'B2', target: 'Shared' },
      { id: 'e-sh-s1', source: 'Shared', target: 'S1' },
      { id: 'e-sh-s2', source: 'Shared', target: 'S2' },
      { id: 'fb1', source: 'S1', target: 'B1', isFeedback: true },
      { id: 'fb2', source: 'S2', target: 'B2', isFeedback: true },
    ]

    expect(() => {
      validateWorkflowGraph(nodes, edges)
    }).toThrow(
      'Overlapping loops are not supported in workflow graph: feedback edge "fb1" overlaps with "fb2"',
    )
  })

  // TC-2B-VAL-07: invalid loop policy rejected
  it('TC-2B-VAL-07: rejects invalid loop policy with non-positive or non-integer bounds', () => {
    const nodes = [makeNode('A'), makeNode('B')]
    const edges: WorkflowEdge[] = [
      { id: 'e-ab', source: 'A', target: 'B' },
      { id: 'fb', source: 'B', target: 'A', isFeedback: true },
    ]

    expect(() => {
      validateWorkflowGraph(nodes, edges, {
        maxIterations: 0,
        maxRepeatedStates: 1,
        maxNodeAttempts: 10,
      })
    }).toThrow('Invalid loop policy: maxIterations must be a positive integer, got 0')

    expect(() => {
      validateWorkflowGraph(nodes, edges, {
        maxIterations: 5,
        maxRepeatedStates: -1,
        maxNodeAttempts: 10,
      })
    }).toThrow('Invalid loop policy: maxRepeatedStates must be a positive integer, got -1')

    expect(() => {
      validateWorkflowGraph(nodes, edges, {
        maxIterations: 5,
        maxRepeatedStates: 1,
        maxNodeAttempts: 1.5,
      })
    }).toThrow('Invalid loop policy: maxNodeAttempts must be a positive integer, got 1.5')
  })
})
