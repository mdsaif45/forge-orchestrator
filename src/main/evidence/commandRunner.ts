import { execFile, execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import {
  evidenceArtifactSchema,
  evidenceIdSchema,
  redactSecrets,
  type EvidenceArtifact,
  type RunOutcome,
  type StepId,
  type WorkflowId,
} from '@shared/domain'
import { parseTestCounts } from './testParsers'

/**
 * The one place Forge runs a project's own build and test commands.
 *
 * **Why a shell here, when `GitService` and `ProcessManager` both refuse one.**
 * Those two build a command from values that may be attacker-influenced — a branch
 * name, a repository path — so a shell would turn data into syntax. Here the whole
 * command string *is* the user's configured input (`repository.buildCommand`), and
 * running it is the entire purpose. A shell executes what the user wrote; refusing
 * one would mean silently breaking every `&&`, pipe, and `VAR=x` prefix a real
 * build command contains. Tokenising the string ourselves was rejected: a
 * half-written shell parser is its own defect source, and the schema's own comment
 * calls these "verbatim shell commands".
 *
 * **Why `execFile` rather than the pty `ProcessManager`.** A pty merges stdout and
 * stderr into one TTY-wrapped, colourised stream. Evidence gets parsed, and parsing
 * a corrupted stream produces evidence that looks real — the exact failure mode
 * axiom A3 exists to prevent. `execFile` keeps the streams separate and clean.
 */

/** Ceiling on captured output per stream, so a runaway log cannot exhaust memory. */
const DEFAULT_MAX_OUTPUT_BYTES = 4 * 1024 * 1024

/** A build that has produced no output for this long is treated as hung. */
const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000

export interface RunCommandInput {
  /** Verbatim shell command, exactly as configured on the repository. */
  readonly command: string
  /** Working directory. Always the repository root in practice. */
  readonly cwd: string
  readonly kind: EvidenceArtifact['kind']
  readonly workflowId: WorkflowId
  readonly stepId: StepId
  readonly timeoutMs?: number | undefined
  readonly maxOutputBytes?: number | undefined
  /** Added to the child environment. Secret-shaped names are still withheld. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Injected so tests assert on timing without depending on the wall clock. */
  readonly now?: (() => number) | undefined
  /** Resolves to abort the run, wiring workflow cancellation through to the child. */
  readonly signal?: AbortSignal | undefined
}

/**
 * Runs one command and reports what happened, never throwing.
 *
 * A failed command is a normal result, not an exception: the caller's job is to
 * record evidence either way, and an exception would tempt a `catch` that loses the
 * output. The only way this rejects is a bug in artifact construction.
 */
export async function runCommand(input: RunCommandInput): Promise<EvidenceArtifact> {
  const now = input.now ?? Date.now
  const maxBytes = input.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const startedAt = now()

  const { file, args } = shellInvocation(input.command)

  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS

  const result = await new Promise<RawResult>((resolve) => {
    /**
     * Why the timeout and the abort are handled here instead of being passed to
     * `execFile` as `timeout` and `signal`.
     *
     * Both of those kill only the immediate child — the shell — and by the time the
     * completion callback runs, that shell is already gone. `taskkill /T` walks the
     * tree downward *from a live parent*, so a kill attempted in the callback finds
     * nothing to walk and the grandchildren survive. Measured: the shell pid was
     * already unknown to `taskkill` ("process not found") while a `node` grandchild
     * kept running and holding the working directory.
     *
     * Owning the timer means the tree is killed while the shell is still alive, which
     * is the only ordering in which the walk reaches the real work:
     *
     * ```
     * execFile timeout   cmd.exe ✗ ... then kill tree -> parent gone, walk fails
     * own the timer      kill tree while cmd.exe ✓ alive -> whole tree dies
     * ```
     */
    let ending: 'timeout' | 'cancelled' | null = null

    const child = execFile(
      file,
      args,
      {
        cwd: input.cwd,
        maxBuffer: maxBytes,
        encoding: 'utf8',
        windowsHide: true,
        env: buildEnv(input.env ?? {}),
        // POSIX only: the child leads its own process group, so a kill can target
        // the group and take the whole tree. Windows has no equivalent option and is
        // handled by `killTree` walking the tree with `taskkill /T`.
        ...(process.platform === 'win32' ? {} : { detached: true }),
      },
      (error, stdout, stderr) => {
        clearTimeout(timer)
        input.signal?.removeEventListener('abort', onAbort)

        // An ending this runner imposed takes precedence over whatever `execFile`
        // reports, because the kill is why the command stopped.
        if (ending === 'timeout') {
          resolve({
            outcome: 'timeout',
            exitCode: null,
            stdout,
            stderr,
            failure: `no result within ${String(timeoutMs)}ms`,
            truncated: false,
          })
          return
        }

        if (ending === 'cancelled') {
          resolve({
            outcome: 'cancelled',
            exitCode: null,
            stdout,
            stderr,
            failure: 'cancelled before the command finished',
            truncated: false,
          })
          return
        }

        if (error === null) {
          resolve({
            outcome: 'completed',
            exitCode: 0,
            stdout,
            stderr,
            failure: null,
            truncated: false,
          })
          return
        }

        // Which field identifies each remaining case was measured against this Node
        // version rather than recalled; see the comment on `RawResult`.
        const code = error.code

        if (code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') {
          // Overflow kills the child, so its exit code is gone. The tree needs the
          // same treatment as a timeout, and for the same reason.
          killTree(child.pid)
          resolve({
            outcome: 'spawn-failed',
            exitCode: null,
            stdout,
            stderr,
            failure: `output exceeded ${String(maxBytes)} bytes and the command was killed`,
            truncated: true,
          })
          return
        }

        if (typeof code === 'number') {
          resolve({
            outcome: 'completed',
            exitCode: code,
            stdout,
            stderr,
            failure: null,
            truncated: false,
          })
          return
        }

        // ENOENT and friends: the shell itself never ran.
        resolve({
          outcome: 'spawn-failed',
          exitCode: null,
          stdout,
          stderr,
          failure: `${String(code ?? 'unknown')}: ${error.message}`,
          truncated: false,
        })
      },
    )

    const timer = setTimeout(() => {
      ending = 'timeout'
      killTree(child.pid)
    }, timeoutMs)

    function onAbort(): void {
      ending = 'cancelled'
      killTree(child.pid)
    }

    if (input.signal?.aborted === true) {
      onAbort()
    } else {
      input.signal?.addEventListener('abort', onAbort, { once: true })
    }
  })

  const durationMs = Math.max(0, now() - startedAt)

  // Redacted before storage, because an artifact is shown in the UI, written to an
  // event payload, and fed back to an agent in a correction packet. A token echoed
  // by a build script would otherwise reach all three.
  const stdout = redactSecrets(result.stdout)
  const stderr = redactSecrets(result.stderr)

  return evidenceArtifactSchema.parse({
    id: evidenceIdSchema.parse(randomUUID()),
    workflowId: input.workflowId,
    stepId: input.stepId,
    kind: input.kind,
    command: input.command,
    cwd: input.cwd,
    outcome: result.outcome,
    exitCode: result.exitCode,
    durationMs,
    stdout,
    stderr,
    truncated: result.truncated,
    // Parsed from the redacted copies rather than the raw ones: redaction only
    // rewrites secret *values*, never the count fields these parsers read, so the
    // result is the same while nothing unredacted is handled twice.
    counts: input.kind === 'tests' ? parseTestCounts(stdout, stderr) : null,
    failure: result.failure,
    recordedAt: new Date(startedAt).toISOString(),
  })
}

/**
 * How one run ended, before it becomes an artifact.
 *
 * The mapping from `execFile`'s callback to these fields was measured against
 * Node 22 on win32, because three of the four abnormal cases do not look the way
 * the option names imply:
 *
 * ```
 * exit N        code = N (number)          killed = false
 * timeout       code = null, signal SIGTERM, killed = true   <- not 'ETIMEDOUT'
 * abort         name 'AbortError', code 'ABORT_ERR'
 * maxBuffer     RangeError, ERR_CHILD_PROCESS_STDIO_MAXBUFFER, child KILLED,
 *               partial output preserved, exit code lost
 * missing shell code = 'ENOENT'
 * ```
 *
 * The `maxBuffer` case is the one worth knowing: the child is killed, so a build
 * that would have exited 0 reports no code at all. Truncation is therefore its own
 * outcome rather than a flag on a successful run.
 */
interface RawResult {
  readonly outcome: RunOutcome
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
  readonly failure: string | null
  readonly truncated: boolean
}

/**
 * Kills a process and everything it spawned.
 *
 * `execFile`'s own `timeout` and `signal` kill only the immediate child, which here
 * is the shell. A build command's real work happens in that shell's children, so
 * killing the shell alone orphans them:
 *
 * ```
 * kill shell only          cmd.exe ✗ ──> node (test runner) ✓ still running
 * kill the tree            cmd.exe ✗ ──> node ✗
 * ```
 *
 * Windows has no process groups, so `taskkill /T` is the only way to walk the tree;
 * it is spawned rather than awaited because the caller is a completion callback that
 * must resolve now. On POSIX the child was spawned `detached`, so it leads a group
 * and the negated pid reaches every member.
 */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return

  if (process.platform === 'win32') {
    // Synchronous deliberately. The whole point is to walk the tree while the shell
    // is still alive, and an async spawn would let the shell exit first — which is
    // the failure this function exists to prevent. `taskkill` is a short-lived
    // process and this runs at most once per command.
    try {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        windowsHide: true,
        stdio: 'ignore',
      })
    } catch {
      /* Exit 128 means the tree is already gone, which is the desired state. */
    }
    return
  }

  try {
    // Negative pid targets the process group created by `detached: true`.
    process.kill(-pid, 'SIGKILL')
  } catch {
    /* Already gone, or never became a group leader. */
  }
}

/**
 * The shell to hand the command to.
 *
 * `cmd.exe /d /s /c` on Windows: `/d` skips AutoRun registry commands, which would
 * otherwise let a machine-local setting alter what Forge observes; `/s` fixes the
 * quote handling so the command is passed through intact.
 */
function shellInvocation(command: string): { file: string; args: readonly string[] } {
  if (process.platform === 'win32') {
    return { file: process.env['COMSPEC'] ?? 'cmd.exe', args: ['/d', '/s', '/c', command] }
  }
  return { file: '/bin/sh', args: ['-c', command] }
}

/**
 * The child environment: the parent's, minus secret-shaped names, plus explicit
 * additions.
 *
 * `CI=1` and `NO_COLOR=1` are defaulted so runners emit machine-readable output
 * rather than progress spinners and escape codes — set before the caller's `env`,
 * so a project that needs different values can still override them.
 */
function buildEnv(extra: Readonly<Record<string, string>>): Record<string, string> {
  const env: Record<string, string> = {}

  for (const [name, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (isSecretName(name)) continue
    env[name] = value
  }

  env['CI'] = '1'
  env['NO_COLOR'] = '1'
  env['FORCE_COLOR'] = '0'
  // A build must never stall waiting for a git credential prompt it cannot answer.
  env['GIT_TERMINAL_PROMPT'] = '0'

  return { ...env, ...extra }
}

/**
 * Names withheld from the child.
 *
 * Deliberately a local list rather than a reuse of `process/redact.ts`: that one
 * withholds anything matching `auth`, which is right for an agent CLI but would
 * strip variables a build legitimately needs. The narrower set here covers
 * credential-shaped names without breaking toolchains, and an explicit `env` entry
 * still passes through untouched.
 */
const SECRET_NAME_PATTERNS: readonly RegExp[] = [
  /token/i,
  /secret/i,
  /password/i,
  /passwd/i,
  /api[-_]?key/i,
  /access[-_]?key/i,
  /private[-_]?key/i,
  /credential/i,
]

function isSecretName(name: string): boolean {
  return SECRET_NAME_PATTERNS.some((pattern) => pattern.test(name))
}
