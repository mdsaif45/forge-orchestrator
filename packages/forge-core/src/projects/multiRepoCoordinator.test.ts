import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../test/tempDir'
import {
  CrossRepoDependencyCycleError,
  InvalidWorkspaceManifestError,
  MultiRepoWorkspaceCoordinator,
  WorkspaceProvisioningError,
  planMultiRepoExecutionOrder,
} from './multiRepoCoordinator'

const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' })

const makeRepo = (prefix: string, seedFileContent: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  git(dir, ['init', '--quiet'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'README.md'), seedFileContent, 'utf8')
  git(dir, ['add', '.'])
  git(dir, ['commit', '--quiet', '-m', 'initial commit'])
  return dir
}

describe('MultiRepoWorkspaceCoordinator (POLISH-001)', () => {
  const tempDirs: string[] = []

  afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
      await removeTempDir(dir)
    }
  })

  it('orchestrates interdependent multi-repo worktrees and reconciles changesets without cross-contamination', async () => {
    const repoLib = makeRepo('forge-polish-lib-', '# Lib Baseline\n')
    const repoApi = makeRepo('forge-polish-api-', '# API Baseline\n')
    const repoWeb = makeRepo('forge-polish-web-', '# Web Baseline\n')
    const wtRoot = mkdtempSync(join(tmpdir(), 'forge-polish-wt-'))
    const sandboxRoot = mkdtempSync(join(tmpdir(), 'forge-polish-tmp-'))
    tempDirs.push(repoLib, repoApi, repoWeb, wtRoot, sandboxRoot)

    const coordinator = new MultiRepoWorkspaceCoordinator({
      workspaceId: 'ws-platform',
      name: 'Platform Monolith',
      worktreeRoot: wtRoot,
      tempSandboxRoot: sandboxRoot,
      repos: [
        {
          repoId: 'web-app',
          repositoryPath: repoWeb,
          role: 'primary',
          dependsOn: ['api-service', 'shared-lib'],
        },
        {
          repoId: 'api-service',
          repositoryPath: repoApi,
          role: 'service',
          dependsOn: ['shared-lib'],
        },
        {
          repoId: 'shared-lib',
          repositoryPath: repoLib,
          role: 'library',
          dependsOn: [],
        },
      ],
    })

    const plan = coordinator.getExecutionPlan()
    expect(plan.executionOrder).toEqual(['shared-lib', 'api-service', 'web-app'])
    expect(plan.executionWaves).toEqual([['shared-lib'], ['api-service'], ['web-app']])

    const session = await coordinator.provisionWorkspace('agent-coord', 'feat-cross')
    const libAlloc = session.allocations.get('shared-lib')
    const apiAlloc = session.allocations.get('api-service')
    const webAlloc = session.allocations.get('web-app')
    expect(libAlloc).toBeDefined()
    expect(apiAlloc).toBeDefined()
    expect(webAlloc).toBeDefined()

    if (libAlloc && apiAlloc && webAlloc) {
      // Mutate README.md independently in lib and web plus add unique files; leave api clean
      writeFileSync(join(libAlloc.lease.worktreePath, 'README.md'), '# Lib Updated\n', 'utf8')
      writeFileSync(
        join(libAlloc.lease.worktreePath, 'contract.ts'),
        'export const VERSION = 2\n',
        'utf8',
      )
      writeFileSync(join(webAlloc.lease.worktreePath, 'README.md'), '# Web Updated\n', 'utf8')
      writeFileSync(join(webAlloc.lease.worktreePath, 'ui.tsx'), 'export const UI = true\n', 'utf8')
    }

    const report = await coordinator.reconcileSession(session.sessionId)
    expect(report.crossContaminationFree).toBe(true)
    expect(report.totalRepos).toBe(3)
    expect(report.modifiedRepoCount).toBe(2)
    expect(report.totalChangedFiles).toBe(4)
    expect(report.reconciliationDigest).toHaveLength(64)

    const [libRec, apiRec, webRec] = report.reconciliations
    expect(libRec?.repoId).toBe('shared-lib')
    expect(libRec?.clean).toBe(false)
    expect(libRec?.files.map((f) => f.path)).toEqual(['README.md', 'contract.ts'])
    expect(libRec?.patch).toContain('Lib Updated')
    expect(libRec?.patch).not.toContain('Web Updated')

    expect(apiRec?.repoId).toBe('api-service')
    expect(apiRec?.clean).toBe(true)
    expect(apiRec?.changedFileCount).toBe(0)

    expect(webRec?.repoId).toBe('web-app')
    expect(webRec?.clean).toBe(false)
    expect(webRec?.files.map((f) => f.path)).toEqual(['README.md', 'ui.tsx'])
    expect(webRec?.patch).toContain('Web Updated')
    expect(webRec?.patch).not.toContain('Lib Updated')

    // Real checkouts remain completely untouched
    expect(readFileSync(join(repoLib, 'README.md'), 'utf8')).toBe('# Lib Baseline\n')
    expect(readFileSync(join(repoWeb, 'README.md'), 'utf8')).toBe('# Web Baseline\n')

    await coordinator.disposeSession(session.sessionId)
    if (libAlloc && webAlloc) {
      expect(existsSync(libAlloc.lease.worktreePath)).toBe(false)
      expect(existsSync(webAlloc.lease.worktreePath)).toBe(false)
    }
  })

  it('rejects cyclic dependencies, duplicate ids, and overlapping repository roots', () => {
    const repoA = mkdtempSync(join(tmpdir(), 'forge-polish-cyc-a-'))
    const repoB = mkdtempSync(join(tmpdir(), 'forge-polish-cyc-b-'))
    tempDirs.push(repoA, repoB)

    expect(() =>
      planMultiRepoExecutionOrder({
        workspaceId: 'ws-cycle',
        name: 'Cycle',
        repos: [
          { repoId: 'a', repositoryPath: repoA, dependsOn: ['b'] },
          { repoId: 'b', repositoryPath: repoB, dependsOn: ['a'] },
        ],
      }),
    ).toThrow(CrossRepoDependencyCycleError)

    expect(() =>
      planMultiRepoExecutionOrder({
        workspaceId: 'ws-overlap',
        name: 'Overlap',
        repos: [
          { repoId: 'parent', repositoryPath: repoA },
          { repoId: 'nested', repositoryPath: join(repoA, 'packages/sub') },
        ],
      }),
    ).toThrow(InvalidWorkspaceManifestError)

    expect(() =>
      planMultiRepoExecutionOrder({
        workspaceId: 'ws-dup',
        name: 'Dup',
        repos: [
          { repoId: 'same', repositoryPath: repoA },
          { repoId: 'same', repositoryPath: repoB },
        ],
      }),
    ).toThrow(InvalidWorkspaceManifestError)
  })

  it('rolls back previously provisioned repo worktrees atomically if a downstream repo fails', async () => {
    const validRepo = makeRepo('forge-polish-valid-', '# Valid\n')
    const emptyRepo = mkdtempSync(join(tmpdir(), 'forge-polish-empty-'))
    const wtRoot = mkdtempSync(join(tmpdir(), 'forge-polish-wt-rollback-'))
    tempDirs.push(validRepo, emptyRepo, wtRoot)
    git(emptyRepo, ['init', '--quiet'])

    const coordinator = new MultiRepoWorkspaceCoordinator({
      workspaceId: 'ws-rollback',
      name: 'Atomic Rollback',
      worktreeRoot: wtRoot,
      repos: [
        { repoId: 'repo-1', repositoryPath: validRepo },
        { repoId: 'repo-2', repositoryPath: emptyRepo, dependsOn: ['repo-1'] },
      ],
    })

    await expect(coordinator.provisionWorkspace('agent-rb', 'feat-rb')).rejects.toThrow(
      WorkspaceProvisioningError,
    )

    // repo-1 must only have its primary checkout worktree left (zero leaked worktrees)
    const porcelain = git(validRepo, ['worktree', 'list', '--porcelain'])
    const worktreeLines = porcelain.split('\n').filter((line) => line.startsWith('worktree '))
    expect(worktreeLines).toHaveLength(1)
  })
})
