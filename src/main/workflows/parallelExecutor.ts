import { workflowTemplateV2Schema, type WorkflowTemplateV2 } from '@shared/domain'
import { planWorkflowExecution } from './planner'

export interface ParallelNodeInfo {
  readonly id: string
  readonly type: string
  readonly role?: string | undefined
  readonly isIsolated: boolean
  readonly canParallelize: boolean
  readonly dependsOn: readonly string[]
  readonly writeScope?: readonly string[] | undefined
}

export interface ParallelBatch {
  readonly batchIndex: number
  readonly isParallel: boolean
  readonly concurrencyWidth: number
  readonly nodes: readonly ParallelNodeInfo[]
  readonly fanInTarget?: string | undefined
}

export interface ParallelExecutionPlan {
  readonly valid: boolean
  readonly templateId: string
  readonly templateName: string
  readonly maxConcurrencyWidth: number
  readonly totalBatches: number
  readonly hasConcurrentNodes: boolean
  readonly batches: readonly ParallelBatch[]
  readonly formattedSummary: string
  readonly errors?: readonly string[] | undefined
}

/**
 * Plans sibling node parallelism and fan-out/fan-in concurrency for workflow DAGs.
 *
 * Implements Axioms:
 * - A1 (Truth ownership): Strict isolation guarantees via worktrees prevent concurrent branch collisions.
 * - A7 (Least privilege & isolation): Parallel sibling nodes run in isolated worktrees before sequential deterministic merge.
 */
export function planParallelBatches(template: unknown): ParallelExecutionPlan {
  const parsed = workflowTemplateV2Schema.safeParse(template)
  if (!parsed.success) {
    const errors = parsed.error.issues.map(
      (i) => `Schema error at ${i.path.join('.') || 'root'}: ${i.message}`,
    )
    return {
      valid: false,
      templateId: 'unknown',
      templateName: 'Invalid Template',
      maxConcurrencyWidth: 0,
      totalBatches: 0,
      hasConcurrentNodes: false,
      batches: [],
      formattedSummary: 'Invalid workflow template: schema validation failed.',
      errors,
    }
  }

  const tmpl: WorkflowTemplateV2 = parsed.data
  const staticPlan = planWorkflowExecution(tmpl)

  if (!staticPlan.valid) {
    return {
      valid: false,
      templateId: tmpl.id,
      templateName: tmpl.name,
      maxConcurrencyWidth: 0,
      totalBatches: 0,
      hasConcurrentNodes: false,
      batches: [],
      formattedSummary: staticPlan.asciiDiagram,
      errors: staticPlan.errors,
    }
  }

  const nodeMap = new Map(tmpl.nodes.map((n) => [n.id, n]))
  const batches: ParallelBatch[] = []
  let maxConcurrencyWidth = 1

  for (const stage of staticPlan.stages) {
    const nodeInfos: ParallelNodeInfo[] = stage.nodeIds.map((nodeId) => {
      const node = nodeMap.get(nodeId)
      const planned = staticPlan.nodes.find((n) => n.id === nodeId)
      const isParallel = stage.nodeIds.length > 1
      return {
        id: nodeId,
        type: node?.type ?? 'action',
        role: node?.config.role,
        isIsolated: isParallel,
        canParallelize: isParallel,
        dependsOn: planned?.dependsOn ?? [],
      }
    })

    const concurrencyWidth = nodeInfos.length
    if (concurrencyWidth > maxConcurrencyWidth) {
      maxConcurrencyWidth = concurrencyWidth
    }

    // Determine fan-in target if parallel
    let fanInTarget: string | undefined
    if (concurrencyWidth > 1) {
      const nextCandidates = new Set<string>()
      for (const ni of nodeInfos) {
        const planned = staticPlan.nodes.find((n) => n.id === ni.id)
        if (planned) {
          for (const nxt of planned.nextNodes) {
            nextCandidates.add(nxt)
          }
        }
      }
      if (nextCandidates.size === 1) {
        fanInTarget = Array.from(nextCandidates)[0]
      }
    }

    batches.push({
      batchIndex: stage.stageIndex,
      isParallel: concurrencyWidth > 1,
      concurrencyWidth,
      nodes: nodeInfos,
      fanInTarget,
    })
  }

  const hasConcurrentNodes = maxConcurrencyWidth > 1

  const summaryLines: string[] = []
  summaryLines.push(
    '================================================================================',
  )
  summaryLines.push(`Workflow Parallel Execution Plan: ${tmpl.name} (${tmpl.id})`)
  summaryLines.push(
    `Total Batches: ${String(batches.length)} | Max Concurrency: ${String(maxConcurrencyWidth)} | Sibling Parallelism: ${hasConcurrentNodes ? 'ENABLED' : 'SEQUENTIAL'}`,
  )
  summaryLines.push(
    '================================================================================',
  )

  for (const b of batches) {
    const tag = b.isParallel ? `[PARALLEL x${String(b.concurrencyWidth)}]` : '[SEQUENTIAL]   '
    summaryLines.push(`\nBatch #${String(b.batchIndex)} ${tag}`)
    for (const n of b.nodes) {
      const roleStr = n.role ? ` (role: ${n.role})` : ''
      const isolationStr = n.isIsolated ? ' -> isolated worktree' : ''
      summaryLines.push(`  • [${n.type}] ${n.id}${roleStr}${isolationStr}`)
    }
    if (b.fanInTarget) {
      summaryLines.push(`    ↳ Fan-in Merge Barrier -> Node: ${b.fanInTarget}`)
    }
  }
  summaryLines.push(
    '\n================================================================================',
  )

  return {
    valid: true,
    templateId: tmpl.id,
    templateName: tmpl.name,
    maxConcurrencyWidth,
    totalBatches: batches.length,
    hasConcurrentNodes,
    batches,
    formattedSummary: summaryLines.join('\n'),
  }
}
