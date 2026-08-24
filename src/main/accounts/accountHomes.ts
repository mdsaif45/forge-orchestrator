import { statSync } from 'node:fs'
import { mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * Isolated home directories, one per provider account.
 *
 * The CLI writes its own credential into the home it is given, so Forge never reads,
 * stores, or transports a secret — it only knows a path. That removes a class of
 * problems rather than mitigating it: nothing to leak into SQLite, into the
 * append-only event log where it could never be revoked, or through IPC.
 *
 * ```
 * enrol   HOME=<accountHome> claude auth login   -> user completes browser flow once
 * probe   HOME=<accountHome> claude auth status  -> is this account still usable?
 * run     HOME=<accountHome> claude -p ...       -> acts as that account
 * ```
 *
 * Only meaningful for a runtime whose credential is home-relative. `agy` keeps its
 * credential in the Windows Credential Manager under one fixed name, so no home a
 * process is given changes which identity it reads — hence
 * `IAgentRuntime.supportsAccountIsolation`, measured in #111.
 */
export class AccountHomes {
  constructor(private readonly root: string) {}

  /**
   * The home directory for an account, created if absent.
   *
   * Recursive so a first call on a fresh install succeeds, and idempotent so
   * re-enrolling an existing account reuses its credential rather than discarding it.
   */
  async ensure(accountId: string): Promise<string> {
    const home = this.pathFor(accountId)
    await mkdir(home, { recursive: true })
    return home
  }

  /**
   * Where an account's home lives, without creating it.
   *
   * Kept separate from `ensure` so a read-only caller — the auth probe, or a spawn
   * for an account that should already exist — cannot silently create an empty home
   * and make an unenrolled account look enrolled.
   */
  pathFor(accountId: string): string {
    return join(this.root, accountId, 'home')
  }

  /** Whether this account has a home on disk at all. */
  async exists(accountId: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(accountId))).isDirectory()
    } catch {
      return false
    }
  }

  /**
   * The home, or null when the account was never enrolled.
   *
   * Synchronous because it answers a runtime's `homeForAccount`, which runs inside
   * `send` and cannot await. Returning null rather than an unchecked path is what
   * makes the adapter fail loudly instead of spawning against a directory that does
   * not exist — where the CLI would find no credential and quietly use the machine's
   * default identity.
   */
  resolveExisting(accountId: string): string | null {
    const home = this.pathFor(accountId)

    try {
      return statSync(home).isDirectory() ? home : null
    } catch {
      return null
    }
  }

  /**
   * Removes an account's home, and with it the credential the CLI wrote there.
   *
   * This is the only way Forge can revoke an account's local access, precisely
   * because it never held the secret itself. `force` so removing an account that was
   * never enrolled is not an error.
   */
  async remove(accountId: string): Promise<void> {
    await rm(join(this.root, accountId), { recursive: true, force: true })
  }
}
