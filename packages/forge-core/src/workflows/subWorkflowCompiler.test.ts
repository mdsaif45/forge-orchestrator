import { workflowTemplateV2Schema, type WorkflowTemplateV2 } from '@shared/domain'
import { describe, expect, it } from 'vitest'
import {
  SlotMappingError,
  SubWorkflowCompiler,
  SubWorkflowCycleError,
  TemplateNotFoundError,
} from './subWorkflowCompiler'

const nowIso = '2026-11-26T00:00:00.000Z'

function makeTemplate(
  id: string,
  nodes: WorkflowTemplateV2['nodes'],
  edges: WorkflowTemplateV2['edges'] = [],
): WorkflowTemplateV2 {
  return workflowTemplateV2Schema.parse({
    id,
    name: `Template ${id}`,
    description: `Test template ${id}`,
    version: 1,
    status: 'published',
    category: 'Test',
    nodes,
    edges,
    createdAt: nowIso,
    updatedAt: nowIso,
  })
}

describe('SubWorkflowCompiler (COMP-002)', () => {
  const compiler = new SubWorkflowCompiler()

  it('recursively flattens 2-level nested sub-workflows with slot remapping, scoped variable isolation, and lineage', () => {
    const leafTemplate = makeTemplate('leaf-scanner', [
      {
        id: 'run-lint',
        title: 'Lint ${{ scope.scopeName }}',
        type: 'verification',
        runtimeType: 'forge-engine',
        config: {
          skills: [],
          permissionMode: 'read-only',
          systemPrompt:
            'Parent leak check: ${{ scope.parentSecret }} | Local: ${{ scope.scopeName }}',
        },
        inputs: [{ name: 'target_dir', kind: 'path', required: true }],
        outputs: [{ name: 'lint_json', kind: 'report', format: 'json', requiredSections: [] }],
      },
    ])

    const middleTemplate = makeTemplate(
      'mid-quality-gate',
      [
        {
          id: 'prepare-gate',
          title: 'Prepare Quality ${{ scope.gateTier }}',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'read-only' },
          inputs: [{ name: 'branch_ref', kind: 'git', required: true }],
          outputs: [],
        },
        {
          id: 'nested-leaf-invoke',
          title: 'Nested Leaf',
          type: 'agent',
          runtimeType: 'forge-engine',
          config: { skills: [], permissionMode: 'developer' },
          inputs: [],
          outputs: [],
        },
      ],
      [{ id: 'e-mid-1', source: 'prepare-gate', target: 'nested-leaf-invoke' }],
    )

    const rootTemplate = makeTemplate(
      'root-delivery',
      [
        {
          id: 'checkout',
          title: 'Checkout Repo',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'developer' },
          inputs: [],
          outputs: [],
        },
        {
          id: 'invoke-quality',
          title: 'Quality Subflow',
          type: 'agent',
          runtimeType: 'forge-engine',
          config: { skills: [], permissionMode: 'developer' },
          inputs: [],
          outputs: [],
        },
        {
          id: 'ship',
          title: 'Merge PR',
          type: 'user_gate',
          runtimeType: 'human',
          config: { skills: [], permissionMode: 'read-only' },
          inputs: [],
          outputs: [],
        },
      ],
      [
        { id: 'e-root-1', source: 'checkout', target: 'invoke-quality' },
        { id: 'e-root-2', source: 'invoke-quality', target: 'ship' },
      ],
    )

    const result = compiler.compile({
      rootTemplate,
      templateRegistry: {
        'mid-quality-gate': middleTemplate,
        'leaf-scanner': leafTemplate,
      },
      parentVariables: { parentSecret: 'DO_NOT_LEAK' },
      invocations: [
        {
          invocationId: 'invoke-quality',
          title: 'Quality Gate',
          subWorkflowTemplateId: 'mid-quality-gate',
          slotMappings: [
            { parentSlot: 'parent.branch', subWorkflowSlot: 'branch_ref', direction: 'input' },
          ],
          boundary: {
            boundaryId: 'boundary-mid',
            failureIsolation: 'CONTAIN_TO_SUBFLOW',
            inheritParentVariables: false,
            scopedVariables: { gateTier: 'strict' },
            timeoutCeilingMs: 12_000,
          },
          nestedInvocations: [
            {
              invocationId: 'nested-leaf-invoke',
              title: 'Leaf Linter',
              subWorkflowTemplateId: 'leaf-scanner',
              slotMappings: [
                { parentSlot: 'mid.path', subWorkflowSlot: 'target_dir', direction: 'input' },
                { parentSlot: 'mid.lintOut', subWorkflowSlot: 'lint_json', direction: 'output' },
              ],
              boundary: {
                boundaryId: 'boundary-leaf',
                failureIsolation: 'RETRY_SUBFLOW',
                inheritParentVariables: false,
                scopedVariables: { scopeName: 'packages/forge-core' },
              },
            },
          ],
        },
      ],
    })

    expect(result.maxDepthReached).toBe(2)
    expect(result.totalFlattenedNodes).toBe(4)
    expect(result.topologicalOrder).toEqual([
      'checkout',
      'invoke-quality__prepare-gate',
      'invoke-quality__nested-leaf-invoke__run-lint',
      'ship',
    ])
    expect(result.compilationDigest).toHaveLength(64)

    const leafCompiled = result.compiledTemplate.nodes.find(
      (n) => n.id === 'invoke-quality__nested-leaf-invoke__run-lint',
    )
    expect(leafCompiled?.title).toBe('Lint packages/forge-core')
    // Parent secret was NOT inherited across boundary
    expect(leafCompiled?.config.systemPrompt).toContain('${{ scope.parentSecret }}')
    expect(leafCompiled?.config.systemPrompt).not.toContain('DO_NOT_LEAK')

    const leafLineage = result.lineageMap['invoke-quality__nested-leaf-invoke__run-lint']
    expect(leafLineage?.lineagePath).toEqual([
      'root',
      'invoke-quality',
      'nested-leaf-invoke',
      'run-lint',
    ])
    expect(leafLineage?.nestingDepth).toBe(2)
    expect(leafLineage?.failureIsolation).toBe('RETRY_SUBFLOW')
    expect(leafLineage?.mappedInputs).toEqual({ target_dir: 'mid.path' })
    expect(leafLineage?.mappedOutputs).toEqual({ 'mid.lintOut': 'lint_json' })
  })

  it('rejects circular sub-workflow recursion and exceeded nesting depth fail-closed', () => {
    const recursiveTemplate = makeTemplate('self-loop-subflow', [
      {
        id: 'step-a',
        title: 'Self Invoke',
        type: 'agent',
        runtimeType: 'forge-native',
        config: { skills: [], permissionMode: 'developer' },
        inputs: [],
        outputs: [],
      },
    ])

    const root = makeTemplate('root', [
      {
        id: 'call-self',
        title: 'Call Self',
        type: 'agent',
        runtimeType: 'forge-engine',
        config: { skills: [], permissionMode: 'developer' },
        inputs: [],
        outputs: [],
      },
    ])

    expect(() =>
      compiler.compile({
        rootTemplate: root,
        templateRegistry: { 'self-loop-subflow': recursiveTemplate },
        invocations: [
          {
            invocationId: 'call-self',
            title: 'Outer',
            subWorkflowTemplateId: 'self-loop-subflow',
            slotMappings: [],
            boundary: { boundaryId: 'b1', failureIsolation: 'FAIL_CLOSED' },
            nestedInvocations: [
              {
                invocationId: 'step-a',
                title: 'Cycle',
                subWorkflowTemplateId: 'self-loop-subflow',
                slotMappings: [],
                boundary: { boundaryId: 'b2', failureIsolation: 'FAIL_CLOSED' },
              },
            ],
          },
        ],
      }),
    ).toThrow(SubWorkflowCycleError)
  })

  it('enforces slot mapping contracts and rejects missing required inputs or missing templates', () => {
    const subTemplate = makeTemplate('strict-subflow', [
      {
        id: 'child-task',
        title: 'Task',
        type: 'agent',
        runtimeType: 'forge-native',
        config: { skills: [], permissionMode: 'developer' },
        inputs: [{ name: 'required_cfg', kind: 'json', required: true }],
        outputs: [],
      },
    ])
    const root = makeTemplate('root', [
      {
        id: 'invoke-strict',
        title: 'Invoke Strict',
        type: 'agent',
        runtimeType: 'forge-engine',
        config: { skills: [], permissionMode: 'developer' },
        inputs: [],
        outputs: [],
      },
    ])

    expect(() =>
      compiler.compile({
        rootTemplate: root,
        templateRegistry: { 'strict-subflow': subTemplate },
        invocations: [
          {
            invocationId: 'invoke-strict',
            title: 'Invoke',
            subWorkflowTemplateId: 'strict-subflow',
            slotMappings: [],
            boundary: { boundaryId: 'b-strict', failureIsolation: 'FAIL_CLOSED' },
          },
        ],
      }),
    ).toThrow(SlotMappingError)

    expect(() =>
      compiler.compile({
        rootTemplate: root,
        templateRegistry: {},
        invocations: [
          {
            invocationId: 'invoke-strict',
            title: 'Missing',
            subWorkflowTemplateId: 'nonexistent-template',
            slotMappings: [],
            boundary: { boundaryId: 'b-miss', failureIsolation: 'FAIL_CLOSED' },
          },
        ],
      }),
    ).toThrow(TemplateNotFoundError)
  })
})
