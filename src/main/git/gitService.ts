import { realpath } from 'node:fs/promises'
import { repoPathSchema, shaSchema, type ChangedFile, type Sha } from '@shared/domain'
import { GitCommandError, runGit, splitNul, type GitExecOptions } from './exec'
import {
  joinDiffFiles,
  parseNameStatus,
  parseNumstat,
  parseStatus,
  type DiffFile,
  type StatusResult,
} from './parse'

/**
 * Read-only access to a git repository.
 *
 * Git is a first-class source of evidence in Forge, not a shell-out afterthought:
 * an agent's claim about what it changed is checked against what this service
 * reports (axiom A3). Everything here therefore observes and nothing mutates —
 * there is no commit, branch, stage, or push method, and adding one is gated behind
 * the permission model (#37) rather than left to a caller's discretion.
 *
 * Implemented by spawning `git` directly rather than through `simple-git`. The
 * decision and its reasoning are recorded in `docs/ARCHITECTURE.md`; in short, the
 * formats consumed here are git's own stable machine-readable contracts, so a
 * wrapper would add a dependency and a second parser without removing the need to
 * understand them.
 */

/**
 * Whether two paths name the same directory.
 *
 * String comparison is not enough on Windows, where one directory has several
 * legitimate spellings: separators may be `\` or `/`, the drive letter and every
 * segment are case-insensitive, and a path may be an 8.3 short name
 * (`RUNNER~1`) or traverse a junction or symlink. `git rev-parse` always answers
 * with the long, resolved form, so comparing it against whatever the caller
 * supplied rejected a perfectly valid repository — this is exactly what failed on
 * the Windows CI runner, whose temp directory is a short name, while passing on a
 * developer machine whose temp path happens to already be canonical.
 *
 * `realpath` asks the filesystem to canonicalise both sides, which resolves all of
 * those at once. Case is then folded on Windows only, since Linux paths are
 * genuinely case-sensitive and folding there would accept two different
 * directories as one.
 */
async function sameDirectory(left: string, right: string): Promise<boolean> {
  const canonical = async (value: string): Promise<string> => {
    // Falls back to the input when the path does not exist: the caller is asking
    // whether two names match, and a missing path simply does not match.
    const resolved = await realpath(value).catch(() => value)
    const normalised = resolved.split('\\').join('/').replace(/\/+$/, '')
    return process.platform === 'win32' ? normalised.toLowerCase() : normalised
  }

  return (await canonical(left)) === (await canonical(right))
}

/** Raised when a path is not a git repository, or not its root. */
export class NotARepositoryError extends Error {
  constructor(readonly path: string) {
    super(`Not a git repository: ${path}`)
    this.name = 'NotARepositoryError'
  }
}

/**
 * Raised when the worktree has uncommitted changes and the caller did not opt in.
 *
 * Guarding this is not fussiness: a snapshot SHA taken while the tree is dirty
 * would attribute pre-existing edits to the agent step that runs next, which is
 * exactly the confusion the changeset exists to prevent.
 */
export class DirtyWorktreeError extends Error {
  constructor(
    readonly path: string,
    readonly changedPaths: readonly string[],
  ) {
    super(
      `Worktree has ${String(changedPaths.length)} uncommitted change(s): ${changedPaths
        .slice(0, 5)
        .join(', ')}`,
    )
    this.name = 'DirtyWorktreeError'
  }
}

export interface GitServiceOptions {
  /** Absolute path to the repository root. */
  readonly repositoryPath: string
  readonly timeoutMs?: number
  readonly maxBuffer?: number
}

export interface DiffOptions {
  /**
   * Detect renames. On by default because a rename reported as an
   * add-plus-delete inflates the apparent scope of a change.
   */
  readonly detectRenames?: boolean
}

export interface DiffResult {
  readonly files: readonly DiffFile[]
  /** The unified patch, kept verbatim so review reads the real thing. */
  readonly patch: string
}

/** A point-in-time reference for later diffing, captured before a step runs. */
export interface Snapshot {
  readonly sha: Sha
  readonly branch: string | null
  readonly capturedAt: string
}

export class GitService {
  private readonly exec: GitExecOptions

  constructor(private readonly options: GitServiceOptions) {
    // Spread rather than assign: `exactOptionalPropertyTypes` distinguishes an
    // absent key from one set to undefined, and `runGit` reads its defaults from
    // absence.
    this.exec = {
      cwd: options.repositoryPath,
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
    }
  }

  get repositoryPath(): string {
    return this.options.repositoryPath
  }

  /**
   * Whether the configured path is the root of a work tree.
   *
   * Requires the root specifically. Pointing a project at a subdirectory would make
   * every path Forge records relative to that subdirectory while `git` reports it
   * relative to the real root, so the two would silently fail to match.
   */
  async isRepo(): Promise<boolean> {
    try {
      const { stdout } = await runGit(['rev-parse', '--show-toplevel'], this.exec)
      const root = stdout.trim()
      if (root === '') return false

      return await sameDirectory(root, this.options.repositoryPath)
    } catch (error) {
      if (error instanceof GitCommandError) return false
      throw error
    }
  }

  /** Throws unless the configured path is a repository root. */
  private async assertRepo(): Promise<void> {
    if (!(await this.isRepo())) {
      throw new NotARepositoryError(this.options.repositoryPath)
    }
  }

  async currentBranch(): Promise<string | null> {
    await this.assertRepo()
    const status = await this.status()
    return status.branch
  }

  /**
   * The commit HEAD points at, or null in a repository with no commits.
   *
   * Null is a real state rather than an error: a freshly initialised repository is a
   * legitimate project to bind, and callers that need a base for diffing check for
   * null instead of receiving a fabricated SHA.
   */
  async headSha(): Promise<Sha | null> {
    await this.assertRepo()

    try {
      const { stdout } = await runGit(['rev-parse', 'HEAD'], this.exec)
      return shaSchema.parse(stdout.trim())
    } catch (error) {
      // An unborn HEAD exits non-zero with "unknown revision"; other failures are
      // genuine and must not be flattened into null.
      if (error instanceof GitCommandError && (await this.hasNoCommits())) return null
      throw error
    }
  }

  private async hasNoCommits(): Promise<boolean> {
    try {
      await runGit(['rev-parse', '--verify', 'HEAD'], this.exec)
      return false
    } catch {
      return true
    }
  }

  /** Working-tree and index state, including untracked and conflicted paths. */
  async status(): Promise<StatusResult> {
    await this.assertRepo()
    const { stdout } = await runGit(
      ['status', '--porcelain=v2', '--branch', '-z', '--untracked-files=normal'],
      this.exec,
    )
    return parseStatus(splitNul(stdout))
  }

  /**
   * Whether the worktree has changes that are not committed.
   *
   * Untracked files count. An agent that creates a file and does not stage it has
   * still changed the repository, and omitting it would let real work escape the
   * evidence trail.
   */
  async isDirty(): Promise<boolean> {
    const status = await this.status()
    return status.entries.length > 0 || status.untracked.length > 0 || status.conflicted.length > 0
  }

  /**
   * Captures a reference point for later diffing.
   *
   * Refuses a dirty worktree unless `allowDirty` is set, so that changes already
   * present are not later attributed to the step being measured. The flag exists
   * because binding an in-progress repository is a legitimate thing for a user to
   * do; the default is the safe one.
   */
  async snapshot({
    allowDirty = false,
  }: { readonly allowDirty?: boolean } = {}): Promise<Snapshot> {
    await this.assertRepo()

    if (!allowDirty) {
      const status = await this.status()
      const changed = [
        ...status.entries.map((entry) => entry.path),
        ...status.untracked,
        ...status.conflicted,
      ]
      if (changed.length > 0) {
        throw new DirtyWorktreeError(this.options.repositoryPath, changed)
      }
    }

    const sha = await this.headSha()
    if (sha === null) {
      throw new GitCommandError(
        'Cannot snapshot a repository with no commits: there is no base to diff against',
        ['rev-parse', 'HEAD'],
        null,
        '',
      )
    }

    return {
      sha,
      branch: await this.currentBranch(),
      capturedAt: new Date().toISOString(),
    }
  }

  /**
   * Diffs two commits.
   *
   * Three git invocations rather than one: neither `--numstat` nor `--name-status`
   * carries the other's information, and the patch is requested separately so the
   * structured summary is available even when the patch is too large to be useful.
   */
  async diff(base: string, head: string, options: DiffOptions = {}): Promise<DiffResult> {
    await this.assertRepo()
    return this.collectDiff([`${base}..${head}`], options)
  }

  /**
   * Diffs the working tree — staged, unstaged, and untracked — against a base.
   *
   * This is the shape a changeset needs: an agent's work is uncommitted in the
   * normal case, so a commit-to-commit diff would report nothing at all.
   *
   * Untracked files need separate handling, and this is the one genuinely
   * surprising thing about the command set. `git diff <base>` compares the base
   * against tracked content only, so a file the agent *created* — the single most
   * common kind of change — is invisible to it. A test caught this rather than
   * review.
   *
   * The usual fix, `git add -N`, is not available here: it writes to the index, and
   * this service must not mutate a repository an agent may be working in. Instead
   * the untracked paths come from `status`, which already reports them, and each is
   * diffed against an empty file with `--no-index`.
   */
  async diffWorktree(base: string, options: DiffOptions = {}): Promise<DiffResult> {
    await this.assertRepo()

    const [tracked, status] = await Promise.all([this.collectDiff([base], options), this.status()])
    if (status.untracked.length === 0) return tracked

    const untracked = await this.collectUntracked(status.untracked)

    return {
      files: [...tracked.files, ...untracked.files],
      patch: [tracked.patch, untracked.patch].filter((part) => part.trim() !== '').join(''),
    }
  }

  /**
   * Diffs untracked files against nothing, so they appear as additions.
   *
   * `--no-index` makes git compare two paths on disk without consulting the index,
   * which keeps this read-only. The null device is passed as the left side; note
   * that git echoes it back as a platform-specific path (`nul` on Windows), so the
   * reported path is taken from the input rather than parsed out of the output.
   */
  private async collectUntracked(paths: readonly string[]): Promise<DiffResult> {
    const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null'

    const diffs = await Promise.all(
      paths.map(async (path) => {
        const args = ['diff', '--no-index', '--no-color']

        const [numstat, patch] = await Promise.all([
          // `--no-index` exits 1 when the files differ, which is always the case
          // here, so a non-zero exit is expected rather than a failure.
          runGit([...args, '--numstat', '-z', nullDevice, path], this.exec).catch(
            (error: unknown) => {
              if (error instanceof GitCommandError && error.exitCode === 1) {
                return { stdout: error.stdout, stderr: '' }
              }
              throw error
            },
          ),
          runGit([...args, '--patch', nullDevice, path], this.exec).catch((error: unknown) => {
            if (error instanceof GitCommandError && error.exitCode === 1) {
              return { stdout: error.stdout, stderr: '' }
            }
            throw error
          }),
        ])

        const counts = parseNumstat(splitNul(numstat.stdout))[0]

        const file: DiffFile = {
          path,
          changeType: 'added',
          previousPath: null,
          insertions: counts?.insertions ?? 0,
          deletions: 0,
          binary: counts?.binary ?? false,
        }

        return { file, patch: Buffer.from(patch.stdout, 'latin1').toString('utf8') }
      }),
    )

    return {
      files: diffs.map((entry) => entry.file),
      patch: diffs.map((entry) => entry.patch).join(''),
    }
  }

  private async collectDiff(revArgs: readonly string[], options: DiffOptions): Promise<DiffResult> {
    const renameArgs = options.detectRenames === false ? ['--no-renames'] : ['-M']
    const base = ['diff', ...renameArgs, ...revArgs]

    const [nameStatus, numstat, patch] = await Promise.all([
      runGit([...base, '--name-status', '-z'], this.exec),
      runGit([...base, '--numstat', '-z'], this.exec),
      runGit([...base, '--patch', '--no-color'], this.exec),
    ])

    const files = joinDiffFiles(
      parseNameStatus(splitNul(nameStatus.stdout)),
      parseNumstat(splitNul(numstat.stdout)),
    )

    // A patch with files but no text, or text but no files, means the capture went
    // wrong; `changeSetSchema` rejects that pairing, so failing here points at the
    // cause instead of surfacing later as a validation error far from its origin.
    return { files, patch: Buffer.from(patch.stdout, 'latin1').toString('utf8') }
  }

  /**
   * The contents of one file at one revision.
   *
   * Used by review to show what a line looked like before a change, without
   * checking anything out — a checkout would mutate the worktree an agent may be
   * working in.
   */
  async fileAtRev(rev: string, path: string): Promise<string | null> {
    await this.assertRepo()
    const repoPath = repoPathSchema.parse(path)

    try {
      const { stdout } = await runGit(['show', `${rev}:${repoPath}`], this.exec)
      return Buffer.from(stdout, 'latin1').toString('utf8')
    } catch (error) {
      // A path that does not exist at that revision is an expected answer, not a
      // failure: it is how "this file was added by the change" is detected.
      if (error instanceof GitCommandError) return null
      throw error
    }
  }

  /**
   * The structured file list of a diff, without the patch text.
   *
   * Kept separate because scope enforcement (#34) only needs the paths and counts,
   * and a large patch would dominate the cost of answering that question.
   */
  async changedFiles(base: string, head?: string): Promise<readonly ChangedFile[]> {
    const result = head === undefined ? await this.diffWorktree(base) : await this.diff(base, head)

    return result.files.map(({ binary: _binary, ...file }) => file)
  }
}
