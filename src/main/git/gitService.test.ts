import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { changedFileSchema } from '@shared/domain'
import { DirtyWorktreeError, GitService, NotARepositoryError } from '.'

/**
 * Integration tests against real repositories.
 *
 * These build actual git repositories in a temp directory rather than mocking the
 * process boundary. Mocking `git` here would test the parsers against fixtures that
 * the parsers' author invented — which is exactly the failure mode this service
 * exists to prevent, since the whole point is that the repository, not a claim
 * about it, is authoritative (axiom A3).
 */

let repoPath: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })
}

function write(relativePath: string, contents: string): void {
  writeFileSync(join(repoPath, relativePath), contents)
}

function service(): GitService {
  return new GitService({ repositoryPath: repoPath })
}

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'forge-git-'))
  git('init', '--quiet', '--initial-branch=main', '.')
  git('config', 'user.email', 'test@forge.local')
  git('config', 'user.name', 'Forge Test')
  // Signing would prompt for a key that CI does not have.
  git('config', 'commit.gpgsign', 'false')
})

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true })
})

describe('isRepo', () => {
  it('accepts a repository root', async () => {
    await expect(service().isRepo()).resolves.toBe(true)
  })

  it('rejects a directory that is not a repository', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'forge-plain-'))

    try {
      await expect(new GitService({ repositoryPath: plain }).isRepo()).resolves.toBe(false)
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('accepts a path spelled differently from git output', async () => {
    // Regression: the comparison was string-based, so a valid repository reached by
    // an equivalent spelling was reported as "not a repository". This is what broke
    // Windows CI, whose temp directory is an 8.3 short name that git resolves to the
    // long form. Identity is now device+inode, which no spelling can change.
    const spellings = [
      `${repoPath}${sep}`,
      repoPath.split('\\').join('/'),
      ...(process.platform === 'win32' ? [repoPath.toUpperCase()] : []),
    ]

    for (const spelling of spellings) {
      await expect(new GitService({ repositoryPath: spelling }).isRepo(), spelling).resolves.toBe(
        true,
      )
    }
  })

  it('rejects a subdirectory of a repository', async () => {
    // Accepting this would make every recorded path relative to the wrong root, so
    // Forge's paths would silently stop matching git's.
    execFileSync('git', ['init', '--quiet', 'nested'], { cwd: repoPath })
    const sub = join(repoPath, 'sub')
    execFileSync('mkdir', [sub], { cwd: repoPath, shell: true })

    await expect(new GitService({ repositoryPath: sub }).isRepo()).resolves.toBe(false)
  })

  it('reports operations on a non-repository as an error, not an empty result', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'forge-plain-'))

    try {
      await expect(new GitService({ repositoryPath: plain }).status()).rejects.toThrow(
        NotARepositoryError,
      )
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })
})

describe('an empty repository', () => {
  it('reports a null head sha rather than inventing one', async () => {
    await expect(service().headSha()).resolves.toBeNull()
  })

  it('reports the initial branch', async () => {
    await expect(service().currentBranch()).resolves.toBe('main')
  })

  it('refuses to snapshot, because there is no base to diff against', async () => {
    await expect(service().snapshot()).rejects.toThrow(/no commits/)
  })
})

describe('branches', () => {
  beforeEach(() => {
    write('a.txt', 'one\n')
    git('add', '-A')
    git('commit', '--quiet', '-m', 'first')
  })

  it('lists local branches in a reproducible order', async () => {
    git('branch', 'zebra')
    git('branch', 'alpha')

    // Sorted by refname explicitly, not left to git's default: `git branch` ordering
    // has varied between versions, and this list is shown to the user.
    await expect(service().listBranches()).resolves.toEqual(['alpha', 'main', 'zebra'])
  })

  describe('defaultBranch', () => {
    it('does NOT report the checked-out branch when that is not the default', async () => {
      // The #100 regression, stated as its own case because it is the whole point:
      // a project created mid-feature previously recorded the feature branch as its
      // default, which silently moved the diff base for every later scope verdict.
      git('checkout', '--quiet', '-b', 'feature/visual-studio-extension')

      const git_ = service()
      await expect(git_.currentBranch()).resolves.toBe('feature/visual-studio-extension')
      await expect(git_.defaultBranch()).resolves.toBe('main')
    })

    it('prefers what the remote says over local convention', async () => {
      // A repository whose default is genuinely not `main`: if origin/HEAD is
      // consulted at all, it has to win over the conventional-name fallback.
      git('branch', 'develop')
      git('remote', 'add', 'origin', repoPath)
      git('update-ref', 'refs/remotes/origin/develop', 'HEAD')
      git('symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/develop')

      await expect(service().defaultBranch()).resolves.toBe('develop')
    })

    it('falls back to a conventional name when there is no remote', async () => {
      await expect(service().defaultBranch()).resolves.toBe('main')
    })

    it('finds master when that is what exists', async () => {
      git('branch', '--move', 'master')

      await expect(service().defaultBranch()).resolves.toBe('master')
    })

    it('returns null rather than guessing when no convention matches', async () => {
      git('branch', '--move', 'trunk')

      // Null is the honest answer: the caller surfaces the question instead of
      // inheriting a fabricated default (A2).
      await expect(service().defaultBranch()).resolves.toBeNull()
    })

    it('ignores a configured default that does not exist here', async () => {
      // `init.defaultBranch` describes what `git init` would create, not what this
      // repository contains — trusting it blindly would name a branch that is absent.
      git('config', 'init.defaultBranch', 'nonexistent')

      await expect(service().defaultBranch()).resolves.toBe('main')
    })
  })
})

describe('status', () => {
  beforeEach(() => {
    write('tracked.txt', 'one\n')
    git('add', '-A')
    git('commit', '--quiet', '-m', 'first')
  })

  it('is clean immediately after a commit', async () => {
    const status = await service().status()

    expect(status.entries).toEqual([])
    expect(status.untracked).toEqual([])
    await expect(service().isDirty()).resolves.toBe(false)
  })

  it('counts an untracked file as dirty', async () => {
    // An agent that writes a file without staging it has still changed the repo;
    // ignoring that would let real work escape the evidence trail.
    write('stray.txt', 'x\n')

    const status = await service().status()

    expect(status.untracked).toEqual(['stray.txt'])
    await expect(service().isDirty()).resolves.toBe(true)
  })

  it('reads the head sha and branch', async () => {
    const sha = await service().headSha()

    expect(sha).toMatch(/^[0-9a-f]{40}$/)
    expect(sha).toBe(git('rev-parse', 'HEAD').trim())
    await expect(service().currentBranch()).resolves.toBe('main')
  })
})

describe('snapshot', () => {
  beforeEach(() => {
    write('tracked.txt', 'one\n')
    git('add', '-A')
    git('commit', '--quiet', '-m', 'first')
  })

  it('captures the head sha of a clean worktree', async () => {
    const snapshot = await service().snapshot()

    expect(snapshot.sha).toBe(git('rev-parse', 'HEAD').trim())
    expect(snapshot.branch).toBe('main')
    expect(snapshot.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('refuses a dirty worktree by default', async () => {
    write('tracked.txt', 'changed\n')

    // Snapshotting here would attribute this edit to whichever step runs next.
    await expect(service().snapshot()).rejects.toThrow(DirtyWorktreeError)
  })

  it('names the offending paths in the error', async () => {
    write('tracked.txt', 'changed\n')
    write('stray.txt', 'new\n')

    await expect(service().snapshot()).rejects.toThrow(/tracked\.txt/)
  })

  it('proceeds on a dirty worktree when the caller opts in', async () => {
    write('tracked.txt', 'changed\n')

    const snapshot = await service().snapshot({ allowDirty: true })

    expect(snapshot.sha).toBe(git('rev-parse', 'HEAD').trim())
  })
})

describe('diff', () => {
  let baseSha: string

  beforeEach(() => {
    write('keep.txt', 'line1\nline2\nline3\n')
    write('rename-me.txt', 'stable content\nsecond line\nthird line\n')
    write('delete-me.txt', 'goodbye\n')
    git('add', '-A')
    git('commit', '--quiet', '-m', 'base')
    baseSha = git('rev-parse', 'HEAD').trim()
  })

  it('reports a structured diff that satisfies the domain schema', async () => {
    // The definition of done: a real repository's diff, as validated JSON.
    write('keep.txt', 'line1\nline2\nline3\nline4\n')
    write('created.txt', 'brand new\n')
    git('add', '-A')

    const result = await service().diffWorktree(baseSha)
    const byPath = new Map(result.files.map((file) => [file.path, file]))

    expect(byPath.get('keep.txt')).toMatchObject({
      changeType: 'modified',
      insertions: 1,
      deletions: 0,
      previousPath: null,
    })
    expect(byPath.get('created.txt')).toMatchObject({ changeType: 'added', insertions: 1 })

    // Every entry must be a valid ChangedFile, since these become changeset
    // evidence and an invalid one would fail far from here.
    for (const file of result.files) {
      const { binary: _binary, ...changedFile } = file
      expect(changedFileSchema.parse(changedFile)).toBeTruthy()
    }
  })

  it('includes the real patch text', async () => {
    write('keep.txt', 'line1\nline2\nline3\nline4\n')

    const result = await service().diffWorktree(baseSha)

    expect(result.patch).toContain('+line4')
    expect(result.patch).toContain('diff --git')
  })

  it('detects a rename instead of an add plus a delete', async () => {
    git('mv', 'rename-me.txt', 'renamed.txt')

    const result = await service().diffWorktree(baseSha)

    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toMatchObject({
      path: 'renamed.txt',
      changeType: 'renamed',
      previousPath: 'rename-me.txt',
    })
  })

  it('reports a rename as two files when detection is off', async () => {
    git('mv', 'rename-me.txt', 'renamed.txt')

    const result = await service().diffWorktree(baseSha, { detectRenames: false })
    const types = result.files.map((file) => file.changeType).sort()

    expect(types).toEqual(['added', 'deleted'])
  })

  it('reports a deletion', async () => {
    git('rm', '--quiet', 'delete-me.txt')

    const result = await service().diffWorktree(baseSha)

    expect(result.files[0]).toMatchObject({ path: 'delete-me.txt', changeType: 'deleted' })
  })

  it('reports a binary file as changed with zero line counts', async () => {
    // Dashes in numstat are not integers; the domain schema requires integers, so
    // this is the case that would throw if the parser trusted the format blindly.
    writeFileSync(join(repoPath, 'blob.bin'), Buffer.from([0, 1, 2, 0, 255]))
    git('add', '-A')

    const result = await service().diffWorktree(baseSha)
    const blob = result.files.find((file) => file.path === 'blob.bin')

    expect(blob).toMatchObject({ changeType: 'added', insertions: 0, deletions: 0, binary: true })
    const { binary: _binary, ...changedFile } = blob ?? { binary: false }
    expect(changedFileSchema.parse(changedFile)).toBeTruthy()
  })

  it('handles a path with spaces and non-ascii characters', async () => {
    write('café menu.txt', 'crème\n')
    git('add', '-A')

    const result = await service().diffWorktree(baseSha)

    expect(result.files.map((file) => file.path)).toContain('café menu.txt')
  })

  it('reports both staged and unstaged work against the base', async () => {
    // An agent's changes are uncommitted in the normal case, and a partially
    // staged tree must not report only half the work.
    write('keep.txt', 'staged\n')
    git('add', 'keep.txt')
    write('created.txt', 'unstaged\n')

    const paths = (await service().diffWorktree(baseSha)).files.map((file) => file.path).sort()

    expect(paths).toEqual(['created.txt', 'keep.txt'])
  })

  it('includes an untracked file, which a plain diff does not see', async () => {
    // Regression: `git diff <base>` compares tracked content only, so a file the
    // agent created was silently absent from the changeset — the most common kind
    // of change going unreported. Caught by a test, not by review.
    write('agent-created.txt', 'line one\nline two\n')

    const result = await service().diffWorktree(baseSha)
    const created = result.files.find((file) => file.path === 'agent-created.txt')

    expect(created).toMatchObject({
      changeType: 'added',
      insertions: 2,
      deletions: 0,
      previousPath: null,
    })
    expect(result.patch).toContain('+line one')
  })

  it('includes an untracked file alongside staged and unstaged work', async () => {
    write('keep.txt', 'staged\n')
    git('add', 'keep.txt')
    write('delete-me.txt', 'unstaged edit\n')
    write('agent-created.txt', 'new\n')

    const paths = (await service().diffWorktree(baseSha)).files.map((file) => file.path).sort()

    expect(paths).toEqual(['agent-created.txt', 'delete-me.txt', 'keep.txt'])
  })

  it('reports an untracked binary file without inventing line counts', async () => {
    writeFileSync(join(repoPath, 'untracked.bin'), Buffer.from([0, 1, 2, 0, 255]))

    const result = await service().diffWorktree(baseSha)
    const blob = result.files.find((file) => file.path === 'untracked.bin')

    expect(blob).toMatchObject({ changeType: 'added', insertions: 0, deletions: 0, binary: true })
  })

  it('does not stage anything while reporting untracked files', async () => {
    // `git add -N` would make the diff work but writes to the index, which would
    // corrupt the state of a repository an agent is mid-way through editing.
    write('agent-created.txt', 'new\n')
    const before = git('status', '--porcelain=v2')

    await service().diffWorktree(baseSha)

    expect(git('status', '--porcelain=v2')).toBe(before)
    expect(before).toContain('? agent-created.txt')
  })

  it('returns no files and no patch when nothing changed', async () => {
    const result = await service().diffWorktree(baseSha)

    // Both empty together: changeSetSchema rejects one without the other.
    expect(result.files).toEqual([])
    expect(result.patch.trim()).toBe('')
  })

  it('diffs two commits', async () => {
    write('keep.txt', 'line1\nline2\nline3\nline4\n')
    git('add', '-A')
    git('commit', '--quiet', '-m', 'second')
    const headSha = git('rev-parse', 'HEAD').trim()

    const result = await service().diff(baseSha, headSha)

    expect(result.files).toHaveLength(1)
    expect(result.files[0]).toMatchObject({ path: 'keep.txt', insertions: 1 })
  })

  it('omits the binary flag from changedFiles, matching the domain shape', async () => {
    write('keep.txt', 'changed\n')

    const files = await service().changedFiles(baseSha)

    expect(files[0]).not.toHaveProperty('binary')
    expect(files.map((file) => changedFileSchema.parse(file))).toHaveLength(files.length)
  })
})

describe('fileAtRev', () => {
  let baseSha: string

  beforeEach(() => {
    write('keep.txt', 'original\n')
    git('add', '-A')
    git('commit', '--quiet', '-m', 'base')
    baseSha = git('rev-parse', 'HEAD').trim()
  })

  it('reads the committed contents without touching the worktree', async () => {
    write('keep.txt', 'edited in the worktree\n')

    await expect(service().fileAtRev(baseSha, 'keep.txt')).resolves.toBe('original\n')
  })

  it('returns null for a path that does not exist at that revision', async () => {
    // This is how "the change added this file" is detected, so it is an answer
    // rather than a failure.
    await expect(service().fileAtRev(baseSha, 'never-existed.txt')).resolves.toBeNull()
  })

  it('rejects an absolute path, which cannot be repository-relative', async () => {
    await expect(service().fileAtRev(baseSha, '/etc/passwd')).rejects.toThrow()
  })

  it('rejects a windows-style path, which would not match git output', async () => {
    await expect(service().fileAtRev(baseSha, 'src\\keep.txt')).rejects.toThrow()
  })
})

describe('the read-only guarantee', () => {
  it('exposes no method that mutates a repository', () => {
    // The service is evidence-gathering only; write operations are gated behind the
    // permission model (#37). This asserts the surface rather than trusting review
    // to notice a method being added.
    const methods = Object.getOwnPropertyNames(GitService.prototype)
    const mutating = [
      'commit',
      'add',
      'stage',
      'push',
      'pull',
      'checkout',
      'branch',
      'reset',
      'merge',
      'rebase',
      'stash',
      'clean',
      'apply',
    ]

    expect(methods.filter((name) => mutating.includes(name))).toEqual([])
  })

  it('leaves the repository untouched after a full read cycle', async () => {
    write('tracked.txt', 'one\n')
    git('add', '-A')
    git('commit', '--quiet', '-m', 'first')
    write('tracked.txt', 'edited\n')
    // An untracked file is present deliberately: the untracked branch of
    // diffWorktree is the one place a mutating command would be tempting.
    write('dirty.txt', 'uncommitted\n')

    const before = {
      head: git('rev-parse', 'HEAD').trim(),
      status: git('status', '--porcelain=v2', '--branch'),
      reflog: git('reflog', '--format=%H %gs'),
    }

    const subject = service()
    const sha = await subject.headSha()
    await subject.status()
    await subject.currentBranch()
    await subject.isDirty()
    await subject.diffWorktree(sha ?? 'HEAD')
    await subject.fileAtRev('HEAD', 'tracked.txt')
    await subject.changedFiles('HEAD')

    // Reflog included deliberately: a stray checkout or reset would move HEAD and
    // then restore it, leaving status identical but the reflog changed.
    expect({
      head: git('rev-parse', 'HEAD').trim(),
      status: git('status', '--porcelain=v2', '--branch'),
      reflog: git('reflog', '--format=%H %gs'),
    }).toEqual(before)
  })
})
