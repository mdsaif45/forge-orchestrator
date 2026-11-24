/**
 * WORK-020: Workflow DAG execution dry-run simulator and critical path analyzer.
 * Calculates stage parallelization limits, projected execution durations, and critical path bottlenecks (Axioms A1, A5).
 */

export interface SimulationNodeSpec {
  readonly id: string
  readonly estimatedDurationMs?: number | undefined
  readonly dependencies?: readonly string[] | undefined
}

export interface WorkflowSimulationDAG {
  readonly id: string
  readonly nodes: readonly SimulationNodeSpec[]
}

export interface SimulatedStepNode {
  readonly id: string
  readonly estimatedDurationMs: number
  readonly dependencies: readonly string[]
  readonly stageIndex: number
  readonly earliestStartMs: number
  readonly earliestFinishMs: number
  readonly isCriticalPath: boolean
}

export interface WorkflowSimulationReport {
  readonly valid: boolean
  readonly graphId: string
  readonly totalNodes: number
  readonly criticalPathDurationMs: number
  readonly criticalPathNodeIds: readonly string[]
  readonly parallelStages: readonly (readonly string[])[]
  readonly maxConcurrentWorkers: number
  readonly nodes: readonly SimulatedStepNode[]
  readonly formattedSummary: string
  readonly error?: string | undefined
}

const DEFAULT_ESTIMATED_DURATION_MS = 1000

/**
 * Simulates workflow DAG execution to compute topological stages, critical path, and duration bounds (Axioms A1, A5).
 */
export function simulateWorkflowExecution(dag: WorkflowSimulationDAG): WorkflowSimulationReport {
  if (dag.nodes.length === 0) {
    return {
      valid: false,
      graphId: dag.id,
      totalNodes: 0,
      criticalPathDurationMs: 0,
      criticalPathNodeIds: [],
      parallelStages: [],
      maxConcurrentWorkers: 0,
      nodes: [],
      formattedSummary: 'WORKFLOW SIMULATION FAILED: DAG contains no nodes',
      error: 'DAG contains no nodes',
    }
  }

  const nodeMap = new Map<string, SimulationNodeSpec>()
  for (const n of dag.nodes) {
    if (nodeMap.has(n.id)) {
      return {
        valid: false,
        graphId: dag.id,
        totalNodes: dag.nodes.length,
        criticalPathDurationMs: 0,
        criticalPathNodeIds: [],
        parallelStages: [],
        maxConcurrentWorkers: 0,
        nodes: [],
        formattedSummary: `WORKFLOW SIMULATION FAILED: Duplicate node ID "${n.id}"`,
        error: `Duplicate node ID "${n.id}"`,
      }
    }
    nodeMap.set(n.id, n)
  }

  // Validate dependency references
  for (const n of dag.nodes) {
    for (const dep of n.dependencies ?? []) {
      if (!nodeMap.has(dep)) {
        return {
          valid: false,
          graphId: dag.id,
          totalNodes: dag.nodes.length,
          criticalPathDurationMs: 0,
          criticalPathNodeIds: [],
          parallelStages: [],
          maxConcurrentWorkers: 0,
          nodes: [],
          formattedSummary: `WORKFLOW SIMULATION FAILED: Node "${n.id}" references missing dependency "${dep}"`,
          error: `Missing dependency "${dep}"`,
        }
      }
    }
  }

  // Detect cycles using in-degree topological sort (Kahn's algorithm)
  const inDegree = new Map<string, number>()
  const adjList = new Map<string, string[]>()
  for (const n of dag.nodes) {
    inDegree.set(n.id, 0)
    adjList.set(n.id, [])
  }

  for (const n of dag.nodes) {
    for (const dep of n.dependencies ?? []) {
      const list = adjList.get(dep)
      if (list) {
        list.push(n.id)
      }
      inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1)
    }
  }

  const queue: string[] = []
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(id)
    }
  }

  const topoOrder: string[] = []
  while (queue.length > 0) {
    const curr = queue.shift()
    if (!curr) break
    topoOrder.push(curr)

    for (const next of adjList.get(curr) ?? []) {
      const newDeg = (inDegree.get(next) ?? 1) - 1
      inDegree.set(next, newDeg)
      if (newDeg === 0) {
        queue.push(next)
      }
    }
  }

  if (topoOrder.length !== dag.nodes.length) {
    return {
      valid: false,
      graphId: dag.id,
      totalNodes: dag.nodes.length,
      criticalPathDurationMs: 0,
      criticalPathNodeIds: [],
      parallelStages: [],
      maxConcurrentWorkers: 0,
      nodes: [],
      formattedSummary: 'WORKFLOW SIMULATION FAILED: Cycle detected in workflow DAG',
      error: 'Cycle detected in workflow DAG',
    }
  }

  // Compute earliest start/finish times and stage indices
  const nodeSimMap = new Map<
    string,
    {
      stageIndex: number
      earliestStartMs: number
      earliestFinishMs: number
      durationMs: number
      dependencies: string[]
    }
  >()

  for (const id of topoOrder) {
    const spec = nodeMap.get(id)
    const durationMs = spec?.estimatedDurationMs ?? DEFAULT_ESTIMATED_DURATION_MS
    const deps = spec?.dependencies ? [...spec.dependencies] : []

    let maxDepFinish = 0
    let maxDepStage = -1

    for (const dep of deps) {
      const depSim = nodeSimMap.get(dep)
      if (depSim) {
        if (depSim.earliestFinishMs > maxDepFinish) {
          maxDepFinish = depSim.earliestFinishMs
        }
        if (depSim.stageIndex > maxDepStage) {
          maxDepStage = depSim.stageIndex
        }
      }
    }

    const earliestStartMs = maxDepFinish
    const earliestFinishMs = earliestStartMs + durationMs
    const stageIndex = maxDepStage + 1

    nodeSimMap.set(id, {
      stageIndex,
      earliestStartMs,
      earliestFinishMs,
      durationMs,
      dependencies: deps,
    })
  }

  // Find terminal node with max finish time
  let maxDuration = 0
  let terminalNodeId: string | null = null

  for (const [id, sim] of nodeSimMap.entries()) {
    if (sim.earliestFinishMs >= maxDuration) {
      maxDuration = sim.earliestFinishMs
      terminalNodeId = id
    }
  }

  // Trace back critical path
  const criticalPathSet = new Set<string>()
  const criticalPathList: string[] = []
  let currId = terminalNodeId

  while (currId) {
    criticalPathSet.add(currId)
    criticalPathList.unshift(currId)
    const currSim = nodeSimMap.get(currId)
    if (!currSim || currSim.dependencies.length === 0) {
      break
    }

    // Find the predecessor that caused this start time
    let criticalPredecessor: string | null = null
    for (const dep of currSim.dependencies) {
      const depSim = nodeSimMap.get(dep)
      if (depSim?.earliestFinishMs === currSim.earliestStartMs) {
        criticalPredecessor = dep
        break
      }
    }
    currId = criticalPredecessor
  }

  // Construct simulated node objects
  const simulatedNodes: SimulatedStepNode[] = []
  const stageMap = new Map<number, string[]>()

  for (const id of topoOrder) {
    const sim = nodeSimMap.get(id)
    if (!sim) continue
    simulatedNodes.push({
      id,
      estimatedDurationMs: sim.durationMs,
      dependencies: sim.dependencies,
      stageIndex: sim.stageIndex,
      earliestStartMs: sim.earliestStartMs,
      earliestFinishMs: sim.earliestFinishMs,
      isCriticalPath: criticalPathSet.has(id),
    })

    const stageList = stageMap.get(sim.stageIndex) ?? []
    stageList.push(id)
    stageMap.set(sim.stageIndex, stageList)
  }

  const maxStage = Math.max(...Array.from(stageMap.keys()), 0)
  const parallelStages: (readonly string[])[] = []
  let maxConcurrency = 0

  for (let s = 0; s <= maxStage; s++) {
    const stageNodes = stageMap.get(s) ?? []
    if (stageNodes.length > 0) {
      parallelStages.push(stageNodes)
      if (stageNodes.length > maxConcurrency) {
        maxConcurrency = stageNodes.length
      }
    }
  }

  const lines = [
    '================================================================================',
    `WORKFLOW DAG SIMULATION REPORT: ${dag.id}`,
    '================================================================================',
    `Total Nodes:            ${String(dag.nodes.length)}`,
    `Parallel Stages:        ${String(parallelStages.length)} stages`,
    `Max Concurrency:        ${String(maxConcurrency)} parallel workers`,
    `Projected Duration:     ${String(maxDuration)}ms`,
    `Critical Path:          ${criticalPathList.join(' -> ')}`,
    '================================================================================',
    'Stage Concurrency Breakdown:',
  ]

  for (const [idx, stage] of parallelStages.entries()) {
    lines.push(`  Stage ${String(idx + 1)} (${String(stage.length)} nodes): ${stage.join(', ')}`)
  }

  return {
    valid: true,
    graphId: dag.id,
    totalNodes: dag.nodes.length,
    criticalPathDurationMs: maxDuration,
    criticalPathNodeIds: criticalPathList,
    parallelStages,
    maxConcurrentWorkers: maxConcurrency,
    nodes: simulatedNodes,
    formattedSummary: lines.join('\n'),
  }
}
