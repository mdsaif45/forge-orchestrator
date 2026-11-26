import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../test/tempDir'
import {
  EmptyRepositoryIsolationError,
  WorktreeIsolationError,
  WorktreeIsolationManager,
  WorktreeLockConflictError,
} from './worktreeIsolationManager'

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' })

const makeCommittedRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-par002-repo-'))
  git(dir, ['init', '--quiet'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'shared.txt'), 'baseline\n', 'utf8')
  git(dir, ['add', '.'])
  git(dir, ['commit', '--quiet', '-m', 'initial'])
  return dir
}

describe('WorktreeIsolationManager (PAR-002)', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await removeTempDir(dir)
    }
  })

  it('provisions isolated parallel worktrees and temp sandboxes with zero cross-contamination', async () => {
    const repo = makeCommittedRepo()
    const wtRoot = mkdtempSync(join(tmpdir(), 'forge-par002-wt-'))
    const tmpRoot = mkdtempSync(join(tmpdir(), 'forge-par002-tmp-'))
    tempDirs.push(repo, wtRoot, tmpRoot)

    const manager = new WorktreeIsolationManager({
      repositoryPath: repo,
      worktreeRoot: wtRoot,
      tempSandboxRoot: tmpRoot,
    })

    const leases = await Promise.all([
      manager.provisionLease({ agentId: 'agent-a', branchId: 'branch-1', scopeType: 'agent' }),
      manager.provisionLease({ agentId: 'agent-b', branchId: 'branch-2', scopeType: 'agent' }),
      manager.provisionLease({ agentId: 'agent-c', branchId: 'branch-3', scopeType: 'agent' }),
    ])

    expect(leases).toHaveLength(3)
    const [leaseA, leaseB, leaseC] = leases
    expect(leaseA.worktreePath).not.toBe(leaseB.worktreePath)
    expect(leaseB.worktreePath).not.toBe(leaseC.worktreePath)
    expect(leaseA.sandboxTempDir).toBeTruthy()
    expect(leaseA.sandboxTempDir).not.toBe(leaseB.sandboxTempDir)

    // Parallel edits on the exact same filename inside each isolated worktree never collide
    writeFileSync(join(leaseA.worktreePath, 'shared.txt'), 'modified-by-A\n', 'utf8')
    writeFileSync(join(leaseB.worktreePath, 'shared.txt'), 'modified-by-B\n', 'utf8')
    writeFileSync(join(leaseC.worktreePath, 'shared.txt'), 'modified-by-C\n', 'utf8')

    expect(readFileSync(join(leaseA.worktreePath, 'shared.txt'), 'utf8')).toBe('modified-by-A\n')
    expect(readFileSync(join(leaseB.worktreePath, 'shared.txt'), 'utf8')).toBe('modified-by-B\n')
    expect(readFileSync(join(leaseC.worktreePath, 'shared.txt'), 'utf8')).toBe('modified-by-C\n')
    // Main repository working tree remains untouched
    expect(readFileSync(join(repo, 'shared.txt'), 'utf8')).toBe('baseline\n')

    const listed = await manager.listWorktrees()
    expect(listed.activeLeases).toHaveLength(3)
    expect(listed.worktrees.filter((w) => w.managedByForge)).toHaveLength(3)
    expect(listed.listDigest).toHaveLength(64)

    await manager.disposeAll()

    for (const lease of leases) {
      expect(existsSync(lease.worktreePath)).toBe(false)
      if (lease.sandboxTempDir) {
        expect(existsSync(lease.sandboxTempDir)).toBe(false)
      }
    }
    const postClean = await manager.listWorktrees()
    expect(postClean.activeLeases).toHaveLength(0)
    expect(postClean.worktrees.filter((w) => w.managedByForge)).toHaveLength(0)
  })

  it('rejects duplicate concurrent lock scopes and executes cleanup hooks deterministically', async () => {
    const repo = makeCommittedRepo()
    const wtRoot = mkdtempSync(join(tmpdir(), 'forge-par002-wt-'))
    const tmpRoot = mkdtempSync(join(tmpdir(), 'forge-par002-tmp-'))
    tempDirs.push(repo, wtRoot, tmpRoot)

    const manager = new WorktreeIsolationManager({
      repositoryPath: repo,
      worktreeRoot: wtRoot,
      tempSandboxRoot: tmpRoot,
    })

    const lease = await manager.provisionLease({
      agentId: 'worker-1',
      branchId: 'feat-lock',
      scopeType: 'branch',
    })

    await expect(
      manager.provisionLease({
        agentId: 'worker-1',
        branchId: 'feat-lock',
        scopeType: 'branch',
      }),
    ).rejects.toThrow(WorktreeLockConflictError)

    const callOrder: string[] = []
    lease.registerCleanupHook(() => {
      callOrder.push('first')
    })
    lease.registerCleanupHook(() => {
      callOrder.push('second')
      throw new Error('non-fatal hook error')
    })

    const report = await lease.release()
    expect(callOrder).toEqual(['second', 'first'])
    expect(report.cleanupHooksExecuted).toBe(2)
    expect(report.hookErrors).toEqual(['non-fatal hook error'])
    expect(report.worktreeRemoved).toBe(true)
    expect(report.tempSandboxRemoved).toBe(true)

    // Idempotent second release does not re-run hooks
    const secondReport = await lease.release()
    expect(secondReport.cleanupHooksExecuted).toBe(2)
    expect(callOrder).toEqual(['second', 'first'])

    // Scope lock is freed after release
    const reacquired = await manager.provisionLease({
      agentId: 'worker-1',
      branchId: 'feat-lock',
      scopeType: 'branch',
    })
    await reacquired.release()
  })

  it('reaps expired leases by clock and fails closed on empty repositories or unsafe paths', async () => {
    const repo = makeCommittedRepo()
    const emptyRepo = mkdtempSync(join(tmpdir(), 'forge-par002-empty-'))
    const wtRoot = mkdtempSync(join(tmpdir(), 'forge-par002-wt-'))
    const tmpRoot = mkdtempSync(join(tmpdir(), 'forge-par002-tmp-'))
    tempDirs.push(repo, emptyRepo, wtRoot, tmpRoot)

    git(emptyRepo, ['init', '--quiet'])
    const emptyManager = new WorktreeIsolationManager({ repositoryPath: emptyRepo })
    await expect(emptyManager.provisionLease({ agentId: 'a1', branchId: 'main' })).rejects.toThrow(
      EmptyRepositoryIsolationError,
    )

    let now = 1_000
    const timedManager = new WorktreeIsolationManager({
      repositoryPath: repo,
      worktreeRoot: wtRoot,
      tempSandboxRoot: tmpRoot,
      clock: () => now,
    })

    await expect(
      timedManager.provisionLease({ agentId: '../escape', branchId: 'main' }),
    ).rejects.toThrow(WorktreeIsolationError)

    const timedLease = await timedManager.provisionLease({
      agentId: 'ttl-agent',
      branchId: 'ttl-branch',
      leaseTtlMs: 5_000,
    })

    expect(await timedManager.reapExpiredLeases()).toHaveLength(0)

    now += 6_000
    const reaped = await timedManager.reapExpiredLeases()
    expect(reaped).toHaveLength(1)
    expect(reaped[0]?.leaseId).toBe(timedLease.leaseId)
    expect(existsSync(timedLease.worktreePath)).toBe(false)
  })
})
