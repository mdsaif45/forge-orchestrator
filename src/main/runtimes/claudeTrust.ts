import { readFile, writeFile, rename } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * Records a worktree as trusted before the Claude CLI is launched into it.
 *
 * On a directory it has not seen, the CLI blocks at startup on:
 *
 * ```
 * Quick safety check: Is this a project you created or one you trust?
 *   1. Yes, I trust this folder    2. No, exit
 * ```
 *
 * Every Forge worktree is a fresh path, so this fires on **every run**. Measured
 * (#166): the dialog owns the screen, swallows typed characters, and exits the
 * process on Escape — which is why a hosted turn appeared to hang forever.
 *
 * Writing `hasTrustDialogAccepted` ahead of the launch skips it. Measured
 * (#167): an untrusted fresh path stops at the dialog, and a path pre-recorded
 * this way boots straight to the prompt box.
 *
 * Forge is not deciding trust on the user's behalf. A worktree is a checkout of
 * a repository the user already opened in Forge; this carries forward a decision
 * they made, to a path they never see.
 *
 * The alternative — writing Enter into the pty to answer the dialog — was
 * rejected as fragile: it depends on option 1 staying preselected and on the
 * wording never changing, and a mis-timed write would answer a different prompt.
 */
export interface ClaudeTrustOptions {
  /** Overridable so a test never touches the developer's real config. */
  readonly configPath?: string
}

/** The subset of the CLI's config Forge reads. Everything else is preserved verbatim. */
interface ClaudeConfig {
  projects?: Record<string, Record<string, unknown>>
  [key: string]: unknown
}

export class ClaudeTrustStore {
  private readonly configPath: string

  constructor(options: ClaudeTrustOptions = {}) {
    this.configPath = options.configPath ?? join(homedir(), '.claude.json')
  }

  /**
   * Marks `workspacePath` trusted, leaving every other key untouched.
   *
   * Read-modify-write rather than a blind write: this file is the CLI's own, and
   * on this machine it holds 85 other projects plus the whole of the CLI's
   * state — onboarding flags, caches, OAuth account. Replacing it would destroy
   * a file Forge does not own.
   *
   * Written to a temporary file and renamed, so a crash mid-write cannot leave
   * the user with a truncated config and a CLI that will not start. `rename` is
   * atomic within a directory on both NTFS and POSIX.
   *
   * Returns false when the config cannot be read or parsed. That is not fatal:
   * the caller can still launch, and the user answers the dialog once by hand.
   * Throwing here would turn a cosmetic problem into a failed run.
   */
  async trust(workspacePath: string): Promise<boolean> {
    let config: ClaudeConfig
    try {
      config = JSON.parse(await readFile(this.configPath, 'utf8')) as ClaudeConfig
    } catch {
      // Absent on a first install, or unreadable. Either way there is nothing to
      // merge into, and creating one risks colliding with the CLI's own first write.
      return false
    }

    if (typeof config !== 'object') return false

    const key = normalisePath(workspacePath)
    const projects = config.projects ?? {}
    const existing = projects[key] ?? {}

    if (existing.hasTrustDialogAccepted === true) return true

    config.projects = { ...projects, [key]: { ...existing, hasTrustDialogAccepted: true } }

    const temporary = `${this.configPath}.forge-${String(process.pid)}`
    try {
      await writeFile(temporary, JSON.stringify(config, null, 2), 'utf8')
      await rename(temporary, this.configPath)
      return true
    } catch {
      return false
    }
  }
}

/**
 * The key form the CLI stores.
 *
 * Measured from a real config: entries are written with forward slashes even on
 * Windows. A backslash key would be a second, unmatched entry, and the dialog
 * would appear anyway — the failure would look like the trust write silently
 * doing nothing.
 */
function normalisePath(value: string): string {
  return value.split('\\').join('/')
}
