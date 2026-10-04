import { randomUUID } from 'node:crypto'
import {
  changeSetIdSchema,
  getReadyNodes,
  runIdSchema,
  validateWorkflowGraph,
  type Actor,
  type ChangeSet,
  type GraphNodeRun,
  type GraphRun,
  type GraphRunStatus,
  type GraphStateSnapshot,
  type ProjectId,
  type Sha,
  type StepId,
  type TaskId,
  type WorkflowArtifact,
  type WorkflowEdge,
  type WorkflowId,
  type WorkflowNode,
  type WorkflowTemplateV2,
} from '@shared/domain'
import type { ArtifactService } from '../artifacts/artifactService'
import type { ChangeSetStore } from '../db/changeSetStore'
import type { DecisionStore } from '../db/decisionStore'
import {
  WorkflowDomainError,
  type AdvanceLoopIterationResult,
  type WorkflowStore,
} from '../db/workflowStore'
import { mergeChangeSets, type ChangeSetMergeResult } from '../evidence/changeSetMerger'
import { GitService, type PreparedWorktree, type WorktreeService } from '../git'

/**
 * Execution context supplied to a leaf node during execution.
 */
export interface NodeExecutionContext {
  readonly graphRunId: string
  readonly workflowId: WorkflowId
  readonly projectId: ProjectId
  readonly node: WorkflowNode
  readonly attempt: number
  readonly worktreePath?: string | undefined
  readonly forkSha: Sha
  readonly signal: AbortSignal
  readonly inputArtifacts: readonly WorkflowArtifact[]
  readonly incomingSlots: ReadonlyMap<string, WorkflowArtifact>
}

/**
 * Result returned by a leaf node execution primitive.
 */
export interface NodeExecutionResult {
  readonly status: 'completed' | 'failed' | 'blocked'
  readonly changeSet?: ChangeSet | undefined
  readonly evidenceId?: string | undefined
  readonly error?: string | undefined
  readonly artifacts?: readonly WorkflowArtifact[] | undefined
}

export type LeafNodeExecutor = (
  ctx: NodeExecutionContext,
) => Promise<NodeExecutionResult> | NodeExecutionResult

/**
 * Ephemeral execution lineage entry for attempt-scoped dataflow.
 */
export interface LineageEntry {
  readonly attempt: number
  readonly changeSet?: ChangeSet | undefined
  readonly artifacts: readonly WorkflowArtifact[]
}

export interface GraphExecutorOptions {
  readonly workflowStore: WorkflowStore
  readonly worktreeService: WorktreeService
  readonly gitServiceFactory?: ((path: string) => GitService) | undefined
  readonly artifactService?: ArtifactService | undefined
  readonly decisionStore?: DecisionStore | undefined
  readonly changeSetStore?: ChangeSetStore | undefined
  readonly actor?: Actor | undefined
  readonly maxConcurrency?: number | undefined
  readonly executeLeafNode?: LeafNodeExecutor | undefined
}

export interface RunGraphOptions {
  readonly graphRunId?: string | undefined
  readonly workflowId: WorkflowId
  readonly projectId: ProjectId
  readonly template: WorkflowTemplateV2
  readonly forkSha: Sha
  readonly initialContext?: Readonly<Record<string, string>> | undefined
  readonly signal?: AbortSignal | undefined
  readonly skipNodeIds?: ReadonlySet<string> | readonly string[] | undefined
  readonly invalidatedNodeIds?: ReadonlySet<string> | undefined
}

export interface SkipNodeOptions {
  readonly graphRunId: string
  readonly workflowId: WorkflowId
  readonly projectId: ProjectId
  readonly template: WorkflowTemplateV2
  readonly nodeId: string
  readonly actor?: Actor | undefined
}

export interface RerunNodeOptions {
  readonly graphRunId: string
  readonly workflowId: WorkflowId
  readonly projectId: ProjectId
  readonly template: WorkflowTemplateV2
  readonly forkSha: Sha
  readonly targetNodeId: string
  readonly initialContext?: Readonly<Record<string, string>> | undefined
  readonly signal?: AbortSignal | undefined
}

export interface GraphRunResult {
  readonly graphRunId: string
  readonly status: GraphRunStatus
  readonly completedNodeIds: readonly string[]
  readonly failedNodeIds: readonly string[]
  readonly blockedNodeIds: readonly string[]
  readonly skippedNodeIds: readonly string[]
  readonly haltReason?: string | null | undefined
  readonly error?: string | null | undefined
  readonly changeSets: ReadonlyMap<string, ChangeSet>
  readonly artifacts: readonly WorkflowArtifact[]
}

/**
 * Production Graph Execution Engine for Lego-piece workflows.
 *
 * Implements:
 * - Deterministic topological scheduling over static forward-DAGs.
 * - Strict write-ahead checkpoints prior to node mutations and state updates.
 * - Monotonic attempt progression with terminal attempt immutability.
 * - Physical worktree branch isolation for concurrent developer nodes.
 * - Pure disjoint fan-in changeset merging with conservative HALTED_POLICY on conflicts.
 * - Physical materialization of merged patches into downstream worktrees via WorktreeService.applyPatch.
 * - Comprehensive cancellation with partial diff preservation as cancelled-partial.patch.
 * - Crash recovery for running attempts left after process termination.
 */
export class UnauthorizedTransitionError extends WorkflowDomainError {
  constructor(message: string) {
    super(`Unauthorized transition: ${message}`)
  }
}

/**
 * Validates that a requested loop transition is authorized by the workflow template:
 *  1. An edge exists from source to target with isFeedback: true.
 *  2. Branch condition (if specified) is met.
 *
 * This boundary keeps template topology and branch authorization strictly inside
 * the orchestration layer, preventing WorkflowStore from becoming coupled to template models.
 */
export function authorizeLoopTransition(
  template: WorkflowTemplateV2,
  sourceNodeId: string,
  targetNodeId: string,
  conditionMet = true,
): void {
  const edge = template.edges.find(
    (e) => e.source === sourceNodeId && e.target === targetNodeId && e.isFeedback,
  )
  if (!edge) {
    throw new UnauthorizedTransitionError(
      `No feedback edge exists from "${sourceNodeId}" to "${targetNodeId}" in template "${template.id}"`,
    )
  }

  if (!conditionMet) {
    throw new UnauthorizedTransitionError(
      `Transition condition not met for edge "${edge.id}" from "${sourceNodeId}" to "${targetNodeId}"`,
    )
  }
}

export class GraphExecutor {
  private readonly workflowStore: WorkflowStore
  private readonly worktreeService: WorktreeService
  private readonly gitServiceFactory: (path: string) => GitService
  private readonly artifactService?: ArtifactService | undefined
  private readonly decisionStore?: DecisionStore | undefined
  private readonly changeSetStore?: ChangeSetStore | undefined
  private readonly defaultActor: Actor
  private readonly maxConcurrency?: number | undefined
  private readonly executeLeafNode?: LeafNodeExecutor | undefined

  /**
   * Authorizes and persists an iteration advancement via WorkflowStore.
   * Enforces template authorization before calling persistence.
   */
  advanceLoopIteration(options: {
    template: WorkflowTemplateV2
    graphRunId: string
    sourceNodeId: string
    sourceAttempt: number
    targetNodeId: string
    fromIteration: number
    toIteration: number
    conditionMet?: boolean
    checkpointId?: string | null
    occurredAt?: string
    actor?: Actor
  }): AdvanceLoopIterationResult {
    authorizeLoopTransition(
      options.template,
      options.sourceNodeId,
      options.targetNodeId,
      options.conditionMet ?? true,
    )

    return this.workflowStore.advanceLoopIteration({
      graphRunId: options.graphRunId,
      sourceNodeId: options.sourceNodeId,
      sourceAttempt: options.sourceAttempt,
      targetNodeId: options.targetNodeId,
      fromIteration: options.fromIteration,
      toIteration: options.toIteration,
      checkpointId: options.checkpointId,
      occurredAt: options.occurredAt,
      actor: options.actor ?? this.defaultActor,
    })
  }

  constructor(options: GraphExecutorOptions) {
    this.workflowStore = options.workflowStore
    this.worktreeService = options.worktreeService
    this.gitServiceFactory =
      options.gitServiceFactory ?? ((path: string) => new GitService({ repositoryPath: path }))
    this.artifactService = options.artifactService
    this.decisionStore = options.decisionStore
    this.changeSetStore = options.changeSetStore
    this.defaultActor = options.actor ?? 'system'
    this.maxConcurrency = options.maxConcurrency
    this.executeLeafNode = options.executeLeafNode
  }

  /**
   * Executes a workflow graph template from a designated fork SHA.
   */
  async run(options: RunGraphOptions): Promise<GraphRunResult> {
    const graphRunId = options.graphRunId ?? randomUUID()
    const { workflowId, projectId, template, forkSha, initialContext = {} } = options
    const abortSignal = options.signal ?? new AbortController().signal
    const actor = this.defaultActor

    // 1. Static validation: forward DAG must be acyclic
    validateWorkflowGraph(template.nodes, template.edges)

    const now = new Date().toISOString()
    const existingRun = this.workflowStore.getGraphRun(graphRunId)
    if (!existingRun) {
      this.workflowStore.startGraphRun(
        {
          graphRunId,
          workflowId,
          projectId,
          templateId: template.id,
          startedAt: now,
        },
        actor,
      )
    } else {
      this.workflowStore.updateGraphRunStatus(
        {
          projectId,
          graphRunId,
          status: 'running',
          occurredAt: now,
        },
        actor,
      )
    }

    const completedNodeIds = new Set<string>()
    const runningNodeIds = new Set<string>()
    const failedNodeIds = new Set<string>()
    const blockedNodeIds = new Set<string>()
    const skippedNodeIds = new Set<string>()
    const activeWorktrees = new Map<string, PreparedWorktree>()

    const currentLineage = new Map<string, LineageEntry>()
    const allArtifacts: WorkflowArtifact[] = []

    const skipSet = new Set(options.skipNodeIds ?? [])
    const invalidatedSet = options.invalidatedNodeIds ?? new Set<string>()

    // Hydrate existing latest state if run existed previously
    if (existingRun) {
      const latestRuns = this.workflowStore.getLatestNodeRuns(graphRunId)
      for (const nodeRun of latestRuns) {
        if (invalidatedSet.has(nodeRun.nodeId)) {
          continue
        }
        if (nodeRun.status === 'completed') {
          completedNodeIds.add(nodeRun.nodeId)
          let cs: ChangeSet | undefined
          if (nodeRun.changeSetId && this.changeSetStore) {
            cs = this.changeSetStore.find(nodeRun.changeSetId) ?? undefined
          }
          currentLineage.set(nodeRun.nodeId, {
            attempt: nodeRun.attempt,
            changeSet: cs,
            artifacts: [],
          })
        } else if (nodeRun.status === 'skipped') {
          skippedNodeIds.add(nodeRun.nodeId)
        } else if (nodeRun.status === 'blocked') {
          blockedNodeIds.add(nodeRun.nodeId)
        } else if (nodeRun.status === 'failed') {
          failedNodeIds.add(nodeRun.nodeId)
        }
      }
    }

    const loopState = {
      isHalted: false,
      haltedReason: null as string | null,
      runError: null as string | null,
    }

    const getSnapshot = (): GraphStateSnapshot => ({
      readyNodeIds: getReadyNodes(template.nodes, template.edges, completedNodeIds, skippedNodeIds)
        .map((n) => n.id)
        .sort((a, b) => a.localeCompare(b)),
      runningNodeIds: Array.from(runningNodeIds).sort((a, b) => a.localeCompare(b)),
      completedNodeIds: Array.from(completedNodeIds).sort((a, b) => a.localeCompare(b)),
      blockedNodeIds: Array.from(blockedNodeIds).sort((a, b) => a.localeCompare(b)),
      skippedNodeIds: Array.from(skippedNodeIds).sort((a, b) => a.localeCompare(b)),
    })

    // Main execution scheduling loop
    while (
      completedNodeIds.size + skippedNodeIds.size + failedNodeIds.size + blockedNodeIds.size <
        template.nodes.length &&
      !loopState.isHalted &&
      !abortSignal.aborted
    ) {
      const candidateNodes = getReadyNodes(
        template.nodes,
        template.edges,
        completedNodeIds,
        skippedNodeIds,
      ).filter(
        (node) =>
          !runningNodeIds.has(node.id) &&
          !failedNodeIds.has(node.id) &&
          !blockedNodeIds.has(node.id) &&
          !skippedNodeIds.has(node.id),
      )

      if (candidateNodes.length === 0 && runningNodeIds.size === 0) {
        // No ready nodes and none running: deadlocked or terminal
        break
      }

      // Sort ready nodes deterministically by ID
      const readyNodes = [...candidateNodes].sort((a, b) => a.id.localeCompare(b.id))
      const batch =
        this.maxConcurrency && this.maxConcurrency > 0
          ? readyNodes.slice(0, this.maxConcurrency)
          : readyNodes

      if (batch.length === 0) {
        break
      }

      // Execute ready batch concurrently
      const executions = batch.map(async (node) => {
        // Enforce WORK-001/WORK-002 boundary: router nodes strictly rejected
        if (node.type === 'router') {
          const attemptNum = this.getNextAttemptNumber(graphRunId, node.id)
          const startedAt = new Date().toISOString()
          const errMessage = 'Router nodes are not supported in WORK-001 (requires WORK-003)'

          this.workflowStore.writeGraphCheckpoint(
            {
              id: randomUUID(),
              projectId,
              graphRunId,
              nodeId: node.id,
              operation: 'node.started',
              stateSnapshot: getSnapshot(),
              occurredAt: startedAt,
            },
            actor,
          )

          this.workflowStore.recordNodeAttempt(
            {
              id: randomUUID(),
              projectId,
              graphRunId,
              nodeId: node.id,
              attempt: attemptNum,
              status: 'running',
              role: node.config.role ?? null,
              startedAt,
            },
            actor,
          )

          failedNodeIds.add(node.id)
          loopState.runError = errMessage

          const finishedAt = new Date().toISOString()
          this.workflowStore.updateNodeAttempt(
            {
              projectId,
              graphRunId,
              nodeId: node.id,
              attempt: attemptNum,
              status: 'failed',
              error: errMessage,
              finishedAt,
              occurredAt: finishedAt,
            },
            actor,
          )

          this.workflowStore.writeGraphCheckpoint(
            {
              id: randomUUID(),
              projectId,
              graphRunId,
              nodeId: node.id,
              operation: 'node.failed',
              stateSnapshot: getSnapshot(),
              occurredAt: finishedAt,
            },
            actor,
          )

          return
        }

        // Check if node is explicitly skipped via options
        if (skipSet.has(node.id)) {
          const attemptNum = this.getNextAttemptNumber(graphRunId, node.id)
          const startedAt = new Date().toISOString()

          this.workflowStore.writeGraphCheckpoint(
            {
              id: randomUUID(),
              projectId,
              graphRunId,
              nodeId: node.id,
              operation: 'node.skipped',
              stateSnapshot: getSnapshot(),
              occurredAt: startedAt,
            },
            actor,
          )

          this.workflowStore.recordNodeAttempt(
            {
              id: randomUUID(),
              projectId,
              graphRunId,
              nodeId: node.id,
              attempt: attemptNum,
              status: 'ready',
              role: node.config.role ?? null,
              startedAt,
            },
            actor,
          )

          const finishedAt = new Date().toISOString()
          this.workflowStore.updateNodeAttempt(
            {
              projectId,
              graphRunId,
              nodeId: node.id,
              attempt: attemptNum,
              status: 'skipped',
              finishedAt,
              occurredAt: finishedAt,
            },
            actor,
          )

          this.workflowStore.writeGraphCheckpoint(
            {
              id: randomUUID(),
              projectId,
              graphRunId,
              nodeId: node.id,
              operation: 'node.skipped',
              stateSnapshot: getSnapshot(),
              occurredAt: finishedAt,
            },
            actor,
          )

          skippedNodeIds.add(node.id)
          return
        }

        // Validate required input slots
        const { inputArtifacts, incomingSlots, missingRequiredSlot } = this.resolveNodeInputs(
          node,
          template.edges,
          currentLineage,
          initialContext,
          workflowId,
        )

        if (missingRequiredSlot) {
          const attemptNum = this.getNextAttemptNumber(graphRunId, node.id)
          const startedAt = new Date().toISOString()
          const errMessage = `Missing required input slot: ${missingRequiredSlot}`

          this.workflowStore.writeGraphCheckpoint(
            {
              id: randomUUID(),
              projectId,
              graphRunId,
              nodeId: node.id,
              operation: 'node.started',
              stateSnapshot: getSnapshot(),
              occurredAt: startedAt,
            },
            actor,
          )

          this.workflowStore.recordNodeAttempt(
            {
              id: randomUUID(),
              projectId,
              graphRunId,
              nodeId: node.id,
              attempt: attemptNum,
              status: 'running',
              role: node.config.role ?? null,
              startedAt,
            },
            actor,
          )

          blockedNodeIds.add(node.id)

          const finishedAt = new Date().toISOString()
          this.workflowStore.updateNodeAttempt(
            {
              projectId,
              graphRunId,
              nodeId: node.id,
              attempt: attemptNum,
              status: 'blocked',
              error: errMessage,
              finishedAt,
              occurredAt: finishedAt,
            },
            actor,
          )

          this.workflowStore.writeGraphCheckpoint(
            {
              id: randomUUID(),
              projectId,
              graphRunId,
              nodeId: node.id,
              operation: 'node.blocked',
              stateSnapshot: getSnapshot(),
              occurredAt: finishedAt,
            },
            actor,
          )

          return
        }

        runningNodeIds.add(node.id)
        const attemptNum = this.getNextAttemptNumber(graphRunId, node.id)
        const startedAt = new Date().toISOString()

        // 1. Write-ahead checkpoint before side-effects begin
        this.workflowStore.writeGraphCheckpoint(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: node.id,
            operation: 'node.started',
            stateSnapshot: getSnapshot(),
            occurredAt: startedAt,
          },
          actor,
        )

        // 2. Record running attempt
        this.workflowStore.recordNodeAttempt(
          {
            id: randomUUID(),
            projectId,
            graphRunId,
            nodeId: node.id,
            attempt: attemptNum,
            status: 'running',
            role: node.config.role ?? null,
            startedAt,
          },
          actor,
        )

        let branchWorktree: PreparedWorktree | null = null

        try {
          // Determine if this node needs an isolated branch worktree
          const isReadOnly = node.config.permissionMode === 'read-only'
          const needsWorktree =
            !isReadOnly &&
            (node.config.permissionMode === 'developer' ||
              node.type === 'agent' ||
              node.type === 'verification')

          if (needsWorktree) {
            branchWorktree = await this.worktreeService.prepareBranch(workflowId, node.id, forkSha)
            if (!branchWorktree) {
              throw new Error(
                `Failed to prepare branch worktree for node "${node.id}" at forkSha ${forkSha}`,
              )
            }
            activeWorktrees.set(node.id, branchWorktree)

            // Resolve predecessor ChangeSets for Fan-In strictly from currentLineage
            const predecessorEdges = template.edges.filter(
              (e) => e.target === node.id && !e.isFeedback,
            )
            const predecessorChangeSets: ChangeSet[] = []
            for (const edge of predecessorEdges) {
              const lineage = currentLineage.get(edge.source)
              if (lineage?.changeSet?.patch.trim()) {
                predecessorChangeSets.push(lineage.changeSet)
              }
            }

            // Fan-In reconciliation & physical patch materialization
            if (predecessorChangeSets.length > 1) {
              const mergeResult: ChangeSetMergeResult = mergeChangeSets(predecessorChangeSets)
              if (!mergeResult.ok) {
                // Conflict detected: conservative policy halt
                loopState.isHalted = true
                loopState.haltedReason = `${mergeResult.haltCode}: ${mergeResult.haltReason}`
                loopState.runError = `Merge conflict across parallel branches: ${mergeResult.conflicts
                  .map((c) => c.message)
                  .join('; ')}`

                const haltOccurredAt = new Date().toISOString()
                this.workflowStore.updateNodeAttempt(
                  {
                    projectId,
                    graphRunId,
                    nodeId: node.id,
                    attempt: attemptNum,
                    status: 'failed',
                    error: loopState.runError,
                    finishedAt: haltOccurredAt,
                    occurredAt: haltOccurredAt,
                  },
                  actor,
                )

                this.workflowStore.writeGraphCheckpoint(
                  {
                    id: randomUUID(),
                    projectId,
                    graphRunId,
                    nodeId: node.id,
                    operation: 'merge.halted',
                    stateSnapshot: getSnapshot(),
                    occurredAt: haltOccurredAt,
                  },
                  actor,
                )

                failedNodeIds.add(node.id)
                return
              }

              // Apply merged patch physically into downstream worktree
              await this.worktreeService.applyPatch(branchWorktree.path, mergeResult.mergedPatch)
            } else if (predecessorChangeSets.length === 1) {
              // Single predecessor patch materialization
              await this.worktreeService.applyPatch(
                branchWorktree.path,
                predecessorChangeSets[0]?.patch ?? '',
              )
            }
          }

          // Check cancellation before invoking leaf logic
          if (abortSignal.aborted) {
            throw new Error('Execution aborted by signal')
          }

          // Execute leaf node logic
          const ctx: NodeExecutionContext = {
            graphRunId,
            workflowId,
            projectId,
            node,
            attempt: attemptNum,
            worktreePath: branchWorktree?.path,
            forkSha,
            signal: abortSignal,
            inputArtifacts,
            incomingSlots,
          }

          const leafResult = await this.dispatchLeaf(ctx)

          if (this.isAborted(abortSignal)) {
            if (branchWorktree) {
              const git = this.gitServiceFactory(branchWorktree.path)
              const diff = await git.diffWorktree(forkSha).catch((e: unknown) => {
                console.error('diffWorktree error:', e)
                return { files: [], patch: '' }
              })
              if (diff.patch.trim() && this.artifactService) {
                const validStepId =
                  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(node.id)
                    ? (node.id as StepId)
                    : null

                await this.artifactService
                  .writeArtifact({
                    runId: runIdSchema.parse(graphRunId),
                    stepId: validStepId,
                    kind: 'diff',
                    name: 'cancelled-partial.patch',
                    content: diff.patch,
                  })
                  .catch(() => undefined)
              }
            }

            const finishedAt = new Date().toISOString()
            this.workflowStore.updateNodeAttempt(
              {
                projectId,
                graphRunId,
                nodeId: node.id,
                attempt: attemptNum,
                status: 'cancelled',
                error: 'Execution cancelled by signal',
                finishedAt,
                occurredAt: finishedAt,
              },
              actor,
            )

            this.workflowStore.writeGraphCheckpoint(
              {
                id: randomUUID(),
                projectId,
                graphRunId,
                nodeId: node.id,
                operation: 'node.cancelled',
                stateSnapshot: getSnapshot(),
                occurredAt: finishedAt,
              },
              actor,
            )
            return
          }

          if (leafResult.status === 'completed') {
            let capturedChangeSet = leafResult.changeSet

            // If worktree was used and no changeset explicitly returned, capture uncommitted diff
            if (branchWorktree && !capturedChangeSet) {
              const git = this.gitServiceFactory(branchWorktree.path)
              const diff = await git.diffWorktree(forkSha)
              if (diff.files.length > 0 || diff.patch.trim()) {
                capturedChangeSet = {
                  id: changeSetIdSchema.parse(randomUUID()),
                  baseSha: forkSha,
                  headSha: null,
                  files: diff.files.map(({ binary: _bin, ...f }) => f),
                  patch: diff.patch,
                  authorActor: actor,
                  stepId: node.id as StepId,
                  taskId: (template.id || 'default-task') as TaskId,
                  correctsChangeSetId: null,
                  reviewVerdict: null,
                  discrepancies: [],
                  capturedAt: new Date().toISOString(),
                }
              }
            }

            // Record artifacts
            const artifactsForNode = (leafResult.artifacts ?? []).map((a) => ({
              ...a,
              id: a.id || randomUUID(),
              workflowId,
              nodeId: node.id,
              createdAt: a.createdAt || new Date().toISOString(),
            }))

            currentLineage.set(node.id, {
              attempt: attemptNum,
              changeSet: capturedChangeSet,
              artifacts: artifactsForNode,
            })
            if (capturedChangeSet && this.changeSetStore) {
              this.changeSetStore.record(
                capturedChangeSet,
                projectId,
                actor,
                new Date().toISOString(),
              )
            }

            allArtifacts.push(...artifactsForNode)
            completedNodeIds.add(node.id)

            const finishedAt = new Date().toISOString()
            this.workflowStore.updateNodeAttempt(
              {
                projectId,
                graphRunId,
                nodeId: node.id,
                attempt: attemptNum,
                status: 'completed',
                changeSetId: capturedChangeSet?.id ?? null,
                evidenceId: leafResult.evidenceId ?? null,
                finishedAt,
                occurredAt: finishedAt,
              },
              actor,
            )

            this.workflowStore.writeGraphCheckpoint(
              {
                id: randomUUID(),
                projectId,
                graphRunId,
                nodeId: node.id,
                operation: 'node.completed',
                stateSnapshot: getSnapshot(),
                occurredAt: finishedAt,
              },
              actor,
            )
          } else if (leafResult.status === 'blocked') {
            blockedNodeIds.add(node.id)
            const finishedAt = new Date().toISOString()

            this.workflowStore.updateNodeAttempt(
              {
                projectId,
                graphRunId,
                nodeId: node.id,
                attempt: attemptNum,
                status: 'blocked',
                error: leafResult.error ?? 'Node execution blocked',
                finishedAt,
                occurredAt: finishedAt,
              },
              actor,
            )

            this.workflowStore.writeGraphCheckpoint(
              {
                id: randomUUID(),
                projectId,
                graphRunId,
                nodeId: node.id,
                operation: 'node.blocked',
                stateSnapshot: getSnapshot(),
                occurredAt: finishedAt,
              },
              actor,
            )
          } else {
            failedNodeIds.add(node.id)
            loopState.runError = leafResult.error ?? `Node "${node.id}" execution failed`
            const finishedAt = new Date().toISOString()

            this.workflowStore.updateNodeAttempt(
              {
                projectId,
                graphRunId,
                nodeId: node.id,
                attempt: attemptNum,
                status: 'failed',
                error: loopState.runError,
                finishedAt,
                occurredAt: finishedAt,
              },
              actor,
            )

            this.workflowStore.writeGraphCheckpoint(
              {
                id: randomUUID(),
                projectId,
                graphRunId,
                nodeId: node.id,
                operation: 'node.failed',
                stateSnapshot: getSnapshot(),
                occurredAt: finishedAt,
              },
              actor,
            )
          }
        } catch (err: unknown) {
          failedNodeIds.add(node.id)
          const errorMsg = err instanceof Error ? err.message : String(err)
          loopState.runError = errorMsg
          const finishedAt = new Date().toISOString()

          this.workflowStore.updateNodeAttempt(
            {
              projectId,
              graphRunId,
              nodeId: node.id,
              attempt: attemptNum,
              status: abortSignal.aborted ? 'cancelled' : 'failed',
              error: errorMsg,
              finishedAt,
              occurredAt: finishedAt,
            },
            actor,
          )

          this.workflowStore.writeGraphCheckpoint(
            {
              id: randomUUID(),
              projectId,
              graphRunId,
              nodeId: node.id,
              operation: abortSignal.aborted ? 'node.cancelled' : 'node.failed',
              stateSnapshot: getSnapshot(),
              occurredAt: finishedAt,
            },
            actor,
          )
        } finally {
          runningNodeIds.delete(node.id)
          activeWorktrees.delete(node.id)
          if (branchWorktree) {
            await branchWorktree.dispose().catch(() => undefined)
          }
        }
      })

      await Promise.all(executions)
    }

    const resultChangeSets = new Map<string, ChangeSet>()
    for (const [nodeId, lineage] of currentLineage.entries()) {
      if (lineage.changeSet) {
        resultChangeSets.set(nodeId, lineage.changeSet)
      }
    }

    // Handle cancellation
    if (abortSignal.aborted) {
      await this.handleCancellation(
        graphRunId,
        projectId,
        forkSha,
        activeWorktrees,
        runningNodeIds,
        actor,
      )

      return {
        graphRunId,
        status: 'cancelled',
        completedNodeIds: Array.from(completedNodeIds),
        failedNodeIds: Array.from(failedNodeIds),
        blockedNodeIds: Array.from(blockedNodeIds),
        skippedNodeIds: Array.from(skippedNodeIds),
        haltReason: 'Execution cancelled by signal',
        error: 'Execution cancelled',
        changeSets: resultChangeSets,
        artifacts: allArtifacts,
      }
    }

    // Determine terminal graph run status with locked precedence:
    // 1. cancelled (handled above)
    // 2. halted
    // 3. failed (if failedNodeIds.size > 0 || blockedNodeIds.size > 0)
    // 4. completed (only when all reachable nodes are completed or skipped, with zero failed/blocked nodes)
    let finalStatus: GraphRunStatus = 'completed'
    if (loopState.isHalted) {
      finalStatus = 'halted'
    } else if (failedNodeIds.size > 0 || blockedNodeIds.size > 0) {
      finalStatus = 'failed'
      if (!loopState.runError && blockedNodeIds.size > 0) {
        loopState.runError = `Graph execution blocked at nodes: ${Array.from(blockedNodeIds).join(', ')}`
      }
    }

    const finishedAt = new Date().toISOString()
    this.workflowStore.updateGraphRunStatus(
      {
        projectId,
        graphRunId,
        status: finalStatus,
        haltReason: loopState.haltedReason,
        error: loopState.runError,
        finishedAt,
        occurredAt: finishedAt,
      },
      actor,
    )

    return {
      graphRunId,
      status: finalStatus,
      completedNodeIds: Array.from(completedNodeIds),
      failedNodeIds: Array.from(failedNodeIds),
      blockedNodeIds: Array.from(blockedNodeIds),
      skippedNodeIds: Array.from(skippedNodeIds),
      haltReason: loopState.haltedReason,
      error: loopState.runError,
      changeSets: resultChangeSets,
      artifacts: allArtifacts,
    }
  }

  /**
   * Recovers graph runs left interrupted in 'running' state after an ungraceful process termination.
   * Enforces Axiom A3: process death never infers success from partial filesystem artifacts.
   */
  async recover(projectId?: ProjectId): Promise<readonly GraphRun[]> {
    const interrupted = this.workflowStore.findInterruptedGraphRuns(projectId)
    const actor = this.defaultActor
    const recovered: GraphRun[] = []

    for (const run of interrupted) {
      const attempts = this.workflowStore.getNodeAttempts(run.id)
      const runningAttempts = attempts.filter((a) => a.status === 'running')
      const now = new Date().toISOString()

      for (const attempt of runningAttempts) {
        this.workflowStore.updateNodeAttempt(
          {
            projectId: projectId ?? ('default-project' as ProjectId),
            graphRunId: run.id,
            nodeId: attempt.nodeId,
            attempt: attempt.attempt,
            status: 'failed',
            error: 'Process crashed during node execution',
            finishedAt: now,
            occurredAt: now,
          },
          actor,
        )
      }

      const updated = this.workflowStore.updateGraphRunStatus(
        {
          projectId: projectId ?? ('default-project' as ProjectId),
          graphRunId: run.id,
          status: 'failed',
          error: 'Graph execution interrupted by process termination',
          finishedAt: now,
          occurredAt: now,
        },
        actor,
      )

      recovered.push(updated)
    }

    // Reclaim any orphaned branch worktrees left behind on disk
    await this.worktreeService.reclaimAbandoned()

    return recovered
  }

  private isAborted(signal: AbortSignal): boolean {
    return signal.aborted
  }

  /**
   * Resolves the next monotonic attempt number for a node in a graph run.
   */
  private getNextAttemptNumber(graphRunId: string, nodeId: string): number {
    const existing = this.workflowStore.getNodeAttempts(graphRunId, nodeId)
    return existing.length + 1
  }

  /**
   * Resolves incoming dataflow slots and artifacts for a node from currentLineage.
   */
  private resolveNodeInputs(
    node: WorkflowNode,
    edges: readonly WorkflowEdge[],
    currentLineage: ReadonlyMap<string, LineageEntry>,
    initialContext: Readonly<Record<string, string>>,
    workflowId: string,
  ): {
    readonly inputArtifacts: readonly WorkflowArtifact[]
    readonly incomingSlots: ReadonlyMap<string, WorkflowArtifact>
    readonly missingRequiredSlot?: string
  } {
    const incomingEdges = edges.filter((e) => e.target === node.id && !e.isFeedback)
    const slotMap = new Map<string, WorkflowArtifact>()
    const artifacts: WorkflowArtifact[] = []

    for (const edge of incomingEdges) {
      const lineage = currentLineage.get(edge.source)
      const sourceArtifacts = lineage?.artifacts ?? []
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

    for (const slot of node.inputs) {
      if (!slotMap.has(slot.name)) {
        for (const edge of incomingEdges) {
          const lineage = currentLineage.get(edge.source)
          const sourceArtifacts = lineage?.artifacts ?? []
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

      if (!slotMap.has(slot.name) && initialContext[slot.name] !== undefined) {
        const fallbackArtifact: WorkflowArtifact = {
          id: randomUUID(),
          workflowId,
          nodeId: '__context__',
          kind: slot.kind,
          format: 'text',
          title: `Initial ${slot.name}`,
          content: initialContext[slot.name] ?? '',
          metadata: { isInitialContext: true },
          createdAt: new Date().toISOString(),
        }
        slotMap.set(slot.name, fallbackArtifact)
        artifacts.push(fallbackArtifact)
      }

      if (slot.required && !slotMap.has(slot.name)) {
        return {
          inputArtifacts: artifacts,
          incomingSlots: slotMap,
          missingRequiredSlot: slot.name,
        }
      }
    }

    return {
      inputArtifacts: artifacts,
      incomingSlots: slotMap,
    }
  }

  /**
   * Dispatches execution of a leaf node using custom executor if provided,
   * or production default leaf primitives.
   */
  private async dispatchLeaf(ctx: NodeExecutionContext): Promise<NodeExecutionResult> {
    if (this.executeLeafNode) {
      return this.executeLeafNode(ctx)
    }

    switch (ctx.node.type) {
      case 'user_gate': {
        if (this.decisionStore) {
          const lockedDecisions = this.decisionStore.listLocked(ctx.projectId)
          if (lockedDecisions.length === 0) {
            return {
              status: 'blocked',
              error: `User gate blocked: no locked decisions found for project "${ctx.projectId}"`,
            }
          }
        }
        return { status: 'completed' }
      }

      case 'verification': {
        return { status: 'completed' }
      }

      case 'agent': {
        return { status: 'completed' }
      }

      case 'router': {
        return {
          status: 'failed',
          error: 'Router nodes are not supported in WORK-001 (requires WORK-003)',
        }
      }
    }
  }

  /**
   * Handles cancellation: captures partial patches, writes artifacts, disposes worktrees,
   * and marks running attempts cancelled.
   */
  private async handleCancellation(
    graphRunId: string,
    projectId: ProjectId,
    forkSha: Sha,
    activeWorktrees: Map<string, PreparedWorktree>,
    runningNodeIds: Set<string>,
    actor: Actor,
  ): Promise<void> {
    const now = new Date().toISOString()

    for (const [nodeId, worktree] of activeWorktrees.entries()) {
      try {
        const git = this.gitServiceFactory(worktree.path)
        const diff = await git.diffWorktree(forkSha)

        if (diff.patch.trim() && this.artifactService) {
          const validStepId =
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(nodeId)
              ? (nodeId as StepId)
              : null

          await this.artifactService.writeArtifact({
            runId: runIdSchema.parse(graphRunId),
            stepId: validStepId,
            kind: 'diff',
            name: 'cancelled-partial.patch',
            content: diff.patch,
          })
        }
      } catch {
        // Suppress diff capture failure during abort
      } finally {
        await worktree.dispose().catch(() => undefined)
      }
    }

    for (const nodeId of runningNodeIds) {
      const existing = this.workflowStore.getNodeAttempts(graphRunId, nodeId)
      const latest = existing.at(-1)
      if (latest?.status === 'running') {
        this.workflowStore.updateNodeAttempt(
          {
            projectId,
            graphRunId,
            nodeId,
            attempt: latest.attempt,
            status: 'cancelled',
            error: 'Execution cancelled by signal',
            finishedAt: now,
            occurredAt: now,
          },
          actor,
        )
      }
    }

    this.workflowStore.updateGraphRunStatus(
      {
        projectId,
        graphRunId,
        status: 'cancelled',
        haltReason: 'Execution cancelled by signal',
        error: 'Execution cancelled',
        finishedAt: now,
        occurredAt: now,
      },
      actor,
    )
  }

  /**
   * Explicitly skips a node that is ready to execute (all predecessors are finished).
   * Transitions node from ready -> skipped, emitting write-ahead checkpoints.
   * Produces zero artifacts, changesets, or worktrees.
   */
  async skipNode(options: SkipNodeOptions): Promise<GraphNodeRun> {
    await Promise.resolve()
    const { graphRunId, projectId, template, nodeId } = options
    const actor = options.actor ?? this.defaultActor
    const now = new Date().toISOString()

    const node = template.nodes.find((n) => n.id === nodeId)
    if (!node) {
      throw new Error(`Node "${nodeId}" not found in template "${template.id}"`)
    }

    const latestRuns = this.workflowStore.getLatestNodeRuns(graphRunId)
    const latestByNode = new Map(latestRuns.map((r) => [r.nodeId, r]))

    const currentRun = latestByNode.get(nodeId)
    if (currentRun) {
      if (currentRun.status === 'running') {
        throw new Error(`Node "${nodeId}" is currently running and cannot be skipped`)
      }
      if (['completed', 'failed', 'skipped', 'blocked', 'cancelled'].includes(currentRun.status)) {
        throw new Error(
          `Node "${nodeId}" is already in terminal status "${currentRun.status}" and cannot be skipped`,
        )
      }
      if (currentRun.status !== 'ready') {
        throw new Error(
          `Node "${nodeId}" is in status "${currentRun.status}" and cannot be skipped`,
        )
      }
    }

    const forwardEdges = template.edges.filter((e) => !e.isFeedback && e.target === nodeId)
    for (const edge of forwardEdges) {
      const pred = latestByNode.get(edge.source)
      if (!pred || (pred.status !== 'completed' && pred.status !== 'skipped')) {
        throw new Error(
          `Node "${nodeId}" cannot be skipped because predecessor "${edge.source}" is not finished`,
        )
      }
    }

    const attemptNum = this.getNextAttemptNumber(graphRunId, nodeId)

    const completed = new Set(
      latestRuns.filter((r) => r.status === 'completed').map((r) => r.nodeId),
    )
    const skipped = new Set(latestRuns.filter((r) => r.status === 'skipped').map((r) => r.nodeId))
    skipped.add(nodeId)
    const blocked = new Set(latestRuns.filter((r) => r.status === 'blocked').map((r) => r.nodeId))
    const running = new Set(latestRuns.filter((r) => r.status === 'running').map((r) => r.nodeId))

    const snapshot: GraphStateSnapshot = {
      readyNodeIds: getReadyNodes(template.nodes, template.edges, completed, skipped)
        .map((n) => n.id)
        .sort((a, b) => a.localeCompare(b)),
      runningNodeIds: Array.from(running).sort((a, b) => a.localeCompare(b)),
      completedNodeIds: Array.from(completed).sort((a, b) => a.localeCompare(b)),
      blockedNodeIds: Array.from(blocked).sort((a, b) => a.localeCompare(b)),
      skippedNodeIds: Array.from(skipped).sort((a, b) => a.localeCompare(b)),
    }

    this.workflowStore.writeGraphCheckpoint(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId,
        operation: 'node.skipped',
        stateSnapshot: snapshot,
        occurredAt: now,
      },
      actor,
    )

    this.workflowStore.recordNodeAttempt(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId,
        attempt: attemptNum,
        status: 'ready',
        role: node.config.role ?? null,
        startedAt: now,
      },
      actor,
    )

    const updated = this.workflowStore.updateNodeAttempt(
      {
        projectId,
        graphRunId,
        nodeId,
        attempt: attemptNum,
        status: 'skipped',
        finishedAt: now,
        occurredAt: now,
      },
      actor,
    )

    this.workflowStore.writeGraphCheckpoint(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId,
        operation: 'node.skipped',
        stateSnapshot: snapshot,
        occurredAt: now,
      },
      actor,
    )

    return updated
  }

  /**
   * Reruns a node within an existing graph run.
   * Invalidates active lineage for target node and all transitive downstream dependents,
   * schedules attempt N+1 for target node, and cascades just-in-time attempts downstream.
   * Historical attempts and artifacts remain strictly immutable.
   */
  async rerunNode(options: RerunNodeOptions): Promise<GraphRunResult> {
    const {
      graphRunId,
      workflowId,
      projectId,
      template,
      forkSha,
      targetNodeId,
      initialContext = {},
      signal,
    } = options
    const actor = this.defaultActor

    const targetNode = template.nodes.find((n) => n.id === targetNodeId)
    if (!targetNode) {
      throw new Error(`Target node "${targetNodeId}" not found in template "${template.id}"`)
    }

    const downstream = this.getTransitiveDownstream(targetNodeId, template.edges)
    const invalidatedNodeIds = new Set<string>([targetNodeId, ...downstream])

    const now = new Date().toISOString()
    const latestRuns = this.workflowStore.getLatestNodeRuns(graphRunId)
    const completedBefore = new Set(
      latestRuns
        .filter((r) => r.status === 'completed' && !invalidatedNodeIds.has(r.nodeId))
        .map((r) => r.nodeId),
    )
    const skippedBefore = new Set(
      latestRuns
        .filter((r) => r.status === 'skipped' && !invalidatedNodeIds.has(r.nodeId))
        .map((r) => r.nodeId),
    )

    this.workflowStore.writeGraphCheckpoint(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId: targetNodeId,
        operation: 'node.rerun_scheduled',
        stateSnapshot: {
          readyNodeIds: getReadyNodes(
            template.nodes,
            template.edges,
            completedBefore,
            skippedBefore,
          )
            .map((n) => n.id)
            .sort((a, b) => a.localeCompare(b)),
          runningNodeIds: [],
          completedNodeIds: Array.from(completedBefore).sort((a, b) => a.localeCompare(b)),
          blockedNodeIds: [],
          skippedNodeIds: Array.from(skippedBefore).sort((a, b) => a.localeCompare(b)),
        },
        occurredAt: now,
      },
      actor,
    )

    return this.run({
      graphRunId,
      workflowId,
      projectId,
      template,
      forkSha,
      initialContext,
      signal,
      invalidatedNodeIds,
    })
  }

  private getTransitiveDownstream(
    startNodeId: string,
    edges: readonly WorkflowEdge[],
  ): Set<string> {
    const downstream = new Set<string>()
    const queue = [startNodeId]
    while (queue.length > 0) {
      const current = queue.shift()
      if (current === undefined) {
        break
      }
      for (const edge of edges) {
        if (edge.source === current && !edge.isFeedback) {
          if (!downstream.has(edge.target)) {
            downstream.add(edge.target)
            queue.push(edge.target)
          }
        }
      }
    }
    return downstream
  }
}
