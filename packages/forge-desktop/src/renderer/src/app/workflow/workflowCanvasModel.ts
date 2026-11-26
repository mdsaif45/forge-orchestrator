import {
  getTopologicalSort,
  validateWorkflowGraph,
  WorkflowGraphCycleError,
  workflowTemplateV2Schema,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowTemplateV2,
} from '@shared/domain'
import type { WorkflowEdgeView, WorkflowTemplateV2View } from '@shared/ipc'

export interface SerializedCanvasSchema {
  readonly valid: boolean
  readonly template: WorkflowTemplateV2 | null
  readonly json: string
  readonly topologicalOrder: readonly string[] | null
  readonly errors: readonly string[]
}

/**
 * Checks whether adding a directed forward edge `sourceId -> targetId` would create a cycle
 * or duplicate an existing edge on the workflow canvas.
 */
export function wouldEdgeCreateCycle(
  edges: readonly {
    readonly source: string
    readonly target: string
    readonly isFeedback?: boolean | undefined
  }[],
  sourceId: string,
  targetId: string,
): boolean {
  if (sourceId === targetId) {
    return true
  }

  // Forward edges form a DAG; if sourceId is already reachable from targetId, adding source->target closes a cycle.
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (edge.isFeedback) {
      continue
    }
    const targets = adjacency.get(edge.source)
    if (targets) {
      targets.push(edge.target)
    } else {
      adjacency.set(edge.source, [edge.target])
    }
  }

  const visited = new Set<string>()
  const queue: string[] = [targetId]
  while (queue.length > 0) {
    const current = queue.shift()
    if (current === undefined || visited.has(current)) {
      continue
    }
    if (current === sourceId) {
      return true
    }
    visited.add(current)
    for (const next of adjacency.get(current) ?? []) {
      if (!visited.has(next)) {
        queue.push(next)
      }
    }
  }

  return false
}

export function hasDuplicateEdge(
  edges: readonly WorkflowEdgeView[],
  sourceId: string,
  targetId: string,
  sourceHandle?: string,
  targetHandle?: string,
): boolean {
  return edges.some(
    (e) =>
      e.source === sourceId &&
      e.target === targetId &&
      (e.sourceHandle ?? '') === (sourceHandle ?? '') &&
      (e.targetHandle ?? '') === (targetHandle ?? ''),
  )
}

/**
 * Converts and validates visual WorkflowCanvas state against the canonical WorkflowTemplateV2 DAG schema.
 */
export function serializeCanvasToWorkflowSchema(
  view: WorkflowTemplateV2View,
): SerializedCanvasSchema {
  const normalizedNodes: WorkflowNode[] = view.nodes.map((node) => ({
    id: node.id,
    title: node.title,
    type: node.type,
    runtimeType: node.runtimeType,
    config: {
      skills: [...node.config.skills],
      permissionMode: node.config.permissionMode,
      ...(node.config.agentExecutable !== undefined
        ? { agentExecutable: node.config.agentExecutable }
        : {}),
      ...(node.config.argsTemplate !== undefined ? { argsTemplate: node.config.argsTemplate } : {}),
      ...(node.config.providerId !== undefined ? { providerId: node.config.providerId } : {}),
      ...(node.config.modelId !== undefined ? { modelId: node.config.modelId } : {}),
      ...(node.config.systemPrompt !== undefined ? { systemPrompt: node.config.systemPrompt } : {}),
    },
    inputs: node.inputs.map((slot) => ({
      name: slot.name,
      kind: slot.kind,
      required: slot.required,
      ...(slot.formHint !== undefined ? { formHint: slot.formHint } : {}),
      ...(slot.description !== undefined ? { description: slot.description } : {}),
    })),
    outputs: node.outputs.map((out) => ({
      name: out.name,
      kind: out.kind,
      format: out.format,
      requiredSections: [...out.requiredSections],
    })),
    ...(node.position !== undefined ? { position: node.position } : {}),
  }))

  const normalizedEdges: WorkflowEdge[] = view.edges.map((edge) => ({
    id: edge.id,
    source: edge.source,
    target: edge.target,
    ...(edge.sourceHandle !== undefined ? { sourceHandle: edge.sourceHandle } : {}),
    ...(edge.targetHandle !== undefined ? { targetHandle: edge.targetHandle } : {}),
  }))

  const parsed = workflowTemplateV2Schema.safeParse({
    id: view.id,
    name: view.name,
    description: view.description,
    version: view.version,
    status: view.status,
    category: view.category,
    nodes: normalizedNodes,
    edges: normalizedEdges,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  })

  if (!parsed.success) {
    return {
      valid: false,
      template: null,
      json: JSON.stringify(view, null, 2),
      topologicalOrder: null,
      errors: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
    }
  }

  try {
    validateWorkflowGraph(parsed.data.nodes, parsed.data.edges, parsed.data.loopPolicy)
    const topologicalOrder = getTopologicalSort(parsed.data.nodes, parsed.data.edges)
    return {
      valid: true,
      template: parsed.data,
      json: JSON.stringify(parsed.data, null, 2),
      topologicalOrder,
      errors: [],
    }
  } catch (err) {
    const msg =
      err instanceof WorkflowGraphCycleError || err instanceof Error ? err.message : String(err)
    return {
      valid: false,
      template: null,
      json: JSON.stringify(parsed.data, null, 2),
      topologicalOrder: null,
      errors: [msg],
    }
  }
}
