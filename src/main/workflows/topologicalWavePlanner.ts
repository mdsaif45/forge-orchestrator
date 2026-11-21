/**
 * WORK-025: Workflow step dependency topological levelizer and execution wave planner.
 * Partitions workflow DAG nodes into sequential execution waves using Kahn's algorithm with critical path analysis (Axioms A1, A5).
 */

export interface WorkflowNodeDefinition {
  readonly id: string
  readonly dependencies?: readonly string[] | undefined
  readonly estimatedDurationMs?: number | undefined
}

export interface ExecutionWave {
  readonly waveIndex: number
  readonly nodeIds: readonly string[]
  readonly maxConcurrency: number
  readonly estimatedDurationMs: number
}

export interface WavePlanResult {
  readonly waves: readonly ExecutionWave[]
  readonly totalWaves: number
  readonly maxParallelWidth: number
  readonly criticalPath: readonly string[]
  readonly hasCycles: boolean
  readonly cycleNodes?: readonly string[] | undefined
  readonly formattedSummary: string
}

/**
 * Plans topological execution waves for a collection of workflow DAG nodes.
 */
export function planTopologicalWaves(
  nodes: readonly WorkflowNodeDefinition[],
  maxWaveConcurrency = 8,
): WavePlanResult {
  if (nodes.length === 0) {
    return {
      waves: [],
      totalWaves: 0,
      maxParallelWidth: 0,
      criticalPath: [],
      hasCycles: false,
      formattedSummary: '✓ Workflow graph is empty; 0 waves planned.',
    }
  }

  const nodeMap = new Map<string, WorkflowNodeDefinition>()
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  const durationMap = new Map<string, number>()

  for (const n of nodes) {
    nodeMap.set(n.id, n)
    inDegree.set(n.id, 0)
    dependents.set(n.id, [])
    durationMap.set(n.id, n.estimatedDurationMs ?? 1000)
  }

  for (const n of nodes) {
    const deps = n.dependencies ?? []
    for (const depId of deps) {
      if (!nodeMap.has(depId)) {
        // External or implicit dependency; register as virtual zero-in-degree node
        nodeMap.set(depId, { id: depId, dependencies: [] })
        inDegree.set(depId, 0)
        dependents.set(depId, [])
        durationMap.set(depId, 0)
      }
      inDegree.set(n.id, (inDegree.get(n.id) ?? 0) + 1)
      dependents.get(depId)?.push(n.id)
    }
  }

  // Levelization via Kahn's algorithm
  const waves: ExecutionWave[] = []
  const remainingInDegree = new Map(inDegree)
  let processedCount = 0

  while (true) {
    const currentWaveNodes: string[] = []
    for (const [id, deg] of remainingInDegree.entries()) {
      if (deg === 0) {
        currentWaveNodes.push(id)
      }
    }

    if (currentWaveNodes.length === 0) {
      break
    }

    // Sort alphabetically for deterministic ordering (A1)
    currentWaveNodes.sort()

    // Bounded concurrency per wave
    const effectiveWaveConcurrency = Math.min(currentWaveNodes.length, maxWaveConcurrency)

    // Compute max duration for this parallel wave
    let waveDuration = 0
    for (const id of currentWaveNodes) {
      const d = durationMap.get(id) ?? 1000
      if (d > waveDuration) waveDuration = d
    }

    waves.push({
      waveIndex: waves.length,
      nodeIds: currentWaveNodes,
      maxConcurrency: effectiveWaveConcurrency,
      estimatedDurationMs: waveDuration,
    })

    processedCount += currentWaveNodes.length

    // Decrement in-degree for dependents and remove current wave nodes
    for (const id of currentWaveNodes) {
      remainingInDegree.delete(id)
      const deps = dependents.get(id) ?? []
      for (const depId of deps) {
        const curDeg = remainingInDegree.get(depId)
        if (curDeg !== undefined) {
          remainingInDegree.set(depId, curDeg - 1)
        }
      }
    }
  }

  const hasCycles = processedCount < nodeMap.size
  const cycleNodes = hasCycles ? Array.from(remainingInDegree.keys()).sort() : undefined

  let maxParallelWidth = 0
  for (const w of waves) {
    if (w.nodeIds.length > maxParallelWidth) {
      maxParallelWidth = w.nodeIds.length
    }
  }

  // Compute critical path only for acyclic graphs
  const criticalPath = hasCycles ? [] : computeCriticalPath(nodeMap, durationMap)

  const summary = hasCycles
    ? `✗ Graph contains circular dependency cycle involving ${String(cycleNodes?.length ?? 0)} node(s): ${(cycleNodes ?? []).join(', ')}.`
    : `✓ Planned ${String(waves.length)} execution wave(s) for ${String(nodeMap.size)} node(s) (Max width: ${String(maxParallelWidth)}, Critical path: ${String(criticalPath.length)} steps).`

  return {
    waves,
    totalWaves: waves.length,
    maxParallelWidth,
    criticalPath,
    hasCycles,
    cycleNodes,
    formattedSummary: summary,
  }
}

function computeCriticalPath(
  nodeMap: Map<string, WorkflowNodeDefinition>,
  durationMap: Map<string, number>,
): string[] {
  const memo = new Map<string, { duration: number; path: string[] }>()
  const visiting = new Set<string>()

  function getLongestPath(id: string): { duration: number; path: string[] } {
    if (memo.has(id)) return memo.get(id)!
    if (visiting.has(id)) return { duration: 0, path: [] }

    visiting.add(id)
    const node = nodeMap.get(id)
    const ownDuration = durationMap.get(id) ?? 1000
    const deps = node?.dependencies ?? []

    if (deps.length === 0) {
      visiting.delete(id)
      const res = { duration: ownDuration, path: [id] }
      memo.set(id, res)
      return res
    }

    let bestDepResult: { duration: number; path: string[] } = { duration: 0, path: [] }
    for (const depId of deps) {
      if (nodeMap.has(depId)) {
        const depResult = getLongestPath(depId)
        if (depResult.duration > bestDepResult.duration) {
          bestDepResult = depResult
        }
      }
    }

    visiting.delete(id)
    const res = {
      duration: bestDepResult.duration + ownDuration,
      path: [...bestDepResult.path, id],
    }
    memo.set(id, res)
    return res
  }

  let overallBest: { duration: number; path: string[] } = { duration: 0, path: [] }
  for (const id of nodeMap.keys()) {
    const candidate = getLongestPath(id)
    if (candidate.duration > overallBest.duration) {
      overallBest = candidate
    }
  }

  return overallBest.path
}
