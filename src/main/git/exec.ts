import { execFile } from 'node:child_process'

/**
 * The one place Forge runs `git`.
 *
 * `execFile` rather than `exec`: no shell is involved, so a branch name or path
 * containing a space, quote, `;`, or `&&` is an argument rather than syntax. Every
 * caller below passes repository paths and refs that may ultimately come from a
 * project's configuration, and a shell here would make that an injection surface.
 */

/**
 * Raised when `git` itself fails, carrying enough to diagnose without a re-run.
 *
 * `stdout` is retained because a non-zero exit does not always mean no output:
 * `diff --no-index` exits 1 whenever the files differ, and its diff is on stdout.
 */
export class GitCommandError extends Error {
  constructor(
    message: string,
    readonly args: readonly string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    readonly stdout = '',
  ) {
    super(message)
    this.name = 'GitCommandError'
  }
}

export interface GitExecOptions {
  /** Working directory the command runs in. */
  readonly cwd: string
  /**
   * Diffs of a large repository can be many megabytes, and truncation would be
   * silent corruption of evidence, so the cap is generous and exceeding it is an
   * error rather than a partial result.
   */
  readonly maxBuffer?: number
  readonly timeoutMs?: number
}

const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * Arguments prepended to every invocation, so that Forge's reading of a repository
 * cannot be altered by the machine it happens to run on.
 *
 * `core.quotepath=false` is the load-bearing one: by default git escapes non-ASCII
 * bytes in paths as `"\303\251"`, which would not match the repository-relative
 * paths Forge compares against, and `-z` output does *not* turn that off by itself.
 */
const GLOBAL_ARGS = [
  '-c',
  'core.quotepath=false',
  // A user's `diff.external`, pager, or textconv would rewrite what Forge sees.
  '-c',
  'core.pager=cat',
  '--no-optional-locks',
] as const

export interface GitExecResult {
  readonly stdout: string
  readonly stderr: string
}

/**
 * Runs one git command and returns its output, rejecting on a non-zero exit.
 *
 * Returns `stdout` as a string with `latin1` (byte-preserving) decoding rather
 * than utf8, because `-z` records are split on NUL bytes before any path is
 * interpreted; decoding is applied per-field by the parsers, so a path with
 * multi-byte characters survives the split intact.
 */
export async function runGit(
  args: readonly string[],
  options: GitExecOptions,
): Promise<GitExecResult> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      [...GLOBAL_ARGS, ...args],
      {
        cwd: options.cwd,
        maxBuffer: options.maxBuffer ?? DEFAULT_MAX_BUFFER,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        encoding: 'latin1',
        windowsHide: true,
        // A repository-local hook or config must not be able to change the answer.
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' },
      },
      (error, stdout, stderr) => {
        if (error) {
          const exitCode = typeof error.code === 'number' ? error.code : null
          reject(
            new GitCommandError(
              `git ${args.join(' ')} failed: ${stderr.trim() || error.message}`,
              args,
              exitCode,
              stderr,
              stdout,
            ),
          )
          return
        }

        resolve({ stdout, stderr })
      },
    )
  })
}

/**
 * Decodes one `-z` field from byte-preserved form back to UTF-8.
 *
 * The split happens on raw bytes so that a NUL separator is unambiguous; each
 * field is only interpreted as text afterwards.
 */
export function decodeField(field: string): string {
  return Buffer.from(field, 'latin1').toString('utf8')
}

/**
 * Splits `-z` output into records, dropping the trailing empty string.
 *
 * Git terminates each record with NUL rather than separating with it, so a naive
 * split yields a final empty element that would otherwise be parsed as a record.
 */
export function splitNul(stdout: string): string[] {
  const parts = stdout.split('\0')
  if (parts.length > 0 && parts[parts.length - 1] === '') {
    parts.pop()
  }
  return parts
}
