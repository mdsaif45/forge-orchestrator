import { describe, expect, it } from 'vitest'
import type { WorkflowTemplateV2 } from '@shared/domain'
import { planParallelBatches } from './parallelExecutor'

describe('parallelExecutor (WORK-013)', () => {
  it('identifies parallel sibling nodes and fan-in merge targets accurately', () => {
    // Diamond DAG: Start -> (Branch1, Branch2) -> Merge
    const diamondTemplate: WorkflowTemplateV2 = {
      id: 'diamond-test',
      name: 'Diamond Parallel Workflow',
      description: 'Tests parallel sibling execution',
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
          config: { skills: [], permissionMode: 'developer', role: 'planner' },
        },
        {
          id: 'unit_test',
          title: 'Unit Test',
          type: 'agent',
          runtimeType: 'cli-agent',
          inputs: [],
          outputs: [],
          config: { skills: [], permissionMode: 'developer', role: 'tester' },
        },
        {
          id: 'lint_check',
          title: 'Lint Check',
          type: 'agent',
          runtimeType: 'cli-agent',
          inputs: [],
          outputs: [],
          config: { skills: [], permissionMode: 'developer', role: 'reviewer' },
        },
        {
          id: 'merge_barrier',
          title: 'Merge Barrier',
          type: 'verification',
          runtimeType: 'forge-engine',
          inputs: [],
          outputs: [],
          config: { skills: [], permissionMode: 'developer' },
        },
      ],
      edges: [
        { id: 'e1', source: 'start', target: 'unit_test', isFeedback: false },
        { id: 'e2', source: 'start', target: 'lint_check', isFeedback: false },
        { id: 'e3', source: 'unit_test', target: 'merge_barrier', isFeedback: false },
        { id: 'e4', source: 'lint_check', target: 'merge_barrier', isFeedback: false },
      ],
    }

    const plan = planParallelBatches(diamondTemplate)
    expect(plan.valid).toBe(true)
    expect(plan.hasConcurrentNodes).toBe(true)
    expect(plan.maxConcurrencyWidth).toBe(2)
    expect(plan.batches.length).toBe(3)

    // Batch 0: start (sequential)
    expect(plan.batches[0]?.isParallel).toBe(false)
    expect(plan.batches[0]?.nodes.length).toBe(1)

    // Batch 1: unit_test & lint_check (parallel)
    const parallelBatch = plan.batches[1]
    expect(parallelBatch?.isParallel).toBe(true)
    expect(parallelBatch?.concurrencyWidth).toBe(2)
    expect(parallelBatch?.nodes.map((n) => n.id).sort()).toEqual(['lint_check', 'unit_test'])
    expect(parallelBatch?.fanInTarget).toBe('merge_barrier')

    // Batch 2: merge_barrier (sequential)
    expect(plan.batches[2]?.isParallel).toBe(false)
    expect(plan.batches[2]?.nodes[0]?.id).toBe('merge_barrier')

    expect(plan.formattedSummary).toContain('Sibling Parallelism: ENABLED')
  })

  it('correctly evaluates sequential pipelines without concurrency', () => {
    const linearTemplate: WorkflowTemplateV2 = {
      id: 'linear-test',
      name: 'Linear Pipeline',
      description: 'Linear sequential',
      version: 1,
      status: 'published',
      category: 'Test',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      nodes: [
        {
          id: 'step1',
          title: 'Step 1',
          type: 'agent',
          runtimeType: 'cli-agent',
          inputs: [],
          outputs: [],
          config: { skills: [], permissionMode: 'developer' },
        },
        {
          id: 'step2',
          title: 'Step 2',
          type: 'agent',
          runtimeType: 'cli-agent',
          inputs: [],
          outputs: [],
          config: { skills: [], permissionMode: 'developer' },
        },
      ],
      edges: [{ id: 'e1', source: 'step1', target: 'step2', isFeedback: false }],
    }

    const plan = planParallelBatches(linearTemplate)
    expect(plan.valid).toBe(true)
    expect(plan.hasConcurrentNodes).toBe(false)
    expect(plan.maxConcurrencyWidth).toBe(1)
  })

  it('fails closed on invalid template schema (Axiom A2)', () => {
    const invalidPlan = planParallelBatches({ id: 123 })
    expect(invalidPlan.valid).toBe(false)
    expect(invalidPlan.errors).toBeDefined()
  })
})
