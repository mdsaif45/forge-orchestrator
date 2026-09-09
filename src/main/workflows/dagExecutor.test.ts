import { describe, expect, it, vi } from 'vitest'
import type { WorkflowTemplateV2 } from '@shared/domain'
import { DagExecutor } from './dagExecutor'

describe('DagExecutor', () => {
  it('executes linear DAG and passes produced artifacts downstream', async () => {
    const template: WorkflowTemplateV2 = {
      id: 'test-linear',
      name: 'Test Linear',
      description: 'Linear test',
      version: 1,
      status: 'published',
      category: 'Test',
      nodes: [
        {
          id: 'step-1',
          title: 'Produce Spec',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'developer' },
          inputs: [],
          outputs: [
            {
              name: 'spec',
              kind: 'final_specification',
              format: 'markdown',
              requiredSections: [],
            },
          ],
        },
        {
          id: 'step-2',
          title: 'Consume Spec',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'developer' },
          inputs: [{ name: 'input_spec', kind: 'final_specification', required: true }],
          outputs: [
            {
              name: 'plan',
              kind: 'solution_architecture',
              format: 'markdown',
              requiredSections: [],
            },
          ],
        },
      ],
      edges: [
        {
          id: 'e1',
          source: 'step-1',
          sourceHandle: 'final_specification',
          target: 'step-2',
          targetHandle: 'input_spec',
        },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const step2ReceivedSlots: string[] = []

    const executor = new DagExecutor({
      template,
      workflowId: 'wf-123',
      projectId: 'proj-abc',
      executeNode: (ctx) => {
        if (ctx.node.id === 'step-1') {
          return Promise.resolve([
            {
              id: 'art-1',
              workflowId: ctx.workflowId,
              nodeId: ctx.node.id,
              kind: 'final_specification',
              format: 'markdown',
              title: 'Spec v1',
              content: '# Requirements Document',
              metadata: {},
              createdAt: new Date().toISOString(),
            },
          ])
        }
        if (ctx.node.id === 'step-2') {
          const slot = ctx.incomingSlots.get('input_spec')
          if (slot) {
            step2ReceivedSlots.push(slot.content)
          }
          return Promise.resolve([
            {
              id: 'art-2',
              workflowId: ctx.workflowId,
              nodeId: ctx.node.id,
              kind: 'solution_architecture',
              format: 'markdown',
              title: 'Architecture Doc',
              content: '# Solution Architecture',
              metadata: {},
              createdAt: new Date().toISOString(),
            },
          ])
        }
        return Promise.resolve([])
      },
    })

    const result = await executor.run()
    expect(result.status).toBe('completed')
    expect(result.completedNodeIds).toEqual(['step-1', 'step-2'])
    expect(result.artifacts).toHaveLength(2)
    expect(step2ReceivedSlots).toEqual(['# Requirements Document'])
  })

  it('executes parallel fan-out branches and converges at fan-in', async () => {
    const executionOrder: string[] = []

    const template: WorkflowTemplateV2 = {
      id: 'test-fan-out',
      name: 'Test Fan Out',
      description: 'Fan out and in',
      version: 1,
      status: 'published',
      category: 'Test',
      nodes: [
        {
          id: 'root',
          title: 'Root',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'developer' },
          inputs: [],
          outputs: [],
        },
        {
          id: 'branch-a',
          title: 'Branch A',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'developer' },
          inputs: [],
          outputs: [],
        },
        {
          id: 'branch-b',
          title: 'Branch B',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'developer' },
          inputs: [],
          outputs: [],
        },
        {
          id: 'join',
          title: 'Join',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'developer' },
          inputs: [],
          outputs: [],
        },
      ],
      edges: [
        { id: 'e1', source: 'root', target: 'branch-a' },
        { id: 'e2', source: 'root', target: 'branch-b' },
        { id: 'e3', source: 'branch-a', target: 'join' },
        { id: 'e4', source: 'branch-b', target: 'join' },
      ],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const executor = new DagExecutor({
      template,
      workflowId: 'wf-456',
      projectId: 'proj-abc',
      executeNode: (ctx) => {
        executionOrder.push(ctx.node.id)
        return Promise.resolve([])
      },
    })

    const result = await executor.run()
    expect(result.status).toBe('completed')
    expect(result.completedNodeIds).toHaveLength(4)

    // Root must be first
    expect(executionOrder[0]).toBe('root')
    // Join must be last
    expect(executionOrder[3]).toBe('join')
    // Both branch-a and branch-b must be executed in between
    expect(executionOrder.slice(1, 3)).toEqual(expect.arrayContaining(['branch-a', 'branch-b']))
  })

  it('handles node failure and halts cleanly', async () => {
    const template: WorkflowTemplateV2 = {
      id: 'test-fail',
      name: 'Test Fail',
      description: 'Fails at step 2',
      version: 1,
      status: 'published',
      category: 'Test',
      nodes: [
        {
          id: 's1',
          title: 'S1',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'developer' },
          inputs: [],
          outputs: [],
        },
        {
          id: 's2',
          title: 'S2',
          type: 'agent',
          runtimeType: 'forge-native',
          config: { skills: [], permissionMode: 'developer' },
          inputs: [],
          outputs: [],
        },
      ],
      edges: [{ id: 'e1', source: 's1', target: 's2' }],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }

    const onFailed = vi.fn()

    const executor = new DagExecutor({
      template,
      workflowId: 'wf-fail',
      projectId: 'proj-abc',
      onNodeFailed: onFailed,
      executeNode: (ctx) => {
        if (ctx.node.id === 's2') {
          return Promise.reject(new Error('Step 2 agent timed out'))
        }
        return Promise.resolve([])
      },
    })

    await expect(executor.run()).rejects.toThrow('Step 2 agent timed out')
    expect(onFailed).toHaveBeenCalledWith(expect.objectContaining({ id: 's2' }), expect.any(Error))
  })
})
