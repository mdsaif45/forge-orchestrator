import { workflowTemplateV2Schema, type WorkflowTemplateV2 } from '@shared/domain'

export interface StagePlan {
  readonly stageIndex: number
  readonly nodeIds: readonly string[]
}

export interface PlannedNode {
  readonly id: string
  readonly type: string
  readonly role?: string | undefined
  readonly permissionMode?: string | undefined
  readonly stageIndex: number
  readonly dependsOn: readonly string[]
  readonly nextNodes: readonly string[]
  readonly feedbackTargets: readonly string[]
  readonly inputs: readonly string[]
  readonly outputs: readonly string[]
}

export interface WorkflowExecutionPlan {
  readonly valid: boolean
  readonly templateId: string
  readonly templateName: string
  readonly totalNodes: number
  readonly stageCount: number
  readonly stages: readonly StagePlan[]
  readonly nodes: readonly PlannedNode[]
  readonly asciiDiagram: string
  readonly errors?: readonly string[] | undefined
}

/**
 * Computes a static execution plan for a WorkflowTemplateV2 DAG,
 * including topological stage barriers, role permission ceilings,
 * dependency mappings, and an ASCII visual flow diagram.
 */
export function planWorkflowExecution(template: unknown): WorkflowExecutionPlan {
  const parsed = workflowTemplateV2Schema.safeParse(template)
  if (!parsed.success) {
    const errors = parsed.error.issues.map(
      (i) => `Schema error at ${i.path.join('.') || 'root'}: ${i.message}`,
    )
    return {
      valid: false,
      templateId: 'unknown',
      templateName: 'Invalid Template',
      totalNodes: 0,
      stageCount: 0,
      stages: [],
      nodes: [],
      asciiDiagram: 'Invalid template: schema validation failed.',
      errors,
    }
  }

  const tmpl: WorkflowTemplateV2 = parsed.data
  const nodes = tmpl.nodes
  const edges = tmpl.edges
  const forwardEdges = edges.filter((e) => !e.isFeedback)
  const feedbackEdges = edges.filter((e) => e.isFeedback)

  const nodeMap = new Map(nodes.map((n) => [n.id, n]))
  const incomingForward = new Map<string, string[]>()
  const outgoingForward = new Map<string, string[]>()
  const feedbackTargetsMap = new Map<string, string[]>()

  for (const n of nodes) {
    incomingForward.set(n.id, [])
    outgoingForward.set(n.id, [])
    feedbackTargetsMap.set(n.id, [])
  }

  for (const e of forwardEdges) {
    const inList = incomingForward.get(e.target)
    if (inList) {
      inList.push(e.source)
    }
    const outList = outgoingForward.get(e.source)
    if (outList) {
      outList.push(e.target)
    }
  }

  for (const e of feedbackEdges) {
    const fbList = feedbackTargetsMap.get(e.source)
    if (fbList) {
      fbList.push(e.target)
    }
  }

  // Calculate topological levels (stages) using Kahn's algorithm
  const inDegree = new Map<string, number>()
  for (const n of nodes) {
    inDegree.set(n.id, incomingForward.get(n.id)?.length ?? 0)
  }

  const queue: string[] = []
  const stageLevel = new Map<string, number>()

  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      queue.push(id)
      stageLevel.set(id, 0)
    }
  }

  let processedCount = 0
  while (queue.length > 0) {
    const current = queue.shift()
    if (!current) break
    processedCount++
    const currentLevel = stageLevel.get(current) ?? 0

    const neighbors = outgoingForward.get(current) ?? []
    for (const neighbor of neighbors) {
      const nextLevel = Math.max(stageLevel.get(neighbor) ?? 0, currentLevel + 1)
      stageLevel.set(neighbor, nextLevel)

      const remainingDeg = (inDegree.get(neighbor) ?? 1) - 1
      inDegree.set(neighbor, remainingDeg)
      if (remainingDeg === 0) {
        queue.push(neighbor)
      }
    }
  }

  if (processedCount < nodes.length) {
    return {
      valid: false,
      templateId: tmpl.id,
      templateName: tmpl.name,
      totalNodes: nodes.length,
      stageCount: 0,
      stages: [],
      nodes: [],
      asciiDiagram: 'Invalid DAG: forward edges contain circular dependencies.',
      errors: ['Cycle detected in forward execution graph.'],
    }
  }

  // Group nodes by stage index
  const stageMap = new Map<number, string[]>()
  for (const n of nodes) {
    const level = stageLevel.get(n.id) ?? 0
    let bucket = stageMap.get(level)
    if (!bucket) {
      bucket = []
      stageMap.set(level, bucket)
    }
    bucket.push(n.id)
  }

  const sortedStageIndices = Array.from(stageMap.keys()).sort((a, b) => a - b)
  const stages: StagePlan[] = sortedStageIndices.map((idx) => ({
    stageIndex: idx,
    nodeIds: (stageMap.get(idx) ?? []).slice().sort(),
  }))

  const plannedNodes: PlannedNode[] = nodes.map((n) => {
    const stageIdx = stageLevel.get(n.id) ?? 0
    const dependsOn = (incomingForward.get(n.id) ?? []).slice().sort()
    const nextNodes = (outgoingForward.get(n.id) ?? []).slice().sort()
    const feedbackTargets = (feedbackTargetsMap.get(n.id) ?? []).slice().sort()
    const inputs = n.inputs.map((s) => s.name).sort()
    const outputs = n.outputs.map((o) => o.name).sort()

    return {
      id: n.id,
      type: n.type,
      role: n.config.role,
      permissionMode: n.config.permissionMode,
      stageIndex: stageIdx,
      dependsOn,
      nextNodes,
      feedbackTargets,
      inputs,
      outputs,
    }
  })

  // Generate ASCII diagram
  const lines: string[] = []
  lines.push('================================================================================')
  lines.push(`Workflow Execution Plan: ${tmpl.id} (${tmpl.name})`)
  lines.push(
    `Stages: ${String(stages.length)} | Total Nodes: ${String(nodes.length)} | Edges: ${String(edges.length)} (Fwd: ${String(forwardEdges.length)}, Feedback: ${String(feedbackEdges.length)})`,
  )
  lines.push('================================================================================')

  for (const stage of stages) {
    lines.push('')
    lines.push(`[Stage ${String(stage.stageIndex)}]`)
    for (const nodeId of stage.nodeIds) {
      const node = nodeMap.get(nodeId)
      const planNode = plannedNodes.find((pn) => pn.id === nodeId)
      if (!node || !planNode) {
        continue
      }
      const roleStr = planNode.role ? `Role: ${planNode.role}` : 'Role: [unassigned]'
      const permStr = `[${planNode.permissionMode ?? 'developer'}]`
      lines.push(`  ● ${node.id} (${node.type}) -> ${roleStr} ${permStr}`)

      if (planNode.dependsOn.length > 0) {
        lines.push(`    Depends on: ${planNode.dependsOn.join(', ')}`)
      }
      if (planNode.inputs.length > 0) {
        lines.push(`    Inputs: ${planNode.inputs.join(', ')}`)
      }
      if (planNode.outputs.length > 0) {
        lines.push(`    Outputs: ${planNode.outputs.join(', ')}`)
      }
      if (planNode.nextNodes.length > 0) {
        lines.push(`    ──(forward)──> ${planNode.nextNodes.join(', ')}`)
      }
      if (planNode.feedbackTargets.length > 0) {
        lines.push(`    ──(feedback)──> ${planNode.feedbackTargets.join(', ')}`)
      }
      if (planNode.nextNodes.length === 0 && planNode.feedbackTargets.length === 0) {
        lines.push(`    └── [Sink / Terminal Node]`)
      }
    }
  }

  const asciiDiagram = lines.join('\n')

  return {
    valid: true,
    templateId: tmpl.id,
    templateName: tmpl.name,
    totalNodes: nodes.length,
    stageCount: stages.length,
    stages,
    nodes: plannedNodes,
    asciiDiagram,
  }
}
