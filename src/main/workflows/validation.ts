import {
  getTopologicalSort,
  validateWorkflowGraph,
  WorkflowGraphCycleError,
  workflowTemplateV2Schema,
  type WorkflowTemplateV2,
} from '@shared/domain'

export interface TemplateValidationMetrics {
  readonly nodeCount: number
  readonly edgeCount: number
  readonly feedbackLoopCount: number
  readonly terminalCount: number
}

export interface TemplateValidationResult {
  readonly valid: boolean
  readonly errors: readonly string[]
  readonly warnings: readonly string[]
  readonly topologicalOrder: readonly string[] | null
  readonly metrics: TemplateValidationMetrics
}

/**
 * Performs deep static validation of a WorkflowTemplateV2 DAG topology,
 * ensuring acyclicity, reachability, bounded loops (Axiom A5), role definitions,
 * and edge consistency before execution.
 */
export function validateTemplateGraph(template: unknown): TemplateValidationResult {
  const errors: string[] = []
  const warnings: string[] = []

  // 1. Schema-level validation
  const parsed = workflowTemplateV2Schema.safeParse(template)
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      errors.push(`Schema error at ${issue.path.join('.') || 'root'}: ${issue.message}`)
    }
    return {
      valid: false,
      errors,
      warnings,
      topologicalOrder: null,
      metrics: {
        nodeCount: 0,
        edgeCount: 0,
        feedbackLoopCount: 0,
        terminalCount: 0,
      },
    }
  }

  const tmpl: WorkflowTemplateV2 = parsed.data
  const nodes = tmpl.nodes
  const edges = tmpl.edges
  const forwardEdges = edges.filter((e) => !e.isFeedback)
  const feedbackEdges = edges.filter((e) => e.isFeedback)

  const incomingForward = new Map<string, string[]>()
  const outgoingForward = new Map<string, string[]>()

  for (const node of nodes) {
    incomingForward.set(node.id, [])
    outgoingForward.set(node.id, [])
  }

  for (const edge of forwardEdges) {
    incomingForward.get(edge.target)?.push(edge.source)
    outgoingForward.get(edge.source)?.push(edge.target)
  }

  // 2. Topology and DAG validation
  let topologicalOrder: readonly string[] | null = null
  try {
    validateWorkflowGraph(nodes, edges, tmpl.loopPolicy)
    topologicalOrder = getTopologicalSort(nodes, edges)
  } catch (err) {
    if (err instanceof WorkflowGraphCycleError) {
      errors.push(`Cycle detected in forward DAG: ${err.message}`)
    } else if (err instanceof Error) {
      errors.push(`Topology error: ${err.message}`)
    } else {
      errors.push(`Unknown topology validation error`)
    }
  }

  // 3. Root and Terminal Sink Analysis
  const rootNodes = nodes.filter((n) => (incomingForward.get(n.id)?.length ?? 0) === 0)
  const terminalNodes = nodes.filter((n) => (outgoingForward.get(n.id)?.length ?? 0) === 0)

  if (nodes.length > 0 && rootNodes.length === 0) {
    errors.push('No root node found: graph has no entry node with zero incoming forward edges')
  }

  if (nodes.length > 0 && terminalNodes.length === 0) {
    errors.push('No terminal node found: graph has no sink node with zero outgoing forward edges')
  }

  // Check for orphan / isolated nodes
  for (const node of nodes) {
    const inCount =
      (incomingForward.get(node.id)?.length ?? 0) +
      edges.filter((e) => e.target === node.id && e.isFeedback).length
    const outCount =
      (outgoingForward.get(node.id)?.length ?? 0) +
      edges.filter((e) => e.source === node.id && e.isFeedback).length
    if (nodes.length > 1 && inCount === 0 && outCount === 0) {
      warnings.push(`Isolated node "${node.id}" has no incoming or outgoing edges`)
    }
  }

  // 4. Role & Node Contract Check
  for (const node of nodes) {
    if (node.type === 'agent') {
      const role = node.config.role
      if (!role || typeof role !== 'string' || role.trim().length === 0) {
        warnings.push(`Node "${node.id}" (${node.type}) specifies no execution role in config.role`)
      }
    }
  }

  // 5. Loop Policy Boundedness Check (Axiom A5)
  if (feedbackEdges.length > 0) {
    if (!tmpl.loopPolicy) {
      warnings.push(
        `Template contains ${String(feedbackEdges.length)} feedback loop(s) but defines no explicit loopPolicy; defaults will apply (maxIterations: 5)`,
      )
    } else if (tmpl.loopPolicy.maxIterations > 20) {
      warnings.push(
        `loopPolicy.maxIterations (${String(tmpl.loopPolicy.maxIterations)}) exceeds recommended bounded ceiling (20)`,
      )
    }
  }

  const metrics: TemplateValidationMetrics = {
    nodeCount: nodes.length,
    edgeCount: edges.length,
    feedbackLoopCount: feedbackEdges.length,
    terminalCount: terminalNodes.length,
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    topologicalOrder,
    metrics,
  }
}
