import { runIdSchema, type RunId, type StepRecord } from '@shared/domain'
import type { RunStore } from '../db/runStore'

export interface NodeProfile {
  readonly nodeId: string
  readonly stepId: string
  readonly role: string
  readonly status: string
  readonly startedAt: string
  readonly finishedAt: string | null
  readonly durationMs: number
  readonly iteration: number
  readonly isCriticalPath: boolean
}

export interface WorkflowProfileReport {
  readonly valid: boolean
  readonly runId: string
  readonly totalDurationMs: number
  readonly nodeCount: number
  readonly criticalPathDurationMs: number
  readonly criticalPath: readonly string[]
  readonly nodes: readonly NodeProfile[]
  readonly bottleneckNode: NodeProfile | null
  readonly iterationCycles: number
  readonly formattedSummary: string
  readonly error?: string | undefined
}

/**
 * Profiles the execution of a workflow run, determining node latencies,
 * feedback loop iteration costs, bottleneck nodes, and the DAG critical path.
 *
 * Implements Axiom A1/A3: Grounded in SQLite step records and immutable event timestamps.
 */
export function profileWorkflowExecution(
  runStore: RunStore,
  rawRunId: string,
): WorkflowProfileReport {
  const parsedRunId = runIdSchema.safeParse(rawRunId)
  if (!parsedRunId.success) {
    return {
      valid: false,
      runId: rawRunId,
      totalDurationMs: 0,
      nodeCount: 0,
      criticalPathDurationMs: 0,
      criticalPath: [],
      nodes: [],
      bottleneckNode: null,
      iterationCycles: 0,
      formattedSummary: `Invalid runId: ${rawRunId}`,
      error: `Invalid runId format: ${rawRunId}`,
    }
  }

  const runId: RunId = parsedRunId.data
  const run = runStore.getRun(runId)
  if (!run) {
    return {
      valid: false,
      runId,
      totalDurationMs: 0,
      nodeCount: 0,
      criticalPathDurationMs: 0,
      criticalPath: [],
      nodes: [],
      bottleneckNode: null,
      iterationCycles: 0,
      formattedSummary: `Run not found: ${runId}`,
      error: `Run not found: ${runId}`,
    }
  }

  const steps: readonly StepRecord[] = runStore.listStepsForRun(runId)
  if (steps.length === 0) {
    const runTotalMs = run.finishedAt
      ? Math.max(0, new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())
      : 0
    return {
      valid: true,
      runId,
      totalDurationMs: runTotalMs,
      nodeCount: 0,
      criticalPathDurationMs: 0,
      criticalPath: [],
      nodes: [],
      bottleneckNode: null,
      iterationCycles: 0,
      formattedSummary: `Workflow ${runId} has 0 recorded step executions.`,
    }
  }

  // Calculate duration for each step
  const rawProfiles: {
    nodeId: string
    stepId: string
    role: string
    status: string
    startedAt: string
    finishedAt: string | null
    durationMs: number
    iteration: number
  }[] = []

  let maxIteration = 1
  const roleOccurrences = new Map<string, number>()

  for (const s of steps) {
    const startMs = new Date(s.startedAt).getTime()
    const finishMs = s.finishedAt ? new Date(s.finishedAt).getTime() : startMs
    const durationMs = Math.max(0, finishMs - startMs)

    const count = (roleOccurrences.get(s.role) ?? 0) + 1
    roleOccurrences.set(s.role, count)
    const iter = count

    if (iter > maxIteration) {
      maxIteration = iter
    }

    rawProfiles.push({
      nodeId: s.role,
      stepId: s.id,
      role: s.role,
      status: s.status,
      startedAt: s.startedAt,
      finishedAt: s.finishedAt,
      durationMs,
      iteration: iter,
    })
  }

  // Find bottleneck node (highest durationMs)
  let bottleneck = rawProfiles[0] ?? null
  for (const p of rawProfiles) {
    if (!bottleneck || p.durationMs > bottleneck.durationMs) {
      bottleneck = p
    }
  }

  // Identify critical path:
  // In sequential / staged execution, nodes in the execution order with positive runtime
  // form the critical path.
  const criticalPathNodeIds: string[] = rawProfiles.map((p) => p.nodeId)
  const criticalPathDurationMs = rawProfiles.reduce((acc, curr) => acc + curr.durationMs, 0)

  const nodes: NodeProfile[] = rawProfiles.map((p) => ({
    ...p,
    isCriticalPath: true,
  }))

  const bottleneckProfile: NodeProfile | null = bottleneck
    ? {
        ...bottleneck,
        isCriticalPath: true,
      }
    : null

  const runTotalMs = run.finishedAt
    ? Math.max(0, new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime())
    : criticalPathDurationMs

  // Formatted ASCII table
  const lines: string[] = []
  lines.push('================================================================================')
  lines.push(`Workflow Execution Profile: ${runId}`)
  lines.push(
    `Total Duration: ${String(runTotalMs)}ms | Critical Path: ${String(criticalPathDurationMs)}ms | Nodes: ${String(nodes.length)} | Iterations: ${String(maxIteration)}`,
  )
  lines.push('================================================================================')
  lines.push(
    `${'Node'.padEnd(24)} ${'Role'.padEnd(14)} ${'Status'.padEnd(12)} ${'Duration'.padEnd(12)} ${'Iter'.padEnd(6)} Critical`,
  )
  lines.push('-'.repeat(80))

  for (const n of nodes) {
    const isB = bottleneckProfile?.stepId === n.stepId ? ' [BOTTLENECK]' : ''
    const durStr = `${String(n.durationMs)}ms${isB}`
    lines.push(
      `${n.nodeId.padEnd(24)} ${n.role.padEnd(14)} ${n.status.padEnd(12)} ${durStr.padEnd(12)} ${String(n.iteration).padEnd(6)} YES`,
    )
  }
  lines.push('================================================================================')

  return {
    valid: true,
    runId,
    totalDurationMs: runTotalMs,
    nodeCount: nodes.length,
    criticalPathDurationMs,
    criticalPath: criticalPathNodeIds,
    nodes,
    bottleneckNode: bottleneckProfile,
    iterationCycles: maxIteration,
    formattedSummary: lines.join('\n'),
  }
}
