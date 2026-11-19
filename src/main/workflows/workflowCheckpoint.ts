/**
 * WORK-019: Workflow execution pause, resume, and checkpoint restore engine.
 * Captures execution snapshots and plans DAG resumption from completed frontiers (Axioms A1, A2).
 */

import { createHash, randomUUID } from 'node:crypto'

export interface WorkflowDAGNode {
  readonly id: string
  readonly name?: string | undefined
  readonly dependencies?: readonly string[] | undefined
  readonly handler?: string | undefined
}

export interface WorkflowDAG {
  readonly id: string
  readonly name?: string | undefined
  readonly nodes: readonly WorkflowDAGNode[]
}

export interface WorkflowCheckpoint {
  readonly checkpointId: string
  readonly runId: string
  readonly graphId: string
  readonly createdAt: string
  readonly completedNodeIds: readonly string[]
  readonly nodeOutputs: Record<string, unknown>
  readonly contextVariables: Record<string, unknown>
  readonly checksum: string
}

export interface WorkflowResumePlan {
  readonly valid: boolean
  readonly runId: string
  readonly graphId: string
  readonly checkpointId: string
  readonly completedCount: number
  readonly pendingCount: number
  readonly completedNodeIds: readonly string[]
  readonly pendingFrontierNodeIds: readonly string[]
  readonly remainingNodeIds: readonly string[]
  readonly restoredVariables: Record<string, unknown>
  readonly formattedSummary: string
  readonly error?: string | undefined
}

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function computeCheckpointChecksum(
  runId: string,
  graphId: string,
  completedNodeIds: readonly string[],
  contextVariables: Record<string, unknown>,
): string {
  const sortedIds = [...completedNodeIds].sort().join(',')
  const sortedVars = JSON.stringify(contextVariables, Object.keys(contextVariables).sort())
  return sha256(`${runId}:${graphId}:${sortedIds}:${sortedVars}`)
}

/**
 * Creates an immutable checkpoint of the active workflow state (Axioms A1, A4).
 */
export function createWorkflowCheckpoint(
  runId: string,
  graph: WorkflowDAG,
  completedNodeIds: readonly string[],
  nodeOutputs: Record<string, unknown> = {},
  contextVariables: Record<string, unknown> = {},
): WorkflowCheckpoint {
  const checkpointId = randomUUID()
  const createdAt = new Date().toISOString()
  const checksum = computeCheckpointChecksum(runId, graph.id, completedNodeIds, contextVariables)

  return {
    checkpointId,
    runId,
    graphId: graph.id,
    createdAt,
    completedNodeIds: [...completedNodeIds],
    nodeOutputs: { ...nodeOutputs },
    contextVariables: { ...contextVariables },
    checksum,
  }
}

/**
 * Plans the DAG resumption frontier based on a validated checkpoint (Axioms A2, A5).
 */
export function planWorkflowResume(
  checkpoint: WorkflowCheckpoint,
  graph: WorkflowDAG,
): WorkflowResumePlan {
  // Validate checksum integrity (Axiom A2 fail-closed)
  const expectedChecksum = computeCheckpointChecksum(
    checkpoint.runId,
    checkpoint.graphId,
    checkpoint.completedNodeIds,
    checkpoint.contextVariables,
  )

  if (checkpoint.checksum !== expectedChecksum) {
    const err = 'Checkpoint checksum mismatch: state has been tampered with or corrupted'
    return {
      valid: false,
      runId: checkpoint.runId,
      graphId: graph.id,
      checkpointId: checkpoint.checkpointId,
      completedCount: 0,
      pendingCount: graph.nodes.length,
      completedNodeIds: [],
      pendingFrontierNodeIds: [],
      remainingNodeIds: graph.nodes.map((n) => n.id),
      restoredVariables: {},
      formattedSummary: `RESUME FAILED: ${err}`,
      error: err,
    }
  }

  // Validate graph ID match
  if (checkpoint.graphId !== graph.id) {
    const err = `Graph ID mismatch: checkpoint belongs to graph "${checkpoint.graphId}", target is "${graph.id}"`
    return {
      valid: false,
      runId: checkpoint.runId,
      graphId: graph.id,
      checkpointId: checkpoint.checkpointId,
      completedCount: 0,
      pendingCount: graph.nodes.length,
      completedNodeIds: [],
      pendingFrontierNodeIds: [],
      remainingNodeIds: graph.nodes.map((n) => n.id),
      restoredVariables: {},
      formattedSummary: `RESUME FAILED: ${err}`,
      error: err,
    }
  }

  const allGraphNodeIds = new Set(graph.nodes.map((n) => n.id))
  const completedSet = new Set<string>()

  // Ensure completed nodes belong to this graph
  for (const id of checkpoint.completedNodeIds) {
    if (!allGraphNodeIds.has(id)) {
      const err = `Checkpoint references unknown node "${id}" not present in DAG`
      return {
        valid: false,
        runId: checkpoint.runId,
        graphId: graph.id,
        checkpointId: checkpoint.checkpointId,
        completedCount: 0,
        pendingCount: graph.nodes.length,
        completedNodeIds: [],
        pendingFrontierNodeIds: [],
        remainingNodeIds: graph.nodes.map((n) => n.id),
        restoredVariables: {},
        formattedSummary: `RESUME FAILED: ${err}`,
        error: err,
      }
    }
    completedSet.add(id)
  }

  const remainingNodes = graph.nodes.filter((n) => !completedSet.has(n.id))
  const frontierNodes: string[] = []

  // Frontier: remaining nodes whose dependencies are all satisfied
  for (const node of remainingNodes) {
    const deps = node.dependencies ?? []
    const allDepsMet = deps.every((dep) => completedSet.has(dep))
    if (allDepsMet) {
      frontierNodes.push(node.id)
    }
  }

  const lines = [
    `WORKFLOW RESUME PLAN: Graph "${graph.id}" (Run ${checkpoint.runId})`,
    `  Checkpoint: ${checkpoint.checkpointId} (${checkpoint.createdAt})`,
    `  Completed:  ${String(completedSet.size)} / ${String(graph.nodes.length)} nodes`,
    `  Remaining:  ${String(remainingNodes.length)} nodes`,
    `  Frontier:   ${frontierNodes.length > 0 ? frontierNodes.join(', ') : '(None - all nodes completed)'}`,
  ]

  return {
    valid: true,
    runId: checkpoint.runId,
    graphId: graph.id,
    checkpointId: checkpoint.checkpointId,
    completedCount: completedSet.size,
    pendingCount: remainingNodes.length,
    completedNodeIds: [...completedSet],
    pendingFrontierNodeIds: frontierNodes,
    remainingNodeIds: remainingNodes.map((n) => n.id),
    restoredVariables: { ...checkpoint.contextVariables },
    formattedSummary: lines.join('\n'),
  }
}
