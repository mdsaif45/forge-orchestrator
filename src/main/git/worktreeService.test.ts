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
