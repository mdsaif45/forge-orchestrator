import { describe, expect, it, vi } from 'vitest'
import {
  AgentToolSpeculativeExecutionSupervisor,
  type SpeculativeToolInvocation,
} from './agentToolSpeculativeExecutionSupervisor'

describe('AgentToolSpeculativeExecutionSupervisor', () => {
  it('correctly classifies tool calls into read-only and mutating by prefix', () => {
    const supervisor = new AgentToolSpeculativeExecutionSupervisor()
    expect(supervisor.classifyTool('read_file')).toBe('READ_ONLY')
    expect(supervisor.classifyTool('get_user')).toBe('READ_ONLY')
    expect(supervisor.classifyTool('write_file')).toBe('MUTATING')
    expect(supervisor.classifyTool('delete_entry')).toBe('MUTATING')
    expect(supervisor.classifyTool('custom_tool')).toBe('MUTATING') // default
    expect(supervisor.classifyTool('custom_tool', 'IDEMPOTENT_WRITE')).toBe('IDEMPOTENT_WRITE')
  })

  it('throws fail-closed when a cycle is detected in tool dependencies', () => {
    const supervisor = new AgentToolSpeculativeExecutionSupervisor()
    const invocations: SpeculativeToolInvocation[] = [
      { id: 'node-a', toolName: 'read_a', dependencies: ['node-b'] },
      { id: 'node-b', toolName: 'read_b', dependencies: ['node-a'] },
    ]
    expect(() => supervisor.buildPlan(invocations)).toThrow(/Dependency cycle detected/)
  })

  it('throws fail-closed on missing dependencies or duplicate IDs', () => {
    const supervisor = new AgentToolSpeculativeExecutionSupervisor()
    expect(() =>
      supervisor.buildPlan([
        { id: 'dup', toolName: 'read_1' },
        { id: 'dup', toolName: 'read_2' },
      ]),
    ).toThrow(/Duplicate invocation ID detected/)

    expect(() =>
      supervisor.buildPlan([{ id: 'node-1', toolName: 'read_1', dependencies: ['missing-id'] }]),
    ).toThrow(/Missing dependency "missing-id"/)
  })

  it('separates speculative read-only tasks from mutating and dependent tasks', () => {
    const supervisor = new AgentToolSpeculativeExecutionSupervisor()
    const invocations: SpeculativeToolInvocation[] = [
      { id: 'read-1', toolName: 'read_file' },
      { id: 'read-2', toolName: 'get_status' },
      { id: 'write-1', toolName: 'write_config', dependencies: ['read-1'] },
      { id: 'read-after-write', toolName: 'read_verify', dependencies: ['write-1'] },
    ]

    const plan = supervisor.buildPlan(invocations)
    expect(plan.speculativeBatch).toEqual(['read-1', 'read-2'])
    expect(plan.sequentialPipeline).toEqual(['write-1', 'read-after-write'])
    expect(plan.rollbackSequence).toEqual(['write-1'])
  })

  it('executes speculative batch and sequential pipeline successfully', async () => {
    const supervisor = new AgentToolSpeculativeExecutionSupervisor()
    const invocations: SpeculativeToolInvocation[] = [
      { id: 'read-1', toolName: 'read_file' },
      { id: 'read-2', toolName: 'get_status' },
      { id: 'write-1', toolName: 'write_file' },
    ]

    const plan = supervisor.buildPlan(invocations)
    const executed: string[] = []

    const summary = await supervisor.executePlan(plan, invocations, {
      execute: async (inv) => {
        await Promise.resolve()
        executed.push(inv.id)
        return { data: `result-${inv.id}` }
      },
    })

    expect(executed).toContain('read-1')
    expect(executed).toContain('read-2')
    expect(executed).toContain('write-1')
    expect(summary.committedCount).toBe(3)
    expect(summary.discardedCount).toBe(0)
    expect(summary.rollbackTriggered).toBe(false)
  })

  it('discards speculative results if precondition validation gate fails', async () => {
    const supervisor = new AgentToolSpeculativeExecutionSupervisor()
    const invocations: SpeculativeToolInvocation[] = [
      { id: 'read-1', toolName: 'read_file' },
      { id: 'write-1', toolName: 'write_file' },
    ]

    const plan = supervisor.buildPlan(invocations)

    const summary = await supervisor.executePlan(plan, invocations, {
      execute: (inv) => Promise.resolve({ data: `val-${inv.id}` }),
      validatePreconditions: () => false, // rejects
    })

    expect(summary.committedCount).toBe(0)
    expect(summary.discardedCount).toBe(1)
    expect(summary.rollbackLog[0]).toMatch(/validation gate failure|discarded at validation gate/)
  })

  it('triggers rollback for executed mutating nodes when sequential pipeline fails', async () => {
    const supervisor = new AgentToolSpeculativeExecutionSupervisor()
    const invocations: SpeculativeToolInvocation[] = [
      { id: 'read-1', toolName: 'read_file' },
      { id: 'write-1', toolName: 'write_first' },
      { id: 'write-2', toolName: 'write_second' },
    ]

    const plan = supervisor.buildPlan(invocations)
    const rolledBack: string[] = []
    const rollbackSpy = vi.fn((inv: SpeculativeToolInvocation) => {
      rolledBack.push(inv.id)
      return Promise.resolve()
    })

    const summary = await supervisor.executePlan(plan, invocations, {
      execute: async (inv) => {
        await Promise.resolve()
        if (inv.id === 'write-2') {
          throw new Error('Write 2 disk quota exceeded')
        }
        return { executed: inv.id }
      },
      rollback: rollbackSpy,
    })

    expect(summary.rollbackTriggered).toBe(true)
    expect(rollbackSpy).toHaveBeenCalledTimes(1)
    expect(rolledBack).toEqual(['write-1'])
    expect(summary.rolledBackCount).toBe(1)
  })
})
