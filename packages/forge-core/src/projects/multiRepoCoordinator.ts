import { createHash, randomUUID } from 'node:crypto'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { z } from 'zod'
import { GitService, WorktreeIsolationManager, type DiffFile, type WorktreeLease } from '../git'

export const workspaceRepoRoleSchema = z.enum(['primary', 'library', 'service', 'infra'])

export type WorkspaceRepoRole = z.infer<typeof workspaceRepoRoleSchema>

export const workspaceRepoEntrySchema = z.strictObject({
  repoId: z
    .string()
    .trim()
    .min(1)
    .regex(/^[a-zA-Z0-9._-]+$/, 'repoId must contain only [a-zA-Z0-9._-]'),
  repositoryPath: z.string().trim().min(1),
  baseRef: z.string().trim().min(1).default('HEAD'),
  role: workspaceRepoRoleSchema.default('service'),
  dependsOn: z.array(z.string().trim().min(1)).default([]),
})

export type WorkspaceRepoEntry = z.infer<typeof workspaceRepoEntrySchema>
export type WorkspaceRepoInput = z.input<typeof workspaceRepoEntrySchema>

export const multiRepoWorkspaceManifestSchema = z.strictObject({
  workspaceId: z.string().trim().min(1),
  name: z.string().trim().min(1),
  repos: z.array(workspaceRepoEntrySchema).min(1),
  worktreeRoot: z.string().trim().min(1).optional(),
  tempSandboxRoot: z.string().trim().min(1).optional(),
})

export type MultiRepoWorkspaceManifest = z.infer<typeof multiRepoWorkspaceManifestSchema>
export type MultiRepoWorkspaceManifestInput = z.input<typeof multiRepoWorkspaceManifestSchema>

export interface MultiRepoExecutionPlan {
  readonly workspaceId: string
  readonly name: string
  readonly repoCount: number
  readonly executionOrder: readonly string[]
  readonly executionWaves: readonly (readonly string[])[]
}

export interface RepoWorktreeAllocation {
  readonly repoId: string
  readonly role: WorkspaceRepoRole
  readonly repositoryPath: string
  readonly lease: WorktreeLease
  readonly dependsOn: readonly string[]
}

export interface MultiRepoWorkspaceSession {
  readonly sessionId: string
  readonly workspaceId: string
  readonly agentId: string
  readonly branchId: string
  readonly executionOrder: readonly string[]
  readonly executionWaves: readonly (readonly string[])[]
  readonly allocations: ReadonlyMap<string, RepoWorktreeAllocation>
  readonly createdAtMs: number
}

export interface RepoChangesetReconciliation {
  readonly repoId: string
  readonly role: WorkspaceRepoRole
  readonly repositoryPath: string
  readonly isolatedWorktreePath: string
  readonly baseSha: string
  readonly clean: boolean
  readonly changedFileCount: number
  readonly insertions: number
  readonly deletions: number
  readonly files: readonly DiffFile[]
  readonly patch: string
  readonly changesetDigest: string
}

export interface CrossRepoReconciliationReport {
  readonly sessionId: string
  readonly workspaceId: string
  readonly executionOrder: readonly string[]
  readonly executionWaves: readonly (readonly string[])[]
  readonly totalRepos: number
  readonly modifiedRepoCount: number
  readonly totalChangedFiles: number
  readonly crossContaminationFree: boolean
  readonly reconciliations: readonly RepoChangesetReconciliation[]
  readonly reconciliationDigest: string
  readonly reconciledAtMs: number
}

export class InvalidWorkspaceManifestError extends Error {
  constructor(message: string) {
    super(`Invalid multi-repo workspace manifest: ${message}`)
    this.name = 'InvalidWorkspaceManifestError'
  }
}

export class CrossRepoDependencyCycleError extends InvalidWorkspaceManifestError {
  readonly cycleRepoIds: readonly string[]

  constructor(cycleRepoIds: readonly string[]) {
    super(`Dependency cycle detected across repositories: ${cycleRepoIds.join(', ')}`)
    this.name = 'CrossRepoDependencyCycleError'
    this.cycleRepoIds = cycleRepoIds
  }
}

export class WorkspaceProvisioningError extends Error {
  constructor(message: string) {
    super(`Multi-repo workspace provisioning failed: ${message}`)
    this.name = 'WorkspaceProvisioningError'
  }
}

function pathsOverlap(pathA: string, pathB: string): boolean {
  const a = resolve(pathA)
  const b = resolve(pathB)
  if (a === b) {
    return true
  }
  const relAB = relative(a, b)
  const relBA = relative(b, a)
  const insideAB = relAB !== '' && !relAB.startsWith('..') && !isAbsolute(relAB)
  const insideBA = relBA !== '' && !relBA.startsWith('..') && !isAbsolute(relBA)
  return insideAB || insideBA
}

/**
 * Validates manifest integrity and computes deterministic topological execution waves (Kahn's algorithm).
 */
export function planMultiRepoExecutionOrder(manifestInput: MultiRepoWorkspaceManifestInput): {
  readonly manifest: MultiRepoWorkspaceManifest
  readonly plan: MultiRepoExecutionPlan
} {
  const parsed = multiRepoWorkspaceManifestSchema.safeParse(manifestInput)
  if (!parsed.success) {
    throw new InvalidWorkspaceManifestError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
    )
  }
  const manifest = parsed.data

  const seenIds = new Set<string>()
  const resolvedPaths: { readonly repoId: string; readonly path: string }[] = []

  for (const repo of manifest.repos) {
    if (seenIds.has(repo.repoId)) {
      throw new InvalidWorkspaceManifestError(`Duplicate repoId "${repo.repoId}"`)
    }
    seenIds.add(repo.repoId)

    const resolved = resolve(repo.repositoryPath)
    for (const existing of resolvedPaths) {
      if (pathsOverlap(existing.path, resolved)) {
        throw new InvalidWorkspaceManifestError(
          `Repository paths overlap between "${existing.repoId}" (${existing.path}) and "${repo.repoId}" (${resolved})`,
        )
      }
    }
    resolvedPaths.push({ repoId: repo.repoId, path: resolved })
  }

  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()
  for (const repo of manifest.repos) {
    inDegree.set(repo.repoId, 0)
    dependents.set(repo.repoId, [])
  }

  for (const repo of manifest.repos) {
    const uniqueDeps = new Set(repo.dependsOn)
    for (const depId of uniqueDeps) {
      if (!seenIds.has(depId)) {
        throw new InvalidWorkspaceManifestError(
          `Repository "${repo.repoId}" declares unknown dependency "${depId}"`,
        )
      }
      if (depId === repo.repoId) {
        throw new CrossRepoDependencyCycleError([repo.repoId])
      }
      inDegree.set(repo.repoId, (inDegree.get(repo.repoId) ?? 0) + 1)
      dependents.get(depId)?.push(repo.repoId)
    }
  }

  const executionOrder: string[] = []
  const executionWaves: string[][] = []
  let currentWave = manifest.repos
    .map((r) => r.repoId)
    .filter((id) => (inDegree.get(id) ?? 0) === 0)
    .sort()

  while (currentWave.length > 0) {
    executionWaves.push(currentWave)
    const nextWave: string[] = []
    for (const id of currentWave) {
      executionOrder.push(id)
      for (const childId of dependents.get(id) ?? []) {
        const nextDegree = (inDegree.get(childId) ?? 0) - 1
        inDegree.set(childId, nextDegree)
        if (nextDegree === 0) {
          nextWave.push(childId)
        }
      }
    }
    currentWave = nextWave.sort()
  }

  if (executionOrder.length !== manifest.repos.length) {
    const remaining = manifest.repos
      .map((r) => r.repoId)
      .filter((id) => !executionOrder.includes(id))
    throw new CrossRepoDependencyCycleError(remaining)
  }

  return {
    manifest,
    plan: {
      workspaceId: manifest.workspaceId,
      name: manifest.name,
      repoCount: manifest.repos.length,
      executionOrder,
      executionWaves,
    },
  }
}

/**
 * Multi-Repository Workspace Orchestrator and Cross-Repo Reconciliation Coordinator (POLISH-001).
 * Coordinates isolated git worktree leases across interdependent repositories and reconciles
 * changesets independently per repository with zero cross-contamination.
 */
export class MultiRepoWorkspaceCoordinator {
  private readonly manifest: MultiRepoWorkspaceManifest
  private readonly plan: MultiRepoExecutionPlan
  private readonly managers = new Map<string, WorktreeIsolationManager>()
  private readonly sessions = new Map<string, MultiRepoWorkspaceSession>()
  private readonly clock: () => number

  constructor(manifestInput: MultiRepoWorkspaceManifestInput, clock: () => number = Date.now) {
    const { manifest, plan } = planMultiRepoExecutionOrder(manifestInput)
    this.manifest = manifest
    this.plan = plan
    this.clock = clock

    for (const repo of this.manifest.repos) {
      const worktreeRoot = manifest.worktreeRoot
        ? join(resolve(manifest.worktreeRoot), repo.repoId)
        : undefined
      const tempSandboxRoot = manifest.tempSandboxRoot
        ? join(resolve(manifest.tempSandboxRoot), repo.repoId)
        : undefined
      this.managers.set(
        repo.repoId,
        new WorktreeIsolationManager({
          repositoryPath: resolve(repo.repositoryPath),
          ...(worktreeRoot !== undefined ? { worktreeRoot } : {}),
          ...(tempSandboxRoot !== undefined ? { tempSandboxRoot } : {}),
          clock,
        }),
      )
    }
  }

  /**
   * Returns the validated topological execution order across workspace repositories.
   */
  public getExecutionPlan(): MultiRepoExecutionPlan {
    return this.plan
  }

  /**
   * Atomically provisions isolated worktrees across all target repositories in topological wave order.
   * Rolls back already-provisioned leases if any repository fails to provision.
   */
  public async provisionWorkspace(
    agentId: string,
    branchId: string,
  ): Promise<MultiRepoWorkspaceSession> {
    const allocations = new Map<string, RepoWorktreeAllocation>()
    const repoById = new Map(this.manifest.repos.map((r) => [r.repoId, r]))

    try {
      for (const repoId of this.plan.executionOrder) {
        const repo = repoById.get(repoId)
        const manager = this.managers.get(repoId)
        if (!repo || !manager) {
          throw new WorkspaceProvisioningError(`Missing manager for repository "${repoId}"`)
        }
        const lease = await manager.provisionLease({
          scopeType: 'run',
          agentId,
          branchId: `${branchId}-${repoId}`,
          baseRef: repo.baseRef,
        })
        allocations.set(repoId, {
          repoId,
          role: repo.role,
          repositoryPath: resolve(repo.repositoryPath),
          lease,
          dependsOn: [...repo.dependsOn],
        })
      }
    } catch (error) {
      await Promise.all(
        Array.from(allocations.values()).map((alloc) =>
          alloc.lease.release().catch(() => undefined),
        ),
      )
      throw new WorkspaceProvisioningError(error instanceof Error ? error.message : String(error))
    }

    const session: MultiRepoWorkspaceSession = {
      sessionId: randomUUID(),
      workspaceId: this.manifest.workspaceId,
      agentId,
      branchId,
      executionOrder: this.plan.executionOrder,
      executionWaves: this.plan.executionWaves,
      allocations,
      createdAtMs: this.clock(),
    }
    this.sessions.set(session.sessionId, session)
    return session
  }

  /**
   * Reconciles diffs independently per repository within an active isolated workspace session.
   * Verifies no isolated worktree paths overlap and aggregates per-repo changeset evidence.
   */
  public async reconcileSession(sessionId: string): Promise<CrossRepoReconciliationReport> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      throw new WorkspaceProvisioningError(`Workspace session "${sessionId}" not found`)
    }

    const isolatedPaths: string[] = []
    for (const alloc of session.allocations.values()) {
      for (const seen of isolatedPaths) {
        if (pathsOverlap(seen, alloc.lease.worktreePath)) {
          throw new WorkspaceProvisioningError(
            `Cross-contamination risk: overlapping isolated worktrees "${seen}" and "${alloc.lease.worktreePath}"`,
          )
        }
      }
      isolatedPaths.push(alloc.lease.worktreePath)
    }

    const reconciliations: RepoChangesetReconciliation[] = []
    for (const repoId of session.executionOrder) {
      const alloc = session.allocations.get(repoId)
      if (!alloc) {
        continue
      }
      const git = new GitService({ repositoryPath: alloc.lease.worktreePath })
      const diff = await git.diffWorktree(alloc.lease.resolvedSha)
      let insertions = 0
      let deletions = 0
      for (const f of diff.files) {
        insertions += f.insertions
        deletions += f.deletions
      }

      const changesetDigest = createHash('sha256')
        .update(
          JSON.stringify({
            repoId,
            baseSha: alloc.lease.resolvedSha,
            files: diff.files,
            patch: diff.patch,
          }),
        )
        .digest('hex')

      reconciliations.push({
        repoId,
        role: alloc.role,
        repositoryPath: alloc.repositoryPath,
        isolatedWorktreePath: alloc.lease.worktreePath,
        baseSha: alloc.lease.resolvedSha,
        clean: diff.files.length === 0,
        changedFileCount: diff.files.length,
        insertions,
        deletions,
        files: diff.files,
        patch: diff.patch,
        changesetDigest,
      })
    }

    const modifiedRepoCount = reconciliations.filter((r) => !r.clean).length
    const totalChangedFiles = reconciliations.reduce((sum, r) => sum + r.changedFileCount, 0)
    const reconciledAtMs = this.clock()

    const reconciliationDigest = createHash('sha256')
      .update(
        JSON.stringify({
          sessionId: session.sessionId,
          workspaceId: session.workspaceId,
          executionOrder: session.executionOrder,
          reconciliations: reconciliations.map((r) => ({
            repoId: r.repoId,
            changesetDigest: r.changesetDigest,
          })),
        }),
      )
      .digest('hex')

    return {
      sessionId: session.sessionId,
      workspaceId: session.workspaceId,
      executionOrder: session.executionOrder,
      executionWaves: session.executionWaves,
      totalRepos: reconciliations.length,
      modifiedRepoCount,
      totalChangedFiles,
      crossContaminationFree: true,
      reconciliations,
      reconciliationDigest,
      reconciledAtMs,
    }
  }

  /**
   * Releases all isolated worktrees and temp sandboxes owned by the workspace session.
   */
  public async disposeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) {
      return
    }
    this.sessions.delete(sessionId)
    await Promise.all(
      Array.from(session.allocations.values()).map((alloc) => alloc.lease.release()),
    )
  }

  /**
   * Disposes all active workspace sessions cleanly.
   */
  public async disposeAll(): Promise<void> {
    const ids = Array.from(this.sessions.keys())
    await Promise.all(ids.map((id) => this.disposeSession(id)))
  }
}
