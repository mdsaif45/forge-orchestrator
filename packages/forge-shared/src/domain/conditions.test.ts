import { describe, expect, it } from 'vitest'
import {
  evaluateCondition,
  resolveConditionRef,
  type ConditionEvaluationContext,
} from './conditions'
import {
  validateWorkflowGraph,
  type EdgeCondition,
  type WorkflowEdge,
  type WorkflowNode,
} from './workflowGraph'

describe('conditions domain evaluator (Gate 1 Correctness)', () => {
  const artifactJson = JSON.stringify({
    verdict: 'pass',
    score: 85,
    metrics: { coverage: 92.5, exitCode: 0 },
    tags: ['ci', 'production'],
    explicitNull: null,
  })

  const ctx: ConditionEvaluationContext = {
    incomingSlots: new Map([
      [
        'review_report',
        {
          id: 'art-1',
          workflowId: 'wf-1',
          nodeId: 'node-reviewer',
          kind: 'review_report',
          format: 'json',
          title: 'Review Report',
          content: artifactJson,
          metadata: {},
          createdAt: '2026-10-04T12:00:00Z',
        },
      ],
      [
        'raw_text',
        {
          id: 'art-2',
          workflowId: 'wf-1',
          nodeId: 'node-raw',
          kind: 'raw_text',
          format: 'text',
          title: 'Raw Text',
          content: 'Plain unparseable string',
          metadata: {},
          createdAt: '2026-10-04T12:00:00Z',
        },
      ],
    ]),
    initialContext: {
      env: 'production',
      branch: 'main',
    },
    iteration: 2,
  }

  describe('resolveConditionRef', () => {
    it('resolves run.iteration and iteration', () => {
      expect(resolveConditionRef('run.iteration', ctx)).toBe(2)
      expect(resolveConditionRef('iteration', ctx)).toBe(2)
      expect(resolveConditionRef('run.iteration', {})).toBe(1)
    })

    it('resolves context values', () => {
      expect(resolveConditionRef('context.env', ctx)).toBe('production')
      expect(resolveConditionRef('context.missing', ctx)).toBeUndefined()
    })

    it('resolves nested JSON artifact properties', () => {
      expect(resolveConditionRef('artifacts.review_report.verdict', ctx)).toBe('pass')
      expect(resolveConditionRef('artifacts.review_report.score', ctx)).toBe(85)
      expect(resolveConditionRef('artifacts.review_report.metrics.coverage', ctx)).toBe(92.5)
      expect(resolveConditionRef('artifacts.review_report.metrics.exitCode', ctx)).toBe(0)
      expect(resolveConditionRef('artifacts.review_report.explicitNull', ctx)).toBeNull()
    })

    it('returns undefined for missing artifact or missing path', () => {
      expect(resolveConditionRef('artifacts.unknown_slot.foo', ctx)).toBeUndefined()
      expect(resolveConditionRef('artifacts.review_report.nonexistent', ctx)).toBeUndefined()
      expect(resolveConditionRef('artifacts.review_report.metrics.unknown', ctx)).toBeUndefined()
    })

    it('returns undefined when querying nested properties on non-JSON artifacts', () => {
      expect(resolveConditionRef('artifacts.raw_text.foo', ctx)).toBeUndefined()
    })
  })

  describe('Operator correctness & Gate 1 fail-closed rules', () => {
    // 1. Missing references fail closed
    it('fails closed: missing reference NEVER satisfies neq or not_in', () => {
      const neqCondition: EdgeCondition = {
        mode: 'all',
        predicates: [
          { ref: 'artifacts.review_report.missingField', operator: 'neq', value: 'pass' },
        ],
      }
      expect(evaluateCondition(neqCondition, ctx)).toBe(false)

      const notInCondition: EdgeCondition = {
        mode: 'all',
        predicates: [
          {
            ref: 'artifacts.review_report.missingField',
            operator: 'not_in',
            value: ['pass', 'fail'],
          },
        ],
      }
      expect(evaluateCondition(notInCondition, ctx)).toBe(false)
    })

    it('fails closed: missing reference does not satisfy eq or numeric operators', () => {
      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [
              { ref: 'artifacts.review_report.missingField', operator: 'eq', value: null },
            ],
          },
          ctx,
        ),
      ).toBe(false)

      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [{ ref: 'artifacts.review_report.missingField', operator: 'gt', value: 0 }],
          },
          ctx,
        ),
      ).toBe(false)
    })

    // 2. Explicit null distinction
    it('distinguishes explicit null from missing undefined', () => {
      // explicitNull === null -> true
      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [
              { ref: 'artifacts.review_report.explicitNull', operator: 'eq', value: null },
            ],
          },
          ctx,
        ),
      ).toBe(true)

      // explicitNull !== 'pass' -> true (because null is a concrete value !== 'pass')
      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [
              { ref: 'artifacts.review_report.explicitNull', operator: 'neq', value: 'pass' },
            ],
          },
          ctx,
        ),
      ).toBe(true)
    })

    // 3. exists operator
    it('handles exists operator explicitly for present, null, and missing values', () => {
      // Present field exists
      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [{ ref: 'artifacts.review_report.verdict', operator: 'exists' }],
          },
          ctx,
        ),
      ).toBe(true)

      // Explicit null exists
      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [{ ref: 'artifacts.review_report.explicitNull', operator: 'exists' }],
          },
          ctx,
        ),
      ).toBe(true)

      // Missing field does NOT exist
      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [{ ref: 'artifacts.review_report.missingField', operator: 'exists' }],
          },
          ctx,
        ),
      ).toBe(false)

      // exists: false tests for missing
      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [
              { ref: 'artifacts.review_report.missingField', operator: 'exists', value: false },
            ],
          },
          ctx,
        ),
      ).toBe(true)

      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [
              { ref: 'artifacts.review_report.verdict', operator: 'exists', value: false },
            ],
          },
          ctx,
        ),
      ).toBe(false)
    })

    // 4. Strict type equality (no coercion)
    it('strictly enforces type equality without coercion', () => {
      // score is 85 (number)
      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [{ ref: 'artifacts.review_report.score', operator: 'eq', value: 85 }],
          },
          ctx,
        ),
      ).toBe(true)

      // String '85' does NOT equal number 85
      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [{ ref: 'artifacts.review_report.score', operator: 'eq', value: '85' }],
          },
          ctx,
        ),
      ).toBe(false)

      // exitCode 0 does NOT equal string '0' or false
      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [
              { ref: 'artifacts.review_report.metrics.exitCode', operator: 'eq', value: '0' },
            ],
          },
          ctx,
        ),
      ).toBe(false)

      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [
              { ref: 'artifacts.review_report.metrics.exitCode', operator: 'eq', value: false },
            ],
          },
          ctx,
        ),
      ).toBe(false)
    })

    // 5. Numeric comparisons
    it('evaluates numeric comparisons strictly', () => {
      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [{ ref: 'artifacts.review_report.score', operator: 'gt', value: 80 }],
          },
          ctx,
        ),
      ).toBe(true)

      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [{ ref: 'artifacts.review_report.score', operator: 'gte', value: 85 }],
          },
          ctx,
        ),
      ).toBe(true)

      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [{ ref: 'artifacts.review_report.score', operator: 'lt', value: 90 }],
          },
          ctx,
        ),
      ).toBe(true)

      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [{ ref: 'artifacts.review_report.score', operator: 'lte', value: 85 }],
          },
          ctx,
        ),
      ).toBe(true)

      // Comparing string to number evaluates to false
      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [{ ref: 'artifacts.review_report.verdict', operator: 'gt', value: 0 }],
          },
          ctx,
        ),
      ).toBe(false)
    })

    // 6. in and not_in
    it('evaluates in and not_in array membership', () => {
      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [
              {
                ref: 'artifacts.review_report.verdict',
                operator: 'in',
                value: ['pass', 'conditional'],
              },
            ],
          },
          ctx,
        ),
      ).toBe(true)

      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [
              {
                ref: 'artifacts.review_report.verdict',
                operator: 'in',
                value: ['fail', 'rejected'],
              },
            ],
          },
          ctx,
        ),
      ).toBe(false)

      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [
              {
                ref: 'artifacts.review_report.verdict',
                operator: 'not_in',
                value: ['fail', 'rejected'],
              },
            ],
          },
          ctx,
        ),
      ).toBe(true)

      // Non-array value returns false
      expect(
        evaluateCondition(
          {
            mode: 'all',
            predicates: [{ ref: 'artifacts.review_report.verdict', operator: 'in', value: 'pass' }],
          },
          ctx,
        ),
      ).toBe(false)
    })

    // 7. mode: all vs any
    it('combines predicates with mode all and any', () => {
      const allCondition: EdgeCondition = {
        mode: 'all',
        predicates: [
          { ref: 'artifacts.review_report.verdict', operator: 'eq', value: 'pass' },
          { ref: 'artifacts.review_report.score', operator: 'gt', value: 90 }, // false
        ],
      }
      expect(evaluateCondition(allCondition, ctx)).toBe(false)

      const anyCondition: EdgeCondition = {
        mode: 'any',
        predicates: [
          { ref: 'artifacts.review_report.verdict', operator: 'eq', value: 'pass' }, // true
          { ref: 'artifacts.review_report.score', operator: 'gt', value: 90 }, // false
        ],
      }
      expect(evaluateCondition(anyCondition, ctx)).toBe(true)
    })
  })
})

describe('validateWorkflowGraph router validation', () => {
  const nodeA: WorkflowNode = {
    id: 'node-A',
    title: 'Node A',
    type: 'agent',
    runtimeType: 'cli-agent',
    config: { skills: [], permissionMode: 'developer' },
    inputs: [],
    outputs: [],
  }

  const routerR: WorkflowNode = {
    id: 'router-R',
    title: 'Router R',
    type: 'router',
    runtimeType: 'forge-engine',
    config: { skills: [], permissionMode: 'read-only' },
    inputs: [],
    outputs: [],
  }

  const nodeB: WorkflowNode = {
    id: 'node-B',
    title: 'Node B',
    type: 'agent',
    runtimeType: 'cli-agent',
    config: { skills: [], permissionMode: 'developer' },
    inputs: [],
    outputs: [],
  }

  const nodeC: WorkflowNode = {
    id: 'node-C',
    title: 'Node C',
    type: 'agent',
    runtimeType: 'cli-agent',
    config: { skills: [], permissionMode: 'developer' },
    inputs: [],
    outputs: [],
  }

  it('validates a valid router with conditional edge and default fallback', () => {
    const edges: WorkflowEdge[] = [
      { id: 'e1', source: 'node-A', target: 'router-R' },
      {
        id: 'e2',
        source: 'router-R',
        target: 'node-B',
        condition: {
          mode: 'all',
          predicates: [{ ref: 'artifacts.review.verdict', operator: 'eq', value: 'pass' }],
        },
      },
      { id: 'e3', source: 'router-R', target: 'node-C', isDefault: true },
    ]

    expect(() => {
      validateWorkflowGraph([nodeA, routerR, nodeB, nodeC], edges)
    }).not.toThrow()
  })

  it('rejects a router with zero outgoing edges', () => {
    const edges: WorkflowEdge[] = [{ id: 'e1', source: 'node-A', target: 'router-R' }]

    expect(() => {
      validateWorkflowGraph([nodeA, routerR], edges)
    }).toThrow('Router node "router-R" has no outgoing edges')
  })

  it('rejects a router with multiple default edges', () => {
    const edges: WorkflowEdge[] = [
      { id: 'e1', source: 'node-A', target: 'router-R' },
      { id: 'e2', source: 'router-R', target: 'node-B', isDefault: true },
      { id: 'e3', source: 'router-R', target: 'node-C', isDefault: true },
    ]

    expect(() => {
      validateWorkflowGraph([nodeA, routerR, nodeB, nodeC], edges)
    }).toThrow(
      'Router node "router-R" declares multiple default outgoing edges: [e2, e3]. At most one default edge is permitted.',
    )
  })

  it('rejects an edge from a router specifying both condition and isDefault', () => {
    const edges: WorkflowEdge[] = [
      { id: 'e1', source: 'node-A', target: 'router-R' },
      {
        id: 'e2',
        source: 'router-R',
        target: 'node-B',
        isDefault: true,
        condition: {
          mode: 'all',
          predicates: [{ ref: 'artifacts.review.verdict', operator: 'eq', value: 'pass' }],
        },
      },
    ]

    expect(() => {
      validateWorkflowGraph([nodeA, routerR, nodeB], edges)
    }).toThrow('Edge "e2" from router "router-R" cannot specify both condition and isDefault: true')
  })

  it('rejects an edge from a router that is ambiguous (neither condition nor isDefault)', () => {
    const edges: WorkflowEdge[] = [
      { id: 'e1', source: 'node-A', target: 'router-R' },
      { id: 'e2', source: 'router-R', target: 'node-B' }, // ambiguous
    ]

    expect(() => {
      validateWorkflowGraph([nodeA, routerR, nodeB], edges)
    }).toThrow(
      'Edge "e2" from router "router-R" must specify either a condition or isDefault: true',
    )
  })

  it('rejects a non-router node declaring a condition or isDefault', () => {
    const edgesWithCond: WorkflowEdge[] = [
      {
        id: 'e1',
        source: 'node-A',
        target: 'node-B',
        condition: {
          mode: 'all',
          predicates: [{ ref: 'artifacts.review.verdict', operator: 'eq', value: 'pass' }],
        },
      },
    ]

    expect(() => {
      validateWorkflowGraph([nodeA, nodeB], edgesWithCond)
    }).toThrow(
      'Edge "e1" from non-router node "node-A" cannot declare a condition. Only router nodes support conditional branching.',
    )

    const edgesWithDef: WorkflowEdge[] = [
      { id: 'e2', source: 'node-A', target: 'node-B', isDefault: true },
    ]

    expect(() => {
      validateWorkflowGraph([nodeA, nodeB], edgesWithDef)
    }).toThrow(
      'Edge "e2" from non-router node "node-A" cannot be marked isDefault. Only router nodes support default branching.',
    )
  })
})
