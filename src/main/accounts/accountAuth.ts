import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { buildChildEnv } from '../process/redact'

const run = promisify(execFile)

/** What `claude auth status` reports for one account home. */
export interface AccountAuthState {
  readonly loggedIn: boolean
  /** `claude.ai` for a subscription, `console` for API billing, `none` when logged out. */
  readonly authMethod: string
  /** Present once logged in; the account's own identity, not one Forge assigned. */
  readonly email: string | null
}

/**
 * Environment for a child that must act as one specific account.
 *
 * Both variables are set because Windows resolves a home through `USERPROFILE` while
 * the CLI's own logic reads `HOME`. Setting only one leaves the other pointing at the
 * real user, and the process would silently authenticate as the wrong account — the
 * failure mode #111 exists to prevent, reintroduced by an incomplete environment.
 */
export function accountEnv(home: string): Record<string, string> {
  return { HOME: home, USERPROFILE: home }
}

/**
 * Whether an account home holds a usable credential.
 *
 * Asks the CLI rather than inspecting the credentials file. The file's shape is the
 * vendor's business and has already changed once; `auth status` is the documented,
 * machine-readable answer and stays correct when the file does not.
 *
 * A failure to run is reported as logged out rather than thrown: an unenrolled
 * account and a broken one are both "cannot act as this account right now", and the
 * caller's remedy — enrol it — is the same.
 */
export async function probeAccountAuth(
  executable: string,
  home: string,
): Promise<AccountAuthState> {
  const [command, prefixArgs] = windowsBatchSafe(executable)

  let stdout: string
  try {
    stdout = (
      await run(command, [...prefixArgs, 'auth', 'status'], {
        env: buildChildEnv(process.env, accountEnv(home)),
        timeout: 30_000,
      })
    ).stdout
  } catch (error: unknown) {
    // A logged-out account exits 1 and still prints a complete, valid JSON answer on
    // stdout — measured, not assumed. Reading it is what makes the exit code stop
    // mattering: discarding it and returning a hardcoded "logged out" would be right
    // only by coincidence, and would silently report the wrong state the moment the
    // CLI exits non-zero for some other reason.
    stdout = readStdout(error)
  }

  return parseAuthStatus(stdout)
}

/** The stdout an `execFile` rejection carries, when it carries one. */
function readStdout(error: unknown): string {
  if (typeof error !== 'object' || error === null) return ''
  const candidate = (error as { readonly stdout?: unknown }).stdout
  return typeof candidate === 'string' ? candidate : ''
}

/**
 * Reads the CLI's own answer, defaulting to logged out.
 *
 * Unparseable output means Forge cannot establish that the account is usable, and the
 * safe reading of "cannot establish" is "not usable" — claiming otherwise would be the
 * unverified assertion A3 exists to prevent, applied to auth instead of to work.
 */
function parseAuthStatus(stdout: string): AccountAuthState {
  const loggedOut: AccountAuthState = { loggedIn: false, authMethod: 'none', email: null }

  let parsed: unknown
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return loggedOut
  }

  if (typeof parsed !== 'object' || parsed === null) return loggedOut

  const record = parsed as Record<string, unknown>
  return {
    loggedIn: record.loggedIn === true,
    authMethod: typeof record.authMethod === 'string' ? record.authMethod : 'none',
    email: typeof record.email === 'string' ? record.email : null,
  }
}

/**
 * Runs a Windows batch shim without enabling a shell.
 *
 * `claude` installs as `claude.cmd` on Windows, and Node refuses to `execFile` a
 * `.cmd` or `.bat` directly — it fails with `EINVAL`, a deliberate hardening against
 * argument-injection through the batch interpreter. Measured, not inferred: the same
 * call succeeds only with `shell: true`.
 *
 * `shell: true` is the obvious fix and the wrong one, because it would interpolate the
 * path into a command line and reintroduce exactly the injection the restriction
 * exists to prevent. Invoking `cmd.exe /c` with the script as a separate argument runs
 * the shim while every argument stays a discrete value.
 */
function windowsBatchSafe(executable: string): [string, readonly string[]] {
  const isBatch = /\.(cmd|bat)$/i.test(executable)
  if (process.platform !== 'win32' || !isBatch) return [executable, []]

  return ['cmd.exe', ['/c', executable]]
}
