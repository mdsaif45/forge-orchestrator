import { describe, expect, it, vi } from 'vitest'
import {
  computeSavepointChecksum,
  DefaultGitTreeSnapshotProvider,
  SavepointIntegrityError,
  SavepointNotFoundError,
  WorkflowTransactionalSavepointArbiter,
  type GitTreeSnapshotProvider,
} from './workflowTransactionalSavepointArbiter'

describe('WorkflowTransactionalSavepointArbiter (WORK-040)', () => {
  it('creates transactional savepoints with shadow git checkpoint refs and SHA-256 checksums', async () => {
    const arbiter = new WorkflowTransactionalSavepointArbiter()

    const manifest = await arbiter.createSavepoint({
      workflowId: 'wf-test-1',
      runId: 'run-alpha',
      turnIndex: 1,
      label: 'Initial feature turn',
      completedNodeIds: ['node-init', 'node-parse'],
      nodeSnapshots: [
        { nodeId: 'node-init', status: 'COMPLETED' },
        { nodeId: 'node-parse', status: 'COMPLETED', output: { tokens: 42 } },
      ],
      contextVariables: { branch: 'main', step: 1 },
    })

    expect(manifest.savepointId).toMatch(/^sp-run-alpha-turn-1-/)
    expect(manifest.checkpointRef.refName).toBe(
      `refs/forge/checkpoints/run-alpha/${manifest.savepointId}`,
    )
    expect(manifest.checkpointRef.commitSha).toHaveLength(40)
    expect(manifest.checkpointRef.treeSha).toHaveLength(40)
    expect(manifest.completedNodeIds).toEqual(['node-init', 'node-parse'])
    expect(manifest.contextVariables).toEqual({ branch: 'main', step: 1 })
    expect(manifest.checksum).toHaveLength(64)

    const verification = await arbiter.verifySavepoint(manifest.savepointId)
    expect(verification.valid).toBe(true)
    expect(verification.reason).toBeUndefined()
  })

  it('detects manifest tampering and ref mismatch during verification (fail-closed A2)', async () => {
    const arbiter = new WorkflowTransactionalSavepointArbiter()

    const manifest = await arbiter.createSavepoint({
      workflowId: 'wf-test-2',
      runId: 'run-beta',
      turnIndex: 1,
      completedNodeIds: ['node-setup'],
      nodeSnapshots: [{ nodeId: 'node-setup', status: 'COMPLETED' }],
      contextVariables: { count: 10 },
    })

    // Alter completedNodeIds without updating checksum
    const tamperedChecksum = computeSavepointChecksum(
      manifest.savepointId,
      manifest.workflowId,
      manifest.runId,
      manifest.turnIndex,
      manifest.checkpointRef.commitSha,
      ['node-setup', 'node-malicious-injected'],
      manifest.contextVariables,
    )
    expect(tamperedChecksum).not.toBe(manifest.checksum)

    // Test with mock provider that reports missing ref
    const mockProvider: GitTreeSnapshotProvider = {
      createTreeSnapshot: vi.fn().mockResolvedValue({
        treeSha: 'a'.repeat(40),
        commitSha: 'b'.repeat(40),
      }),
      updateRef: vi.fn().mockResolvedValue(undefined),
      restoreTreeSnapshot: vi.fn().mockResolvedValue(undefined),
      deleteRef: vi.fn().mockResolvedValue(undefined),
      verifyRef: vi.fn().mockResolvedValue(false), // Git ref missing!
    }

    const arbiterWithMissingRef = new WorkflowTransactionalSavepointArbiter({
      gitProvider: mockProvider,
    })

    const sp = await arbiterWithMissingRef.createSavepoint({
      workflowId: 'wf-test-2',
      runId: 'run-beta',
      turnIndex: 1,
      completedNodeIds: ['node-setup'],
      nodeSnapshots: [{ nodeId: 'node-setup', status: 'COMPLETED' }],
    })

    const verifyResult = await arbiterWithMissingRef.verifySavepoint(sp.savepointId)
    expect(verifyResult.valid).toBe(false)
    expect(verifyResult.reason).toContain('is missing or invalid in repository')
  })

  it('rewinds multi-turn execution safely, reverting intervening DAG nodes and restoring context', async () => {
    const restoreSpy = vi.fn().mockResolvedValue(undefined)
    const deleteSpy = vi.fn().mockResolvedValue(undefined)

    const mockProvider: GitTreeSnapshotProvider = {
      createTreeSnapshot: vi
        .fn<GitTreeSnapshotProvider['createTreeSnapshot']>()
        .mockImplementation((_repo: string | undefined, msg: string) => {
          const id = msg.includes('turn:1') ? '1'.repeat(40) : '2'.repeat(40)
          return Promise.resolve({ treeSha: id, commitSha: id })
        }),
      updateRef: vi.fn().mockResolvedValue(undefined),
      restoreTreeSnapshot: restoreSpy,
      deleteRef: deleteSpy,
      verifyRef: vi.fn().mockResolvedValue(true),
    }

    const arbiter = new WorkflowTransactionalSavepointArbiter({ gitProvider: mockProvider })

    const sp1 = await arbiter.createSavepoint({
      workflowId: 'wf-multi-turn',
      runId: 'run-gamma',
      turnIndex: 1,
      label: 'Good state turn 1',
      completedNodeIds: ['node-1'],
      nodeSnapshots: [{ nodeId: 'node-1', status: 'COMPLETED' }],
      contextVariables: { stage: 'init', health: 'nominal' },
    })

    const sp2 = await arbiter.createSavepoint({
      workflowId: 'wf-multi-turn',
      runId: 'run-gamma',
      turnIndex: 2,
      label: 'Flawed state turn 2',
      completedNodeIds: ['node-1', 'node-2', 'node-3'],
      nodeSnapshots: [
        { nodeId: 'node-1', status: 'COMPLETED' },
        { nodeId: 'node-2', status: 'COMPLETED' },
        { nodeId: 'node-3', status: 'COMPLETED' },
      ],
      contextVariables: { stage: 'corrupted', health: 'degraded' },
    })

    expect(arbiter.listSavepoints('run-gamma')).toHaveLength(2)

    // Execute rewind to sp1
    const rewindResult = await arbiter.rewindToSavepoint({
      targetSavepointId: sp1.savepointId,
      purgeDescendantSavepoints: true,
    })

    expect(rewindResult.success).toBe(true)
    expect(rewindResult.targetSavepointId).toBe(sp1.savepointId)
    expect(rewindResult.restoredRunId).toBe('run-gamma')
    expect(rewindResult.restoredTurnIndex).toBe(1)
    expect(rewindResult.restoredCommitSha).toBe(sp1.checkpointRef.commitSha)
    expect(rewindResult.activeNodeIds).toEqual(['node-1'])
    // node-2 and node-3 should be marked as reverted
    expect(rewindResult.revertedNodeIds).toContain('node-2')
    expect(rewindResult.revertedNodeIds).toContain('node-3')
    expect(rewindResult.restoredContextVariables).toEqual({ stage: 'init', health: 'nominal' })
    expect(rewindResult.purgedSavepoints).toEqual([sp2.savepointId])

    // Verify git restore and purge calls
    expect(restoreSpy).toHaveBeenCalledWith(undefined, sp1.checkpointRef.commitSha)
    expect(deleteSpy).toHaveBeenCalledWith(undefined, sp2.checkpointRef.refName)

    // sp2 should no longer exist in ledger
    expect(arbiter.getSavepoint(sp2.savepointId)).toBeUndefined()
    expect(arbiter.listSavepoints('run-gamma')).toHaveLength(1)
  })

  it('supports preserving descendant savepoints when purgeDescendantSavepoints is false', async () => {
    const arbiter = new WorkflowTransactionalSavepointArbiter()

    const sp1 = await arbiter.createSavepoint({
      workflowId: 'wf-keep',
      runId: 'run-delta',
      turnIndex: 1,
      completedNodeIds: ['node-1'],
      nodeSnapshots: [{ nodeId: 'node-1', status: 'COMPLETED' }],
    })

    const sp2 = await arbiter.createSavepoint({
      workflowId: 'wf-keep',
      runId: 'run-delta',
      turnIndex: 2,
      completedNodeIds: ['node-1', 'node-2'],
      nodeSnapshots: [
        { nodeId: 'node-1', status: 'COMPLETED' },
        { nodeId: 'node-2', status: 'COMPLETED' },
      ],
    })

    const res = await arbiter.rewindToSavepoint({
      targetSavepointId: sp1.savepointId,
      purgeDescendantSavepoints: false,
    })

    expect(res.purgedSavepoints).toEqual([])
    expect(arbiter.getSavepoint(sp2.savepointId)).toBeDefined()
    expect(arbiter.listSavepoints('run-delta')).toHaveLength(2)
  })

  it('throws SavepointNotFoundError when target savepoint does not exist', async () => {
    const arbiter = new WorkflowTransactionalSavepointArbiter()

    await expect(
      arbiter.rewindToSavepoint({ targetSavepointId: 'sp-nonexistent' }),
    ).rejects.toThrow(SavepointNotFoundError)
  })

  it('throws SavepointIntegrityError when savepoint is corrupted unless force is true', async () => {
    const mockProvider: GitTreeSnapshotProvider = {
      createTreeSnapshot: vi.fn().mockResolvedValue({
        treeSha: 'c'.repeat(40),
        commitSha: 'd'.repeat(40),
      }),
      updateRef: vi.fn().mockResolvedValue(undefined),
      restoreTreeSnapshot: vi.fn().mockResolvedValue(undefined),
      deleteRef: vi.fn().mockResolvedValue(undefined),
      verifyRef: vi.fn().mockResolvedValue(false), // Corrupted ref
    }

    const arbiter = new WorkflowTransactionalSavepointArbiter({ gitProvider: mockProvider })
    const sp = await arbiter.createSavepoint({
      workflowId: 'wf-corrupt',
      runId: 'run-epsilon',
      turnIndex: 1,
      completedNodeIds: ['node-1'],
      nodeSnapshots: [{ nodeId: 'node-1', status: 'COMPLETED' }],
    })

    // Normal rewind fails closed
    await expect(
      arbiter.rewindToSavepoint({ targetSavepointId: sp.savepointId, force: false }),
    ).rejects.toThrow(SavepointIntegrityError)

    // Force rewind bypasses verification
    const res = await arbiter.rewindToSavepoint({
      targetSavepointId: sp.savepointId,
      force: true,
    })
    expect(res.success).toBe(true)
  })

  it('evaluates savepoints and reports timeline, verified targets, and integrity status', async () => {
    const arbiter = new WorkflowTransactionalSavepointArbiter()

    await arbiter.createSavepoint({
      workflowId: 'wf-eval',
      runId: 'run-eval-1',
      turnIndex: 1,
      label: 'Setup phase',
      completedNodeIds: ['init'],
      nodeSnapshots: [{ nodeId: 'init', status: 'COMPLETED' }],
    })

    await arbiter.createSavepoint({
      workflowId: 'wf-eval',
      runId: 'run-eval-1',
      turnIndex: 2,
      label: 'Build phase',
      completedNodeIds: ['init', 'build'],
      nodeSnapshots: [
        { nodeId: 'init', status: 'COMPLETED' },
        { nodeId: 'build', status: 'COMPLETED' },
      ],
    })

    const evaluation = await arbiter.evaluateSavepoints('wf-eval', 'run-eval-1')
    expect(evaluation.workflowId).toBe('wf-eval')
    expect(evaluation.runId).toBe('run-eval-1')
    expect(evaluation.totalSavepoints).toBe(2)
    expect(evaluation.canRewind).toBe(true)
    expect(evaluation.availableRewindTargets).toHaveLength(2)
    expect(evaluation.integrityIssues).toHaveLength(0)
    expect(evaluation.savepoints[0]?.completedNodesCount).toBe(1)
    expect(evaluation.savepoints[1]?.completedNodesCount).toBe(2)
  })

  it('supports deletion of individual savepoints and ledger clearing', async () => {
    const arbiter = new WorkflowTransactionalSavepointArbiter()

    const sp = await arbiter.createSavepoint({
      workflowId: 'wf-del',
      runId: 'run-del',
      turnIndex: 1,
      completedNodeIds: ['a'],
      nodeSnapshots: [{ nodeId: 'a', status: 'COMPLETED' }],
    })

    expect(arbiter.listSavepoints('run-del')).toHaveLength(1)
    const deleted = await arbiter.deleteSavepoint(sp.savepointId)
    expect(deleted).toBe(true)
    expect(arbiter.listSavepoints('run-del')).toHaveLength(0)

    // Idempotent delete on non-existent
    const deleteAgain = await arbiter.deleteSavepoint(sp.savepointId)
    expect(deleteAgain).toBe(false)
  })

  it('uses DefaultGitTreeSnapshotProvider fallback when repositoryPath is unset', async () => {
    const provider = new DefaultGitTreeSnapshotProvider()
    const snapshot = await provider.createTreeSnapshot(undefined, 'test snapshot')
    expect(snapshot.treeSha).toHaveLength(40)
    expect(snapshot.commitSha).toHaveLength(40)

    await expect(
      provider.updateRef(undefined, 'refs/test', snapshot.commitSha),
    ).resolves.not.toThrow()
    await expect(provider.restoreTreeSnapshot(undefined, snapshot.commitSha)).resolves.not.toThrow()
    await expect(provider.deleteRef(undefined, 'refs/test')).resolves.not.toThrow()
    const verified = await provider.verifyRef(undefined, 'refs/test')
    expect(verified).toBe(true)
  })
})
