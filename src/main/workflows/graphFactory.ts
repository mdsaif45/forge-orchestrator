import { isAbsolute, normalize, resolve } from 'node:path'
import type { Actor } from '@shared/domain'
import { ArtifactService } from '../artifacts/artifactService'
import { BindingStore } from '../db/bindingStore'
import type { ForgeDatabase } from '../db/connection'
import { ChangeSetStore } from '../db/changeSetStore'
import { DecisionStore } from '../db/decisionStore'
import { EventStore } from '../db/eventStore'
import { ProjectStore } from '../db/projectStore'
import { WorkflowStore } from '../db/workflowStore'
import { GitService, WorktreeService } from '../git'
import type { BindingSet } from '../runtimes/bindings'
import type { RuntimeRegistry } from '../runtimes/registry'
import { GraphExecutor, type LeafNodeExecutor } from './graphExecutor'
import { createLeafRunner } from './leafRunner'

/**
 * Production options required to compose GraphExecutor with LeafRunner.
 * Requires genuine infrastructure; permissive or fake fallbacks are rejected.
 */
export interface ProductionGraphCompositionOptions {
  /** Authoritative SQLite database connection. */
  readonly db: ForgeDatabase
  /** Authoritative event store for domain projections. */
  readonly eventStore: EventStore
  /** Root directory on disk for isolated node worktrees. */
  readonly worktreeRoot: string
  /** Absolute path to the subject repository root. */
  readonly repositoryPath: string
  /** Durable artifact service for physical file and metadata persistence. */
  readonly artifactService: ArtifactService
  /** Registered agent runtimes registry. */
  readonly registry: RuntimeRegistry
  /** System actor for audit logging (defaults to 'system'). */
  readonly actor?: Actor | undefined
  /** Maximum concurrent node scheduling limit. */
  readonly maxConcurrency?: number | undefined
  /**
   * Optional default runtime ID for leaf agent execution.
   */
  readonly defaultRuntimeId?: string | undefined
  /**
   * Optional composition-level agent role bindings.
   */
  readonly bindings?: BindingSet | undefined
}

/**
 * Production composition bundle containing wired engine components and domain stores.
 */
export interface ProductionGraphComposition {
  readonly executor: GraphExecutor
  readonly leafRunner: LeafNodeExecutor
  readonly worktreeService: WorktreeService
  readonly gitServiceFactory: (path: string) => GitService
  readonly stores: {
    readonly workflowStore: WorkflowStore
    readonly projectStore: ProjectStore
    readonly decisionStore: DecisionStore
    readonly changeSetStore: ChangeSetStore
    readonly bindingStore: BindingStore
  }
}

export class GraphCompositionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'GraphCompositionError'
  }
}

/**
 * Validates production composition options for structural consistency and fail-closed safety.
 */
export function validateCompositionOptions(
  rawOptions: unknown,
): asserts rawOptions is ProductionGraphCompositionOptions {
  if (!rawOptions || typeof rawOptions !== 'object') {
    throw new GraphCompositionError('Options object is required for graph composition')
  }

  const options = rawOptions as Partial<ProductionGraphCompositionOptions>

  if (!options.db || typeof options.db !== 'object') {
    throw new GraphCompositionError(
      'Valid ForgeDatabase instance is required for graph composition',
    )
  }

  if (!options.eventStore || !(options.eventStore instanceof EventStore)) {
    throw new GraphCompositionError('Valid EventStore instance is required for graph composition')
  }

  if (!options.eventStore.isBoundToDatabase(options.db)) {
    throw new GraphCompositionError(
      'EventStore must be bound to the exact ForgeDatabase instance supplied as db',
    )
  }

  if (!options.artifactService || !(options.artifactService instanceof ArtifactService)) {
    throw new GraphCompositionError(
      'Valid ArtifactService instance is required for graph composition',
    )
  }

  if (!options.artifactService.isBoundToDatabase(options.db)) {
    throw new GraphCompositionError(
      'ArtifactService metadata store must be bound to the exact ForgeDatabase instance supplied as db',
    )
  }

  if (!options.registry) {
    throw new GraphCompositionError(
      'Valid RuntimeRegistry instance is required for graph composition',
    )
  }

  if (typeof options.worktreeRoot !== 'string' || options.worktreeRoot.trim() === '') {
    throw new GraphCompositionError('worktreeRoot must be a non-empty string path')
  }

  if (typeof options.repositoryPath !== 'string' || options.repositoryPath.trim() === '') {
    throw new GraphCompositionError('repositoryPath must be a non-empty string path')
  }

  if (!isAbsolute(options.worktreeRoot)) {
    throw new GraphCompositionError(
      `worktreeRoot must be an absolute path: "${options.worktreeRoot}"`,
    )
  }

  if (!isAbsolute(options.repositoryPath)) {
    throw new GraphCompositionError(
      `repositoryPath must be an absolute path: "${options.repositoryPath}"`,
    )
  }

  const normRepo = normalize(resolve(options.repositoryPath))
  const normWorktree = normalize(resolve(options.worktreeRoot))

  if (normRepo === normWorktree) {
    throw new GraphCompositionError(
      `worktreeRoot cannot be identical to repositoryPath: "${normRepo}"`,
    )
  }
}

/**
 * Canonical composition factory wiring GraphExecutor and LeafRunner using real application infrastructure.
 *
 * This factory establishes the production-quality composition of the graph engine without
 * altering the active production path (WorkflowService -> Orchestrator) or modifying global defaults.
 */
export function createGraphExecutorWithLeafRunner(
  options: ProductionGraphCompositionOptions,
): ProductionGraphComposition {
  validateCompositionOptions(options)

  const actor = options.actor ?? 'system'

  // 1. Construct durable domain stores from authoritative database and eventStore
  const workflowStore = new WorkflowStore(options.db)
  const projectStore = new ProjectStore(options.db)
  const decisionStore = new DecisionStore(options.db, options.eventStore)
  const changeSetStore = new ChangeSetStore(options.db, options.eventStore)
  const bindingStore = new BindingStore(options.db, options.eventStore)

  // 2. Construct production worktree isolation and git service factory
  const worktreeService = new WorktreeService({
    repositoryPath: options.repositoryPath,
    root: options.worktreeRoot,
  })

  const gitServiceFactory = (path: string): GitService => new GitService({ repositoryPath: path })

  // 3. Construct LeafRunner wiring real stores and git factory
  const leafRunner = createLeafRunner({
    registry: options.registry,
    gitServiceFactory,
    decisionStore,
    workflowStore,
    projectStore,
    bindingStore,
    bindings: options.bindings,
    actor,
    defaultRuntimeId: options.defaultRuntimeId,
  })

  // 4. Construct GraphExecutor wiring real stores, worktree service, artifact service, and leafRunner
  const executor = new GraphExecutor({
    workflowStore,
    worktreeService,
    gitServiceFactory,
    artifactService: options.artifactService,
    decisionStore,
    projectStore,
    changeSetStore,
    bindingStore,
    bindings: options.bindings,
    registry: options.registry,
    defaultRuntimeId: options.defaultRuntimeId,
    actor,
    maxConcurrency: options.maxConcurrency,
    executeLeafNode: leafRunner,
  })

  return {
    executor,
    leafRunner,
    worktreeService,
    gitServiceFactory,
    stores: {
      workflowStore,
      projectStore,
      decisionStore,
      changeSetStore,
      bindingStore,
    },
  }
}
