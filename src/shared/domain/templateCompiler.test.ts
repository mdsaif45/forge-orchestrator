import { describe, expect, it } from 'vitest'
import { BUG_FIX, FEATURE_IMPLEMENTATION } from './template'
import { compileLinearTemplateToGraph } from './templateCompiler'
import {
  getReadyNodes,
  getTopologicalSort,
  validateWorkflowGraph,
  workflowTemplateV2Schema,
} from './workflowGraph'

describe('compileLinearTemplateToGraph', () => {
  it('faithfully compiles FEATURE_IMPLEMENTATION preserving all ADR-007 invariants', () => {
    const limits = {
      maxIterations: 5,
      stepTimeoutMs: 15 * 60 * 1000,
      idleTimeoutMs: 5 * 60 * 1000,
      totalTimeoutMs: 60 * 60 * 1000,
      maxRetries: 3,
      retryDelayMs: 5000,
      stopOn: {
        buildFailure: false,
        testFailure: false,
        openQuestion: false,
        permissionViolation: true as const,
        unexpectedFileModification: true,
      },
    }

    const compiled = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION, limits)

    // 1. Schema validity
    expect(() => workflowTemplateV2Schema.parse(compiled)).not.toThrow()

    // 2. Node count and identities
    expect(compiled.nodes).toHaveLength(5)
    expect(compiled.nodes.map((n) => n.id)).toEqual([
      'step-1-planner',
      'step-2-user',
      'step-3-implementer',
      'step-4-system',
      'step-5-reviewer',
    ])

    // 3. Node types & runtime types
    expect(compiled.nodes[0]!.type).toBe('agent')
    expect(compiled.nodes[0]!.runtimeType).toBe('cli-agent')
    expect(compiled.nodes[0]!.config.permissionMode).toBe('read-only')
    expect(compiled.nodes[0]!.config.timeoutMs).toBe(15 * 60 * 1000)

    expect(compiled.nodes[1]!.type).toBe('user_gate')
    expect(compiled.nodes[1]!.runtimeType).toBe('human')
    expect(compiled.nodes[1]!.config.permissionMode).toBe('read-only')

    expect(compiled.nodes[2]!.type).toBe('agent')
    expect(compiled.nodes[2]!.runtimeType).toBe('cli-agent')
    expect(compiled.nodes[2]!.config.permissionMode).toBe('developer')

    expect(compiled.nodes[3]!.type).toBe('verification')
    expect(compiled.nodes[3]!.runtimeType).toBe('forge-engine')
    expect(compiled.nodes[3]!.config.permissionMode).toBe('read-only')

    expect(compiled.nodes[4]!.type).toBe('agent')
    expect(compiled.nodes[4]!.runtimeType).toBe('cli-agent')
    expect(compiled.nodes[4]!.config.permissionMode).toBe('read-only')

    // 4. Edges: 4 forward linear edges + 1 feedback edge (reviewer -> implementer)
    expect(compiled.edges).toHaveLength(5)
    const forwardEdges = compiled.edges.filter((e) => !e.isFeedback)
    const feedbackEdges = compiled.edges.filter((e) => e.isFeedback)

    expect(forwardEdges).toHaveLength(4)
    expect(feedbackEdges).toHaveLength(1)
    expect(feedbackEdges[0]!.source).toBe('step-5-reviewer')
    expect(feedbackEdges[0]!.target).toBe('step-3-implementer')

    // 5. Forward DAG validity & topological sorting
    expect(() => {
      validateWorkflowGraph(compiled.nodes, compiled.edges)
    }).not.toThrow()
    const sort = getTopologicalSort(compiled.nodes, compiled.edges)
    expect(sort).toEqual([
      'step-1-planner',
      'step-2-user',
      'step-3-implementer',
      'step-4-system',
      'step-5-reviewer',
    ])

    // 6. Initial readiness: only step-1-planner is ready
    const initialReady = getReadyNodes(compiled.nodes, compiled.edges, new Set())
    expect(initialReady.map((n) => n.id)).toEqual(['step-1-planner'])

    // When step-1 completes, step-2-user becomes ready
    const step2Ready = getReadyNodes(compiled.nodes, compiled.edges, new Set(['step-1-planner']))
    expect(step2Ready.map((n) => n.id)).toEqual(['step-2-user'])
  })

  it('faithfully compiles BUG_FIX preserving all ADR-007 invariants', () => {
    const compiled = compileLinearTemplateToGraph(BUG_FIX)

    expect(() => {
      workflowTemplateV2Schema.parse(compiled)
    }).not.toThrow()
    expect(compiled.nodes).toHaveLength(5)
    expect(compiled.nodes.map((n) => n.id)).toEqual([
      'step-1-planner',
      'step-2-user',
      'step-3-implementer',
      'step-4-system',
      'step-5-reviewer',
    ])

    expect(() => {
      validateWorkflowGraph(compiled.nodes, compiled.edges)
    }).not.toThrow()
    const feedbackEdges = compiled.edges.filter((e) => e.isFeedback)
    expect(feedbackEdges).toHaveLength(1)
    expect(feedbackEdges[0]!.source).toBe('step-5-reviewer')
    expect(feedbackEdges[0]!.target).toBe('step-3-implementer')
  })

  it('rejects an illegal feedback edge that targets a successor node', () => {
    const compiled = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)

    // Tamper feedback edge so target does not precede source
    const illegalEdges = compiled.edges.map((e) =>
      e.isFeedback ? { ...e, source: 'step-1-planner', target: 'step-5-reviewer' } : e,
    )

    expect(() => {
      validateWorkflowGraph(compiled.nodes, illegalEdges)
    }).toThrow(/Feedback edge .* does not precede source node/i)
  })
})
