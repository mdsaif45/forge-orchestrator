/**
 * WORK-040: Workflow Transactional Savepoint and Rewind Arbiter.
 *
 * Coordinates turn-level transactional git checkpoints (refs/forge/checkpoints/<runId>/<savepointId>)
 * allowing multi-stage workflow graphs to rewind safely to known good states with
 * cryptographic integrity verification and DAG state restoration (Axioms A1, A2, A5).
 */

import { createHash, randomUUID } from 'node:crypto'
import { runGit } from '../git/exec'

export type NodeExecutionStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED'

export interface CheckpointReference {
  readonly refName: string
  readonly commitSha: string
  readonly treeSha: string
  readonly parentSha?: string | undefined
  readonly createdAt: number
}

export interface NodeExecutionSnapshot {
  readonly nodeId: string
  readonly status: NodeExecutionStatus
  readonly output?: unknown
  readonly completedAt?: number | undefined
  readonly metadata?: Record<string, unknown> | undefined
}

export interface SavepointManifest {
  readonly savepointId: string
  readonly workflowId: string
  readonly runId: string
  readonly turnIndex: number
  readonly label: string
  readonly timestamp: number
  readonly checkpointRef: CheckpointReference
  readonly completedNodeIds: readonly string[]
  readonly nodeSnapshots: readonly NodeExecutionSnapshot[]
  readonly contextVariables: Record<string, unknown>
  readonly metadata?: Record<string, unknown> | undefined
  readonly checksum: string
}

export interface CreateSavepointOptions {
  readonly workflowId: string
  readonly runId: string
  readonly turnIndex: number
  readonly label?: string | undefined
  readonly completedNodeIds: readonly string[]
  readonly nodeSnapshots: readonly NodeExecutionSnapshot[]
  readonly contextVariables?: Record<string, unknown> | undefined
  readonly metadata?: Record<string, unknown> | undefined
  readonly workingTreeSha?: string | undefined
  readonly parentCommitSha?: string | undefined
}

export interface RewindOptions {
  readonly targetSavepointId: string
  readonly purgeDescendantSavepoints?: boolean | undefined
  readonly force?: boolean | undefined
}

export interface RewindResult {
  readonly success: boolean
  readonly targetSavepointId: string
  readonly restoredRunId: string
  readonly restoredTurnIndex: number
  readonly restoredCheckpointRef: string
  readonly restoredCommitSha: string
  readonly revertedNodeIds: readonly string[]
  readonly activeNodeIds: readonly string[]
  readonly restoredContextVariables: Record<string, unknown>
  readonly purgedSavepoints: readonly string[]
  readonly durationMs: number
  readonly error?: string | undefined
}

export interface SavepointSummary {
  readonly savepointId: string
  readonly workflowId: string
  readonly runId: string
  readonly turnIndex: number
  readonly label: string
  readonly timestamp: number
  readonly refName: string
  readonly commitSha: string
  readonly completedNodesCount: number
  readonly verified: boolean
}

export interface SavepointEvaluationResult {
  readonly workflowId: string
  readonly runId: string
  readonly totalSavepoints: number
  readonly latestSavepointId?: string | undefined
  readonly savepoints: readonly SavepointSummary[]
  readonly canRewind: boolean
  readonly availableRewindTargets: readonly string[]
  readonly integrityIssues: readonly string[]
}

export class SavepointNotFoundError extends Error {
  constructor(savepointId: string) {
    super(`Workflow savepoint not found: "${savepointId}"`)
    this.name = 'SavepointNotFoundError'
  }
}

export class SavepointIntegrityError extends Error {
  constructor(savepointId: string, details: string) {
    super(`Workflow savepoint integrity check failed for "${savepointId}": ${details}`)
    this.name = 'SavepointIntegrityError'
  }
}

export class SavepointLinearityViolationError extends Error {
  constructor(message: string) {
    super(`Savepoint linearity violation: ${message}`)
    this.name = 'SavepointLinearityViolationError'
  }
}

export class SavepointGitOperationError extends Error {
  constructor(message: string) {
    super(`Savepoint git operation error: ${message}`)
    this.name = 'SavepointGitOperationError'
  }
}

export interface GitTreeSnapshotProvider {
  createTreeSnapshot(
    repoPath: string | undefined,
    message: string,
    parentCommit?: string,
  ): Promise<{ treeSha: string; commitSha: string }>
  updateRef(repoPath: string | undefined, refName: string, commitSha: string): Promise<void>
  restoreTreeSnapshot(repoPath: string | undefined, commitSha: string): Promise<void>
  deleteRef(repoPath: string | undefined, refName: string): Promise<void>
  verifyRef(repoPath: string | undefined, refName: string): Promise<boolean>
}

export class DefaultGitTreeSnapshotProvider implements GitTreeSnapshotProvider {
  constructor(private readonly repositoryPath?: string | undefined) {}

  async createTreeSnapshot(
    repoPath: string | undefined,
    message: string,
    parentCommit?: string,
  ): Promise<{ treeSha: string; commitSha: string }> {
    const cwd = repoPath ?? this.repositoryPath
    if (cwd) {
      try {
        const { stdout: treeShaRaw } = await runGit(['write-tree'], { cwd })
        const treeSha = treeShaRaw.trim()
        const commitArgs = ['commit-tree', treeSha, '-m', message]
        if (parentCommit) {
          commitArgs.push('-p', parentCommit)
        }
        const { stdout: commitShaRaw } = await runGit(commitArgs, { cwd })
        const commitSha = commitShaRaw.trim()
        return { treeSha, commitSha }
      } catch (err) {
        throw new SavepointGitOperationError(
          `Failed to create git tree snapshot: ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }

    const pseudoHash = createHash('sha256')
      .update(`${message}:${String(Date.now())}:${parentCommit ?? 'root'}`)
      .digest('hex')
    return {
      treeSha: pseudoHash.slice(0, 40),
      commitSha: pseudoHash.slice(20, 60),
    }
  }

  async updateRef(repoPath: string | undefined, refName: string, commitSha: string): Promise<void> {
    const cwd = repoPath ?? this.repositoryPath
    if (cwd) {
      try {
        await runGit(['update-ref', refName, commitSha], { cwd })
      } catch (err) {
        throw new SavepointGitOperationError(
          `Failed to update git ref "${refName}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  async restoreTreeSnapshot(repoPath: string | undefined, commitSha: string): Promise<void> {
    const cwd = repoPath ?? this.repositoryPath
    if (cwd) {
      try {
        await runGit(['read-tree', '-u', '--reset', commitSha], { cwd })
      } catch (err) {
        throw new SavepointGitOperationError(
          `Failed to restore git snapshot "${commitSha}": ${err instanceof Error ? err.message : String(err)}`,
        )
      }
    }
  }

  async deleteRef(repoPath: string | undefined, refName: string): Promise<void> {
    const cwd = repoPath ?? this.repositoryPath
    if (cwd) {
      try {
        await runGit(['update-ref', '-d', refName], { cwd })
      } catch {
        // Safe no-op if ref does not exist
      }
    }
  }

  async verifyRef(repoPath: string | undefined, refName: string): Promise<boolean> {
    const cwd = repoPath ?? this.repositoryPath
    if (cwd) {
      try {
        const { stdout } = await runGit(['rev-parse', '--verify', refName], { cwd })
        return stdout.trim().length === 40
      } catch {
        return false
      }
    }
    return true
  }
}

export function computeSavepointChecksum(
  savepointId: string,
  workflowId: string,
  runId: string,
  turnIndex: number,
  commitSha: string,
  completedNodeIds: readonly string[],
  contextVariables: Record<string, unknown>,
): string {
  const sortedCompleted = [...completedNodeIds].sort().join(',')
  const sortedVars = JSON.stringify(contextVariables, Object.keys(contextVariables).sort())
  const payload = `${savepointId}:${workflowId}:${runId}:${String(turnIndex)}:${commitSha}:${sortedCompleted}:${sortedVars}`
  return createHash('sha256').update(payload).digest('hex')
}

export interface ArbiterConfig {
  readonly repositoryPath?: string | undefined
  readonly gitProvider?: GitTreeSnapshotProvider | undefined
}

export class WorkflowTransactionalSavepointArbiter {
  private readonly repositoryPath?: string | undefined
  private readonly gitProvider: GitTreeSnapshotProvider
  private readonly savepointsById = new Map<string, SavepointManifest>()
  private readonly runSavepoints = new Map<string, string[]>()

  constructor(config: ArbiterConfig = {}) {
    this.repositoryPath = config.repositoryPath
    this.gitProvider =
      config.gitProvider ?? new DefaultGitTreeSnapshotProvider(config.repositoryPath)
  }

  async createSavepoint(options: CreateSavepointOptions): Promise<SavepointManifest> {
    const savepointId = `sp-${options.runId}-turn-${String(options.turnIndex)}-${randomUUID().slice(0, 8)}`
    const refName = `refs/forge/checkpoints/${options.runId}/${savepointId}`
    const label = options.label ?? `Turn ${String(options.turnIndex)} savepoint`
    const timestamp = Date.now()
    const contextVariables = { ...(options.contextVariables ?? {}) }

    const snapshot = options.workingTreeSha
      ? {
          treeSha: options.workingTreeSha,
          commitSha:
            options.parentCommitSha ??
            createHash('sha256').update(options.workingTreeSha).digest('hex').slice(0, 40),
        }
      : await this.gitProvider.createTreeSnapshot(
          this.repositoryPath,
          `forge savepoint: ${label} [run:${options.runId} turn:${String(options.turnIndex)}]`,
          options.parentCommitSha,
        )

    await this.gitProvider.updateRef(this.repositoryPath, refName, snapshot.commitSha)

    const checkpointRef: CheckpointReference = {
      refName,
      commitSha: snapshot.commitSha,
      treeSha: snapshot.treeSha,
      ...(options.parentCommitSha ? { parentSha: options.parentCommitSha } : {}),
      createdAt: timestamp,
    }

    const checksum = computeSavepointChecksum(
      savepointId,
      options.workflowId,
      options.runId,
      options.turnIndex,
      snapshot.commitSha,
      options.completedNodeIds,
      contextVariables,
    )

    const manifest: SavepointManifest = {
      savepointId,
      workflowId: options.workflowId,
      runId: options.runId,
      turnIndex: options.turnIndex,
      label,
      timestamp,
      checkpointRef,
      completedNodeIds: [...options.completedNodeIds],
      nodeSnapshots: [...options.nodeSnapshots],
      contextVariables,
      ...(options.metadata ? { metadata: { ...options.metadata } } : {}),
      checksum,
    }

    this.savepointsById.set(savepointId, manifest)

    let runList = this.runSavepoints.get(options.runId)
    if (!runList) {
      runList = []
      this.runSavepoints.set(options.runId, runList)
    }
    runList.push(savepointId)

    return manifest
  }

  async verifySavepoint(
    savepointId: string,
  ): Promise<{ valid: boolean; reason?: string | undefined }> {
    const savepoint = this.savepointsById.get(savepointId)
    if (!savepoint) {
      return { valid: false, reason: `Savepoint "${savepointId}" not found in ledger` }
    }

    const expectedChecksum = computeSavepointChecksum(
      savepoint.savepointId,
      savepoint.workflowId,
      savepoint.runId,
      savepoint.turnIndex,
      savepoint.checkpointRef.commitSha,
      savepoint.completedNodeIds,
      savepoint.contextVariables,
    )

    if (savepoint.checksum !== expectedChecksum) {
      return {
        valid: false,
        reason: 'Checksum mismatch: savepoint manifest has been modified or corrupted',
      }
    }

    const refValid = await this.gitProvider.verifyRef(
      this.repositoryPath,
      savepoint.checkpointRef.refName,
    )
    if (!refValid) {
      return {
        valid: false,
        reason: `Git checkpoint ref "${savepoint.checkpointRef.refName}" is missing or invalid in repository`,
      }
    }

    return { valid: true }
  }

  async rewindToSavepoint(options: RewindOptions): Promise<RewindResult> {
    const startTime = Date.now()
    const target = this.savepointsById.get(options.targetSavepointId)
    if (!target) {
      throw new SavepointNotFoundError(options.targetSavepointId)
    }

    if (!options.force) {
      const verification = await this.verifySavepoint(options.targetSavepointId)
      if (!verification.valid) {
        throw new SavepointIntegrityError(
          options.targetSavepointId,
          verification.reason ?? 'Integrity check failed',
        )
      }
    }

    const runSavepointIds = this.runSavepoints.get(target.runId) ?? []
    const allRunSavepoints = runSavepointIds
      .map((id) => this.savepointsById.get(id))
      .filter((sp): sp is SavepointManifest => sp !== undefined)
      .sort((a, b) => a.turnIndex - b.turnIndex)

    const descendantSavepoints = allRunSavepoints.filter((sp) => sp.turnIndex > target.turnIndex)
    const targetCompletedSet = new Set(target.completedNodeIds)

    const allSeenCompleted = new Set<string>()
    for (const sp of allRunSavepoints) {
      for (const id of sp.completedNodeIds) {
        allSeenCompleted.add(id)
      }
    }

    const revertedNodeIds: string[] = []
    for (const id of allSeenCompleted) {
      if (!targetCompletedSet.has(id)) {
        revertedNodeIds.push(id)
      }
    }

    await this.gitProvider.restoreTreeSnapshot(this.repositoryPath, target.checkpointRef.commitSha)

    const purgeDescendants = options.purgeDescendantSavepoints ?? true
    const purgedSavepoints: string[] = []

    if (purgeDescendants) {
      for (const desc of descendantSavepoints) {
        await this.gitProvider.deleteRef(this.repositoryPath, desc.checkpointRef.refName)
        this.savepointsById.delete(desc.savepointId)
        purgedSavepoints.push(desc.savepointId)
      }
      this.runSavepoints.set(
        target.runId,
        runSavepointIds.filter((id) => !purgedSavepoints.includes(id)),
      )
    }

    const durationMs = Date.now() - startTime

    return {
      success: true,
      targetSavepointId: target.savepointId,
      restoredRunId: target.runId,
      restoredTurnIndex: target.turnIndex,
      restoredCheckpointRef: target.checkpointRef.refName,
      restoredCommitSha: target.checkpointRef.commitSha,
      revertedNodeIds,
      activeNodeIds: [...target.completedNodeIds],
      restoredContextVariables: { ...target.contextVariables },
      purgedSavepoints,
      durationMs,
    }
  }

  getSavepoint(savepointId: string): SavepointManifest | undefined {
    return this.savepointsById.get(savepointId)
  }

  listSavepoints(runId: string): readonly SavepointManifest[] {
    const ids = this.runSavepoints.get(runId) ?? []
    return ids
      .map((id) => this.savepointsById.get(id))
      .filter((sp): sp is SavepointManifest => sp !== undefined)
      .sort((a, b) => a.turnIndex - b.turnIndex)
  }

  async evaluateSavepoints(workflowId: string, runId: string): Promise<SavepointEvaluationResult> {
    const savepoints = this.listSavepoints(runId)
    const summaries: SavepointSummary[] = []
    const integrityIssues: string[] = []

    for (const sp of savepoints) {
      const verification = await this.verifySavepoint(sp.savepointId)
      if (!verification.valid && verification.reason) {
        integrityIssues.push(`[${sp.savepointId}] ${verification.reason}`)
      }
      summaries.push({
        savepointId: sp.savepointId,
        workflowId: sp.workflowId,
        runId: sp.runId,
        turnIndex: sp.turnIndex,
        label: sp.label,
        timestamp: sp.timestamp,
        refName: sp.checkpointRef.refName,
        commitSha: sp.checkpointRef.commitSha,
        completedNodesCount: sp.completedNodeIds.length,
        verified: verification.valid,
      })
    }

    const verifiedSavepoints = summaries.filter((s) => s.verified)
    const latestSavepoint = summaries.length > 0 ? summaries[summaries.length - 1] : undefined

    return {
      workflowId,
      runId,
      totalSavepoints: summaries.length,
      ...(latestSavepoint ? { latestSavepointId: latestSavepoint.savepointId } : {}),
      savepoints: summaries,
      canRewind: verifiedSavepoints.length > 0,
      availableRewindTargets: verifiedSavepoints.map((s) => s.savepointId),
      integrityIssues,
    }
  }

  async deleteSavepoint(savepointId: string): Promise<boolean> {
    const sp = this.savepointsById.get(savepointId)
    if (!sp) return false

    await this.gitProvider.deleteRef(this.repositoryPath, sp.checkpointRef.refName)
    this.savepointsById.delete(savepointId)

    const runList = this.runSavepoints.get(sp.runId)
    if (runList) {
      this.runSavepoints.set(
        sp.runId,
        runList.filter((id) => id !== savepointId),
      )
    }

    return true
  }

  clear(): void {
    this.savepointsById.clear()
    this.runSavepoints.clear()
  }
}
