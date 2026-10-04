import { z } from 'zod'
import { roleSchema } from './enums'
import { changeSetIdSchema, timestampSchema, workflowIdSchema } from './ids'

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
  role: roleSchema.optional(),
  timeoutMs: z.number().int().positive().optional(),
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

export const conditionOperatorSchema = z.enum([
  'eq',
  'neq',
  'gt',
  'gte',
  'lt',
  'lte',
  'in',
  'not_in',
  'exists',
])
export type ConditionOperator = z.infer<typeof conditionOperatorSchema>

export const edgePredicateSchema = z.strictObject({
  ref: z.string().min(1),
  operator: conditionOperatorSchema,
  value: z
    .union([
      z.string(),
      z.number(),
      z.boolean(),
      z.array(z.string()),
      z.array(z.number()),
      z.null(),
    ])
    .optional(),
})
export type EdgePredicate = z.infer<typeof edgePredicateSchema>

export const edgeConditionSchema = z.strictObject({
  mode: z.enum(['all', 'any']).default('all'),
  predicates: z.array(edgePredicateSchema).min(1),
})
export type EdgeCondition = z.infer<typeof edgeConditionSchema>

export const workflowEdgeSchema = z.strictObject({
  id: z.string().min(1),
  source: z.string().min(1),
  sourceHandle: z.string().optional(),
  target: z.string().min(1),
  targetHandle: z.string().optional(),
  isFeedback: z.boolean().optional(),
  condition: edgeConditionSchema.optional(),
  isDefault: z.boolean().optional(),
})
export type WorkflowEdge = z.infer<typeof workflowEdgeSchema>

export const graphRunStatusSchema = z.enum([
  'running',
  'completed',
  'failed',
  'halted',
  'cancelled',
])
export type GraphRunStatus = z.infer<typeof graphRunStatusSchema>

export const nodeStatusSchema = z.enum([
  'pending',
  'ready',
  'running',
  'completed',
  'failed',
  'skipped',
  'blocked',
  'cancelled',
])
export type NodeStatus = z.infer<typeof nodeStatusSchema>

export const graphRunSchema = z.strictObject({
  id: z.string().min(1),
  workflowId: workflowIdSchema,
  templateId: z.string().min(1),
  status: graphRunStatusSchema,
  iteration: z.number().int().positive().default(1),
  startedAt: timestampSchema,
  finishedAt: timestampSchema.nullable().default(null),
  haltReason: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
})
export type GraphRun = z.infer<typeof graphRunSchema>

export const graphNodeRunSchema = z.strictObject({
  id: z.string().min(1),
  graphRunId: z.string().min(1),
  nodeId: z.string().min(1),
  attempt: z.number().int().positive().default(1),
  iteration: z.number().int().positive().default(1),
  status: nodeStatusSchema,
  role: roleSchema.nullable().default(null),
  runtimeId: z.string().nullable().default(null),
  contextRef: z.string().nullable().default(null),
  changeSetId: changeSetIdSchema.nullable().default(null),
  evidenceId: z.string().nullable().default(null),
  startedAt: timestampSchema.nullable().default(null),
  finishedAt: timestampSchema.nullable().default(null),
  error: z.string().nullable().default(null),
})
export type GraphNodeRun = z.infer<typeof graphNodeRunSchema>

export const graphTransitionSchema = z.strictObject({
  id: z.string().min(1),
  graphRunId: z.string().min(1),
  sourceNodeId: z.string().min(1),
  sourceAttempt: z.number().int().positive(),
  targetNodeId: z.string().min(1),
  targetAttempt: z.number().int().positive(),
  fromIteration: z.number().int().positive(),
  toIteration: z.number().int().positive(),
  checkpointId: z.string().nullable().default(null),
  occurredAt: timestampSchema,
})
export type GraphTransition = z.infer<typeof graphTransitionSchema>

export const graphStateSnapshotSchema = z.strictObject({
  readyNodeIds: z.array(z.string()).readonly().default([]),
  runningNodeIds: z.array(z.string()).readonly().default([]),
  completedNodeIds: z.array(z.string()).readonly().default([]),
  blockedNodeIds: z.array(z.string()).readonly().default([]),
  skippedNodeIds: z.array(z.string()).readonly().optional(),
})
export type GraphStateSnapshot = z.infer<typeof graphStateSnapshotSchema>

export const graphCheckpointSchema = z.strictObject({
  id: z.string().min(1),
  graphRunId: z.string().min(1),
  nodeId: z.string().min(1),
  operation: z.string().min(1),
  stateSnapshot: graphStateSnapshotSchema,
  occurredAt: timestampSchema,
})
export type GraphCheckpoint = z.infer<typeof graphCheckpointSchema>

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
 * - Forward graph must be acyclic (DAG).
 * - Feedback edges must target a node that precedes the source topologically.
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

  // Detect cycles in forward DAG
  const sortedNodeIds = getTopologicalSort(nodes, edges)

  // Validate feedback edges: target must precede source topologically
  const feedbackEdges = edges.filter((e) => e.isFeedback)
  for (const edge of feedbackEdges) {
    const sourceIndex = sortedNodeIds.indexOf(edge.source)
    const targetIndex = sortedNodeIds.indexOf(edge.target)
    if (targetIndex >= sourceIndex) {
      throw new Error(
        `Feedback edge "${edge.id}" targets node "${edge.target}" which does not precede source node "${edge.source}" topologically`,
      )
    }
  }

  // Validate router and non-router edge configurations
  for (const node of nodes) {
    const outgoingForward = edges.filter((e) => e.source === node.id && !e.isFeedback)

    if (node.type === 'router') {
      if (outgoingForward.length === 0) {
        throw new Error(`Router node "${node.id}" has no outgoing edges`)
      }

      const defaults = outgoingForward.filter((e) => e.isDefault)
      if (defaults.length > 1) {
        throw new Error(
          `Router node "${node.id}" declares multiple default outgoing edges: [${defaults.map((e) => e.id).join(', ')}]. At most one default edge is permitted.`,
        )
      }

      for (const edge of outgoingForward) {
        if (edge.condition && edge.isDefault) {
          throw new Error(
            `Edge "${edge.id}" from router "${node.id}" cannot specify both condition and isDefault: true`,
          )
        }
        if (!edge.condition && !edge.isDefault) {
          throw new Error(
            `Edge "${edge.id}" from router "${node.id}" must specify either a condition or isDefault: true`,
          )
        }
      }
    } else {
      for (const edge of outgoingForward) {
        if (edge.condition) {
          throw new Error(
            `Edge "${edge.id}" from non-router node "${node.id}" cannot declare a condition. Only router nodes support conditional branching.`,
          )
        }
        if (edge.isDefault) {
          throw new Error(
            `Edge "${edge.id}" from non-router node "${node.id}" cannot be marked isDefault. Only router nodes support default branching.`,
          )
        }
      }
    }
  }
}

/**
 * Computes a valid topological execution order for the forward workflow nodes.
 * Filters out feedback edges (isFeedback: true) so they do not produce false cycles.
 * Throws WorkflowGraphCycleError if a cycle is detected in the forward DAG.
 */
export function getTopologicalSort(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): readonly string[] {
  const forwardEdges = edges.filter((e) => !e.isFeedback)
  const inDegree = new Map<string, number>()
  const adjacency = new Map<string, string[]>()

  for (const node of nodes) {
    inDegree.set(node.id, 0)
    adjacency.set(node.id, [])
  }

  for (const edge of forwardEdges) {
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
 * already-completed and skipped node IDs. Feedback edges do not block initial node readiness.
 * Sequencing dependency satisfaction evaluates: finishedNodeIds = completedNodeIds ∪ skippedNodeIds.
 */
export function getReadyNodes(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  completedNodeIds: ReadonlySet<string>,
  skippedNodeIds: ReadonlySet<string> = new Set<string>(),
): readonly WorkflowNode[] {
  const forwardEdges = edges.filter((e) => !e.isFeedback)
  const incomingEdges = new Map<string, string[]>()

  for (const node of nodes) {
    incomingEdges.set(node.id, [])
  }

  for (const edge of forwardEdges) {
    incomingEdges.get(edge.target)?.push(edge.source)
  }

  const finishedNodeIds = new Set<string>([...completedNodeIds, ...skippedNodeIds])

  const ready: WorkflowNode[] = []
  for (const node of nodes) {
    if (finishedNodeIds.has(node.id)) {
      continue
    }

    const dependencies = incomingEdges.get(node.id) ?? []
    const allDependenciesMet = dependencies.every((depId) => finishedNodeIds.has(depId))

    if (allDependenciesMet) {
      ready.push(node)
    }
  }

  return ready
}
