import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { runGit, GitCommandError } from './exec'

/**
 * A disposable git worktree, so a workflow's agents never touch the user's checkout.
 *
 * The welcome screen promises "Multi-agent execution runs in dedicated worktrees,
 * protecting your active working tree and branch". Until this existed that was copy
 * and nothing else: agents were spawned with the project's own `repositoryPath`, so a
 * planner bound to a read-only role wrote two files straight into a real repository
 * (measured — `crates/vault-core/src/format.rs` and `journal.rs` in a dogfood run).
 * The policy engine caught it *afterwards* and halted, which is detection, not
 * protection; uncommitted work was already at risk.
 *
 * ```
 * prepare   git worktree add --detach <dir> <HEAD>   isolated checkout
 * run       agents spawn with cwd = <dir>            edits land here, never in the checkout
 * inspect   git -C <dir> diff                        what the run actually changed
 * dispose   git worktree remove --force <dir>        nothing left behind
 * ```
 *
 * Detached on purpose. A named branch would either collide with one the user already
 * has or leave a branch behind after cleanup; a detached HEAD carries the commit
 * without claiming a name, and the diff is what Forge reads anyway.
 */
export interface PreparedWorktree {
  /** Absolute path the agents should run in. */
  readonly path: string
  /** Removes the worktree. Safe to call more than once. */
  readonly dispose: () => Promise<void>
}

export interface WorktreeServiceOptions {
  readonly repositoryPath: string
  /** Where worktrees are created. One directory per workflow lives under it. */
  readonly root: string
}

export class WorktreeService {
  constructor(private readonly options: WorktreeServiceOptions) {}

  /**
   * Creates an isolated worktree for a workflow.
   *
   * Returns `null` when the repository cannot provide one — an empty repository has no
   * commit to check out, and `git worktree add` fails against it. A null result means
   * "no isolation available", which the caller must treat as a reason to refuse the
   * run rather than silently fall back to the user's checkout: falling back is exactly
   * the behaviour this module exists to remove.
   */
  async prepare(workflowId: string): Promise<PreparedWorktree | null> {
    const path = join(this.options.root, workflowId)
    const exec = { cwd: this.options.repositoryPath }

    // Resolved rather than passing `HEAD` through: `git worktree add` refuses a
    // repository with no commits, and the error it gives names neither the cause nor
    // the fix. Checking first lets the caller say something true about why.
    try {
      await runGit(['rev-parse', '--verify', 'HEAD'], exec)
    } catch (error) {
      if (error instanceof GitCommandError) return null
      throw error
    }

    // A directory left by a killed run would make `add` fail; removing it first makes
    // prepare idempotent across a crash.
    await rm(path, { recursive: true, force: true }).catch(() => undefined)

    await runGit(['worktree', 'add', '--detach', path, 'HEAD'], exec)

    let disposed = false
    const dispose = async (): Promise<void> => {
      if (disposed) return
      disposed = true

      // `--force` because the agents will have left the worktree dirty, and a clean
      // removal is not the goal — reclaiming the directory is.
      await runGit(['worktree', 'remove', '--force', path], exec).catch(() => undefined)
      // `worktree remove` leaves the directory behind if git considered it already
      // detached; removing it directly keeps the root from accumulating.
      await rm(path, { recursive: true, force: true }).catch(() => undefined)
      await runGit(['worktree', 'prune'], exec).catch(() => undefined)
    }

    return { path, dispose }
  }
}
