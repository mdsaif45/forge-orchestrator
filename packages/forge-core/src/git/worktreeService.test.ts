import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../test/tempDir'
import { WorktreeService } from './worktreeService'

/**
 * Isolation is the point, so the assertions are about the *user's* checkout staying
 * untouched, not about the worktree being created. A run measured against the app
 * modified `format.rs` and `journal.rs` in a real repository because agents were
 * spawned with the project path; a test that only checked "a directory appeared"
 * would have passed throughout that defect.
 */
const git = (cwd: string, args: readonly string[]): string =>
  execFileSync('git', [...args], { cwd, encoding: 'utf8' })

const makeRepo = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'forge-wt-repo-'))
  git(dir, ['init', '--quiet'])
  git(dir, ['config', 'user.email', 'test@example.com'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'source.txt'), 'original\n', 'utf8')
  git(dir, ['add', '.'])
  git(dir, ['commit', '--quiet', '-m', 'initial'])
  return dir
}

describe('WorktreeService', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await removeTempDir(dir)
  })

  it('gives an agent a checkout whose edits never reach the real repository', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    const prepared = await new WorktreeService({ repositoryPath: repo, root }).prepare('wf-1')
    expect(prepared).not.toBeNull()
    if (prepared === null) return

    // Stands in for the agent: it writes wherever Forge pointed it.
    writeFileSync(join(prepared.path, 'source.txt'), 'agent rewrote this\n', 'utf8')
    writeFileSync(join(prepared.path, 'added.txt'), 'new\n', 'utf8')

    expect(readFileSync(join(repo, 'source.txt'), 'utf8')).toBe('original\n')
    expect(existsSync(join(repo, 'added.txt'))).toBe(false)
    // A dirty checkout would show here; the user's tree must stay clean.
    expect(git(repo, ['status', '--porcelain']).trim()).toBe('')

    await prepared.dispose()
  })

  it('leaves no worktree registered after disposal', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    const prepared = await new WorktreeService({ repositoryPath: repo, root }).prepare('wf-2')
    if (prepared === null) throw new Error('expected a worktree')

    expect(git(repo, ['worktree', 'list'])).toContain('wf-2')

    // Dirty on purpose: a real run always leaves edits behind, and removal must not
    // depend on the agent having cleaned up after itself.
    writeFileSync(join(prepared.path, 'source.txt'), 'dirty\n', 'utf8')
    await prepared.dispose()

    expect(git(repo, ['worktree', 'list'])).not.toContain('wf-2')
    expect(existsSync(prepared.path)).toBe(false)
  })

  it('reports no isolation for a repository with no commit, rather than falling back', async () => {
    // An empty repository cannot produce a worktree. Returning null lets the caller
    // refuse the run; silently using the checkout instead is the behaviour this
    // module exists to prevent.
    const repo = mkdtempSync(join(tmpdir(), 'forge-wt-empty-'))
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)
    git(repo, ['init', '--quiet'])

    expect(await new WorktreeService({ repositoryPath: repo, root }).prepare('wf-3')).toBeNull()
  })
})

describe('WorktreeService.reclaimAbandoned', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await removeTempDir(dir)
  })

  it('removes a worktree a killed session never disposed', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    const service = new WorktreeService({ repositoryPath: repo, root })
    const prepared = await service.prepare('wf-orphan')
    if (prepared === null) throw new Error('expected a worktree')

    // Stands in for the process being killed: prepared, dirty, never disposed.
    writeFileSync(join(prepared.path, 'source.txt'), 'mid-run\n', 'utf8')
    expect(git(repo, ['worktree', 'list'])).toContain('wf-orphan')

    await service.reclaimAbandoned()

    expect(git(repo, ['worktree', 'list'])).not.toContain('wf-orphan')
    expect(existsSync(prepared.path)).toBe(false)
  })

  it('leaves a worktree the user created outside its root alone', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    const theirs = join(mkdtempSync(join(tmpdir(), 'forge-wt-theirs-')), 'mine')
    dirs.push(repo, root)

    git(repo, ['worktree', 'add', '--detach', theirs, 'HEAD'])

    await new WorktreeService({ repositoryPath: repo, root }).reclaimAbandoned()

    // Forge must never reclaim a worktree it did not create.
    expect(git(repo, ['worktree', 'list'])).toContain('mine')
    expect(existsSync(theirs)).toBe(true)

    git(repo, ['worktree', 'remove', '--force', theirs])
  })

  it('reclaims orphaned branch worktrees across workflows and nodes', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    const service = new WorktreeService({ repositoryPath: repo, root })
    const branchA = await service.prepareBranch('wf-orphan-multi', 'node-1')
    const branchB = await service.prepareBranch('wf-orphan-multi', 'node-2')
    if (!branchA || !branchB) throw new Error('expected branch worktrees')

    writeFileSync(join(branchA.path, 'source.txt'), 'abandoned-a\n', 'utf8')
    writeFileSync(join(branchB.path, 'source.txt'), 'abandoned-b\n', 'utf8')

    expect(git(repo, ['worktree', 'list'])).toContain('branch-node-1')
    expect(git(repo, ['worktree', 'list'])).toContain('branch-node-2')

    await service.reclaimAbandoned()

    expect(git(repo, ['worktree', 'list'])).not.toContain('branch-node-1')
    expect(git(repo, ['worktree', 'list'])).not.toContain('branch-node-2')
    expect(existsSync(branchA.path)).toBe(false)
    expect(existsSync(branchB.path)).toBe(false)
  })
})

describe('WorktreeService.prepareBranch', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await removeTempDir(dir)
  })

  it('provisions isolated branch worktrees where edits do not bleed between peer branches or into repo', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    const service = new WorktreeService({ repositoryPath: repo, root })
    const branchA = await service.prepareBranch('wf-concurrency', 'nodeA')
    const branchB = await service.prepareBranch('wf-concurrency', 'nodeB')
    expect(branchA).not.toBeNull()
    expect(branchB).not.toBeNull()
    if (!branchA || !branchB) return

    expect(branchA.path).toContain('branch-nodeA')
    expect(branchB.path).toContain('branch-nodeB')
    expect(branchA.path).not.toBe(branchB.path)

    // Write to branch A
    writeFileSync(join(branchA.path, 'fileA.txt'), 'content A\n', 'utf8')
    // Write to branch B
    writeFileSync(join(branchB.path, 'fileB.txt'), 'content B\n', 'utf8')

    // Branch A sees only fileA.txt
    expect(existsSync(join(branchA.path, 'fileA.txt'))).toBe(true)
    expect(existsSync(join(branchA.path, 'fileB.txt'))).toBe(false)

    // Branch B sees only fileB.txt
    expect(existsSync(join(branchB.path, 'fileB.txt'))).toBe(true)
    expect(existsSync(join(branchB.path, 'fileA.txt'))).toBe(false)

    // User checkout sees neither file
    expect(existsSync(join(repo, 'fileA.txt'))).toBe(false)
    expect(existsSync(join(repo, 'fileB.txt'))).toBe(false)
    expect(git(repo, ['status', '--porcelain']).trim()).toBe('')

    // Dispose branch A
    await branchA.dispose()
    expect(existsSync(branchA.path)).toBe(false)
    expect(git(repo, ['worktree', 'list'])).not.toContain('branch-nodeA')

    // Branch B remains intact until disposed
    expect(existsSync(branchB.path)).toBe(true)
    expect(git(repo, ['worktree', 'list'])).toContain('branch-nodeB')

    await branchB.dispose()
    expect(existsSync(branchB.path)).toBe(false)
    expect(git(repo, ['worktree', 'list'])).not.toContain('branch-nodeB')
  })

  it('checks out a branch worktree at a specific fork commit SHA', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    const initialSha = git(repo, ['rev-parse', 'HEAD']).trim()

    // Add a second commit to the repo
    writeFileSync(join(repo, 'v2.txt'), 'v2 content\n', 'utf8')
    git(repo, ['add', '.'])
    git(repo, ['commit', '--quiet', '-m', 'second commit'])
    const headSha = git(repo, ['rev-parse', 'HEAD']).trim()
    expect(headSha).not.toBe(initialSha)

    const service = new WorktreeService({ repositoryPath: repo, root })
    // Checkout branch at initial forkSha
    const branch = await service.prepareBranch('wf-fork-test', 'node-legacy', initialSha)
    expect(branch).not.toBeNull()
    if (!branch) return

    // Branch should have source.txt (from initial) but NOT v2.txt (from second commit)
    expect(existsSync(join(branch.path, 'source.txt'))).toBe(true)
    expect(existsSync(join(branch.path, 'v2.txt'))).toBe(false)

    const branchHead = git(branch.path, ['rev-parse', 'HEAD']).trim()
    expect(branchHead).toBe(initialSha)

    await branch.dispose()
  })

  it('returns null when checking out against an empty repository', async () => {
    const repo = mkdtempSync(join(tmpdir(), 'forge-wt-empty-branch-'))
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)
    git(repo, ['init', '--quiet'])

    const service = new WorktreeService({ repositoryPath: repo, root })
    expect(await service.prepareBranch('wf-empty', 'node-1')).toBeNull()
  })

  it('handles duplicate prepareBranch allocation on same (workflowId, nodeId) with stale registration', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    const service = new WorktreeService({ repositoryPath: repo, root })
    const branch1 = await service.prepareBranch('wf-dup', 'node-dup')
    expect(branch1).not.toBeNull()
    if (!branch1) return

    // Dirty the branch without disposing it (simulating active or uncleaned state)
    writeFileSync(join(branch1.path, 'stale.txt'), 'stale uncommitted data\n', 'utf8')
    expect(existsSync(join(branch1.path, 'stale.txt'))).toBe(true)

    // Re-allocating the same (workflowId, nodeId) must cleanly recreate the worktree
    const branch2 = await service.prepareBranch('wf-dup', 'node-dup')
    expect(branch2).not.toBeNull()
    if (!branch2) return

    // Path is clean and stale file was removed
    expect(existsSync(join(branch2.path, 'stale.txt'))).toBe(false)
    expect(existsSync(join(branch2.path, 'source.txt'))).toBe(true)

    await branch2.dispose()
    expect(existsSync(branch2.path)).toBe(false)
  })

  it('cleans up directory and leaves no orphan when git worktree add fails', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    // Obtain a tree SHA which passes rev-parse but fails git worktree add (requires commit)
    const treeSha = git(repo, ['rev-parse', 'HEAD^{tree}']).trim()

    const service = new WorktreeService({ repositoryPath: repo, root })
    await expect(service.prepareBranch('wf-fail', 'node-fail', treeSha)).rejects.toThrow()

    // Neither the branch path nor the parent workflow directory should remain on disk
    const branchPath = join(root, 'wf-fail', 'branch-node-fail')
    const parentDir = join(root, 'wf-fail')
    expect(existsSync(branchPath)).toBe(false)
    expect(existsSync(parentDir)).toBe(false)
  })
})

describe('WorktreeService.applyPatch', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await removeTempDir(dir)
  })

  it('applies unified patch with modified files to worktree', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    const service = new WorktreeService({ repositoryPath: repo, root })
    const branch = await service.prepareBranch('wf-patch', 'node-1')
    expect(branch).not.toBeNull()
    if (!branch) return

    const patch = `diff --git a/source.txt b/source.txt
--- a/source.txt
+++ b/source.txt
@@ -1 +1 @@
-original
+modified by patch
`
    await service.applyPatch(branch.path, patch)
    expect(readFileSync(join(branch.path, 'source.txt'), 'utf8')).toBe('modified by patch\n')

    await branch.dispose()
  })

  it('applies patch with added and deleted files', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    const service = new WorktreeService({ repositoryPath: repo, root })
    const branch = await service.prepareBranch('wf-add-del', 'node-1')
    expect(branch).not.toBeNull()
    if (!branch) return

    const patch = `diff --git a/new_file.txt b/new_file.txt
new file mode 100644
--- /dev/null
+++ b/new_file.txt
@@ -0,0 +1 @@
+hello new file
diff --git a/source.txt b/source.txt
deleted file mode 100644
--- a/source.txt
+++ /dev/null
@@ -1 +0,0 @@
-original
`
    await service.applyPatch(branch.path, patch)
    expect(existsSync(join(branch.path, 'new_file.txt'))).toBe(true)
    expect(readFileSync(join(branch.path, 'new_file.txt'), 'utf8')).toBe('hello new file\n')
    expect(existsSync(join(branch.path, 'source.txt'))).toBe(false)

    await branch.dispose()
  })

  it('applies patch with renamed files', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    const service = new WorktreeService({ repositoryPath: repo, root })
    const branch = await service.prepareBranch('wf-rename', 'node-1')
    expect(branch).not.toBeNull()
    if (!branch) return

    const patch = `diff --git a/source.txt b/renamed.txt
similarity index 100%
rename from source.txt
rename to renamed.txt
`
    await service.applyPatch(branch.path, patch)
    expect(existsSync(join(branch.path, 'source.txt'))).toBe(false)
    expect(existsSync(join(branch.path, 'renamed.txt'))).toBe(true)
    expect(readFileSync(join(branch.path, 'renamed.txt'), 'utf8')).toBe('original\n')

    await branch.dispose()
  })

  it('applies patch with mode changes', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    const service = new WorktreeService({ repositoryPath: repo, root })
    const branch = await service.prepareBranch('wf-mode', 'node-1')
    expect(branch).not.toBeNull()
    if (!branch) return

    const patch = `diff --git a/script.sh b/script.sh
new file mode 100755
--- /dev/null
+++ b/script.sh
@@ -0,0 +1 @@
+#!/bin/sh
`
    await service.applyPatch(branch.path, patch)
    expect(existsSync(join(branch.path, 'script.sh'))).toBe(true)
    expect(readFileSync(join(branch.path, 'script.sh'), 'utf8')).toBe('#!/bin/sh\n')

    await branch.dispose()
  })

  it('applies patch with binary changes', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    const service = new WorktreeService({ repositoryPath: repo, root })
    const branch = await service.prepareBranch('wf-bin', 'node-1')
    expect(branch).not.toBeNull()
    if (!branch) return
    const binaryPatch = `diff --git a/blob.bin b/blob.bin
new file mode 100644
index 0000000000000000000000000000000000000000..d43e6e83345438787f245d7976e872ebf6f9eb46
GIT binary patch
literal 6
NcmZQzWMXDv1pojk01yBG

literal 0
HcmV?d00001

`
    await service.applyPatch(branch.path, binaryPatch)
    expect(existsSync(join(branch.path, 'blob.bin'))).toBe(true)
    expect(readFileSync(join(branch.path, 'blob.bin'))).toEqual(Buffer.from([0, 1, 2, 3, 4, 5]))

    await branch.dispose()
  })

  it('handles empty patch as a clean no-op', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    const service = new WorktreeService({ repositoryPath: repo, root })
    const branch = await service.prepareBranch('wf-empty-p', 'node-1')
    expect(branch).not.toBeNull()
    if (!branch) return

    await service.applyPatch(branch.path, '   \n  ')
    expect(readFileSync(join(branch.path, 'source.txt'), 'utf8')).toBe('original\n')

    await branch.dispose()
  })

  it('rejects invalid or corrupted patch and throws GitCommandError', async () => {
    const repo = makeRepo()
    const root = mkdtempSync(join(tmpdir(), 'forge-wt-root-'))
    dirs.push(repo, root)

    const service = new WorktreeService({ repositoryPath: repo, root })
    const branch = await service.prepareBranch('wf-corrupt', 'node-1')
    expect(branch).not.toBeNull()
    if (!branch) return

    const corruptPatch = `diff --git a/source.txt b/source.txt
@@ -100,5 +100,5 @@
-nonexistent line
+replacement
`
    await expect(service.applyPatch(branch.path, corruptPatch)).rejects.toThrow()

    await branch.dispose()
  })
})
