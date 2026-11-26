import { workflowTemplateV2Schema } from '@shared/domain'
import { describe, expect, it } from 'vitest'
import { WorkflowDslCompilationError, WorkflowDslParser, parseYamlToUnknown } from './dslParser'

const SAMPLE_YAML_DSL = `
# Human-editable declarative workflow for COMP-001
id: wf-feature-dsl
name: Feature Implementation Pipeline
description: Implement \${{ params.moduleName }} with automated tests
version: 2
category: Engineering
parameters:
  moduleName:
    type: string
    required: true
  retryLimit:
    type: number
    default: 2
nodes:
  - id: plan
    title: Architecture Plan for \${{ params.moduleName }}
    type: agent
    runtimeType: forge-native
    config:
      role: planner
      permissionMode: read-only
      skills: [architecture, search]
  - id: implement
    title: Implement \${{ params.moduleName }}
    type: agent
    runtimeType: forge-native
    dependsOn: [plan]
    config:
      role: implementer
      permissionMode: developer
  - id: verify
    title: Verify Build & Tests
    type: verification
    runtimeType: forge-engine
    dependsOn: [implement]
    outputs:
      - name: test_report
        kind: report
        format: json
edges:
  - from: verify
    to: implement
    isFeedback: true
loopPolicy:
  maxIterations: 3
  maxRepeatedStates: 1
  maxNodeAttempts: 5
`

describe('WorkflowDslParser (COMP-001)', () => {
  const parser = new WorkflowDslParser()

  it('compiles human-editable YAML into canonical WorkflowTemplateV2 DAG with parameter interpolation', () => {
    const result = parser.parseAndCompile(SAMPLE_YAML_DSL, {
      params: { moduleName: 'auth-router', retryLimit: 3 },
    })

    expect(result.valid).toBe(true)
    expect(result.format).toBe('yaml')
    expect(result.diagnostics).toEqual([])
    expect(result.topologicalOrder).toEqual(['plan', 'implement', 'verify'])
    expect(result.digest).toHaveLength(64)

    expect(result.template).not.toBeNull()
    if (result.template) {
      expect(() => workflowTemplateV2Schema.parse(result.template)).not.toThrow()
      expect(result.template.id).toBe('wf-feature-dsl')
      expect(result.template.description).toBe('Implement auth-router with automated tests')
      expect(result.template.nodes[0]?.config.skills).toEqual(['architecture', 'search'])
      expect(result.template.edges).toHaveLength(3)
      expect(result.template.edges.some((e) => e.isFeedback === true)).toBe(true)
    }
  })

  it('compiles JSON format cleanly', () => {
    const jsonSource = JSON.stringify({
      name: 'JSON Micro Workflow',
      nodes: [
        { id: 'step-1', title: 'Lint Code', type: 'verification', runtimeType: 'forge-engine' },
        {
          id: 'step-2',
          title: 'Approve Release',
          type: 'user_gate',
          runtimeType: 'human',
          dependsOn: ['step-1'],
        },
      ],
    })

    const compiled = parser.compileStrict(jsonSource, { format: 'json' })
    expect(compiled.nodes).toHaveLength(2)
    expect(compiled.edges).toHaveLength(1)
    expect(compiled.edges[0]?.source).toBe('step-1')
    expect(compiled.edges[0]?.target).toBe('step-2')
  })

  it('reports parameter missing, type mismatch, and unknown reference diagnostics', () => {
    const result = parser.parseAndCompile(SAMPLE_YAML_DSL, {
      params: { retryLimit: 'not-a-number', rogueParam: true },
    })

    expect(result.valid).toBe(false)
    const codes = result.diagnostics.map((d) => d.code)
    expect(codes).toContain('MISSING_PARAMETER')
    expect(codes).toContain('PARAMETER_TYPE_MISMATCH')
    expect(codes).toContain('UNKNOWN_PARAMETER')
  })

  it('reports YAML syntax errors with exact line numbers', () => {
    const brokenYaml = 'name: Broken\nnodes:\n\t- id: tabbed'
    const result = parser.parseAndCompile(brokenYaml)
    expect(result.valid).toBe(false)
    expect(result.diagnostics[0]?.code).toBe('SYNTAX_ERROR')
    expect(result.diagnostics[0]?.line).toBe(3)

    expect(() => parseYamlToUnknown('name: "unclosed')).toThrow('line 1')
  })

  it('rejects illegal cycles, dangling references, and duplicate node ids', () => {
    const cyclicYaml = `
name: Cyclic Pipeline
nodes:
  - id: a
    title: Node A
    dependsOn: [b]
  - id: b
    title: Node B
    dependsOn: [a]
  - id: b
    title: Duplicate B
    dependsOn: [missing-node]
`
    expect(() => parser.compileStrict(cyclicYaml)).toThrow(WorkflowDslCompilationError)
    const res = parser.parseAndCompile(cyclicYaml)
    const codes = new Set(res.diagnostics.map((d) => d.code))
    expect(codes.has('DUPLICATE_NODE')).toBe(true)
    expect(codes.has('DANGLING_REFERENCE')).toBe(true)
    expect(codes.has('ILLEGAL_CYCLE')).toBe(true)
  })
})
