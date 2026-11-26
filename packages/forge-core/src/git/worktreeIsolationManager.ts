import { createHash, randomUUID } from 'node:crypto'
import { mkdir, rm, rmdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { GitCommandError, runGit } from './exec'
import { WorktreeService } from './worktreeService'

export type IsolationScope = 'agent' | 'branch' | 'run' | 'scratch'

export type WorktreeLockState = 'ACTIVE' | 'EXPIRED' | 'RELEASING' | 'RELEASED'

export interface IsolationScopeConfig {
  readonly scopeType?: IsolationScope | undefined
  readonly agentId: string
  readonly branchId: string
  readonly baseRef?: string | undefined
  readonly leaseTtlMs?: number | undefined
  readonly createTempSandbox?: boolean | undefined
}

export interface WorktreeLeaseSnapshot {
  readonly leaseId: string
  readonly lockKey: string
  readonly agentId: string
  readonly branchId: string
  readonly scope: IsolationScope
  readonly repositoryPath: string
  readonly worktreePath: string
  readonly sandboxTempDir: string | null
  readonly baseRef: string
  readonly resolvedSha: string
  readonly lockState: WorktreeLockState
  readonly acquiredAtMs: number
  readonly expiresAtMs: number
  readonly hookCount: number
}

export interface WorktreeCleanupReport {
  readonly leaseId: string
  readonly worktreeRemoved: boolean
  readonly tempSandboxRemoved: boolean
  readonly cleanupHooksExecuted: number
  readonly hookErrors: readonly string[]
  readonly durationMs: number
}

export interface WorktreeLease extends WorktreeLeaseSnapshot {
  readonly registerCleanupHook: (hook: CleanupHook) => void
  readonly release: () => Promise<WorktreeCleanupReport>
}

export type CleanupHook = (lease: WorktreeLeaseSnapshot) => Promise<void> | void

export interface WorktreeInventoryEntry {
  readonly path: string
  readonly headSha: string | null
  readonly branch: string | null
  readonly detached: boolean
  readonly bare: boolean
  readonly locked: boolean
  readonly prunable: boolean
  readonly managedByForge: boolean
  readonly leaseId: string | null
  readonly agentId: string | null
}

export interface WorktreeListResult {
  readonly repositoryPath: string
  readonly worktreeRoot: string
  readonly tempSandboxRoot: string
  readonly worktrees: readonly WorktreeInventoryEntry[]
  readonly activeLeases: readonly WorktreeLeaseSnapshot[]
  readonly listDigest: string
}

export interface WorktreeIsolationManagerOptions {
  readonly repositoryPath: string
  readonly worktreeRoot?: string | undefined
  readonly tempSandboxRoot?: string | undefined
  readonly defaultLeaseTtlMs?: number | undefined
  readonly clock?: (() => number) | undefined
}

export class WorktreeIsolationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WorktreeIsolationError'
  }
}

export class WorktreeLockConflictError extends WorktreeIsolationError {
  readonly lockKey: string

  constructor(lockKey: string) {
    super(`Worktree isolation lock conflict: active lease already holds scope "${lockKey}"`)
    this.name = 'WorktreeLockConflictError'
    this.lockKey = lockKey
  }
}

export class EmptyRepositoryIsolationError extends WorktreeIsolationError {
  readonly baseRef: string

  constructor(baseRef: string, repositoryPath: string) {
    super(
      `Cannot isolate git worktree: ref "${baseRef}" could not be resolved in "${repositoryPath}"`,
    )
    this.name = 'EmptyRepositoryIsolationError'
    this.baseRef = baseRef
  }
}

interface InternalLease {
  readonly leaseId: string
  readonly lockKey: string
  readonly agentId: string
  readonly branchId: string
  readonly scope: IsolationScope
  readonly repositoryPath: string
  readonly worktreePath: string
  readonly sandboxTempDir: string | null
  readonly baseRef: string
  readonly resolvedSha: string
  lockState: WorktreeLockState
  readonly acquiredAtMs: number
  readonly expiresAtMs: number
  readonly hooks: CleanupHook[]
  releasePromise?: Promise<WorktreeCleanupReport> | undefined
}

const DEFAULT_LEASE_TTL_MS = 15 * 60 * 1000

function sanitizeSegment(raw: string, fieldName: string): string {
  const trimmed = raw.trim()
  if (trimmed.length === 0) {
    throw new WorktreeIsolationError(`${fieldName} must be a non-empty string`)
  }
  if (trimmed.includes('..') || trimmed.includes('/') || trimmed.includes('\\')) {
    throw new WorktreeIsolationError(`${fieldName} contains unsafe path characters: "${raw}"`)
  }
  const safe = trimmed.replace(/[^a-zA-Z0-9._-]/g, '_')
  if (safe.length === 0) {
    throw new WorktreeIsolationError(`${fieldName} must contain valid path characters`)
  }
  return safe
}

function isSubpath(root: string, candidate: string): boolean {
  const rel = relative(resolve(root), resolve(candidate))
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/**
 * Multi-Agent Git Worktree Isolation Manager and Temp Directory Sandboxing (PAR-002, Axioms A1 & A7).
 * Atomically provisions detached git worktrees alongside isolated temporary staging directories,
 * enforcing exclusive per-scope locks and deterministic LIFO cleanup hooks.
 */
export class WorktreeIsolationManager {
  private readonly repositoryPath: string
  private readonly worktreeRoot: string
  private readonly tempSandboxRoot: string
  private readonly defaultLeaseTtlMs: number
  private readonly clock: () => number

  private readonly pendingLockKeys = new Set<string>()
  private readonly activeLeasesById = new Map<string, InternalLease>()
  private readonly activeLeasesByLockKey = new Map<string, InternalLease>()
  private readonly worktreeService: WorktreeService

  constructor(options: WorktreeIsolationManagerOptions) {
    this.repositoryPath = resolve(options.repositoryPath)
    const repoSlug = createHash('sha1').update(this.repositoryPath).digest('hex').slice(0, 12)
    this.worktreeRoot = resolve(
      options.worktreeRoot ?? join(tmpdir(), 'forge-isolated-worktrees', repoSlug),
    )
    this.tempSandboxRoot = resolve(
      options.tempSandboxRoot ?? join(tmpdir(), 'forge-sandbox-tmp', repoSlug),
    )
    this.defaultLeaseTtlMs = options.defaultLeaseTtlMs ?? DEFAULT_LEASE_TTL_MS
    this.clock = options.clock ?? Date.now
    this.worktreeService = new WorktreeService({
      repositoryPath: this.repositoryPath,
      root: this.worktreeRoot,
    })
  }

  /**
   * Atomically provisions an isolated detached git worktree and optional sandboxed temp directory.
   * Refuses duplicate concurrent locks for the same `(agentId, branchId)` scope or empty repos.
   */
  public async provisionLease(config: IsolationScopeConfig): Promise<WorktreeLease> {
    const safeAgent = sanitizeSegment(config.agentId, 'agentId')
    const safeBranch = sanitizeSegment(config.branchId, 'branchId')
    const scope: IsolationScope = config.scopeType ?? 'agent'
    const baseRef = (config.baseRef ?? 'HEAD').trim() || 'HEAD'
    const leaseTtlMs = config.leaseTtlMs ?? this.defaultLeaseTtlMs

    if (!Number.isFinite(leaseTtlMs) || leaseTtlMs <= 0) {
      throw new WorktreeIsolationError('leaseTtlMs must be a positive number')
    }

    const lockKey = `${scope}:${safeAgent}:${safeBranch}`
    if (this.pendingLockKeys.has(lockKey) || this.activeLeasesByLockKey.has(lockKey)) {
      throw new WorktreeLockConflictError(lockKey)
    }

    // Reserve lock synchronously before any async git or filesystem operation
    this.pendingLockKeys.add(lockKey)
    const leaseId = randomUUID()
    const shortId = leaseId.slice(0, 8)
    const worktreePath = join(this.worktreeRoot, `${safeBranch}-${safeAgent}-${shortId}`)
    const shouldCreateSandbox = config.createTempSandbox ?? true
    const sandboxTempDir = shouldCreateSandbox
      ? join(this.tempSandboxRoot, `lease-${leaseId}`)
      : null

    try {
      const exec = { cwd: this.repositoryPath }
      let resolvedSha: string
      try {
        const rev = await runGit(['rev-parse', '--verify', `${baseRef}^{commit}`], exec)
        resolvedSha = rev.stdout.trim()
      } catch (error) {
        if (error instanceof GitCommandError) {
          throw new EmptyRepositoryIsolationError(baseRef, this.repositoryPath)
        }
        throw error
      }

      await mkdir(this.worktreeRoot, { recursive: true })
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
      await runGit(['worktree', 'add', '--detach', worktreePath, resolvedSha], exec)

      if (sandboxTempDir !== null) {
        await mkdir(sandboxTempDir, { recursive: true, mode: 0o700 })
        await writeFile(
          join(sandboxTempDir, '.forge-lease.json'),
          JSON.stringify({
            leaseId,
            lockKey,
            agentId: config.agentId,
            branchId: config.branchId,
            scope,
            worktreePath,
            resolvedSha,
            acquiredAtMs: this.clock(),
          }),
          'utf8',
        )
      }

      const now = this.clock()
      const internalLease: InternalLease = {
        leaseId,
        lockKey,
        agentId: config.agentId,
        branchId: config.branchId,
        scope,
        repositoryPath: this.repositoryPath,
        worktreePath,
        sandboxTempDir,
        baseRef,
        resolvedSha,
        lockState: 'ACTIVE',
        acquiredAtMs: now,
        expiresAtMs: now + leaseTtlMs,
        hooks: [],
      }

      this.activeLeasesById.set(leaseId, internalLease)
      this.activeLeasesByLockKey.set(lockKey, internalLease)
      return this.toPublicLease(internalLease)
    } catch (error) {
      await runGit(['worktree', 'remove', '--force', worktreePath], {
        cwd: this.repositoryPath,
      }).catch(() => undefined)
      await rm(worktreePath, { recursive: true, force: true }).catch(() => undefined)
      if (sandboxTempDir !== null) {
        await rm(sandboxTempDir, { recursive: true, force: true }).catch(() => undefined)
      }
      throw error
    } finally {
      this.pendingLockKeys.delete(lockKey)
    }
  }

  /**
   * Lists all git worktrees registered against the repository alongside active sandbox lease metadata.
   */
  public async listWorktrees(): Promise<WorktreeListResult> {
    const now = this.clock()
    const res = await runGit(['worktree', 'list', '--porcelain'], { cwd: this.repositoryPath })

    const activeByPath = new Map<string, InternalLease>()
    for (const lease of this.activeLeasesById.values()) {
      if (lease.lockState === 'ACTIVE' && lease.expiresAtMs <= now) {
        lease.lockState = 'EXPIRED'
      }
      activeByPath.set(resolve(lease.worktreePath), lease)
    }

    const worktrees = this.parsePorcelainWorktrees(res.stdout, activeByPath)
    const activeLeases = Array.from(this.activeLeasesById.values()).map((l) =>
      this.toLeaseSnapshot(l),
    )

    const listDigest = createHash('sha256')
      .update(
        JSON.stringify({
          repositoryPath: this.repositoryPath,
          worktreeRoot: this.worktreeRoot,
          worktrees,
          activeLeases,
        }),
      )
      .digest('hex')

    return {
      repositoryPath: this.repositoryPath,
      worktreeRoot: this.worktreeRoot,
      tempSandboxRoot: this.tempSandboxRoot,
      worktrees,
      activeLeases,
      listDigest,
    }
  }

  /**
   * Releases any active leases whose TTL has elapsed.
   */
  public async reapExpiredLeases(): Promise<WorktreeCleanupReport[]> {
    const now = this.clock()
    const expired = Array.from(this.activeLeasesById.values()).filter(
      (lease) => lease.expiresAtMs <= now,
    )
    const reports: WorktreeCleanupReport[] = []
    for (const lease of expired) {
      lease.lockState = 'EXPIRED'
      reports.push(await this.releaseLease(lease))
    }
    return reports
  }

  /**
   * Reclaims abandoned Forge-managed worktrees left by prior processes via WorktreeService.
   */
  public async reclaimAbandoned(): Promise<void> {
    await this.worktreeService.reclaimAbandoned()
  }

  /**
   * Deterministically releases all active worktree leases and removes empty staging roots.
   */
  public async disposeAll(): Promise<WorktreeCleanupReport[]> {
    const leases = Array.from(this.activeLeasesById.values())
    const reports = await Promise.all(leases.map((lease) => this.releaseLease(lease)))
    await rmdir(this.worktreeRoot).catch(() => undefined)
    await rmdir(this.tempSandboxRoot).catch(() => undefined)
    return reports
  }

  private toLeaseSnapshot(lease: InternalLease): WorktreeLeaseSnapshot {
    return {
      leaseId: lease.leaseId,
      lockKey: lease.lockKey,
      agentId: lease.agentId,
      branchId: lease.branchId,
      scope: lease.scope,
      repositoryPath: lease.repositoryPath,
      worktreePath: lease.worktreePath,
      sandboxTempDir: lease.sandboxTempDir,
      baseRef: lease.baseRef,
      resolvedSha: lease.resolvedSha,
      lockState: lease.lockState,
      acquiredAtMs: lease.acquiredAtMs,
      expiresAtMs: lease.expiresAtMs,
      hookCount: lease.hooks.length,
    }
  }

  private toPublicLease(lease: InternalLease): WorktreeLease {
    return {
      ...this.toLeaseSnapshot(lease),
      registerCleanupHook: (hook: CleanupHook): void => {
        if (lease.lockState !== 'RELEASED' && lease.lockState !== 'RELEASING') {
          lease.hooks.push(hook)
        }
      },
      release: (): Promise<WorktreeCleanupReport> => this.releaseLease(lease),
    }
  }

  private async releaseLease(lease: InternalLease): Promise<WorktreeCleanupReport> {
    if (lease.releasePromise) {
      return lease.releasePromise
    }

    lease.releasePromise = (async (): Promise<WorktreeCleanupReport> => {
      const startMs = this.clock()
      lease.lockState = 'RELEASING'
      const snapshot = this.toLeaseSnapshot(lease)
      const hookErrors: string[] = []
      let hooksExecuted = 0

      // Execute registered cleanup hooks in LIFO order before removing filesystem state
      for (let i = lease.hooks.length - 1; i >= 0; i--) {
        const hook = lease.hooks[i]
        if (!hook) {
          continue
        }
        hooksExecuted++
        try {
          await hook(snapshot)
        } catch (err) {
          hookErrors.push(err instanceof Error ? err.message : String(err))
        }
      }

      const exec = { cwd: this.repositoryPath }
      await runGit(['worktree', 'remove', '--force', lease.worktreePath], exec).catch(
        () => undefined,
      )
      await rm(lease.worktreePath, { recursive: true, force: true }).catch(() => undefined)
      await runGit(['worktree', 'prune'], exec).catch(() => undefined)

      let tempSandboxRemoved = false
      if (lease.sandboxTempDir !== null) {
        await rm(lease.sandboxTempDir, { recursive: true, force: true }).catch(() => undefined)
        tempSandboxRemoved = true
      }

      this.activeLeasesById.delete(lease.leaseId)
      if (this.activeLeasesByLockKey.get(lease.lockKey) === lease) {
        this.activeLeasesByLockKey.delete(lease.lockKey)
      }
      lease.lockState = 'RELEASED'

      return {
        leaseId: lease.leaseId,
        worktreeRemoved: true,
        tempSandboxRemoved,
        cleanupHooksExecuted: hooksExecuted,
        hookErrors,
        durationMs: Math.max(0, this.clock() - startMs),
      }
    })()

    return lease.releasePromise
  }

  private parsePorcelainWorktrees(
    stdout: string,
    activeByPath: ReadonlyMap<string, InternalLease>,
  ): WorktreeInventoryEntry[] {
    const entries: WorktreeInventoryEntry[] = []
    const blocks = stdout.replace(/\r\n/g, '\n').trim().split(/\n\n+/)

    for (const block of blocks) {
      if (block.trim() === '') {
        continue
      }
      const lines = block.split('\n')
      let path = ''
      let headSha: string | null = null
      let branch: string | null = null
      let detached = false
      let bare = false
      let locked = false
      let prunable = false

      for (const rawLine of lines) {
        const line = rawLine.trim()
        if (line.startsWith('worktree ')) {
          path = line.slice('worktree '.length).trim()
        } else if (line.startsWith('HEAD ')) {
          headSha = line.slice('HEAD '.length).trim()
        } else if (line.startsWith('branch ')) {
          branch = line.slice('branch '.length).trim()
        } else if (line === 'detached') {
          detached = true
        } else if (line === 'bare') {
          bare = true
        } else if (line === 'locked' || line.startsWith('locked ')) {
          locked = true
        } else if (line === 'prunable' || line.startsWith('prunable ')) {
          prunable = true
        }
      }

      if (path === '') {
        continue
      }

      const resolvedPath = resolve(path)
      const activeLease = activeByPath.get(resolvedPath)
      const managedByForge = activeLease !== undefined || isSubpath(this.worktreeRoot, resolvedPath)

      entries.push({
        path: resolvedPath,
        headSha,
        branch,
        detached,
        bare,
        locked,
        prunable,
        managedByForge,
        leaseId: activeLease?.leaseId ?? null,
        agentId: activeLease?.agentId ?? null,
      })
    }

    return entries
  }
}
