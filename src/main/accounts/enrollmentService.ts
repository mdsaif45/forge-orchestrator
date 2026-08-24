import type { AccountHomes } from './accountHomes'
import { accountEnv, probeAccountAuth, type AccountAuthState } from './accountAuth'
import type { RuntimeRegistry } from '../runtimes/registry'

/** Where an account stands, from Forge's point of view. */
export interface AccountEnrollmentView {
  readonly accountId: string
  /** False when this provider cannot hold more than one identity on this machine. */
  readonly isolatable: boolean
  readonly home: string | null
  readonly auth: AccountAuthState
}

export interface EnrollmentCommand {
  readonly command: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
}

/**
 * Enrolling a provider account, without Forge ever handling a credential.
 *
 * The vendor CLI has no headless login — `claude auth login` is always a browser flow
 * — so Forge cannot log in on the user's behalf and should not want to. What it can do
 * is prepare an isolated home and hand the CLI an environment pointing at it. The CLI
 * writes its own credential there; Forge only ever knows the path.
 *
 * Isolation is a per-adapter capability, not an assumption (#111, #122): Claude's
 * credential is home-relative and isolates, Antigravity's lives in the Windows
 * Credential Manager under one fixed name and cannot. Enrolling a second account
 * against a runtime that cannot isolate would produce two names for one identity, so
 * it is refused rather than silently accepted.
 */
export class EnrollmentService {
  constructor(
    private readonly homes: AccountHomes,
    private readonly registry: RuntimeRegistry,
    /** Resolved per runtime so a test can point at something other than a real CLI. */
    private readonly executableFor: (runtimeId: string) => string,
  ) {}

  /**
   * The command the user must run to sign in, with the environment that isolates it.
   *
   * Returned rather than executed: the login opens a browser and needs a terminal the
   * user can see, and Forge must never be in a position to intercept what is typed
   * there. Handing back the exact invocation keeps that boundary explicit.
   */
  enrollmentCommand(runtimeId: string, home: string): EnrollmentCommand {
    return {
      command: this.executableFor(runtimeId),
      args: ['auth', 'login'],
      env: accountEnv(home),
    }
  }

  /** Prepares an isolated home, refusing when the runtime cannot isolate. */
  async prepare(runtimeId: string, accountId: string): Promise<string> {
    if (!this.isolatable(runtimeId)) {
      throw new Error(
        `Runtime "${runtimeId}" cannot hold more than one account on this machine, so a separate home would not isolate it`,
      )
    }

    return this.homes.ensure(accountId)
  }

  /**
   * What Forge can actually establish about an account right now.
   *
   * The auth state is probed rather than remembered: a credential expires, and a
   * stored "connected" flag would keep asserting it long after it stopped being true —
   * the unverified claim A3 exists to prevent, applied to auth.
   */
  async status(runtimeId: string, accountId: string): Promise<AccountEnrollmentView> {
    const isolatable = this.isolatable(runtimeId)
    const enrolled = isolatable && (await this.homes.exists(accountId))
    const home = enrolled ? this.homes.pathFor(accountId) : null

    return {
      accountId,
      isolatable,
      home,
      auth:
        home === null
          ? { loggedIn: false, authMethod: 'none', email: null }
          : await probeAccountAuth(this.executableFor(runtimeId), home),
    }
  }

  /** Deletes the home, which is the whole of revocation — Forge held nothing else. */
  async revoke(accountId: string): Promise<void> {
    await this.homes.remove(accountId)
  }

  private isolatable(runtimeId: string): boolean {
    return this.registry.has(runtimeId)
      ? this.registry.resolve(runtimeId).supportsAccountIsolation
      : false
  }
}
