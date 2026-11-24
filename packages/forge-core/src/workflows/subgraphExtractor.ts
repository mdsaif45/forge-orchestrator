/**
 * WORK-021: Workflow step dependency topological sub-graph extractor and cycle isolator.
 * Isolates minimal dependency neighborhoods and pinpoints circular references in workflow DAGs (Axioms A1, A5).
 */

export type SubgraphDirection = 'upstream' | 'downstream' | 'both'

export interface SubgraphNodeSpec {
  readonly id: string
  readonly role?: string | undefined
}

export interface SubgraphEdgeSpec {
  readonly id?: string | undefined
  readonly source: string
  readonly target: string
  readonly isFeedback?: boolean | undefined
}

export interface GenericWorkflowGraphInput {
  readonly id?: string | undefined
  readonly nodes: readonly SubgraphNodeSpec[]
  readonly edges: readonly SubgraphEdgeSpec[]
}

export interface WorkflowSubgraphOptions {
  readonly direction?: SubgraphDirection | undefined
  readonly includeFeedbackEdges?: boolean | undefined
  readonly maxDepth?: number | undefined
}

export interface CycleIsolationReport {
  readonly hasCycle: boolean
  readonly cycleNodes: readonly string[]
  readonly cyclePath: readonly string[]
  readonly formattedSummary: string
}

export interface WorkflowSubgraphReport {
  readonly valid: boolean
  readonly targetNodeId: string
  readonly direction: SubgraphDirection
  readonly nodeCount: number
  readonly edgeCount: number
  readonly nodes: readonly SubgraphNodeSpec[]
  readonly edges: readonly SubgraphEdgeSpec[]
  readonly hasCycle: boolean
  readonly cyclePath?: readonly string[] | undefined
  readonly asciiDiagram: string
  readonly formattedSummary: string
  readonly error?: string | undefined
}

/**
 * Detects and isolates a directed cycle in an edge set, reconstructing the exact cycle loop sequence (Axioms A1, A5).
 */
export function isolateCyclePath(
  nodes: readonly SubgraphNodeSpec[],
  edges: readonly SubgraphEdgeSpec[],
): CycleIsolationReport {
  const nodeIds = new Set(nodes.map((n) => n.id))
  const adj = new Map<string, string[]>()
  for (const id of nodeIds) {
    adj.set(id, [])
  }
  for (const edge of edges) {
    if (!edge.isFeedback && nodeIds.has(edge.source) && nodeIds.has(edge.target)) {
      adj.get(edge.source)?.push(edge.target)
    }
  }

  // 0: unvisited, 1: visiting (in stack), 2: visited
  const state = new Map<string, 0 | 1 | 2>()
  const parent = new Map<string, string | null>()
  for (const id of nodeIds) {
    state.set(id, 0)
    parent.set(id, null)
  }

  function dfs(curr: string): string[] | null {
    state.set(curr, 1)

    const neighbors = adj.get(curr) ?? []
    for (const next of neighbors) {
      if (state.get(next) === 1) {
        // Back edge detected: reconstruct cycle from curr back to next
        const path: string[] = [next, curr]
        let p = parent.get(curr)
        while (p && p !== next) {
          path.push(p)
          p = parent.get(p)
        }
        path.push(next)
        path.reverse()
        return path
      }
      if (state.get(next) === 0) {
        parent.set(next, curr)
        const sub = dfs(next)
        if (sub) {
          return sub
        }
      }
    }

    state.set(curr, 2)
    return null
  }

  let cycleFound: string[] | null = null
  for (const id of nodeIds) {
    if (state.get(id) === 0) {
      const found = dfs(id)
      if (found) {
        cycleFound = found
        break
      }
    }
  }

  if (cycleFound !== null) {
    const cycleNodes: string[] = Array.from(new Set(cycleFound))
    return {
      hasCycle: true,
      cycleNodes,
      cyclePath: cycleFound,
      formattedSummary: `CYCLE ISOLATION AUDIT: Detected circular dependency sequence: ${cycleFound.join(' -> ')}`,
    }
  }

  return {
    hasCycle: false,
    cycleNodes: [],
    cyclePath: [],
    formattedSummary: 'CYCLE ISOLATION AUDIT: Clean DAG (0 cyclic loops detected).',
  }
}

/**
 * Extracts a topological neighborhood subgraph upstream, downstream, or bidirectional from a target node (Axioms A1, A5).
 */
export function extractWorkflowSubgraph(
  graph: GenericWorkflowGraphInput,
  targetNodeId: string,
  options: WorkflowSubgraphOptions = {},
): WorkflowSubgraphReport {
  const direction = options.direction ?? 'both'
  const includeFeedback = options.includeFeedbackEdges ?? false
  const maxDepth = options.maxDepth ?? 50

  const allNodeMap = new Map(graph.nodes.map((n) => [n.id, n]))
  if (!allNodeMap.has(targetNodeId)) {
    return {
      valid: false,
      targetNodeId,
      direction,
      nodeCount: 0,
      edgeCount: 0,
      nodes: [],
      edges: [],
      hasCycle: false,
      asciiDiagram: `Node "${targetNodeId}" does not exist in graph.`,
      formattedSummary: `ERROR: Target node "${targetNodeId}" not found in workflow graph.`,
      error: `Target node "${targetNodeId}" not found in graph`,
    }
  }

  // Filter edges based on feedback flag
  const candidateEdges = graph.edges.filter((e) => includeFeedback || !e.isFeedback)

  // Adjacency maps
  const incomingMap = new Map<string, string[]>()
  const outgoingMap = new Map<string, string[]>()
  for (const n of graph.nodes) {
    incomingMap.set(n.id, [])
    outgoingMap.set(n.id, [])
  }
  for (const e of candidateEdges) {
    outgoingMap.get(e.source)?.push(e.target)
    incomingMap.get(e.target)?.push(e.source)
  }

  const selectedNodeIds = new Set<string>([targetNodeId])

  // 1. Traverse upstream (predecessors)
  if (direction === 'upstream' || direction === 'both') {
    const queue: { id: string; depth: number }[] = [{ id: targetNodeId, depth: 0 }]
    const visited = new Set<string>([targetNodeId])

    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) break
      if (item.depth >= maxDepth) continue

      const predecessors = incomingMap.get(item.id) ?? []
      for (const pred of predecessors) {
        selectedNodeIds.add(pred)
        if (!visited.has(pred)) {
          visited.add(pred)
          queue.push({ id: pred, depth: item.depth + 1 })
        }
      }
    }
  }

  // 2. Traverse downstream (successors)
  if (direction === 'downstream' || direction === 'both') {
    const queue: { id: string; depth: number }[] = [{ id: targetNodeId, depth: 0 }]
    const visited = new Set<string>([targetNodeId])

    while (queue.length > 0) {
      const item = queue.shift()
      if (!item) break
      if (item.depth >= maxDepth) continue

      const successors = outgoingMap.get(item.id) ?? []
      for (const succ of successors) {
        selectedNodeIds.add(succ)
        if (!visited.has(succ)) {
          visited.add(succ)
          queue.push({ id: succ, depth: item.depth + 1 })
        }
      }
    }
  }

  // 3. Induced subgraph nodes and edges
  const subgraphNodes = graph.nodes.filter((n) => selectedNodeIds.has(n.id))
  const subgraphEdges = candidateEdges.filter(
    (e) => selectedNodeIds.has(e.source) && selectedNodeIds.has(e.target),
  )

  // 4. Cycle isolation check on induced subgraph
  const cycleAudit = isolateCyclePath(subgraphNodes, subgraphEdges)

  // 5. Generate ASCII diagram
  const asciiLines: string[] = [
    `=== WORKFLOW SUBGRAPH: ${targetNodeId} (${direction.toUpperCase()}) ===`,
    `Nodes: ${String(subgraphNodes.length)} | Edges: ${String(subgraphEdges.length)} | Acyclic: ${cycleAudit.hasCycle ? 'NO (CYCLE)' : 'YES'}`,
  ]

  if (cycleAudit.hasCycle) {
    asciiLines.push(`[!] Cycle sequence: ${cycleAudit.cyclePath.join(' -> ')}`)
  }

  for (const node of subgraphNodes) {
    const isTarget = node.id === targetNodeId ? ' [TARGET]' : ''
    const role = node.role ? ` (role: ${node.role})` : ''
    const incoming = subgraphEdges.filter((e) => e.target === node.id).map((e) => e.source)
    const outgoing = subgraphEdges.filter((e) => e.source === node.id).map((e) => e.target)

    asciiLines.push(`  • [${node.id}]${isTarget}${role}`)
    if (incoming.length > 0) {
      asciiLines.push(`      <- deps: ${incoming.join(', ')}`)
    }
    if (outgoing.length > 0) {
      asciiLines.push(`      -> leads: ${outgoing.join(', ')}`)
    }
  }

  const formattedSummary = [
    'WORKFLOW SUBGRAPH EXTRACTION (WORK-021):',
    `  Target Node:  ${targetNodeId}`,
    `  Direction:    ${direction}`,
    `  Node Count:   ${String(subgraphNodes.length)}`,
    `  Edge Count:   ${String(subgraphEdges.length)}`,
    `  Has Cycle:    ${cycleAudit.hasCycle ? 'YES' : 'NO'}`,
    cycleAudit.hasCycle ? `  Cycle Path:   ${cycleAudit.cyclePath.join(' -> ')}` : '',
  ]
    .filter(Boolean)
    .join('\n')

  return {
    valid: true,
    targetNodeId,
    direction,
    nodeCount: subgraphNodes.length,
    edgeCount: subgraphEdges.length,
    nodes: subgraphNodes,
    edges: subgraphEdges,
    hasCycle: cycleAudit.hasCycle,
    cyclePath: cycleAudit.hasCycle ? cycleAudit.cyclePath : undefined,
    asciiDiagram: asciiLines.join('\n'),
    formattedSummary,
  }
}
