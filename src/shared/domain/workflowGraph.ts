import { z } from 'zod'

/**
 * Node execution categories for generic Lego-piece workflows.
 */
export const nodeTypeSchema = z.enum(['agent', 'user_gate', 'verification', 'router'])
export type NodeType = z.infer<typeof nodeTypeSchema>

export const runtimeTypeSchema = z.enum(['forge-native', 'cli-agent', 'human', 'forge-engine'])
export type RuntimeType = z.infer<typeof runtimeTypeSchema>

export const artifactFormatSchema = z.enum(['markdown', 'diff', 'json', 'text'])
export type ArtifactFormat = z.infer<typeof artifactFormatSchema>

export const templateStatusSchema = z.enum(['draft', 'published', 'archived'])
export type TemplateStatus = z.infer<typeof templateStatusSchema>

/** Input slot schema defining data required by a node */
export const slotDefinitionSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.string().min(1),
  required: z.boolean().default(true),
  formHint: z.string().optional(),
  description: z.string().optional(),
})
export type SlotDefinition = z.infer<typeof slotDefinitionSchema>

/** Output contract schema defining deliverables produced by a node */
export const outputDefinitionSchema = z.strictObject({
  name: z.string().min(1),
  kind: z.string().min(1),
  format: artifactFormatSchema.default('markdown'),
  requiredH1: z.string().optional(),
  requiredSections: z.array(z.string()).readonly().default([]),
  description: z.string().optional(),
})
export type OutputDefinition = z.infer<typeof outputDefinitionSchema>

export const nodePositionSchema = z.strictObject({
  x: z.number(),
  y: z.number(),
})
export type NodePosition = z.infer<typeof nodePositionSchema>

export const nodeRuntimeConfigSchema = z.strictObject({
  agentExecutable: z.string().optional(),
  argsTemplate: z.string().optional(),
  providerId: z.string().optional(),
  modelId: z.string().optional(),
  systemPrompt: z.string().optional(),
  skills: z.array(z.string()).readonly().default([]),
  permissionMode: z.enum(['read-only', 'developer', 'full-access']).default('developer'),
})
export type NodeRuntimeConfig = z.infer<typeof nodeRuntimeConfigSchema>

export const workflowNodeSchema = z.strictObject({
  id: z.string().min(1),
  title: z.string().min(1),
  templateId: z.string().optional(),
  type: nodeTypeSchema,
  runtimeType: runtimeTypeSchema,
  config: nodeRuntimeConfigSchema.default({
    skills: [],
    permissionMode: 'developer',
  }),
  inputs: z.array(slotDefinitionSchema).readonly().default([]),
  outputs: z.array(outputDefinitionSchema).readonly().default([]),
  position: nodePositionSchema.optional(),
})
export type WorkflowNode = z.infer<typeof workflowNodeSchema>

export const workflowEdgeSchema = z.strictObject({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().optional(),
  target: z.string().min(1),
  targetHandle: z.string().optional(),
})
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>

export const workflowTemplateV2Schema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.number().int().positive().default(1),
  status: templateStatusSchema.default('draft'),
  category: z.string().default('General'),
  nodes: z.array(workflowNodeSchema).min(1).readonly(),
  edges: z.array(workflowEdgeSchema).readonly().default([]),
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
})
export type WorkflowTemplateV2 = z.infer<typeof workflowTemplateV2Schema>

export const workflowArtifactSchema = z.strictObject({
  id: z.string().min(1),
  workflowId: z.string().min(1),
  nodeId: z.string().min(1),
  stepIndex: z.number().int().nonnegative().optional(),
  kind: z.string().min(1),
  format: artifactFormatSchema,
  title: z.string().min(1),
  content: z.string(),
  metadata: z.record(z.string(), z.unknown()).readonly().default({}),
  createdAt: z.string().min(1),
})
export type WorkflowArtifact = z.infer<typeof workflowArtifactSchema>

/**
 * Error raised when a workflow DAG contains a cycle.
 */
export class WorkflowGraphCycleError extends Error {
  constructor(cycleNodeIds: readonly string[]) {
    super(`Workflow graph contains a cycle involving nodes: ${cycleNodeIds.join(' -> ')}`)
    this.name = 'WorkflowGraphCycleError'
  }
}

/**
 * Validates a workflow graph:
 * - All edge sources and targets must exist in nodes.
 * - Graph must be acyclic (DAG).
 */
export function validateWorkflowGraph(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): void {
  const nodeMap = new Map<string, WorkflowNode>(nodes.map((n) => [n.id, n]))

  for (const edge of edges) {
    if (!nodeMap.has(edge.source)) {
      throw new Error(`Edge "${edge.id}" references missing source node "${edge.source}"`)
    }
    if (!nodeMap.has(edge.target)) {
      throw new Error(`Edge "${edge.id}" references missing target node "${edge.target}"`)
    }
  }

  // Detect cycles using Tarjan / DFS
  getTopologicalSort(nodes, edges)
}

/**
 * Computes a valid topological execution order for the workflow nodes.
 * Throws WorkflowGraphCycleError if a cycle is detected.
 */
export function getTopologicalSort(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): readonly string[] {
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()

  for (const node of nodes) {
    inDegree.set(node.id, 0)
    adjacency.set(node.id, [])
  }

  for (const edge of edges) {
    // Only count unique edges between node pairs
    const targets = adjacency.get(edge.source)
    if (targets && !targets.includes(edge.target)) {
      targets.push(edge.target)
      inDegree.set(edge.target, (inDegree.get(edge.target) ?? 0) + 1)
    }
  }

  const queue: string[] = []
  for (const [nodeId, degree] of inDegree.entries()) {
    if (degree === 0) {
      queue.push(nodeId)
    }
  }

  const sorted: string[] = []
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined) break
    sorted.push(current)

    const neighbors = adjacency.get(current) ?? []
    for (const neighbor of neighbors) {
      const nextDegree = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, nextDegree)
      if (nextDegree === 0) {
        queue.push(neighbor)
      }
    }
  }

  if (sorted.length !== nodes.length) {
    const remaining = nodes.filter((n) => !sorted.includes(n.id)).map((n) => n.id)
    throw new WorkflowGraphCycleError(remaining)
  }

  return sorted
}

/**
 * Resolves which nodes in a DAG are currently ready to execute given the set of
 * already-completed node IDs.
 */
export function getReadyNodes(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  completedNodeIds: ReadonlySet<string>,
): readonly WorkflowNode[] {
  const incomingEdges = new Map<string, string[]>()

  for (const node of nodes) {
    incomingEdges.set(node.id, [])
  }

  for (const edge of edges) {
    incomingEdges.get(edge.target)?.push(edge.source)
  }

  const ready: WorkflowNode[] = []
  for (const node of nodes) {
    if (completedNodeIds.has(node.id)) {
      continue
    }

    const dependencies = incomingEdges.get(node.id) ?? []
    const allDependenciesMet = dependencies.every((depId) => completedNodeIds.has(depId))

    if (allDependenciesMet) {
      ready.push(node)
    }
  }

  return ready
}
