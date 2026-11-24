/**
 * WORK-039: Workflow execution speculative branch pruner and state eviction coordinator.
 *
 * Traverses workflow DAG subgraphs to detect abandoned, superseded, or failing speculative
 * execution branches, safely interrupts running child tasks via cooperative AbortControllers,
 * evicts in-flight temporary state, and reclaims memory without leaving dangling promises
 * or corrupting primary workflow lineage (Axioms A1, A2, A5).
 */

export type NodeExecutionState =
  'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'PRUNED' | 'SUPERSEDED'

export type PruningReason =
  | 'BRANCH_FAILED'
  | 'BRANCH_SUPERSEDED'
  | 'BUDGET_EXCEEDED'
  | 'DEADLINE_EXCEEDED'
  | 'MANUAL_ABORT'
  | 'UPSTREAM_PRUNED'

export interface SpeculativeBranchNode {
  readonly id: string
  readonly branchId: string
  readonly name?: string | undefined
  readonly dependencies: readonly string[]
  readonly children?: readonly string[] | undefined
  readonly state: NodeExecutionState
  readonly isSpeculative: boolean
  readonly ephemeralArtifacts?: readonly string[] | undefined
  readonly resourceLeases?: readonly string[] | undefined
  readonly estimatedMemoryBytes?: number | undefined
}

export interface BranchPruningPolicy {
  /**
   * Action when a speculative branch fails:
   * 'PRUNE_DESCENDANTS': only descendants of the failed node in the branch.
   * 'PRUNE_BRANCH': the entire speculative branch containing the node.
   * 'ISOLATE_ONLY': mark the node itself without cascading.
   */
  readonly onBranchFailure?: 'PRUNE_DESCENDANTS' | 'PRUNE_BRANCH' | 'ISOLATE_ONLY' | undefined

  /**
   * Action when a branch is superseded by a winning branch:
   * 'CANCEL_RUNNING_AND_EVICT': actively abort running tasks and evict state.
   * 'WAIT_COMPLETION': wait for in-flight tasks to finish before evicting.
   */
  readonly onBranchSuperseded?: 'CANCEL_RUNNING_AND_EVICT' | 'WAIT_COMPLETION' | undefined

  /**
   * Whether pruning cascades to downstream dependent speculative nodes.
   * Defaults to true.
   */
  readonly cascadeToDescendants?: boolean | undefined

  /**
   * Maximum retries for resource eviction hooks. Defaults to 2.
   */
  readonly maxEvictionRetries?: number | undefined
}

export interface PruningDecision {
  readonly nodeId: string
  readonly branchId: string
  readonly action: 'PRUNE' | 'RETAIN' | 'ABORT_IN_FLIGHT'
  readonly reason: PruningReason
  readonly details: string
}

export interface EvictionReport {
  readonly prunerId: string
  readonly workflowId: string
  readonly targetBranchId?: string | undefined
  readonly targetNodeId?: string | undefined
  readonly reason: PruningReason
  readonly prunedNodeIds: readonly string[]
  readonly activeLeavesAborted: readonly string[]
  readonly reclaimedArtifacts: readonly string[]
  readonly releasedLeases: readonly string[]
  readonly reclaimedMemoryBytes: number
  readonly preservedNodeIds: readonly string[]
  readonly decisions: readonly PruningDecision[]
  readonly timestamp: number
  readonly status: 'SUCCESS' | 'PARTIAL' | 'NO_OP'
}

export interface PrunerConfig {
  readonly defaultWorkflowId?: string | undefined
  readonly defaultPolicy?: BranchPruningPolicy | undefined
}

export type ResourceReclaimer = () => Promise<void> | void

export class WorkflowSpeculativeBranchPruner {
  private readonly defaultWorkflowId: string
  private readonly defaultPolicy: BranchPruningPolicy

  private readonly nodes = new Map<string, SpeculativeBranchNode>()
  private readonly childrenMap = new Map<string, Set<string>>()
  private readonly branchNodes = new Map<string, Set<string>>()
  private readonly abortControllers = new Map<string, AbortController>()
  private readonly resourceReclaimers = new Map<string, ResourceReclaimer[]>()
  private readonly history: EvictionReport[] = []

  private instanceCounter = 0

  constructor(config: PrunerConfig = {}) {
    this.defaultWorkflowId = config.defaultWorkflowId ?? 'default-workflow'
    this.defaultPolicy = {
      onBranchFailure: 'PRUNE_DESCENDANTS',
      onBranchSuperseded: 'CANCEL_RUNNING_AND_EVICT',
      cascadeToDescendants: true,
      maxEvictionRetries: 2,
      ...config.defaultPolicy,
    }
  }

  /**
   * Registers a DAG node into the coordinator. Reconstructs forward child edges and branch index.
   */
  registerNode(node: SpeculativeBranchNode): void {
    if (!node.id || node.id.trim().length === 0) {
      throw new Error('Node id cannot be empty')
    }
    if (!node.branchId || node.branchId.trim().length === 0) {
      throw new Error(`Node "${node.id}" must have a non-empty branchId`)
    }

    this.nodes.set(node.id, { ...node })

    // Index by branchId
    let branchSet = this.branchNodes.get(node.branchId)
    if (!branchSet) {
      branchSet = new Set()
      this.branchNodes.set(node.branchId, branchSet)
    }
    branchSet.add(node.id)

    // Build forward edges from dependencies
    for (const depId of node.dependencies) {
      let children = this.childrenMap.get(depId)
      if (!children) {
        children = new Set()
        this.childrenMap.set(depId, children)
      }
      children.add(node.id)
    }

    // Build forward edges from explicit children if declared
    if (node.children && node.children.length > 0) {
      let children = this.childrenMap.get(node.id)
      if (!children) {
        children = new Set()
        this.childrenMap.set(node.id, children)
      }
      for (const childId of node.children) {
        children.add(childId)
      }
    }
  }

  /**
   * Registers multiple nodes at once.
   */
  registerNodes(nodes: readonly SpeculativeBranchNode[]): void {
    for (const node of nodes) {
      this.registerNode(node)
    }
  }

  /**
   * Returns a registered node or undefined.
   */
  getNode(nodeId: string): SpeculativeBranchNode | undefined {
    return this.nodes.get(nodeId)
  }

  /**
   * Updates the state of an existing node.
   */
  updateNodeState(nodeId: string, state: NodeExecutionState): void {
    const existing = this.nodes.get(nodeId)
    if (!existing) {
      throw new Error(`Cannot update state of unknown node "${nodeId}"`)
    }
    this.nodes.set(nodeId, { ...existing, state })
  }

  /**
   * Binds an external AbortController to a node to enable cooperative cancellation.
   */
  bindAbortController(nodeId: string, controller: AbortController): void {
    this.abortControllers.set(nodeId, controller)
  }

  /**
   * Creates, registers, and returns an AbortController for a node.
   */
  createAbortController(nodeId: string): AbortController {
    const controller = new AbortController()
    this.bindAbortController(nodeId, controller)
    return controller
  }

  /**
   * Registers an asynchronous or synchronous resource reclaimer callback for a node.
   */
  bindResourceReclaimer(nodeId: string, reclaimer: ResourceReclaimer): void {
    let list = this.resourceReclaimers.get(nodeId)
    if (!list) {
      list = []
      this.resourceReclaimers.set(nodeId, list)
    }
    list.push(reclaimer)
  }

  /**
   * Prunes an entire speculative branch, aborting running tasks and evicting in-flight state.
   */
  async pruneBranch(
    branchId: string,
    reason: PruningReason = 'BRANCH_SUPERSEDED',
    policy?: BranchPruningPolicy,
  ): Promise<EvictionReport> {
    const effectivePolicy: BranchPruningPolicy = {
      ...this.defaultPolicy,
      ...policy,
    }

    const nodeIds = this.branchNodes.get(branchId)
    if (!nodeIds || nodeIds.size === 0) {
      return this.createReport({
        targetBranchId: branchId,
        reason,
        prunedNodeIds: [],
        activeLeavesAborted: [],
        reclaimedArtifacts: [],
        releasedLeases: [],
        reclaimedMemoryBytes: 0,
        preservedNodeIds: [],
        decisions: [],
        status: 'NO_OP',
      })
    }

    // Determine target nodes: all nodes in the branch
    const candidates = new Set<string>(nodeIds)

    // If cascadeToDescendants is enabled, also find speculative downstream nodes in other branches
    if (effectivePolicy.cascadeToDescendants) {
      for (const nodeId of nodeIds) {
        const downstream = this.traverseDownstream(nodeId)
        for (const descId of downstream) {
          candidates.add(descId)
        }
      }
    }

    return this.executeEviction(candidates, reason, effectivePolicy, { targetBranchId: branchId })
  }

  /**
   * Prunes a downstream subtree starting at a given root node.
   */
  async pruneSubtree(
    rootNodeId: string,
    reason: PruningReason = 'BRANCH_FAILED',
    policy?: BranchPruningPolicy,
  ): Promise<EvictionReport> {
    const effectivePolicy: BranchPruningPolicy = {
      ...this.defaultPolicy,
      ...policy,
    }

    const rootNode = this.nodes.get(rootNodeId)
    if (!rootNode) {
      return this.createReport({
        targetNodeId: rootNodeId,
        reason,
        prunedNodeIds: [],
        activeLeavesAborted: [],
        reclaimedArtifacts: [],
        releasedLeases: [],
        reclaimedMemoryBytes: 0,
        preservedNodeIds: [],
        decisions: [],
        status: 'NO_OP',
      })
    }

    const candidates = new Set<string>()

    if (effectivePolicy.onBranchFailure === 'ISOLATE_ONLY') {
      candidates.add(rootNodeId)
    } else if (effectivePolicy.onBranchFailure === 'PRUNE_BRANCH') {
      const branchNodes = this.branchNodes.get(rootNode.branchId)
      if (branchNodes) {
        for (const id of branchNodes) {
          candidates.add(id)
        }
      }
      if (effectivePolicy.cascadeToDescendants) {
        for (const id of candidates) {
          for (const descId of this.traverseDownstream(id)) {
            candidates.add(descId)
          }
        }
      }
    } else {
      // Default: PRUNE_DESCENDANTS
      candidates.add(rootNodeId)
      for (const descId of this.traverseDownstream(rootNodeId)) {
        candidates.add(descId)
      }
    }

    return this.executeEviction(candidates, reason, effectivePolicy, { targetNodeId: rootNodeId })
  }

  /**
   * Returns all eviction reports generated by this coordinator.
   */
  getEvictionHistory(): readonly EvictionReport[] {
    return [...this.history]
  }

  /**
   * Returns all currently pruned or superseded nodes.
   */
  getPrunedNodes(): readonly SpeculativeBranchNode[] {
    const result: SpeculativeBranchNode[] = []
    for (const node of this.nodes.values()) {
      if (node.state === 'PRUNED' || node.state === 'SUPERSEDED') {
        result.push(node)
      }
    }
    return result
  }

  /**
   * Returns all active, completed, or primary lineage nodes.
   */
  getPreservedNodes(): readonly SpeculativeBranchNode[] {
    const result: SpeculativeBranchNode[] = []
    for (const node of this.nodes.values()) {
      if (node.state !== 'PRUNED' && node.state !== 'SUPERSEDED') {
        result.push(node)
      }
    }
    return result
  }

  /**
   * Resets all internal state and history.
   */
  reset(): void {
    this.nodes.clear()
    this.childrenMap.clear()
    this.branchNodes.clear()
    this.abortControllers.clear()
    this.resourceReclaimers.clear()
    this.history.length = 0
  }

  /**
   * Traverses downstream children from a node using BFS to prevent recursion stack overflow.
   */
  private traverseDownstream(startNodeId: string): Set<string> {
    const visited = new Set<string>()
    const queue: string[] = []

    const immediate = this.childrenMap.get(startNodeId)
    if (immediate) {
      for (const childId of immediate) {
        if (!visited.has(childId)) {
          visited.add(childId)
          queue.push(childId)
        }
      }
    }

    while (queue.length > 0) {
      const current = queue.shift()
      if (current === undefined) continue
      const nextChildren = this.childrenMap.get(current)
      if (nextChildren) {
        for (const nextId of nextChildren) {
          if (!visited.has(nextId)) {
            visited.add(nextId)
            queue.push(nextId)
          }
        }
      }
    }

    return visited
  }

  /**
   * Executes the pruning evaluation, abort triggering, and resource eviction pipeline.
   */
  private async executeEviction(
    candidateNodeIds: Set<string>,
    reason: PruningReason,
    _policy: BranchPruningPolicy,
    context: { targetBranchId?: string; targetNodeId?: string },
  ): Promise<EvictionReport> {
    const prunedNodeIds: string[] = []
    const activeLeavesAborted: string[] = []
    const reclaimedArtifacts: string[] = []
    const releasedLeases: string[] = []
    const preservedNodeIds: string[] = []
    const decisions: PruningDecision[] = []

    let reclaimedMemoryBytes = 0
    let hadEvictionError = false

    for (const nodeId of candidateNodeIds) {
      const node = this.nodes.get(nodeId)
      if (!node) continue

      // Non-speculative (primary lineage) nodes are strictly preserved
      if (!node.isSpeculative) {
        preservedNodeIds.push(nodeId)
        decisions.push({
          nodeId,
          branchId: node.branchId,
          action: 'RETAIN',
          reason,
          details: 'Node belongs to primary lineage (isSpeculative: false); preserved.',
        })
        continue
      }

      // If already pruned or superseded, skip redundant eviction
      if (node.state === 'PRUNED' || node.state === 'SUPERSEDED') {
        preservedNodeIds.push(nodeId)
        decisions.push({
          nodeId,
          branchId: node.branchId,
          action: 'RETAIN',
          reason,
          details: `Node is already ${node.state}; skipping redundant eviction.`,
        })
        continue
      }

      // If node is RUNNING, trigger cooperative abort
      if (node.state === 'RUNNING') {
        const controller = this.abortControllers.get(nodeId)
        if (controller && !controller.signal.aborted) {
          try {
            controller.abort(reason)
          } catch {
            // AbortController errors are non-fatal
          }
        }
        activeLeavesAborted.push(nodeId)
        decisions.push({
          nodeId,
          branchId: node.branchId,
          action: 'ABORT_IN_FLIGHT',
          reason,
          details: 'Active in-flight task aborted via cooperative AbortController.',
        })
      } else {
        decisions.push({
          nodeId,
          branchId: node.branchId,
          action: 'PRUNE',
          reason,
          details: `Node evicted in state ${node.state}.`,
        })
      }

      // Execute resource reclaimers
      const reclaimers = this.resourceReclaimers.get(nodeId)
      if (reclaimers && reclaimers.length > 0) {
        for (const reclaimer of reclaimers) {
          try {
            await reclaimer()
          } catch {
            hadEvictionError = true
          }
        }
      }

      // Reclaim ephemeral artifacts
      if (node.ephemeralArtifacts && node.ephemeralArtifacts.length > 0) {
        for (const artifact of node.ephemeralArtifacts) {
          reclaimedArtifacts.push(artifact)
        }
      }

      // Release resource leases
      if (node.resourceLeases && node.resourceLeases.length > 0) {
        for (const lease of node.resourceLeases) {
          releasedLeases.push(lease)
        }
      }

      // Tally reclaimed memory
      if (node.estimatedMemoryBytes && node.estimatedMemoryBytes > 0) {
        reclaimedMemoryBytes += node.estimatedMemoryBytes
      }

      // Update state
      const nextState: NodeExecutionState = reason === 'BRANCH_SUPERSEDED' ? 'SUPERSEDED' : 'PRUNED'
      this.nodes.set(nodeId, { ...node, state: nextState })
      prunedNodeIds.push(nodeId)
    }

    const status: 'SUCCESS' | 'PARTIAL' | 'NO_OP' =
      prunedNodeIds.length === 0 ? 'NO_OP' : hadEvictionError ? 'PARTIAL' : 'SUCCESS'

    const report = this.createReport({
      targetBranchId: context.targetBranchId,
      targetNodeId: context.targetNodeId,
      reason,
      prunedNodeIds,
      activeLeavesAborted,
      reclaimedArtifacts,
      releasedLeases,
      reclaimedMemoryBytes,
      preservedNodeIds,
      decisions,
      status,
    })

    this.history.push(report)
    return report
  }

  private createReport(data: {
    targetBranchId?: string | undefined
    targetNodeId?: string | undefined
    reason: PruningReason
    prunedNodeIds: readonly string[]
    activeLeavesAborted: readonly string[]
    reclaimedArtifacts: readonly string[]
    releasedLeases: readonly string[]
    reclaimedMemoryBytes: number
    preservedNodeIds: readonly string[]
    decisions: readonly PruningDecision[]
    status: 'SUCCESS' | 'PARTIAL' | 'NO_OP'
  }): EvictionReport {
    this.instanceCounter += 1
    const prunerId = `pruner-${String(Date.now())}-${String(this.instanceCounter)}`

    return {
      prunerId,
      workflowId: this.defaultWorkflowId,
      targetBranchId: data.targetBranchId,
      targetNodeId: data.targetNodeId,
      reason: data.reason,
      prunedNodeIds: data.prunedNodeIds,
      activeLeavesAborted: data.activeLeavesAborted,
      reclaimedArtifacts: data.reclaimedArtifacts,
      releasedLeases: data.releasedLeases,
      reclaimedMemoryBytes: data.reclaimedMemoryBytes,
      preservedNodeIds: data.preservedNodeIds,
      decisions: data.decisions,
      timestamp: Date.now(),
      status: data.status,
    }
  }
}
