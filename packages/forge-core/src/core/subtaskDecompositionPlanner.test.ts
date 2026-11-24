import { describe, expect, it } from 'vitest'
import {
  decomposeGoalIntoSubtasks,
  topologicallySortSubtasks,
  type SubtaskNode,
} from './subtaskDecompositionPlanner'

describe('subtaskDecompositionPlanner (AGENT-021)', () => {
  it('decomposes a valid goal into structured subtask DAG', () => {
    const plan = decomposeGoalIntoSubtasks('Implement tool execution cache')

    expect(plan.goal).toBe('Implement tool execution cache')
    expect(plan.subtasks.length).toBe(5)
    expect(plan.executionOrder.length).toBe(5)
    expect(plan.hasCycles).toBe(false)
    expect(plan.errors).toEqual([])

    expect(plan.executionOrder).toEqual([
      'subtask-1-inspect',
      'subtask-2-design',
      'subtask-3-implement',
      'subtask-4-test',
      'subtask-5-verify',
    ])
  })

  it('fails closed on empty goal input', () => {
    const plan = decomposeGoalIntoSubtasks('   ')

    expect(plan.goal).toBe('')
    expect(plan.subtasks).toEqual([])
    expect(plan.totalSubtasks).toBe(0)
    expect(plan.errors).toContain('Goal description cannot be empty.')
  })

  it('respects maxSubtasks bounding option', () => {
    const plan = decomposeGoalIntoSubtasks('Refactor database indexes', {
      maxSubtasks: 3,
    })

    expect(plan.totalSubtasks).toBe(3)
    expect(plan.subtasks.length).toBe(3)
    expect(plan.executionOrder.length).toBe(3)
    expect(plan.errors).toContain('Subtasks truncated to maximum bound of 3.')
  })

  it('detects unavailable tools when availableTools filter is provided', () => {
    const plan = decomposeGoalIntoSubtasks('Build parser', {
      availableTools: ['read_file'], // Missing write_file, run_command, edit_file
    })

    expect(plan.errors.length).toBeGreaterThan(0)
    expect(plan.errors.some((e) => e.includes('requires unavailable tools'))).toBe(true)
  })

  it('detects circular dependencies correctly via topologicallySortSubtasks', () => {
    const cycleNodes: SubtaskNode[] = [
      {
        id: 'node-A',
        title: 'Task A',
        description: 'Task A',
        category: 'code',
        requiredTools: [],
        prerequisiteIds: ['node-B'],
        validationCriteria: [],
        estimatedComplexity: 'low',
      },
      {
        id: 'node-B',
        title: 'Task B',
        description: 'Task B',
        category: 'code',
        requiredTools: [],
        prerequisiteIds: ['node-A'],
        validationCriteria: [],
        estimatedComplexity: 'low',
      },
    ]

    const result = topologicallySortSubtasks(cycleNodes)
    expect(result.hasCycles).toBe(true)
    expect(result.cycleNodeIds).toEqual(['node-A', 'node-B'])
  })
})
