/**
 * WORK-030: Workflow Execution Deadlock Detector & Cycle Hazard Sentinel.
 *
 * Detects circular wait-for dependencies and execution stalemates across workflow DAG
 * steps, distinguishing normal awaiting from permanent deadlock traps.
 */

export type StepState = 'pending' | 'running' | 'completed' | 'failed' | 'skipped'

export interface WorkflowStepDefinition {
  stepId: string
  dependencies?: string[]
  required?: boolean
}

export interface DeadlockAnalysisOptions {
  availableResourceSlots?: number
  allocatedResourceSlots?: number
}

export interface DeadlockAnalysisReport {
  isDeadlocked: boolean
  canProgress: boolean
  runnableStepIds: string[]
  blockedStepIds: string[]
  cyclePaths: string[][]
  stuckStepIds: string[]
  deadlockReason?: string | undefined
  summary: string
}

export function detectWorkflowDeadlocks(
  steps: WorkflowStepDefinition[],
  stepStates: Record<string, StepState>,
  options: DeadlockAnalysisOptions = {},
): DeadlockAnalysisReport {
  const runnableStepIds: string[] = []
  const blockedStepIds: string[] = []
  const stuckStepIds: string[] = []
  const availableSlots = options.availableResourceSlots ?? Infinity
  const allocatedSlots = options.allocatedResourceSlots ?? 0

  if (steps.length === 0) {
    return {
      isDeadlocked: false,
      canProgress: true,
      runnableStepIds: [],
      blockedStepIds: [],
      cyclePaths: [],
      stuckStepIds: [],
      summary: 'Workflow graph is empty; no deadlock hazards detected.',
    }
  }

  // 1. Build dependency adjacency map
  const adj = new Map<string, string[]>()
  for (const step of steps) {
    adj.set(step.stepId, step.dependencies ?? [])
  }

  // 2. Cycle detection on pending steps using DFS
  const cyclePaths: string[][] = []
  const visited = new Set<string>()
  const recStack = new Set<string>()
  const path: string[] = []

  function dfsFindCycles(curr: string): void {
    visited.add(curr)
    recStack.add(curr)
    path.push(curr)

    const neighbors = adj.get(curr) ?? []
    for (const neighbor of neighbors) {
      const neighborState = stepStates[neighbor] ?? 'pending'
      // Only trace cycles through unfinished dependencies
      if (neighborState === 'pending' || neighborState === 'running') {
        if (!visited.has(neighbor)) {
          dfsFindCycles(neighbor)
        } else if (recStack.has(neighbor)) {
          // Found cycle
          const cycleStartIdx = path.indexOf(neighbor)
          if (cycleStartIdx !== -1) {
            const cycle = [...path.slice(cycleStartIdx), neighbor]
            cyclePaths.push(cycle)
          }
        }
      }
    }

    path.pop()
    recStack.delete(curr)
  }

  for (const step of steps) {
    const state = stepStates[step.stepId] ?? 'pending'
    if ((state === 'pending' || state === 'running') && !visited.has(step.stepId)) {
      dfsFindCycles(step.stepId)
    }
  }

  // 3. Classify pending steps
  let runningCount = 0
  for (const step of steps) {
    const state = stepStates[step.stepId] ?? 'pending'
    if (state === 'running') {
      runningCount++
      continue
    }
    if (state !== 'pending') {
      continue
    }

    const deps = step.dependencies ?? []
    const unfulfilledDeps = deps.filter((d) => {
      const s = stepStates[d] ?? 'pending'
      return s !== 'completed' && s !== 'skipped'
    })

    const failedDeps = deps.filter((d) => (stepStates[d] ?? 'pending') === 'failed')

    if (failedDeps.length > 0) {
      stuckStepIds.push(step.stepId)
      blockedStepIds.push(step.stepId)
    } else if (unfulfilledDeps.length === 0) {
      if (allocatedSlots < availableSlots) {
        runnableStepIds.push(step.stepId)
      } else {
        blockedStepIds.push(step.stepId)
      }
    } else {
      blockedStepIds.push(step.stepId)
    }
  }

  // 4. Deadlock determination
  let isDeadlocked = false
  let canProgress = true
  let deadlockReason: string | undefined

  if (cyclePaths.length > 0) {
    isDeadlocked = true
    canProgress = false
    const cycleStr = cyclePaths.map((c) => c.join(' -> ')).join('; ')
    deadlockReason = `Circular wait-for dependency cycle detected: ${cycleStr}`
  } else if (runningCount === 0 && runnableStepIds.length === 0 && blockedStepIds.length > 0) {
    // If no steps running, none can run, and pending steps remain
    isDeadlocked = true
    canProgress = false
    deadlockReason = `Execution stalemate: 0 steps running, 0 runnable steps, and ${String(blockedStepIds.length)} steps blocked indefinitely.`
  } else if (runnableStepIds.length > 0 || runningCount > 0) {
    canProgress = true
    isDeadlocked = false
  }

  const summary = isDeadlocked
    ? `DEADLOCK HAZARD: ${deadlockReason ?? 'Execution unable to progress.'} (Blocked: ${String(blockedStepIds.length)}, Cycles: ${String(cyclePaths.length)})`
    : `WORKFLOW NOMINAL: Can progress (Runnable: ${String(runnableStepIds.length)}, Running: ${String(runningCount)}, Blocked: ${String(blockedStepIds.length)}).`

  return {
    isDeadlocked,
    canProgress,
    runnableStepIds,
    blockedStepIds,
    cyclePaths,
    stuckStepIds,
    deadlockReason,
    summary,
  }
}
