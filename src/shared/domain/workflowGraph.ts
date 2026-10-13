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

export const loopPolicySchema = z.strictObject({
  maxIterations: z.number().int().positive().default(5),
  maxRepeatedStates: z.number().int().positive().default(1),
  maxNodeAttempts: z.number().int().positive().default(10),
})
export type LoopPolicy = z.infer<typeof loopPolicySchema>

export const workflowTemplateV2Schema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  version: z.number().int().positive().default(1),
  status: templateStatusSchema.default('draft'),
  category: z.string().default('General'),
  nodes: z.array(workflowNodeSchema).min(1).readonly(),
  edges: z.array(workflowEdgeSchema).readonly().default([]),
  loopPolicy: loopPolicySchema.optional(),
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
 * Calculates the set of node IDs belonging to the loop body for feedback edge s -> t.
 * Defined as: ReachableFromForward(t) ∩ CanReachForward(s)
 * in the forward graph G_F (edges where !isFeedback).
 */
export function getLoopBody(
  _nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  sourceNodeId: string,
  targetNodeId: string,
): ReadonlySet<string> {
  const forwardEdges = edges.filter((e) => !e.isFeedback)

  // 1. Forward reachability from targetNodeId
  const reachableFromTarget = new Set<string>()
  const forwardQueue: string[] = [targetNodeId]
  while (forwardQueue.length > 0) {
    const current = forwardQueue.shift()
    if (current !== undefined && !reachableFromTarget.has(current)) {
      reachableFromTarget.add(current)
      for (const edge of forwardEdges) {
        if (edge.source === current && !reachableFromTarget.has(edge.target)) {
          forwardQueue.push(edge.target)
        }
      }
    }
  }

  // 2. Backward reachability from sourceNodeId (nodes that can reach source)
  const canReachSource = new Set<string>()
  const backwardQueue: string[] = [sourceNodeId]
  while (backwardQueue.length > 0) {
    const current = backwardQueue.shift()
    if (current !== undefined && !canReachSource.has(current)) {
      canReachSource.add(current)
      for (const edge of forwardEdges) {
        if (edge.target === current && !canReachSource.has(edge.source)) {
          backwardQueue.push(edge.source)
        }
      }
    }
  }

  // 3. Intersection
  const loopBody = new Set<string>()
  for (const nodeId of reachableFromTarget) {
    if (canReachSource.has(nodeId)) {
      loopBody.add(nodeId)
    }
  }

  return loopBody
}

/**
 * Validates a workflow graph:
 * - All edge sources and targets must exist in nodes.
 * - Forward graph must be acyclic (DAG).
 * - Feedback edges must target a node that precedes the source topologically.
 * - Feedback loops must have valid loop bodies, forward exit paths, and be non-overlapping.
 * - Router and non-router edge configurations must follow declared branch schemas.
 */
export function validateWorkflowGraph(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
  loopPolicy?: LoopPolicy,
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

  // Validate feedback edges
  const feedbackEdges = edges.filter((e) => e.isFeedback)
  for (const edge of feedbackEdges) {
    if (edge.source === edge.target) {
      throw new Error(`Feedback edge "${edge.id}" cannot target itself ("${edge.source}")`)
    }

    const sourceIndex = sortedNodeIds.indexOf(edge.source)
    const targetIndex = sortedNodeIds.indexOf(edge.target)
    if (targetIndex >= sourceIndex) {
      throw new Error(
        `Feedback edge "${edge.id}" targets node "${edge.target}" which does not precede source node "${edge.source}" topologically`,
      )
    }

    // Validate loop body existence and reachability
    const loopBody = getLoopBody(nodes, edges, edge.source, edge.target)
    if (!loopBody.has(edge.source) || !loopBody.has(edge.target)) {
      throw new Error(
        `Feedback edge "${edge.id}" from "${edge.source}" to "${edge.target}" does not form a valid loop body; target cannot reach source in forward graph`,
      )
    }
  }

  // Validate that multiple feedback loops are neither nested nor overlapping
  for (let i = 0; i < feedbackEdges.length; i++) {
    for (let j = i + 1; j < feedbackEdges.length; j++) {
      const e1 = feedbackEdges[i]
      const e2 = feedbackEdges[j]
      if (!e1 || !e2) {
        continue
      }

      // Same head and same source is allowed (e.g. multiple conditional feedback edges from same router to same target)
      if (e1.source === e2.source && e1.target === e2.target) {
        continue
      }

      const b1 = getLoopBody(nodes, edges, e1.source, e1.target)
      const b2 = getLoopBody(nodes, edges, e2.source, e2.target)

      const overlap = Array.from(b1).filter((id) => b2.has(id))
      if (overlap.length > 0) {
        const isB1SubsetOfB2 = Array.from(b1).every((id) => b2.has(id))
        const isB2SubsetOfB1 = Array.from(b2).every((id) => b1.has(id))

        if (isB1SubsetOfB2 || isB2SubsetOfB1) {
          throw new Error(
            `Nested loops are not supported in workflow graph: feedback edge "${e1.id}" nests with "${e2.id}"`,
          )
        } else {
          throw new Error(
            `Overlapping loops are not supported in workflow graph: feedback edge "${e1.id}" overlaps with "${e2.id}"`,
          )
        }
      }
    }
  }

  // Validate loop policy if provided
  if (loopPolicy) {
    if (!Number.isInteger(loopPolicy.maxIterations) || loopPolicy.maxIterations <= 0) {
      throw new Error(
        `Invalid loop policy: maxIterations must be a positive integer, got ${String(loopPolicy.maxIterations)}`,
      )
    }
    if (!Number.isInteger(loopPolicy.maxRepeatedStates) || loopPolicy.maxRepeatedStates <= 0) {
      throw new Error(
        `Invalid loop policy: maxRepeatedStates must be a positive integer, got ${String(loopPolicy.maxRepeatedStates)}`,
      )
    }
    if (!Number.isInteger(loopPolicy.maxNodeAttempts) || loopPolicy.maxNodeAttempts <= 0) {
      throw new Error(
        `Invalid loop policy: maxNodeAttempts must be a positive integer, got ${String(loopPolicy.maxNodeAttempts)}`,
      )
    }
  }

  // Validate router and non-router edge configurations
  for (const node of nodes) {
    const outgoing = edges.filter((e) => e.source === node.id)
    const outgoingForward = outgoing.filter((e) => !e.isFeedback)

    if (node.type === 'router') {
      if (outgoing.length === 0) {
        throw new Error(`Router node "${node.id}" has no outgoing edges`)
      }

      const defaults = outgoing.filter((e) => e.isDefault)
      if (defaults.length > 1) {
        throw new Error(
          `Router node "${node.id}" declares multiple default outgoing edges: [${defaults.map((e) => e.id).join(', ')}]. At most one default edge is permitted.`,
        )
      }

      for (const edge of outgoing) {
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
