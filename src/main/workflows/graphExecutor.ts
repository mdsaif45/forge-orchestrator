import { randomUUID } from 'node:crypto'
import {
  artifactIdSchema,
  artifactKindSchema,
  authoritativeReviewVerdictSchema,
  changeSetIdSchema,
  evaluateCondition,
  evidenceIdSchema,
  getLoopBody,
  getReadyNodes,
  runIdSchema,
  stepIdSchema,
  validateWorkflowGraph,
  workflowArtifactSchema,
  type Actor,
  type ArtifactMetadata,
  type ChangeSet,
  type GraphNodeRun,
  type GraphRun,
  type GraphRunStatus,
  type GraphStateSnapshot,
  type LoopPolicy,
  type OutputDefinition,
  type ProjectId,
  type Repository,
  type Sha,
  type StepId,
  type Task,
  type TaskId,
  type WorkflowArtifact,
  type WorkflowEdge,
  type WorkflowId,
  type WorkflowNode,
  type WorkflowTemplateV2,
} from '@shared/domain'
import {
  computeIterationFingerprint,
  getConsecutiveRepeatCount,
  type RouterDecisionRecord,
} from './loopFingerprint'
import type { ArtifactService } from '../artifacts/artifactService'
import type { BindingStore } from '../db/bindingStore'
import type { ChangeSetStore } from '../db/changeSetStore'
import type { DecisionStore } from '../db/decisionStore'
import type { ProjectStore } from '../db/projectStore'
import {
  WorkflowDomainError,
  type AdvanceLoopIterationResult,
  type WorkflowStore,
} from '../db/workflowStore'
import { mergeChangeSets, type ChangeSetMergeResult } from '../evidence/changeSetMerger'
import { GitService, type PreparedWorktree, type WorktreeService } from '../git'
import type { BindingSet } from '../runtimes/bindings'
import type { RuntimeRegistry } from '../runtimes/registry'
import { resolveRoleRuntime } from './roleResolution'

/**
 * Execution context supplied to a leaf node during execution.
 */
export interface NodeExecutionContext {
  readonly graphRunId: string
  readonly workflowId: WorkflowId
  readonly projectId: ProjectId
  readonly taskId?: TaskId | undefined
  readonly task?: Task | undefined
  readonly repository?: Repository | undefined
  readonly node: WorkflowNode
  readonly attempt: number
  readonly attemptId?: string | undefined
  readonly runtimeId?: string | undefined
  readonly bindings?: BindingSet | undefined
  readonly worktreePath?: string | undefined
  readonly forkSha: Sha
  readonly signal: AbortSignal
  readonly inputArtifacts: readonly WorkflowArtifact[]
  readonly incomingSlots: ReadonlyMap<string, WorkflowArtifact>
  readonly outgoingEdges?: readonly WorkflowEdge[] | undefined
  readonly initialContext?: Readonly<Record<string, string>> | undefined
  readonly iteration?: number | undefined
}

/**
 * Result returned by a leaf node execution primitive.
 */
export interface NodeExecutionResult {
  readonly status: 'completed' | 'failed' | 'blocked' | 'cancelled'
  readonly runtimeId?: string | undefined
  readonly changeSet?: ChangeSet | undefined
  readonly evidenceId?: string | undefined
  readonly error?: string | undefined
  readonly artifacts?: readonly WorkflowArtifact[] | undefined
  readonly awaitingUser?: boolean | undefined
  readonly resumable?: boolean | undefined
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
  readonly projectStore?: ProjectStore | undefined
  readonly bindingStore?: BindingStore | undefined
  readonly bindings?: BindingSet | undefined
  readonly registry?: RuntimeRegistry | undefined
  readonly defaultRuntimeId?: string | undefined
  readonly actor?: Actor | undefined
  readonly maxConcurrency?: number | undefined
  readonly executeLeafNode?: LeafNodeExecutor | undefined
  /**
   * Test-only opt-in allowing leaf nodes to emit artifacts in memory without
   * durable persistence when ArtifactService is unconfigured.
   *
   * In production (default: false), any emitted artifacts (declared or undeclared)
   * strictly require ArtifactService; attempting to emit artifacts without ArtifactService
   * fails closed to prevent silent artifact loss.
   */
  readonly testOnlyAllowEphemeralArtifacts?: boolean | undefined
}

export interface RunGraphOptions {
  readonly graphRunId?: string | undefined
  readonly workflowId: WorkflowId
  readonly projectId: ProjectId
  readonly taskId?: TaskId | undefined
  readonly task?: Task | undefined
  readonly repository?: Repository | undefined
  readonly template: WorkflowTemplateV2
  readonly forkSha: Sha
  readonly initialContext?: Readonly<Record<string, string>> | undefined
  readonly bindings?: BindingSet | undefined
  readonly signal?: AbortSignal | undefined
  readonly skipNodeIds?: ReadonlySet<string> | readonly string[] | undefined
  readonly invalidatedNodeIds?: ReadonlySet<string> | undefined
  readonly resumeNodeIds?: ReadonlySet<string> | readonly string[] | undefined
  readonly loopPolicy?: LoopPolicy | undefined
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
  readonly loopPolicy?: LoopPolicy | undefined
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
  private readonly projectStore?: ProjectStore | undefined
  private readonly bindingStore?: BindingStore | undefined
  private readonly bindings?: BindingSet | undefined
  private readonly registry?: RuntimeRegistry | undefined
  private readonly defaultRuntimeId?: string | undefined
  private readonly defaultActor: Actor
  private readonly maxConcurrency?: number | undefined
  private readonly executeLeafNode?: LeafNodeExecutor | undefined
  private readonly testOnlyAllowEphemeralArtifacts: boolean

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
    this.projectStore = options.projectStore
    this.bindingStore = options.bindingStore
    this.bindings = options.bindings
    this.registry = options.registry
    this.defaultRuntimeId = options.defaultRuntimeId
    this.defaultActor = options.actor ?? 'system'
    this.maxConcurrency = options.maxConcurrency
    this.executeLeafNode = options.executeLeafNode
    this.testOnlyAllowEphemeralArtifacts = options.testOnlyAllowEphemeralArtifacts ?? false
  }

  /**
   * Executes a workflow graph template from a designated fork SHA.
   */
  async run(options: RunGraphOptions): Promise<GraphRunResult> {
    const graphRunId = options.graphRunId ?? randomUUID()
    const { workflowId, projectId, template, forkSha, initialContext = {} } = options
    const abortSignal = options.signal ?? new AbortController().signal
    const actor = this.defaultActor

    const workflow = this.workflowStore.find(workflowId)
    const resolvedTaskId = options.taskId ?? workflow?.taskId
    const resolvedTask =
      options.task ??
      (resolvedTaskId ? (this.workflowStore.getTask(resolvedTaskId) ?? undefined) : undefined)
    const resolvedRepository =
      options.repository ?? this.projectStore?.findById(projectId)?.repository ?? undefined

    // 1. Static validation: forward DAG must be acyclic and feedback loops valid
    validateWorkflowGraph(template.nodes, template.edges, template.loopPolicy ?? options.loopPolicy)

    const now = new Date().toISOString()
    const allArtifacts: WorkflowArtifact[] = []
    const existingRun = this.workflowStore.getGraphRun(graphRunId)

    // Idempotent return for already terminal runs
    if (
      existingRun &&
      (existingRun.status === 'completed' ||
        existingRun.status === 'failed' ||
        existingRun.status === 'halted' ||
        existingRun.status === 'cancelled') &&
      existingRun.finishedAt !== null &&
      (!options.invalidatedNodeIds || options.invalidatedNodeIds.size === 0)
    ) {
      const latestRuns = this.workflowStore.getLatestNodeRuns(graphRunId)
      const resultChangeSets = new Map<string, ChangeSet>()
      const parsedRunId = runIdSchema.safeParse(graphRunId)
      const allRunMetas =
        parsedRunId.success && this.artifactService
          ? this.artifactService.listArtifacts(parsedRunId.data)
          : []
      const artifactsByStepId = new Map<string, ArtifactMetadata[]>()
      for (const meta of allRunMetas) {
        if (meta.stepId) {
          const list = artifactsByStepId.get(meta.stepId) ?? []
          list.push(meta)
          artifactsByStepId.set(meta.stepId, list)
        }
      }

      for (const nodeRun of latestRuns) {
        if (nodeRun.changeSetId && this.changeSetStore) {
          const cs = this.changeSetStore.find(nodeRun.changeSetId)
          if (cs) {
            resultChangeSets.set(nodeRun.nodeId, cs)
          }
        }
        if (nodeRun.status === 'completed') {
          const stepMetas = artifactsByStepId.get(nodeRun.id) ?? []
          const hydrated = await this.hydrateNodeArtifacts(nodeRun, workflowId, stepMetas)
          allArtifacts.push(...hydrated)
        }
      }

      return {
        graphRunId,
        status: existingRun.status,
        completedNodeIds: latestRuns.filter((r) => r.status === 'completed').map((r) => r.nodeId),
        failedNodeIds: latestRuns.filter((r) => r.status === 'failed').map((r) => r.nodeId),
        blockedNodeIds: latestRuns.filter((r) => r.status === 'blocked').map((r) => r.nodeId),
        skippedNodeIds: latestRuns.filter((r) => r.status === 'skipped').map((r) => r.nodeId),
        haltReason: existingRun.haltReason,
        error: existingRun.error,
        changeSets: resultChangeSets,
        artifacts: allArtifacts,
      }
    }

    const loopPolicy: LoopPolicy = options.loopPolicy ??
      template.loopPolicy ?? {
        maxIterations: 5,
        maxRepeatedStates: 1,
        maxNodeAttempts: 10,
      }

    let currentIteration = existingRun?.iteration ?? 1
    let previousLoopIterationPatch: string | null = null
    let latestLoopChangeSet: ChangeSet | null = null
    const fingerprintHistory: string[] = []
    let iterationArtifacts: WorkflowArtifact[] = []
    let iterationRouterDecisions: RouterDecisionRecord[] = []

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
    const resumableBlockedNodeIds = new Set<string>()
    const nonResumableBlockedNodeIds = new Set<string>()
    const cancelledNodeIds = new Set<string>()
    const skippedNodeIds = new Set<string>()
    const deactivatedForwardEdgeIds = new Set<string>()
    const activeWorktrees = new Map<string, PreparedWorktree>()

    const currentLineage = new Map<string, LineageEntry>()

    const skipSet = new Set(options.skipNodeIds ?? [])
    const invalidatedSet = options.invalidatedNodeIds ?? new Set<string>()
    const resumeSet = options.resumeNodeIds ? new Set(options.resumeNodeIds) : undefined

    // Hydrate existing latest state if run existed previously
    if (existingRun) {
      const latestRuns = this.workflowStore.getLatestNodeRuns(graphRunId)
      const transitions = this.workflowStore.getTransitionsForRun(graphRunId)
      const latestTransition = transitions.at(-1)
      let activeLoopBody: ReadonlySet<string> = new Set()
      if (existingRun.iteration === latestTransition?.toIteration) {
        activeLoopBody = getLoopBody(
          template.nodes,
          template.edges,
          latestTransition.sourceNodeId,
          latestTransition.targetNodeId,
        )
      }

      // Restore prior iteration patch if recovering at iteration > 1
      if (currentIteration > 1) {
        const allRuns = this.workflowStore.getNodeAttempts(graphRunId)
        const priorRuns = allRuns.filter((r) => r.iteration < currentIteration && r.changeSetId)
        const latestPriorRun = priorRuns.at(-1)
        if (latestPriorRun?.changeSetId && this.changeSetStore) {
          const cs = this.changeSetStore.find(latestPriorRun.changeSetId)
          if (cs) {
            previousLoopIterationPatch = cs.patch
          }
        }
      }

      const parsedRunId = runIdSchema.safeParse(graphRunId)
      const allRunMetas =
        parsedRunId.success && this.artifactService
          ? this.artifactService.listArtifacts(parsedRunId.data)
          : []
      const artifactsByStepId = new Map<string, ArtifactMetadata[]>()
      for (const meta of allRunMetas) {
        if (meta.stepId) {
          const list = artifactsByStepId.get(meta.stepId) ?? []
          list.push(meta)
          artifactsByStepId.set(meta.stepId, list)
        }
      }

      for (const nodeRun of latestRuns) {
        if (invalidatedSet.has(nodeRun.nodeId)) {
          continue
        }

        const isInActiveLoopBody = activeLoopBody.has(nodeRun.nodeId)
        const isFromPriorIteration = nodeRun.iteration < currentIteration

        if (isInActiveLoopBody && isFromPriorIteration) {
          // Node belongs to the active loop body and needs re-execution in this iteration
          continue
        }

        if (nodeRun.status === 'completed') {
          completedNodeIds.add(nodeRun.nodeId)
          let cs: ChangeSet | undefined
          if (nodeRun.changeSetId && this.changeSetStore) {
            cs = this.changeSetStore.find(nodeRun.changeSetId) ?? undefined
          }
          const stepMetas = artifactsByStepId.get(nodeRun.id) ?? []
          const hydratedArtifacts = await this.hydrateNodeArtifacts(nodeRun, workflowId, stepMetas)
          currentLineage.set(nodeRun.nodeId, {
            attempt: nodeRun.attempt,
            changeSet: cs,
            artifacts: hydratedArtifacts,
          })
          allArtifacts.push(...hydratedArtifacts)
          if (nodeRun.iteration === currentIteration) {
            iterationArtifacts.push(...hydratedArtifacts)
          }
        } else if (nodeRun.status === 'skipped') {
          skippedNodeIds.add(nodeRun.nodeId)
        } else if (nodeRun.status === 'blocked') {
          const isExplicitlyResumed = resumeSet?.has(nodeRun.nodeId)
          const nodeDef = template.nodes.find((n) => n.id === nodeRun.nodeId)
          const isResumable =
            nodeDef?.type === 'user_gate' ||
            nodeDef?.config.role === 'user' ||
            !nodeRun.error?.includes('Missing required input slot')

          if (isExplicitlyResumed || (!existingRun.finishedAt && isResumable)) {
            // Node is unblocked to execute its next attempt upon resume
          } else {
            blockedNodeIds.add(nodeRun.nodeId)
            nonResumableBlockedNodeIds.add(nodeRun.nodeId)
          }
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

    // Check for pending feedback transition from an already-completed node (crash recovery TC-2B-REC-04)
    if (existingRun && !loopState.isHalted) {
      for (const completedNodeId of Array.from(completedNodeIds)) {
        const node = template.nodes.find((n) => n.id === completedNodeId)
        if (!node) continue

        const attempts = this.workflowStore.getNodeAttempts(graphRunId, completedNodeId)
        const latestAttempt = attempts.at(-1)
        if (latestAttempt?.status !== 'completed') continue
        if (latestAttempt.iteration !== currentIteration) continue

        let triggeredFeedbackEdge: WorkflowEdge | undefined

        if (node.type === 'router') {
          let selectedEdgeId = latestAttempt.evidenceId ?? undefined
          if (!selectedEdgeId) {
            const lineage = currentLineage.get(completedNodeId)
            const dec = lineage?.artifacts.find((a) => a.kind === 'routing-decision')
            if (dec?.metadata.selectedEdgeId && typeof dec.metadata.selectedEdgeId === 'string') {
              selectedEdgeId = dec.metadata.selectedEdgeId
            }
          }
          if (selectedEdgeId) {
            const edge = template.edges.find((e) => e.id === selectedEdgeId)
            if (edge?.isFeedback) {
              triggeredFeedbackEdge = edge
            }
          }
        } else {
          const feedbackEdge = template.edges.find((e) => e.source === node.id && e.isFeedback)
          if (feedbackEdge) {
            if (feedbackEdge.condition) {
              const lineage = currentLineage.get(completedNodeId)
              const attemptArtifacts = lineage?.artifacts ?? []

              const candidateReviewArtifacts = attemptArtifacts.filter(
                (a) => a.kind === 'review_report' || a.metadata.outputName === 'review_verdict',
              )

              if (node.config.role === 'reviewer' || candidateReviewArtifacts.length > 0) {
                if (candidateReviewArtifacts.length === 0) {
                  loopState.runError = `Recovery failed: completed reviewer node "${node.id}" has no review_verdict artifact`
                  failedNodeIds.add(node.id)
                  break
                }

                // If multiple candidates exist, prioritize the one matching latestAttempt.id
                let reviewArtifact = candidateReviewArtifacts.find(
                  (a) => a.metadata.stepId === latestAttempt.id,
                )
                if (!reviewArtifact && candidateReviewArtifacts.length === 1) {
                  reviewArtifact = candidateReviewArtifacts[0]
                }
                if (!reviewArtifact) {
                  for (const candidate of candidateReviewArtifacts) {
                    try {
                      const parsed: unknown = JSON.parse(candidate.content)
                      if (
                        parsed &&
                        typeof parsed === 'object' &&
                        'stepId' in parsed &&
                        (parsed as { stepId?: unknown }).stepId === latestAttempt.id
                      ) {
                        reviewArtifact = candidate
                        break
                      }
                    } catch {
                      // ignore parse errors during candidate matching
                    }
                  }
                }

                if (!reviewArtifact) {
                  loopState.runError = `Recovery failed: review artifact for node "${node.id}" does not match completed reviewer attempt (${latestAttempt.id})`
                  failedNodeIds.add(node.id)
                  break
                }

                let parsedOutcome: unknown
                try {
                  parsedOutcome = JSON.parse(reviewArtifact.content)
                } catch {
                  loopState.runError = `Recovery failed: review_verdict artifact for node "${node.id}" contains malformed JSON`
                  failedNodeIds.add(node.id)
                  break
                }

                // Strictly validate against authoritativeReviewVerdictSchema
                const outcomeResult = authoritativeReviewVerdictSchema.safeParse(parsedOutcome)
                if (!outcomeResult.success) {
                  loopState.runError = `Recovery failed: review_verdict artifact for node "${node.id}" violates authoritative verdict contract: ${outcomeResult.error.message}`
                  failedNodeIds.add(node.id)
                  break
                }

                // Invariant: review artifact stepId must match completed reviewer attempt
                if (outcomeResult.data.stepId !== latestAttempt.id) {
                  loopState.runError = `Recovery failed: review artifact stepId (${outcomeResult.data.stepId}) does not match completed reviewer attempt (${latestAttempt.id})`
                  failedNodeIds.add(node.id)
                  break
                }

                // Invariant: review artifact iteration must match current iteration
                if (outcomeResult.data.iteration !== currentIteration) {
                  loopState.runError = `Recovery failed: review artifact iteration (${String(outcomeResult.data.iteration)}) does not match current iteration (${String(currentIteration)})`
                  failedNodeIds.add(node.id)
                  break
                }

                // Invariant: validate lineage against preceding verification evidence
                const incomingVerificationEdges = template.edges.filter(
                  (e) => e.target === node.id && !e.isFeedback,
                )
                if (incomingVerificationEdges.length === 0) {
                  loopState.runError = `Recovery failed: completed reviewer node "${node.id}" has no incoming verification edge`
                  failedNodeIds.add(node.id)
                  break
                }
                if (incomingVerificationEdges.length > 1) {
                  loopState.runError = `Recovery failed: ambiguous incoming edges to reviewer node "${node.id}": multiple non-feedback edges found`
                  failedNodeIds.add(node.id)
                  break
                }

                const incomingVerificationEdge = incomingVerificationEdges[0]
                if (!incomingVerificationEdge) {
                  loopState.runError = `Recovery failed: completed reviewer node "${node.id}" has no incoming verification edge`
                  failedNodeIds.add(node.id)
                  break
                }
                const verifLineage = currentLineage.get(incomingVerificationEdge.source)
                const verifArtifacts = verifLineage?.artifacts ?? []

                if (verifArtifacts.length === 0) {
                  loopState.runError = `Recovery failed: completed reviewer node "${node.id}" has no preceding verification artifacts from node "${incomingVerificationEdge.source}"`
                  failedNodeIds.add(node.id)
                  break
                }

                // Filter candidates matching current iteration (reject stale candidates)
                const currentIterationCandidates = verifArtifacts.filter(
                  (a) =>
                    a.metadata.iteration === currentIteration ||
                    (a.metadata.iteration === undefined && currentIteration === 1),
                )

                if (currentIterationCandidates.length === 0) {
                  loopState.runError = `Recovery failed: verification evidence from node "${incomingVerificationEdge.source}" is stale (no artifacts for current iteration ${String(currentIteration)})`
                  failedNodeIds.add(node.id)
                  break
                }

                // Resolve candidate verification artifacts
                let candidateVerifArtifacts = currentIterationCandidates.filter(
                  (a) =>
                    a.kind === 'evidence' ||
                    a.kind === 'verification_report' ||
                    a.metadata.outputName === 'verification_report',
                )

                // If edge specifies a sourceHandle, use exact match
                if (incomingVerificationEdge.sourceHandle) {
                  const handle = incomingVerificationEdge.sourceHandle
                  candidateVerifArtifacts = candidateVerifArtifacts.filter((a) =>
                    this.matchesArtifactName(a, handle),
                  )
                }

                if (candidateVerifArtifacts.length === 0) {
                  loopState.runError = `Recovery failed: preceding verification node "${incomingVerificationEdge.source}" produced no compatible verification evidence artifact for current iteration`
                  failedNodeIds.add(node.id)
                  break
                }

                let verifArtifact: WorkflowArtifact | undefined
                if (candidateVerifArtifacts.length === 1) {
                  verifArtifact = candidateVerifArtifacts[0]
                } else {
                  // If multiple candidates exist, check if exactly one is specifically named 'verification_report'
                  const namedReportCandidates = candidateVerifArtifacts.filter(
                    (a) => a.metadata.outputName === 'verification_report',
                  )
                  if (namedReportCandidates.length === 1) {
                    verifArtifact = namedReportCandidates[0]
                  } else {
                    // Ambiguous candidate verification artifacts
                    loopState.runError = `Recovery failed: ambiguous verification evidence from node "${incomingVerificationEdge.source}": multiple candidate artifacts (${String(candidateVerifArtifacts.length)}) found without a unique identity`
                    failedNodeIds.add(node.id)
                    break
                  }
                }

                if (!verifArtifact) {
                  loopState.runError = `Recovery failed: could not resolve authoritative verification artifact from node "${incomingVerificationEdge.source}"`
                  failedNodeIds.add(node.id)
                  break
                }

                // 1. Authoritative changeSetId validation on verification evidence
                const rawVerifCsId = verifArtifact.metadata.changeSetId
                if (!rawVerifCsId || typeof rawVerifCsId !== 'string') {
                  loopState.runError = `Recovery failed: verification artifact "${verifArtifact.id}" is missing authoritative changeSetId metadata`
                  failedNodeIds.add(node.id)
                  break
                }
                const verifCsResult = changeSetIdSchema.safeParse(rawVerifCsId)
                if (!verifCsResult.success) {
                  loopState.runError = `Recovery failed: verification artifact "${verifArtifact.id}" contains malformed changeSetId: ${verifCsResult.error.message}`
                  failedNodeIds.add(node.id)
                  break
                }
                if (outcomeResult.data.changeSetId !== verifCsResult.data) {
                  loopState.runError = `Recovery failed: review artifact changeSetId (${outcomeResult.data.changeSetId}) does not match verification evidence changeset (${verifCsResult.data})`
                  failedNodeIds.add(node.id)
                  break
                }

                // 2. Authoritative evidenceId validation on verification evidence
                let rawVerifEvidenceId =
                  typeof verifArtifact.metadata.evidenceId === 'string'
                    ? verifArtifact.metadata.evidenceId
                    : undefined
                if (!rawVerifEvidenceId) {
                  try {
                    const parsed: unknown = JSON.parse(verifArtifact.content)
                    if (
                      parsed &&
                      typeof parsed === 'object' &&
                      'evidenceId' in parsed &&
                      typeof (parsed as Record<string, unknown>).evidenceId === 'string'
                    ) {
                      rawVerifEvidenceId = (parsed as Record<string, unknown>).evidenceId as string
                    }
                  } catch {
                    // Content is not JSON
                  }
                }

                if (!rawVerifEvidenceId) {
                  loopState.runError = `Recovery failed: verification artifact "${verifArtifact.id}" is missing authoritative evidenceId`
                  failedNodeIds.add(node.id)
                  break
                }
                const verifEvidenceResult = evidenceIdSchema.safeParse(rawVerifEvidenceId)
                if (!verifEvidenceResult.success) {
                  loopState.runError = `Recovery failed: verification artifact "${verifArtifact.id}" contains malformed evidenceId: ${verifEvidenceResult.error.message}`
                  failedNodeIds.add(node.id)
                  break
                }
                if (outcomeResult.data.evidenceId !== verifEvidenceResult.data) {
                  loopState.runError = `Recovery failed: review artifact evidenceId (${outcomeResult.data.evidenceId}) does not match verification evidence (${verifEvidenceResult.data})`
                  failedNodeIds.add(node.id)
                  break
                }

                // 3. Iteration validation on verification evidence
                const rawVerifIteration = verifArtifact.metadata.iteration
                if (
                  typeof rawVerifIteration === 'number' &&
                  rawVerifIteration !== currentIteration
                ) {
                  loopState.runError = `Recovery failed: verification artifact iteration (${String(rawVerifIteration)}) does not match current iteration (${String(currentIteration)})`
                  failedNodeIds.add(node.id)
                  break
                }

                if (outcomeResult.data.verdict === 'unknown') {
                  loopState.runError = `Recovery failed: review verdict for node "${node.id}" is UNKNOWN`
                  failedNodeIds.add(node.id)
                  break
                }

                const matched = evaluateCondition(feedbackEdge.condition, {
                  incomingSlots: new Map([
                    ['review_report', reviewArtifact],
                    ['review_verdict', reviewArtifact],
                  ]),
                  inputArtifacts: [reviewArtifact, ...attemptArtifacts],
                  initialContext,
                  iteration: currentIteration,
                })

                if (matched) {
                  triggeredFeedbackEdge = feedbackEdge
                }
              } else {
                const matched = evaluateCondition(feedbackEdge.condition, {
                  inputArtifacts: [...allArtifacts, ...attemptArtifacts],
                  initialContext,
                  iteration: currentIteration,
                })

                if (matched) {
                  triggeredFeedbackEdge = feedbackEdge
                }
              }
            } else {
              triggeredFeedbackEdge = feedbackEdge
            }
          }
        }

        if (loopState.runError) {
          break
        }

        if (triggeredFeedbackEdge) {
          const existingTransition = this.workflowStore.getTransitionBySource(
            graphRunId,
            node.id,
            latestAttempt.attempt,
          )
          if (!existingTransition) {
            this.handleFeedbackTransition({
              template,
              graphRunId,
              projectId,
              sourceNodeId: node.id,
              sourceAttempt: latestAttempt.attempt,
              targetNodeId: triggeredFeedbackEdge.target,
              loopPolicy,
              initialContext,
              loopState,
              completedNodeIds,
              skippedNodeIds,
              blockedNodeIds,
              failedNodeIds,
              deactivatedForwardEdgeIds,
              fingerprintHistory,
              getIterationArtifacts: () => iterationArtifacts,
              getIterationRouterDecisions: () => iterationRouterDecisions,
              getLatestLoopChangeSet: () => latestLoopChangeSet,
              setPreviousLoopIterationPatch: (patch) => {
                previousLoopIterationPatch = patch
              },
              setIterationArtifacts: (artifacts) => {
                iterationArtifacts = artifacts
              },
              setIterationRouterDecisions: (decisions) => {
                iterationRouterDecisions = decisions
              },
              setLatestLoopChangeSet: (cs) => {
                latestLoopChangeSet = cs
              },
              setCurrentIteration: (it) => {
                currentIteration = it
              },
              getCurrentIteration: () => currentIteration,
              getSnapshot,
              actor,
            })
            break
          } else {
            // Window 3: transition row is already committed in database!
            // Replay idempotently without duplicate transition or double iteration increment.
            const targetNodeId = existingTransition.targetNodeId
            const loopBody = getLoopBody(template.nodes, template.edges, node.id, targetNodeId)
            for (const nid of loopBody) {
              completedNodeIds.delete(nid)
              skippedNodeIds.delete(nid)
              blockedNodeIds.delete(nid)
              failedNodeIds.delete(nid)
              for (const edge of template.edges) {
                if (edge.source === nid) {
                  deactivatedForwardEdgeIds.delete(edge.id)
                }
              }
            }
            break
          }
        }
      }
    }

    // Main execution scheduling loop
    while (
      completedNodeIds.size +
        skippedNodeIds.size +
        failedNodeIds.size +
        blockedNodeIds.size +
        cancelledNodeIds.size <
        template.nodes.length &&
      !loopState.isHalted &&
      !loopState.runError &&
      !abortSignal.aborted &&
      cancelledNodeIds.size === 0
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
          !cancelledNodeIds.has(node.id) &&
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
        // Check if node is explicitly skipped via options
        if (skipSet.has(node.id)) {
          const existingAttempts = this.workflowStore.getNodeAttempts(graphRunId, node.id)
          const latestAttempt = existingAttempts.at(-1)
          const startedAt = new Date().toISOString()
          let attemptNum: number

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

          if (latestAttempt?.status === 'ready') {
            attemptNum = latestAttempt.attempt
          } else {
            attemptNum = existingAttempts.length + 1
            this.workflowStore.recordNodeAttempt(
              {
                id: randomUUID(),
                projectId,
                graphRunId,
                nodeId: node.id,
                attempt: attemptNum,
                iteration: currentIteration,
                status: 'ready',
                role: node.config.role ?? null,
                startedAt,
              },
              actor,
            )
          }

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
        const { inputArtifacts, incomingSlots, missingRequiredSlot, resolutionError } =
          this.resolveNodeInputs(
            node,
            template.edges,
            currentLineage,
            initialContext,
            workflowId,
            template.nodes,
          )

        if (resolutionError || missingRequiredSlot) {
          const existingAttempts = this.workflowStore.getNodeAttempts(graphRunId, node.id)
          const latestAttempt = existingAttempts.at(-1)
          const startedAt = new Date().toISOString()
          const errMessage =
            resolutionError ??
            (missingRequiredSlot
              ? `Missing required input slot: ${missingRequiredSlot}`
              : 'Input slot resolution failed')
          let attemptNum: number

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

          if (latestAttempt?.status === 'ready') {
            attemptNum = latestAttempt.attempt
          } else {
            attemptNum = existingAttempts.length + 1
            this.workflowStore.recordNodeAttempt(
              {
                id: randomUUID(),
                projectId,
                graphRunId,
                nodeId: node.id,
                attempt: attemptNum,
                iteration: currentIteration,
                status: 'running',
                role: node.config.role ?? null,
                startedAt,
              },
              actor,
            )
          }

          blockedNodeIds.add(node.id)
          nonResumableBlockedNodeIds.add(node.id)

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
        const existingAttempts = this.workflowStore.getNodeAttempts(graphRunId, node.id)
        const latestAttempt = existingAttempts.at(-1)
        const startedAt = new Date().toISOString()
        let attemptNum: number
        let currentAttemptId: string

        let resolvedRuntimeId: string | null = null
        if (node.type === 'agent' && this.registry) {
          try {
            const resolved = resolveRoleRuntime({
              node,
              projectId,
              executionBindings: options.bindings,
              compositionBindings: this.bindings,
              bindingStore: this.bindingStore,
              registry: this.registry,
              defaultRuntimeId: this.defaultRuntimeId,
            })
            resolvedRuntimeId = resolved.runtimeId
          } catch (err: unknown) {
            attemptNum = existingAttempts.length + 1
            currentAttemptId = randomUUID()
            const errorMsg = err instanceof Error ? err.message : String(err)
            const finishedAt = new Date().toISOString()

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
                id: currentAttemptId,
                projectId,
                graphRunId,
                nodeId: node.id,
                attempt: attemptNum,
                iteration: currentIteration,
                status: 'running',
                role: node.config.role ?? null,
                runtimeId: null,
                startedAt,
              },
              actor,
            )

            this.workflowStore.updateNodeAttempt(
              {
                projectId,
                graphRunId,
                nodeId: node.id,
                attempt: attemptNum,
                status: 'failed',
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
                operation: 'node.failed',
                stateSnapshot: getSnapshot(),
                occurredAt: finishedAt,
              },
              actor,
            )

            failedNodeIds.add(node.id)
            loopState.runError = errorMsg
            return
          }
        } else if (node.type === 'agent' && node.config.providerId) {
          resolvedRuntimeId = node.config.providerId
        }

        if (latestAttempt?.status === 'ready') {
          attemptNum = latestAttempt.attempt
          currentAttemptId = latestAttempt.id
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
        } else {
          attemptNum = existingAttempts.length + 1
          currentAttemptId = randomUUID()
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
              id: currentAttemptId,
              projectId,
              graphRunId,
              nodeId: node.id,
              attempt: attemptNum,
              iteration: currentIteration,
              status: 'running',
              role: node.config.role ?? null,
              runtimeId: resolvedRuntimeId,
              startedAt,
            },
            actor,
          )
        }

        let branchWorktree: PreparedWorktree | null = null

        try {
          // Determine if this node needs an isolated branch worktree
          const isReadOnly =
            node.type === 'router' ||
            (node.type !== 'verification' && node.config.permissionMode === 'read-only')
          const needsWorktree =
            node.type === 'verification' ||
            (!isReadOnly && (node.config.permissionMode === 'developer' || node.type === 'agent'))

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

            // Cumulative prior iteration patch materialization takes precedence for loop targets
            if (previousLoopIterationPatch?.trim()) {
              try {
                await this.worktreeService.applyPatch(
                  branchWorktree.path,
                  previousLoopIterationPatch,
                )
                previousLoopIterationPatch = null
              } catch (patchErr: unknown) {
                loopState.isHalted = true
                loopState.haltedReason = 'HALTED_POLICY: patch-application-failed'
                const errMsg = patchErr instanceof Error ? patchErr.message : String(patchErr)
                loopState.runError = `Failed to apply previous iteration patch into worktree: ${errMsg}`

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
                    operation: 'iteration.halted',
                    stateSnapshot: getSnapshot(),
                    occurredAt: haltOccurredAt,
                  },
                  actor,
                )

                failedNodeIds.add(node.id)
                return
              }
            } else if (predecessorChangeSets.length > 1) {
              // Fan-In reconciliation & physical patch materialization
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
            taskId: resolvedTask?.id ?? resolvedTaskId,
            task: resolvedTask,
            repository: resolvedRepository,
            node,
            attempt: attemptNum,
            attemptId: currentAttemptId,
            runtimeId: resolvedRuntimeId ?? undefined,
            bindings: options.bindings,
            worktreePath: branchWorktree?.path,
            forkSha,
            signal: abortSignal,
            inputArtifacts,
            incomingSlots,
            outgoingEdges: template.edges.filter((e) => e.source === node.id),
            initialContext,
            iteration: currentIteration,
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
                runtimeId: resolvedRuntimeId ?? leafResult.runtimeId ?? null,
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

            const isRouterNode = node.type === 'router'
            const requiredOutputs = node.outputs.filter((o) => o.required !== false)
            const hasRequiredOutputs = requiredOutputs.length > 0
            const hasEmittedArtifacts = !isRouterNode && artifactsForNode.length > 0
            const isArtifactPersistenceRequired =
              hasRequiredOutputs || (hasEmittedArtifacts && !this.testOnlyAllowEphemeralArtifacts)

            if (isArtifactPersistenceRequired && !this.artifactService) {
              throw new Error(
                `Cannot persist artifacts for node attempt "${currentAttemptId}": ArtifactService is required but not configured`,
              )
            }

            const missingOutputs = this.matchRequiredOutputs(
              node.outputs,
              requiredOutputs,
              artifactsForNode,
            )
            if (missingOutputs.length > 0) {
              throw new Error(
                `Node "${node.id}" attempt "${currentAttemptId}" missing required output(s): ${missingOutputs.map((o) => o.name).join(', ')}`,
              )
            }

            // 1. Durably persist artifacts first while attempt is in 'running' state.
            // If persistence fails, the catch block catches the error and marks the attempt 'failed'.
            // This prevents an attempt from being recorded as 'completed' without its complete output set.
            // Router decision artifacts are internal control-flow state and not persisted to artifact storage.
            if (!isRouterNode) {
              await this.persistNodeArtifacts(
                graphRunId,
                currentAttemptId,
                artifactsForNode,
                isArtifactPersistenceRequired,
              )
            }

            // 2. Mark node attempt completed in SQLite once artifact persistence has succeeded.
            const finishedAt = new Date().toISOString()
            this.workflowStore.updateNodeAttempt(
              {
                projectId,
                graphRunId,
                nodeId: node.id,
                attempt: attemptNum,
                status: 'completed',
                runtimeId: resolvedRuntimeId ?? leafResult.runtimeId ?? null,
                changeSetId: capturedChangeSet?.id ?? null,
                evidenceId: leafResult.evidenceId ?? null,
                finishedAt,
                occurredAt: finishedAt,
              },
              actor,
            )

            // 3. Update in-memory state and lineage only after durability boundary succeeds
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
            iterationArtifacts.push(...artifactsForNode)
            if (capturedChangeSet) {
              latestLoopChangeSet = capturedChangeSet
            }
            completedNodeIds.add(node.id)

            // 4. Record completion checkpoint
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

            let triggeredFeedbackEdge: WorkflowEdge | undefined

            if (node.type === 'router') {
              const decisionArtifact = artifactsForNode.find((a) => a.kind === 'routing-decision')
              let selectedEdgeId: string | undefined
              let isFeedbackEdge = false
              if (decisionArtifact) {
                const metaEdgeId = decisionArtifact.metadata.selectedEdgeId
                if (typeof metaEdgeId === 'string') {
                  selectedEdgeId = metaEdgeId
                } else {
                  try {
                    const parsed: unknown = JSON.parse(decisionArtifact.content)
                    if (parsed && typeof parsed === 'object' && 'selectedEdgeId' in parsed) {
                      const edgeId = parsed.selectedEdgeId
                      if (typeof edgeId === 'string') {
                        selectedEdgeId = edgeId
                      }
                    }
                  } catch {
                    // ignore
                  }
                }
                if (decisionArtifact.metadata.isFeedback === true) {
                  isFeedbackEdge = true
                }
              }
              if (!selectedEdgeId && leafResult.evidenceId) {
                selectedEdgeId = leafResult.evidenceId
              }

              const selectedEdge = template.edges.find((e) => e.id === selectedEdgeId)
              if (selectedEdge?.isFeedback) {
                isFeedbackEdge = true
              }

              if (selectedEdgeId && selectedEdge) {
                iterationRouterDecisions.push({
                  routerNodeId: node.id,
                  selectedEdgeId,
                  targetNodeId: selectedEdge.target,
                  isFeedback: isFeedbackEdge,
                })
              }

              if (isFeedbackEdge && selectedEdge) {
                triggeredFeedbackEdge = selectedEdge
              } else {
                const forwardOutgoing = template.edges.filter(
                  (e) => e.source === node.id && !e.isFeedback,
                )
                for (const edge of forwardOutgoing) {
                  if (edge.id !== selectedEdgeId) {
                    deactivatedForwardEdgeIds.add(edge.id)
                  }
                }

                this.pruneUnselectedBranches({
                  template,
                  graphRunId,
                  projectId,
                  actor,
                  deactivatedForwardEdgeIds,
                  completedNodeIds,
                  skippedNodeIds,
                  runningNodeIds,
                  failedNodeIds,
                  blockedNodeIds,
                  getSnapshot,
                })
              }
            } else {
              const outgoingFeedback = template.edges.find(
                (e) => e.source === node.id && e.isFeedback,
              )
              if (outgoingFeedback) {
                const feedbackSlots = new Map(incomingSlots)
                const currentReviewArtifact = artifactsForNode.find(
                  (a) => a.kind === 'review_report' || a.metadata.outputName === 'review_verdict',
                )
                if (currentReviewArtifact) {
                  feedbackSlots.set('review_report', currentReviewArtifact)
                  feedbackSlots.set('review_verdict', currentReviewArtifact)
                }
                const matched = outgoingFeedback.condition
                  ? evaluateCondition(outgoingFeedback.condition, {
                      inputArtifacts: [...artifactsForNode, ...inputArtifacts],
                      incomingSlots: feedbackSlots,
                      initialContext,
                      iteration: currentIteration,
                    })
                  : true
                if (matched) {
                  triggeredFeedbackEdge = outgoingFeedback
                }
              }
            }

            if (triggeredFeedbackEdge) {
              this.handleFeedbackTransition({
                template,
                graphRunId,
                projectId,
                sourceNodeId: node.id,
                sourceAttempt: attemptNum,
                targetNodeId: triggeredFeedbackEdge.target,
                loopPolicy,
                initialContext,
                loopState,
                completedNodeIds,
                skippedNodeIds,
                blockedNodeIds,
                failedNodeIds,
                deactivatedForwardEdgeIds,
                fingerprintHistory,
                getIterationArtifacts: () => iterationArtifacts,
                getIterationRouterDecisions: () => iterationRouterDecisions,
                getLatestLoopChangeSet: () => latestLoopChangeSet,
                setPreviousLoopIterationPatch: (patch) => {
                  previousLoopIterationPatch = patch
                },
                setIterationArtifacts: (artifacts) => {
                  iterationArtifacts = artifacts
                },
                setIterationRouterDecisions: (decisions) => {
                  iterationRouterDecisions = decisions
                },
                setLatestLoopChangeSet: (cs) => {
                  latestLoopChangeSet = cs
                },
                setCurrentIteration: (it) => {
                  currentIteration = it
                },
                getCurrentIteration: () => currentIteration,
                getSnapshot,
                actor,
              })
            }
          } else if (leafResult.status === 'blocked') {
            blockedNodeIds.add(node.id)
            if (
              leafResult.awaitingUser === true ||
              leafResult.resumable === true ||
              node.type === 'user_gate' ||
              node.config.role === 'user'
            ) {
              resumableBlockedNodeIds.add(node.id)
            } else {
              nonResumableBlockedNodeIds.add(node.id)
            }
            const finishedAt = new Date().toISOString()

            this.workflowStore.updateNodeAttempt(
              {
                projectId,
                graphRunId,
                nodeId: node.id,
                attempt: attemptNum,
                status: 'blocked',
                runtimeId: resolvedRuntimeId ?? leafResult.runtimeId ?? null,
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
          } else if (leafResult.status === 'cancelled') {
            cancelledNodeIds.add(node.id)
            const finishedAt = new Date().toISOString()

            this.workflowStore.updateNodeAttempt(
              {
                projectId,
                graphRunId,
                nodeId: node.id,
                attempt: attemptNum,
                status: 'cancelled',
                runtimeId: resolvedRuntimeId ?? leafResult.runtimeId ?? null,
                error: leafResult.error ?? 'Node execution cancelled',
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
                runtimeId: resolvedRuntimeId ?? leafResult.runtimeId ?? null,
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
              runtimeId: resolvedRuntimeId ?? null,
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

    // Handle cancellation (signal abort or explicit node cancellation)
    if (abortSignal.aborted || cancelledNodeIds.size > 0) {
      if (abortSignal.aborted) {
        await this.handleCancellation(
          graphRunId,
          projectId,
          forkSha,
          activeWorktrees,
          runningNodeIds,
          actor,
        )
      } else {
        const finishedAt = new Date().toISOString()
        for (const [, worktree] of activeWorktrees.entries()) {
          await worktree.dispose().catch(() => undefined)
        }
        const cancelReason = loopState.runError ?? 'Execution cancelled by user'
        this.workflowStore.updateGraphRunStatus(
          {
            projectId,
            graphRunId,
            status: 'cancelled',
            haltReason: cancelReason,
            error: cancelReason,
            finishedAt,
            occurredAt: finishedAt,
          },
          actor,
        )
      }

      return {
        graphRunId,
        status: 'cancelled',
        completedNodeIds: Array.from(completedNodeIds),
        failedNodeIds: Array.from(failedNodeIds),
        blockedNodeIds: Array.from(blockedNodeIds),
        skippedNodeIds: Array.from(skippedNodeIds),
        haltReason: 'Execution cancelled',
        error: 'Execution cancelled',
        changeSets: resultChangeSets,
        artifacts: allArtifacts,
      }
    }

    // Determine terminal graph run status with locked precedence:
    // 1. cancelled (handled above)
    // 2. halted
    // 3. failed (if failedNodeIds.size > 0 || nonResumableBlockedNodeIds.size > 0)
    // 4. running (if resumableBlockedNodeIds.size > 0: nonterminal pause awaiting user)
    // 5. completed (only when all reachable nodes are completed or skipped, with zero failed/blocked nodes)

    if (loopState.isHalted) {
      const finishedAt = new Date().toISOString()
      this.workflowStore.updateGraphRunStatus(
        {
          projectId,
          graphRunId,
          status: 'halted',
          haltReason: loopState.haltedReason,
          error: loopState.runError,
          finishedAt,
          occurredAt: finishedAt,
        },
        actor,
      )

      return {
        graphRunId,
        status: 'halted',
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

    if (failedNodeIds.size > 0 || nonResumableBlockedNodeIds.size > 0) {
      if (!loopState.runError && nonResumableBlockedNodeIds.size > 0) {
        loopState.runError = `Graph execution blocked at nodes: ${Array.from(nonResumableBlockedNodeIds).join(', ')}`
      }
      const finishedAt = new Date().toISOString()
      this.workflowStore.updateGraphRunStatus(
        {
          projectId,
          graphRunId,
          status: 'failed',
          haltReason: loopState.haltedReason,
          error: loopState.runError,
          finishedAt,
          occurredAt: finishedAt,
        },
        actor,
      )

      return {
        graphRunId,
        status: 'failed',
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

    if (resumableBlockedNodeIds.size > 0) {
      // Nonterminal pause awaiting human action: preserve running status and leave finishedAt null
      return {
        graphRunId,
        status: 'running',
        completedNodeIds: Array.from(completedNodeIds),
        failedNodeIds: Array.from(failedNodeIds),
        blockedNodeIds: Array.from(blockedNodeIds),
        skippedNodeIds: Array.from(skippedNodeIds),
        haltReason: null,
        error: null,
        changeSets: resultChangeSets,
        artifacts: allArtifacts,
      }
    }

    const finishedAt = new Date().toISOString()
    this.workflowStore.updateGraphRunStatus(
      {
        projectId,
        graphRunId,
        status: 'completed',
        haltReason: null,
        error: null,
        finishedAt,
        occurredAt: finishedAt,
      },
      actor,
    )

    return {
      graphRunId,
      status: 'completed',
      completedNodeIds: Array.from(completedNodeIds),
      failedNodeIds: Array.from(failedNodeIds),
      blockedNodeIds: Array.from(blockedNodeIds),
      skippedNodeIds: Array.from(skippedNodeIds),
      haltReason: null,
      error: null,
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
      let runProjectId = projectId
      if (!runProjectId) {
        try {
          runProjectId = this.workflowStore.projectIdOf(run.workflowId)
        } catch {
          runProjectId = 'default-project' as ProjectId
        }
      }

      const attempts = this.workflowStore.getNodeAttempts(run.id)
      const runningAttempts = attempts.filter((a) => a.status === 'running')
      const failedAttempts = attempts.filter((a) => a.status === 'failed')
      const cancelledAttempts = attempts.filter((a) => a.status === 'cancelled')

      // Derive current logical status per node (filters out superseded historical attempts)
      const latestNodeRuns = this.workflowStore.getLatestNodeRuns(run.id)
      const currentBlockedRuns = latestNodeRuns.filter(
        (r) => r.status === 'blocked' && r.iteration === run.iteration,
      )

      const latestCheckpoint = this.workflowStore.getLatestGraphCheckpoint(run.id)
      const now = new Date().toISOString()

      // A blocked attempt only represents a valid resumable pause if it satisfies
      // the resumable-pause contract (e.g. user gate / decision lock, not missing input slots or fatal errors)
      const hasNonResumableBlockedAttempt = currentBlockedRuns.some((r) => {
        const err = r.error ?? ''
        return (
          err.includes('Missing required input slot') ||
          err.includes('Input slot resolution failed') ||
          err.toLowerCase().includes('non-resumable')
        )
      })

      // Strict identity and snapshot correspondence:
      // - Checkpoint must exist and its stateSnapshot must record blockedNodeIds
      // - Every currently blocked node must be present in stateSnapshot.blockedNodeIds
      // - Every node in stateSnapshot.blockedNodeIds must correspond to a current blocked attempt
      const snapshotBlockedIds = latestCheckpoint
        ? latestCheckpoint.stateSnapshot.blockedNodeIds
        : []

      const hasStrictIdentityAgreement =
        currentBlockedRuns.length > 0 &&
        snapshotBlockedIds.length > 0 &&
        currentBlockedRuns.every((r) => snapshotBlockedIds.includes(r.nodeId)) &&
        snapshotBlockedIds.every((id) => currentBlockedRuns.some((r) => r.nodeId === id))

      // Operation agreement:
      // The latest checkpoint must either be 'node.blocked' OR preserve the blocked state
      // from a concurrent completion in the same batch ('node.completed' / 'node.skipped')
      const hasValidCheckpointOperation =
        latestCheckpoint !== null &&
        (latestCheckpoint.operation === 'node.blocked' ||
          latestCheckpoint.operation === 'node.completed' ||
          latestCheckpoint.operation === 'node.skipped')

      // Axiom A4: A run is legitimately paused awaiting human action ONLY if:
      // 1. It has recorded attempts in the active iteration.
      // 2. Exactly zero attempts are running, failed, or cancelled.
      // 3. Current blocked nodes exist in the active iteration and none are non-resumable.
      // 4. Current blocked nodes strictly agree with the latest checkpoint's blockedNodeIds.
      // 5. The latest checkpoint confirms no in-flight running nodes and a compatible operation.
      const isLegitimatelyPaused =
        attempts.length > 0 &&
        runningAttempts.length === 0 &&
        failedAttempts.length === 0 &&
        cancelledAttempts.length === 0 &&
        !hasNonResumableBlockedAttempt &&
        hasStrictIdentityAgreement &&
        hasValidCheckpointOperation

      if (isLegitimatelyPaused) {
        continue
      }

      // Otherwise, the run was interrupted by process death or left in an invalid/non-resumable state.
      // Fail closed per Axiom A3.
      for (const attempt of runningAttempts) {
        this.workflowStore.updateNodeAttempt(
          {
            projectId: runProjectId,
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

      const nonResumable =
        currentBlockedRuns.find((r) => {
          const err = r.error ?? ''
          return (
            err.includes('Missing required input slot') ||
            err.includes('Input slot resolution failed') ||
            err.toLowerCase().includes('non-resumable')
          )
        }) ??
        attempts
          .filter((a) => a.status === 'blocked')
          .find((a) => {
            const err = a.error ?? ''
            return (
              err.includes('Missing required input slot') ||
              err.includes('Input slot resolution failed') ||
              err.toLowerCase().includes('non-resumable')
            )
          })

      const failureReason =
        runningAttempts.length > 0
          ? 'Graph execution interrupted by process termination'
          : attempts.length === 0
            ? 'Graph execution interrupted by process termination before initial node dispatch'
            : nonResumable
              ? `Graph execution blocked at node "${nonResumable.nodeId}": ${nonResumable.error ?? 'Non-resumable failure'}`
              : failedAttempts.length > 0
                ? `Graph execution interrupted with failed node: ${failedAttempts[0]?.nodeId ?? 'unknown'}`
                : cancelledAttempts.length > 0
                  ? `Graph execution interrupted with cancelled node: ${cancelledAttempts[0]?.nodeId ?? 'unknown'}`
                  : !hasStrictIdentityAgreement && currentBlockedRuns.length > 0
                    ? 'Graph execution state contradictory: blocked node runs do not match checkpoint state'
                    : 'Graph execution interrupted by process termination between node dispatches'

      const updated = this.workflowStore.updateGraphRunStatus(
        {
          projectId: runProjectId,
          graphRunId: run.id,
          status: 'failed',
          error: failureReason,
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

  private matchesArtifactName(art: WorkflowArtifact, name: string): boolean {
    const meta = art.metadata
    return art.title === name || meta.outputName === name || meta.name === name || art.id === name
  }

  /**
   * Matches required output definitions to produced artifacts according to domain identity rules.
   * Each required output must be satisfied by a distinct, valid artifact representing that specific output.
   * Returns any required outputs that were not satisfied.
   */
  private matchRequiredOutputs(
    allDeclaredOutputs: readonly OutputDefinition[],
    requiredOutputs: readonly OutputDefinition[],
    artifacts: readonly WorkflowArtifact[],
  ): readonly OutputDefinition[] {
    if (requiredOutputs.length === 0) {
      return []
    }

    // Count occurrences of each kind across all declared outputs of this node
    const kindCounts = new Map<string, number>()
    for (const out of allDeclaredOutputs) {
      kindCounts.set(out.kind, (kindCounts.get(out.kind) ?? 0) + 1)
    }

    const availableArtifacts = [...artifacts]
    const unmatchedRequired: OutputDefinition[] = []

    // Pass 1: Match by exact name / identity (must also match kind)
    const remainingRequired: OutputDefinition[] = []
    for (const req of requiredOutputs) {
      const matchIndex = availableArtifacts.findIndex(
        (art) => art.kind === req.kind && this.matchesArtifactName(art, req.name),
      )
      if (matchIndex !== -1) {
        // Distinct 1-to-1 matching: consume this artifact so it cannot be reused
        availableArtifacts.splice(matchIndex, 1)
      } else {
        remainingRequired.push(req)
      }
    }

    // Pass 2: For remaining unmatched outputs, allow kind-based match ONLY if:
    // 1. The kind is UNIQUE among all declared outputs of the node (no other output shares this kind)
    // 2. The artifact does not explicitly match the name of any other declared output
    for (const req of remainingRequired) {
      const isUniqueKind = (kindCounts.get(req.kind) ?? 0) === 1
      if (isUniqueKind) {
        const matchIndex = availableArtifacts.findIndex(
          (art) =>
            art.kind === req.kind &&
            !allDeclaredOutputs.some(
              (other) => other.name !== req.name && this.matchesArtifactName(art, other.name),
            ),
        )
        if (matchIndex !== -1) {
          availableArtifacts.splice(matchIndex, 1)
          continue
        }
      }
      unmatchedRequired.push(req)
    }

    return unmatchedRequired
  }

  /**
   * Persists leaf node artifacts to disk via ArtifactService and links to the attempt stepId.
   */
  private async persistNodeArtifacts(
    graphRunId: string,
    nodeRunId: string,
    artifacts: readonly WorkflowArtifact[],
    isRequired = true,
  ): Promise<void> {
    if (!this.artifactService) {
      if (isRequired) {
        throw new Error(
          `Cannot persist artifacts for node attempt "${nodeRunId}": ArtifactService is required but not configured`,
        )
      }
      return
    }

    if (artifacts.length === 0) {
      return
    }

    const parsedRunId = runIdSchema.safeParse(graphRunId)
    if (!parsedRunId.success) {
      throw new Error(`Invalid graphRunId "${graphRunId}": must satisfy runIdSchema`)
    }
    const parsedStepId = stepIdSchema.safeParse(nodeRunId)
    if (!parsedStepId.success) {
      throw new Error(`Invalid nodeRunId "${nodeRunId}": must satisfy stepIdSchema`)
    }

    // Query existing artifacts for this step to make retry/recovery idempotent without duplicates
    const existingMetas = this.artifactService.listForStep(parsedStepId.data)
    const existingByName = new Map(existingMetas.map((m) => [m.name, m]))
    const existingById = new Map(existingMetas.map((m) => [m.id, m]))

    for (let i = 0; i < artifacts.length; i++) {
      const art = artifacts[i]
      if (!art) {
        continue
      }

      // Fail closed on invalid artifact kind - never silently coerce to 'stage-output'
      const parsedKind = artifactKindSchema.safeParse(art.kind)
      if (!parsedKind.success) {
        throw new Error(
          `Invalid artifact kind "${art.kind}" for artifact "${art.id}" in node "${art.nodeId}": must satisfy artifactKindSchema`,
        )
      }
      const metaKind = parsedKind.data

      const expectedName = `${art.title || `artifact-${String(i)}`}.workflow-artifact.json`
      const parsedArtId = artifactIdSchema.safeParse(art.id)

      // Check if this artifact was already persisted for this step
      const existing =
        (parsedArtId.success ? existingById.get(parsedArtId.data) : undefined) ??
        existingByName.get(expectedName)
      if (existing) {
        const integrity = await this.artifactService.verifyArtifactIntegrity(existing.id)
        if (integrity.valid) {
          // Already durably persisted and valid on disk; avoid duplicate rows/files
          continue
        }
      }

      const envelope = {
        ...art,
        kind: metaKind,
        __lineageOrder: i,
        __totalArtifacts: artifacts.length,
      }

      await this.artifactService.writeArtifact({
        ...(parsedArtId.success ? { id: parsedArtId.data } : {}),
        runId: parsedRunId.data,
        stepId: parsedStepId.data,
        kind: metaKind,
        name: expectedName,
        content: JSON.stringify(envelope),
        mimeType: 'application/json',
        createdAt: art.createdAt,
      })
    }
  }

  /**
   * Hydrates workflow artifacts for a node attempt from physical disk and verifies integrity.
   */
  private async hydrateNodeArtifacts(
    nodeRun: GraphNodeRun,
    workflowId: string,
    metas: readonly ArtifactMetadata[],
  ): Promise<WorkflowArtifact[]> {
    if (metas.length === 0) {
      return []
    }

    if (!this.artifactService) {
      throw new Error(
        `Cannot hydrate artifacts for node "${nodeRun.nodeId}": ArtifactService is required but not configured`,
      )
    }

    const hydratedWithOrder: {
      order: number
      total?: number | undefined
      artifact: WorkflowArtifact
    }[] = []

    for (let i = 0; i < metas.length; i++) {
      const meta = metas[i]
      if (!meta) {
        continue
      }
      const integrity = await this.artifactService.verifyArtifactIntegrity(meta.id)
      if (!integrity.valid) {
        throw new Error(
          `Artifact integrity check failed for artifact "${meta.id}" (run: "${nodeRun.graphRunId}", node: "${nodeRun.nodeId}"): ${integrity.reason ?? 'Unknown corruption'}`,
        )
      }

      const rawText = await this.artifactService.readArtifactText(meta.id)
      let parsedEnvelope: unknown
      try {
        parsedEnvelope = JSON.parse(rawText)
      } catch (err: unknown) {
        throw new Error(
          `Malformed artifact envelope: failed to parse JSON for artifact "${meta.id}" (${meta.name}) in node "${nodeRun.nodeId}": ${err instanceof Error ? err.message : String(err)}`,
          { cause: err },
        )
      }

      if (!parsedEnvelope || typeof parsedEnvelope !== 'object' || Array.isArray(parsedEnvelope)) {
        throw new Error(
          `Malformed artifact envelope for artifact "${meta.id}" (${meta.name}) in node "${nodeRun.nodeId}": missing required envelope fields`,
        )
      }

      const envObj = parsedEnvelope as Record<string, unknown>
      if (typeof envObj.title !== 'string' || typeof envObj.content !== 'string') {
        throw new Error(
          `Malformed artifact envelope for artifact "${meta.id}" (${meta.name}) in node "${nodeRun.nodeId}": missing required envelope fields`,
        )
      }

      const rawKind = envObj.kind ?? meta.kind
      const parsedKind = artifactKindSchema.safeParse(rawKind)
      if (!parsedKind.success) {
        const displayKind = typeof rawKind === 'string' ? rawKind : JSON.stringify(rawKind)
        throw new Error(
          `Invalid artifact kind "${displayKind}" for artifact "${meta.id}" (${meta.name}) in node "${nodeRun.nodeId}": must satisfy artifactKindSchema`,
        )
      }

      const order = typeof envObj.__lineageOrder === 'number' ? envObj.__lineageOrder : i
      const total =
        typeof envObj.__totalArtifacts === 'number' ? envObj.__totalArtifacts : undefined

      const reconstructed: WorkflowArtifact = {
        id: typeof envObj.id === 'string' ? envObj.id : meta.id,
        workflowId: typeof envObj.workflowId === 'string' ? envObj.workflowId : workflowId,
        nodeId: typeof envObj.nodeId === 'string' ? envObj.nodeId : nodeRun.nodeId,
        stepIndex: typeof envObj.stepIndex === 'number' ? envObj.stepIndex : nodeRun.attempt,
        kind: parsedKind.data,
        format:
          envObj.format === 'markdown' ||
          envObj.format === 'diff' ||
          envObj.format === 'json' ||
          envObj.format === 'text'
            ? envObj.format
            : 'text',
        title: envObj.title,
        content: envObj.content,
        metadata:
          envObj.metadata && typeof envObj.metadata === 'object'
            ? (envObj.metadata as Readonly<Record<string, unknown>>)
            : {},
        createdAt: typeof envObj.createdAt === 'string' ? envObj.createdAt : meta.createdAt,
      }

      hydratedWithOrder.push({
        order,
        total,
        artifact: workflowArtifactSchema.parse(reconstructed),
      })
    }

    // Verify complete multi-artifact set if total was recorded in envelope
    for (const item of hydratedWithOrder) {
      if (item.total !== undefined && hydratedWithOrder.length !== item.total) {
        throw new Error(
          `Partial artifact persistence detected for node "${nodeRun.nodeId}" attempt ${String(nodeRun.attempt)}: expected ${String(item.total)} artifacts but found ${String(hydratedWithOrder.length)}`,
        )
      }
    }

    hydratedWithOrder.sort((a, b) => a.order - b.order)
    return hydratedWithOrder.map((item) => item.artifact)
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
    templateNodes: readonly WorkflowNode[] = [],
  ): {
    readonly inputArtifacts: readonly WorkflowArtifact[]
    readonly incomingSlots: ReadonlyMap<string, WorkflowArtifact>
    readonly missingRequiredSlot?: string
    readonly resolutionError?: string
  } {
    const incomingEdges = edges.filter((e) => e.target === node.id && !e.isFeedback)
    const slotMap = new Map<string, WorkflowArtifact>()
    const artifacts: WorkflowArtifact[] = []
    const explicitlyBoundSlots = new Set<string>()

    for (const edge of incomingEdges) {
      const sourceNode = templateNodes.find((n) => n.id === edge.source)
      const lineage = currentLineage.get(edge.source)
      const sourceArtifacts = lineage?.artifacts ?? []

      // Check if sourceHandle identifies a declared named output on sourceNode
      const sourceHandle = edge.sourceHandle
      const declaredOutput = sourceHandle
        ? sourceNode?.outputs.find((o) => o.name === sourceHandle)
        : undefined

      if (declaredOutput && sourceHandle) {
        // Edge explicitly identifies a declared named output:
        // Must resolve strictly by established identity. Never substitute an arbitrary artifact of matching kind.
        let targetSlot: (typeof node.inputs)[number] | undefined
        if (edge.targetHandle) {
          targetSlot = node.inputs.find((s) => s.name === edge.targetHandle)
        } else {
          const nameMatches = node.inputs.filter((s) => s.name === sourceHandle)
          if (nameMatches.length === 1) {
            targetSlot = nameMatches[0]
          } else if (nameMatches.length > 1) {
            return {
              inputArtifacts: artifacts,
              incomingSlots: slotMap,
              resolutionError: `Ambiguous target slot on edge "${edge.id}" from source "${edge.source}" with declared output "${sourceHandle}": multiple candidate target inputs (${nameMatches.map((s) => `"${s.name}"`).join(', ')}) match name "${sourceHandle}" and edge omits targetHandle`,
            }
          } else {
            const kindMatches = node.inputs.filter((s) => s.kind === declaredOutput.kind)
            if (kindMatches.length === 1) {
              targetSlot = kindMatches[0]
            } else if (kindMatches.length > 1) {
              return {
                inputArtifacts: artifacts,
                incomingSlots: slotMap,
                resolutionError: `Ambiguous target slot on edge "${edge.id}" from source "${edge.source}" with declared output "${sourceHandle}": multiple candidate target inputs (${kindMatches.map((s) => `"${s.name}"`).join(', ')}) match kind "${declaredOutput.kind}" and edge omits targetHandle`,
              }
            } else {
              return {
                inputArtifacts: artifacts,
                incomingSlots: slotMap,
                resolutionError: `Cannot resolve target slot on edge "${edge.id}" from source "${edge.source}" with declared output "${sourceHandle}": target node "${node.id}" has no inputs matching kind "${declaredOutput.kind}" and edge omits targetHandle`,
              }
            }
          }
        }
        const targetSlotName = targetSlot?.name ?? edge.targetHandle ?? sourceHandle
        explicitlyBoundSlots.add(targetSlotName)
        explicitlyBoundSlots.add(sourceHandle)
        if (edge.targetHandle) {
          explicitlyBoundSlots.add(edge.targetHandle)
        }

        // Verify kind compatibility with declared target input slot
        if (targetSlot && targetSlot.kind !== declaredOutput.kind) {
          return {
            inputArtifacts: artifacts,
            incomingSlots: slotMap,
            resolutionError: `Incompatible artifact kind on edge "${edge.id}" from source "${edge.source}" for target slot "${targetSlotName}": expected kind "${targetSlot.kind}", but declared output "${sourceHandle}" has kind "${declaredOutput.kind}"`,
          }
        }

        const matchedCandidates = sourceArtifacts.filter(
          (a) => a.kind === declaredOutput.kind && this.matchesArtifactName(a, sourceHandle),
        )
        if (matchedCandidates.length === 1) {
          const matched = matchedCandidates[0]
          if (matched) {
            if (targetSlot && matched.kind !== targetSlot.kind) {
              return {
                inputArtifacts: artifacts,
                incomingSlots: slotMap,
                resolutionError: `Incompatible artifact kind on edge "${edge.id}" from source "${edge.source}" for target slot "${targetSlotName}": expected kind "${targetSlot.kind}", but resolved artifact "${matched.id}" has kind "${matched.kind}"`,
              }
            }
            slotMap.set(targetSlotName, matched)
            if (!artifacts.some((a) => a.id === matched.id)) {
              artifacts.push(matched)
            }
          }
        } else if (matchedCandidates.length > 1) {
          return {
            inputArtifacts: artifacts,
            incomingSlots: slotMap,
            resolutionError: `Ambiguous artifact resolution on edge "${edge.id}" from source "${edge.source}" to target slot "${targetSlotName}": multiple candidates (${String(matchedCandidates.length)}) found of kind "${declaredOutput.kind}" for declared output "${sourceHandle}"`,
          }
        } else {
          // matchedCandidates.length === 0: explicitly referenced declared output was not produced
          if (targetSlot?.required !== false || declaredOutput.required === true) {
            return {
              inputArtifacts: artifacts,
              incomingSlots: slotMap,
              resolutionError: `Explicitly referenced declared output "${sourceHandle}" from source "${edge.source}" was not produced for target slot "${targetSlotName}" on edge "${edge.id}"`,
            }
          }
        }
      } else if (sourceHandle) {
        // edge.sourceHandle is not a declared output name on sourceNode.
        // It could be an undeclared artifact title or an artifact kind.
        const targetSlot = edge.targetHandle
          ? node.inputs.find((s) => s.name === edge.targetHandle)
          : (node.inputs.find((s) => s.name === sourceHandle) ??
            (node.inputs.filter((s) => s.kind === sourceHandle).length === 1
              ? node.inputs.find((s) => s.kind === sourceHandle)
              : undefined))
        const targetSlotName = targetSlot?.name ?? edge.targetHandle ?? sourceHandle
        explicitlyBoundSlots.add(targetSlotName)
        explicitlyBoundSlots.add(sourceHandle)
        if (edge.targetHandle) {
          explicitlyBoundSlots.add(edge.targetHandle)
        }

        // Try exact artifact identity match first
        const exactMatches = sourceArtifacts.filter((a) =>
          this.matchesArtifactName(a, sourceHandle),
        )
        if (exactMatches.length === 1) {
          const exactMatch = exactMatches[0]
          if (exactMatch) {
            if (targetSlot && exactMatch.kind !== targetSlot.kind) {
              return {
                inputArtifacts: artifacts,
                incomingSlots: slotMap,
                resolutionError: `Incompatible artifact kind on edge "${edge.id}" from source "${edge.source}" for target slot "${targetSlotName}": expected kind "${targetSlot.kind}", but resolved artifact "${exactMatch.id}" has kind "${exactMatch.kind}"`,
              }
            }
            slotMap.set(targetSlotName, exactMatch)
            if (!artifacts.some((a) => a.id === exactMatch.id)) {
              artifacts.push(exactMatch)
            }
          }
        } else if (exactMatches.length > 1) {
          return {
            inputArtifacts: artifacts,
            incomingSlots: slotMap,
            resolutionError: `Ambiguous artifact resolution on edge "${edge.id}" from source "${edge.source}" to target slot "${targetSlotName}": multiple candidates (${String(exactMatches.length)}) found matching name "${sourceHandle}"`,
          }
        } else {
          // Kind-based fallback:
          // Check other edges from the same source to avoid claiming artifacts that belong to other edges
          const otherNamedEdgeHandles = new Set(
            incomingEdges
              .filter(
                (e): e is typeof e & { sourceHandle: string } =>
                  e.source === edge.source && e !== edge && typeof e.sourceHandle === 'string',
              )
              .map((e) => e.sourceHandle),
          )

          const candidateArtifacts = sourceArtifacts.filter(
            (a) =>
              a.kind === sourceHandle &&
              !Array.from(otherNamedEdgeHandles).some((h) => this.matchesArtifactName(a, h)),
          )

          if (candidateArtifacts.length === 1) {
            const matched = candidateArtifacts[0]
            if (matched) {
              if (targetSlot && matched.kind !== targetSlot.kind) {
                return {
                  inputArtifacts: artifacts,
                  incomingSlots: slotMap,
                  resolutionError: `Incompatible artifact kind on edge "${edge.id}" from source "${edge.source}" for target slot "${targetSlotName}": expected kind "${targetSlot.kind}", but resolved artifact "${matched.id}" has kind "${matched.kind}"`,
                }
              }
              const finalSlotName =
                edge.targetHandle ??
                targetSlot?.name ??
                (sourceHandle !== matched.kind ? sourceHandle : matched.kind)
              slotMap.set(finalSlotName, matched)
              if (!artifacts.some((a) => a.id === matched.id)) {
                artifacts.push(matched)
              }
            }
          } else if (candidateArtifacts.length > 1) {
            // Multiple same-kind candidates exist:
            // Check if edge.targetHandle uniquely identifies one candidate by identity
            const targetHandle = edge.targetHandle
            const targetMatches = targetHandle
              ? candidateArtifacts.filter((a) => this.matchesArtifactName(a, targetHandle))
              : []

            if (targetMatches.length === 1) {
              const matched = targetMatches[0]
              if (matched && targetHandle) {
                if (targetSlot && matched.kind !== targetSlot.kind) {
                  return {
                    inputArtifacts: artifacts,
                    incomingSlots: slotMap,
                    resolutionError: `Incompatible artifact kind on edge "${edge.id}" from source "${edge.source}" for target slot "${targetSlotName}": expected kind "${targetSlot.kind}", but resolved artifact "${matched.id}" has kind "${matched.kind}"`,
                  }
                }
                slotMap.set(targetHandle, matched)
                if (!artifacts.some((a) => a.id === matched.id)) {
                  artifacts.push(matched)
                }
              }
            } else if (targetMatches.length > 1) {
              return {
                inputArtifacts: artifacts,
                incomingSlots: slotMap,
                resolutionError: `Ambiguous artifact resolution on edge "${edge.id}" from source "${edge.source}" to target slot "${targetSlotName}": multiple candidates (${String(targetMatches.length)}) of kind "${sourceHandle}" match target handle "${targetSlotName}"`,
              }
            } else {
              // Multiple same-kind candidates remain and neither endpoint identifies a unique candidate:
              // Under Axiom A2 (Never guess), fail closed. Do NOT choose the first or unmapped artifact.
              return {
                inputArtifacts: artifacts,
                incomingSlots: slotMap,
                resolutionError: `Ambiguous artifact resolution on edge "${edge.id}" from source "${edge.source}" to target slot "${targetSlotName}": multiple candidates (${String(candidateArtifacts.length)}) found of kind "${sourceHandle}" without a unique identity match`,
              }
            }
          }
        }
      } else {
        // No sourceHandle specified on edge
        const targetHandle = edge.targetHandle
        if (targetHandle) {
          explicitlyBoundSlots.add(targetHandle)
          const targetSlot = node.inputs.find((s) => s.name === targetHandle)
          const nameMatches = sourceArtifacts.filter((a) =>
            this.matchesArtifactName(a, targetHandle),
          )

          if (nameMatches.length === 1) {
            const matched = nameMatches[0]
            if (matched) {
              if (targetSlot && matched.kind !== targetSlot.kind) {
                return {
                  inputArtifacts: artifacts,
                  incomingSlots: slotMap,
                  resolutionError: `Incompatible artifact kind on edge "${edge.id}" from source "${edge.source}" for target slot "${targetHandle}": expected kind "${targetSlot.kind}", but resolved artifact "${matched.id}" has kind "${matched.kind}"`,
                }
              }
              slotMap.set(targetHandle, matched)
              if (!artifacts.some((a) => a.id === matched.id)) {
                artifacts.push(matched)
              }
            }
          } else if (nameMatches.length > 1) {
            return {
              inputArtifacts: artifacts,
              incomingSlots: slotMap,
              resolutionError: `Ambiguous artifact resolution on edge "${edge.id}" from source "${edge.source}" to target slot "${targetHandle}": multiple candidates (${String(nameMatches.length)}) match target handle "${targetHandle}"`,
            }
          } else if (targetSlot) {
            const kindCandidates = sourceArtifacts.filter(
              (a) =>
                a.kind === targetSlot.kind &&
                !sourceNode?.outputs.some(
                  (o) => o.name !== targetHandle && this.matchesArtifactName(a, o.name),
                ),
            )
            if (kindCandidates.length === 1) {
              const matched = kindCandidates[0]
              if (matched) {
                slotMap.set(targetHandle, matched)
                if (!artifacts.some((a) => a.id === matched.id)) {
                  artifacts.push(matched)
                }
              }
            } else if (kindCandidates.length > 1) {
              return {
                inputArtifacts: artifacts,
                incomingSlots: slotMap,
                resolutionError: `Ambiguous artifact resolution on edge "${edge.id}" from source "${edge.source}" to target slot "${targetHandle}": multiple candidates (${String(kindCandidates.length)}) found of kind "${targetSlot.kind}" without a unique identity match`,
              }
            }
          }
        } else {
          // Edge has neither sourceHandle nor targetHandle
          const byKind = new Map<string, WorkflowArtifact[]>()
          for (const art of sourceArtifacts) {
            const list = byKind.get(art.kind) ?? []
            list.push(art)
            byKind.set(art.kind, list)
          }

          for (const [kind, kindList] of byKind.entries()) {
            if (kindList.length === 1) {
              const art = kindList[0]
              if (art) {
                const targetSlot =
                  node.inputs.find((s) => s.name === kind) ??
                  (node.inputs.filter((s) => s.kind === kind).length === 1
                    ? node.inputs.find((s) => s.kind === kind)
                    : undefined)
                const boundSlot = targetSlot?.name ?? kind
                slotMap.set(boundSlot, art)
                if (!artifacts.some((a) => a.id === art.id)) {
                  artifacts.push(art)
                }
              }
            } else {
              const targetSlotNeedingKind = node.inputs.find((s) => s.kind === kind)
              if (targetSlotNeedingKind) {
                return {
                  inputArtifacts: artifacts,
                  incomingSlots: slotMap,
                  resolutionError: `Ambiguous artifact resolution on edge "${edge.id}" from source "${edge.source}" to target node "${node.id}": multiple candidates (${String(kindList.length)}) found of kind "${kind}" on edge without handles`,
                }
              }
              for (const art of kindList) {
                if (!artifacts.some((a) => a.id === art.id)) {
                  artifacts.push(art)
                }
              }
            }
          }
        }
      }
    }

    // 2. Unfulfilled declared input slots
    for (const slot of node.inputs) {
      if (!slotMap.has(slot.name)) {
        // Do not auto-wire if the slot was explicitly bound by an edge that failed to resolve
        if (!explicitlyBoundSlots.has(slot.name)) {
          for (const edge of incomingEdges) {
            // If the edge explicitly identified a sourceHandle, that edge's binding was explicit.
            // Do not use this edge for generic auto-wiring.
            if (edge.sourceHandle) {
              continue
            }

            const lineage = currentLineage.get(edge.source)
            const sourceArtifacts = lineage?.artifacts ?? []
            const sourceNode = templateNodes.find((n) => n.id === edge.source)

            // Stage deliverable resolution for compiled linear workflows:
            // Input slots typed as 'stage_deliverable' take the deliverable produced by the upstream step.
            if (slot.kind === 'stage_deliverable') {
              if (sourceArtifacts.length === 1) {
                const match = sourceArtifacts[0]
                if (match) {
                  slotMap.set(slot.name, match)
                  if (!artifacts.some((a) => a.id === match.id)) {
                    artifacts.push(match)
                  }
                  break
                }
              } else if (sourceArtifacts.length > 1) {
                const declaredMatch = sourceArtifacts.find((a) =>
                  sourceNode?.outputs.some((o) => this.matchesArtifactName(a, o.name)),
                )
                if (declaredMatch) {
                  slotMap.set(slot.name, declaredMatch)
                  if (!artifacts.some((a) => a.id === declaredMatch.id)) {
                    artifacts.push(declaredMatch)
                  }
                  break
                }
              }
            }

            // Identity match: exact name and kind match
            const identityMatches = sourceArtifacts.filter(
              (a) => a.kind === slot.kind && this.matchesArtifactName(a, slot.name),
            )
            if (identityMatches.length === 1) {
              const identityMatch = identityMatches[0]
              if (identityMatch) {
                slotMap.set(slot.name, identityMatch)
                if (!artifacts.some((a) => a.id === identityMatch.id)) {
                  artifacts.push(identityMatch)
                }
                break
              }
            } else if (identityMatches.length > 1) {
              return {
                inputArtifacts: artifacts,
                incomingSlots: slotMap,
                resolutionError: `Ambiguous artifact resolution for input slot "${slot.name}": multiple candidates (${String(identityMatches.length)}) match name "${slot.name}" and kind "${slot.kind}" from source "${edge.source}"`,
              }
            }

            // If sourceNode declared an output with slot.name and it was not produced, do not substitute
            const declaredWithSameName = sourceNode?.outputs.find((o) => o.name === slot.name)
            if (declaredWithSameName) {
              continue
            }

            // Kind fallback: allowed only if kind matching is unambiguous
            // (source produced exactly 1 artifact of that kind, and source declared <= 1 output of that kind)
            const sourceKindOutputCount =
              sourceNode?.outputs.filter((o) => o.kind === slot.kind).length ?? 0
            if (sourceKindOutputCount <= 1) {
              // If source declared an output of that kind, verify it wasn't a declared output that was missing
              const declaredOutputOfKind = sourceNode?.outputs.find((o) => o.kind === slot.kind)
              if (declaredOutputOfKind) {
                const producedDeclared = sourceArtifacts.find(
                  (a) =>
                    a.kind === slot.kind && this.matchesArtifactName(a, declaredOutputOfKind.name),
                )
                if (!producedDeclared) {
                  continue
                }
              }

              const sameKindArtifacts = sourceArtifacts.filter((a) => a.kind === slot.kind)
              if (sameKindArtifacts.length === 1) {
                const matched = sameKindArtifacts[0]
                if (matched && !node.inputs.some((s) => slotMap.get(s.name)?.id === matched.id)) {
                  slotMap.set(slot.name, matched)
                  if (!artifacts.some((a) => a.id === matched.id)) {
                    artifacts.push(matched)
                  }
                  break
                }
              }
            }
          }
        }
      }
      if (
        !slotMap.has(slot.name) &&
        !explicitlyBoundSlots.has(slot.name) &&
        initialContext[slot.name] !== undefined
      ) {
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
    if (ctx.node.type === 'router') {
      return this.executeRouterNode(ctx)
    }

    if (this.executeLeafNode) {
      return this.executeLeafNode(ctx)
    }

    switch (ctx.node.type) {
      case 'user_gate': {
        if (this.decisionStore) {
          const decision = this.decisionStore.findGateDecision(ctx.graphRunId, ctx.node.id, {
            projectId: ctx.projectId,
            workflowId: ctx.workflowId,
          })
          if (!decision) {
            return {
              status: 'blocked',
              error: `User gate blocked: awaiting human decision for gate "${ctx.node.id}" in run "${ctx.graphRunId}"`,
              awaitingUser: true,
              resumable: true,
            }
          }
          if (decision.gateVerdict === 'approved') {
            const artifact: WorkflowArtifact = {
              id: artifactIdSchema.parse(randomUUID()),
              workflowId: ctx.workflowId,
              nodeId: ctx.node.id,
              kind: 'decision_record',
              format: 'json',
              title: `Gate ${ctx.node.title} Approved`,
              content: JSON.stringify(decision),
              metadata: {},
              createdAt: decision.lockedAt ?? new Date().toISOString(),
            }
            return { status: 'completed', artifacts: [artifact] }
          }
          if (decision.gateVerdict === 'rejected') {
            return {
              status: 'cancelled',
              error: `User gate "${ctx.node.title}" rejected: ${decision.rationale}`,
            }
          }
        }
        return {
          status: 'blocked',
          error: `User gate blocked: awaiting human decision`,
          awaitingUser: true,
          resumable: true,
        }
      }

      case 'verification': {
        return { status: 'completed' }
      }

      case 'agent': {
        return { status: 'completed' }
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

  /**
   * Evaluates outgoing conditional edges of a router node and emits a routing-decision artifact.
   */
  private executeRouterNode(ctx: NodeExecutionContext): NodeExecutionResult {
    const outgoing = ctx.outgoingEdges ?? []

    const evaluatedConditions: {
      edgeId: string
      targetNodeId: string
      matched: boolean
      isDefault?: boolean
      isFeedback?: boolean
    }[] = []

    let selectedEdge: WorkflowEdge | undefined

    // 1. Evaluate conditional edges in declaration order
    for (const edge of outgoing) {
      if (edge.condition && !edge.isDefault) {
        const matched = evaluateCondition(edge.condition, {
          inputArtifacts: ctx.inputArtifacts,
          incomingSlots: ctx.incomingSlots,
          initialContext: ctx.initialContext,
          iteration: ctx.iteration,
        })

        evaluatedConditions.push({
          edgeId: edge.id,
          targetNodeId: edge.target,
          matched,
          isFeedback: !!edge.isFeedback,
        })

        if (matched) {
          selectedEdge = edge
          break
        }
      }
    }

    // 2. Fall back to default branch if no condition matched
    if (!selectedEdge) {
      const defaultEdge = outgoing.find((e) => e.isDefault)
      if (defaultEdge) {
        selectedEdge = defaultEdge
        evaluatedConditions.push({
          edgeId: defaultEdge.id,
          targetNodeId: defaultEdge.target,
          matched: true,
          isDefault: true,
          isFeedback: !!defaultEdge.isFeedback,
        })
      }
    }

    // 3. Fail closed if neither condition nor default branch matched
    if (!selectedEdge) {
      return {
        status: 'failed',
        error: `No routing condition satisfied and no default branch declared for router "${ctx.node.id}"`,
      }
    }

    // 4. Record durable routing decision artifact
    const decisionPayload = {
      selectedEdgeId: selectedEdge.id,
      targetNodeId: selectedEdge.target,
      isFeedback: !!selectedEdge.isFeedback,
      evaluatedConditions,
    }

    const decisionArtifact: WorkflowArtifact = {
      id: randomUUID(),
      workflowId: ctx.workflowId,
      nodeId: ctx.node.id,
      kind: 'routing-decision',
      format: 'json',
      title: 'routing-decision.json',
      content: JSON.stringify(decisionPayload, null, 2),
      metadata: {
        selectedEdgeId: selectedEdge.id,
        targetNodeId: selectedEdge.target,
        isFeedback: !!selectedEdge.isFeedback,
      },
      createdAt: new Date().toISOString(),
    }

    return {
      status: 'completed',
      evidenceId: selectedEdge.id,
      artifacts: [decisionArtifact],
    }
  }

  /**
   * Handles authorized feedback transition, bound enforcement, progress detection,
   * iteration advancement in persistence, write-ahead checkpoints, and loop body state reset.
   */
  private handleFeedbackTransition(params: {
    template: WorkflowTemplateV2
    graphRunId: string
    projectId: ProjectId
    sourceNodeId: string
    sourceAttempt: number
    targetNodeId: string
    loopPolicy: LoopPolicy
    initialContext: Readonly<Record<string, string>>
    loopState: { isHalted: boolean; haltedReason: string | null; runError: string | null }
    completedNodeIds: Set<string>
    skippedNodeIds: Set<string>
    blockedNodeIds: Set<string>
    failedNodeIds: Set<string>
    deactivatedForwardEdgeIds: Set<string>
    fingerprintHistory: string[]
    getIterationArtifacts: () => WorkflowArtifact[]
    getIterationRouterDecisions: () => RouterDecisionRecord[]
    getLatestLoopChangeSet: () => ChangeSet | null
    setPreviousLoopIterationPatch: (patch: string | null) => void
    setIterationArtifacts: (artifacts: WorkflowArtifact[]) => void
    setIterationRouterDecisions: (decisions: RouterDecisionRecord[]) => void
    setLatestLoopChangeSet: (cs: ChangeSet | null) => void
    setCurrentIteration: (it: number) => void
    getCurrentIteration: () => number
    getSnapshot: () => GraphStateSnapshot
    actor: Actor
  }): boolean {
    const {
      template,
      graphRunId,
      projectId,
      sourceNodeId,
      sourceAttempt,
      targetNodeId,
      loopPolicy,
      initialContext,
      loopState,
      completedNodeIds,
      skippedNodeIds,
      blockedNodeIds,
      failedNodeIds,
      deactivatedForwardEdgeIds,
      fingerprintHistory,
      getIterationArtifacts,
      getIterationRouterDecisions,
      getLatestLoopChangeSet,
      setPreviousLoopIterationPatch,
      setIterationArtifacts,
      setIterationRouterDecisions,
      setLatestLoopChangeSet,
      setCurrentIteration,
      getCurrentIteration,
      getSnapshot,
      actor,
    } = params

    const fromIteration = getCurrentIteration()
    const toIteration = fromIteration + 1
    const { maxIterations, maxRepeatedStates, maxNodeAttempts } = loopPolicy
    const now = new Date().toISOString()

    // 1. Check maxIterations bound
    if (toIteration > maxIterations) {
      loopState.isHalted = true
      loopState.haltedReason = 'HALTED_LIMIT: max-iterations-exceeded'
      loopState.runError = `Maximum loop iterations (${String(maxIterations)}) exceeded at iteration ${String(toIteration)}`

      this.workflowStore.writeGraphCheckpoint(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: sourceNodeId,
          operation: 'iteration.halted',
          stateSnapshot: getSnapshot(),
          occurredAt: now,
        },
        actor,
      )
      return false
    }

    // 2. Check maxNodeAttempts bound on target node
    const existingTargetAttempts = this.workflowStore.getNodeAttempts(graphRunId, targetNodeId)
    const nextTargetAttempt = existingTargetAttempts.length + 1
    if (nextTargetAttempt > maxNodeAttempts) {
      loopState.isHalted = true
      loopState.haltedReason = 'HALTED_LIMIT: max-attempts-exceeded'
      loopState.runError = `Maximum node attempts (${String(maxNodeAttempts)}) exceeded for node "${targetNodeId}"`

      this.workflowStore.writeGraphCheckpoint(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: sourceNodeId,
          operation: 'iteration.halted',
          stateSnapshot: getSnapshot(),
          occurredAt: now,
        },
        actor,
      )
      return false
    }

    // 3. Compute iteration fingerprint and check no-progress bound
    const latestChangeSet = getLatestLoopChangeSet()
    const currentFingerprint = computeIterationFingerprint({
      diffPatch: latestChangeSet?.patch ?? null,
      artifacts: getIterationArtifacts(),
      routerDecisions: getIterationRouterDecisions(),
      context: initialContext,
    })

    const repeatCount = getConsecutiveRepeatCount(fingerprintHistory, currentFingerprint)
    if (repeatCount >= maxRepeatedStates) {
      loopState.isHalted = true
      loopState.haltedReason = 'HALTED_LIMIT: no-progress'
      loopState.runError = `No progress detected: identical semantic fingerprint repeated consecutively (${String(repeatCount + 1)} times)`

      this.workflowStore.writeGraphCheckpoint(
        {
          id: randomUUID(),
          projectId,
          graphRunId,
          nodeId: sourceNodeId,
          operation: 'iteration.halted',
          stateSnapshot: getSnapshot(),
          occurredAt: now,
        },
        actor,
      )
      return false
    }

    fingerprintHistory.push(currentFingerprint)

    // 4. Advance iteration in persistence
    this.advanceLoopIteration({
      template,
      graphRunId,
      sourceNodeId,
      sourceAttempt,
      targetNodeId,
      fromIteration,
      toIteration,
      conditionMet: true,
      checkpointId: null,
      occurredAt: now,
      actor,
    })

    // 5. Update in-memory iteration tracking
    setCurrentIteration(toIteration)
    setPreviousLoopIterationPatch(latestChangeSet?.patch ?? null)
    setIterationArtifacts([])
    setIterationRouterDecisions([])
    setLatestLoopChangeSet(null)

    // 6. Write-ahead checkpoint for iteration advanced
    this.workflowStore.writeGraphCheckpoint(
      {
        id: randomUUID(),
        projectId,
        graphRunId,
        nodeId: targetNodeId,
        operation: 'iteration.advanced',
        stateSnapshot: getSnapshot(),
        occurredAt: now,
      },
      actor,
    )

    // 7. Reset loop body runtime state
    const loopBody = getLoopBody(template.nodes, template.edges, sourceNodeId, targetNodeId)
    for (const nid of loopBody) {
      completedNodeIds.delete(nid)
      skippedNodeIds.delete(nid)
      blockedNodeIds.delete(nid)
      failedNodeIds.delete(nid)
      for (const edge of template.edges) {
        if (edge.source === nid) {
          deactivatedForwardEdgeIds.delete(edge.id)
        }
      }
    }

    // Also un-skip any node downstream of targetNodeId that was pruned
    const downstream = this.getTransitiveDownstream(targetNodeId, template.edges)
    for (const nid of Array.from(skippedNodeIds)) {
      if (downstream.has(nid)) {
        skippedNodeIds.delete(nid)
      }
    }

    return true
  }

  /**
   * Eagerly prunes forward branches that are unreachable due to unselected router edges.
   * Preserves diamond convergence and nodes with at least one active, viable incoming path.
   */
  private pruneUnselectedBranches(params: {
    template: WorkflowTemplateV2
    graphRunId: string
    projectId: ProjectId
    actor: Actor
    deactivatedForwardEdgeIds: Set<string>
    completedNodeIds: Set<string>
    skippedNodeIds: Set<string>
    runningNodeIds: Set<string>
    failedNodeIds: Set<string>
    blockedNodeIds: Set<string>
    getSnapshot: () => GraphStateSnapshot
  }): void {
    const {
      template,
      graphRunId,
      projectId,
      actor,
      deactivatedForwardEdgeIds,
      completedNodeIds,
      skippedNodeIds,
      runningNodeIds,
      failedNodeIds,
      blockedNodeIds,
      getSnapshot,
    } = params

    let newlySkipped = true
    while (newlySkipped) {
      newlySkipped = false
      for (const node of template.nodes) {
        if (
          completedNodeIds.has(node.id) ||
          skippedNodeIds.has(node.id) ||
          runningNodeIds.has(node.id) ||
          failedNodeIds.has(node.id) ||
          blockedNodeIds.has(node.id)
        ) {
          continue
        }

        const incomingForwardEdges = template.edges.filter(
          (e) => e.target === node.id && !e.isFeedback,
        )

        // Root nodes without forward incoming edges cannot be pruned by routers
        if (incomingForwardEdges.length === 0) {
          continue
        }

        // A node is pruned if and only if EVERY incoming forward edge is either:
        // 1. In deactivatedForwardEdgeIds (an unselected edge from a router)
        // 2. OR originating from a node that has already been skipped
        const allIncomingDead = incomingForwardEdges.every(
          (e) => deactivatedForwardEdgeIds.has(e.id) || skippedNodeIds.has(e.source),
        )

        if (allIncomingDead) {
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

          skippedNodeIds.add(node.id)

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

          newlySkipped = true
        }
      }
    }
  }
}
