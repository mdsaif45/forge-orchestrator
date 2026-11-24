import { randomUUID } from 'node:crypto'
import {
  getReadyNodes,
  validateWorkflowGraph,
  type WorkflowArtifact,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowTemplateV2,
} from '@shared/domain'

export interface NodeExecutionContext {
  readonly workflowId: string
  readonly projectId: string
  readonly node: WorkflowNode
  readonly inputArtifacts: readonly WorkflowArtifact[]
  readonly incomingSlots: ReadonlyMap<string, WorkflowArtifact>
  readonly signal: AbortSignal
}

export type NodeExecutor = (ctx: NodeExecutionContext) => Promise<readonly WorkflowArtifact[]>

export interface DagExecutorOptions {
  readonly template: WorkflowTemplateV2
  readonly workflowId: string
  readonly projectId: string
  readonly initialContext?: Readonly<Record<string, string>>
  readonly onNodeStarted?: (node: WorkflowNode) => void
  readonly onNodeCompleted?: (node: WorkflowNode, artifacts: readonly WorkflowArtifact[]) => void
  readonly onNodeFailed?: (node: WorkflowNode, error: unknown) => void
  readonly executeNode: NodeExecutor
}

export interface DagExecutionResult {
  readonly status: 'completed' | 'failed' | 'aborted'
  readonly completedNodeIds: readonly string[]
  readonly failedNodeIds: readonly string[]
  readonly artifacts: readonly WorkflowArtifact[]
  readonly error?: string | undefined
}

/**
 * Executes a DAG workflow template in topological order, supporting parallel branches
 * and automatic dataflow artifact routing.
 */
export class DagExecutor {
  readonly template: WorkflowTemplateV2
  private readonly nodes: readonly WorkflowNode[]
  private readonly edges: readonly WorkflowEdge[]
  private readonly workflowId: string
  private readonly projectId: string
  private readonly initialContext: Readonly<Record<string, string>>
  private readonly executeNode: NodeExecutor
  private readonly options: DagExecutorOptions

  private readonly completedNodeIds = new Set<string>()
  private readonly runningNodeIds = new Set<string>()
  private readonly failedNodeIds = new Set<string>()
  private readonly nodeArtifacts = new Map<string, WorkflowArtifact[]>()
  private readonly allArtifacts: WorkflowArtifact[] = []

  constructor(options: DagExecutorOptions) {
    this.options = options
    this.template = options.template
    this.nodes = options.template.nodes
    this.edges = options.template.edges
    this.workflowId = options.workflowId
    this.projectId = options.projectId
    this.initialContext = options.initialContext ?? {}
    this.executeNode = options.executeNode

    // Validate graph structure before execution
    validateWorkflowGraph(this.nodes, this.edges)
  }

  /**
   * Runs the DAG to completion or until failure / cancellation.
   */
  async run(signal?: AbortSignal): Promise<DagExecutionResult> {
    const abortSignal = signal ?? new AbortController().signal

    while (this.completedNodeIds.size + this.failedNodeIds.size < this.nodes.length) {
      if (abortSignal.aborted) {
        return {
          status: 'aborted',
          completedNodeIds: [...this.completedNodeIds],
          failedNodeIds: [...this.failedNodeIds],
          artifacts: this.allArtifacts,
          error: 'Execution aborted',
        }
      }

      const readyNodes = getReadyNodes(this.nodes, this.edges, this.completedNodeIds).filter(
        (node) => !this.runningNodeIds.has(node.id) && !this.failedNodeIds.has(node.id),
      )

      if (readyNodes.length === 0 && this.runningNodeIds.size === 0) {
        // No ready nodes and none running: either deadlocked or completed
        break
      }

      // Execute ready nodes concurrently
      const executions = readyNodes.map((node) => this.runSingleNode(node, abortSignal))
      await Promise.all(executions)

      if (this.failedNodeIds.size > 0) {
        return {
          status: 'failed',
          completedNodeIds: [...this.completedNodeIds],
          failedNodeIds: [...this.failedNodeIds],
          artifacts: this.allArtifacts,
          error: `Execution failed at nodes: ${[...this.failedNodeIds].join(', ')}`,
        }
      }
    }

    return {
      status: 'completed',
      completedNodeIds: [...this.completedNodeIds],
      failedNodeIds: [],
      artifacts: this.allArtifacts,
    }
  }

  private async runSingleNode(node: WorkflowNode, signal: AbortSignal): Promise<void> {
    this.runningNodeIds.add(node.id)
    this.options.onNodeStarted?.(node)

    try {
      const { inputArtifacts, incomingSlots } = this.resolveInputsForNode(node)

      const ctx: NodeExecutionContext = {
        workflowId: this.workflowId,
        projectId: this.projectId,
        node,
        inputArtifacts,
        incomingSlots,
        signal,
      }

      const produced = await this.executeNode(ctx)

      const finalArtifacts = produced.map((a) => ({
        ...a,
        id: a.id || randomUUID(),
        workflowId: this.workflowId,
        nodeId: node.id,
        createdAt: a.createdAt || new Date().toISOString(),
      }))

      this.nodeArtifacts.set(node.id, finalArtifacts)
      this.allArtifacts.push(...finalArtifacts)
      this.completedNodeIds.add(node.id)
      this.options.onNodeCompleted?.(node, finalArtifacts)
    } catch (err: unknown) {
      this.failedNodeIds.add(node.id)
      this.options.onNodeFailed?.(node, err)
      throw err
    } finally {
      this.runningNodeIds.delete(node.id)
    }
  }

  /**
   * Resolves the input artifacts and named slot mappings for a node based on:
   * 1. Explicit incoming edge bindings.
   * 2. Auto-wired upstream output kinds.
   * 3. Initial context fallbacks.
   */
  resolveInputsForNode(node: WorkflowNode): {
    readonly inputArtifacts: readonly WorkflowArtifact[]
    readonly incomingSlots: ReadonlyMap<string, WorkflowArtifact>
  } {
    const incomingEdges = this.edges.filter((e) => e.target === node.id)
    const slotMap = new Map<string, WorkflowArtifact>()
    const artifacts: WorkflowArtifact[] = []

    // 1. Explicit incoming edges
    for (const edge of incomingEdges) {
      const sourceArtifacts = this.nodeArtifacts.get(edge.source) ?? []
      for (const artifact of sourceArtifacts) {
        if (!edge.sourceHandle || edge.sourceHandle === artifact.kind) {
          const targetSlotName = edge.targetHandle ?? artifact.kind
          slotMap.set(targetSlotName, artifact)
          if (!artifacts.some((a) => a.id === artifact.id)) {
            artifacts.push(artifact)
          }
        }
      }
    }

    // 2. Auto-wired dataflow for any unfulfilled declared slots
    for (const slot of node.inputs) {
      if (!slotMap.has(slot.name)) {
        // Look through all completed upstream dependencies
        for (const edge of incomingEdges) {
          const sourceArtifacts = this.nodeArtifacts.get(edge.source) ?? []
          const matching = sourceArtifacts.find((a) => a.kind === slot.kind)
          if (matching) {
            slotMap.set(slot.name, matching)
            if (!artifacts.some((a) => a.id === matching.id)) {
              artifacts.push(matching)
            }
            break
          }
        }
      }

      // 3. Initial context fallback if slot is still unfulfilled
      const contextValue = this.initialContext[slot.name]
      if (!slotMap.has(slot.name) && contextValue !== undefined) {
        const fallbackArtifact: WorkflowArtifact = {
          id: randomUUID(),
          workflowId: this.workflowId,
          nodeId: '__context__',
          kind: slot.kind,
          format: 'text',
          title: `Initial ${slot.name}`,
          content: contextValue,
          metadata: { isInitialContext: true },
          createdAt: new Date().toISOString(),
        }
        slotMap.set(slot.name, fallbackArtifact)
        artifacts.push(fallbackArtifact)
      }
    }

    return {
      inputArtifacts: artifacts,
      incomingSlots: slotMap,
    }
  }
}
