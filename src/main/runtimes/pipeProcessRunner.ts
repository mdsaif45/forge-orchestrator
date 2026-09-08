import { spawn } from 'node:child_process'
import type { OrphanTracker } from '../process/orphans'
import { resolveCommand } from '../process/processManager'
import { buildChildEnv, redactOutput, stripAnsi } from '../process/redact'
import type { ProcessRunner } from './claudeCliRuntime'

export interface PipeProcessRunnerOptions {
  /** No output for this long ends the run. This is the hang detector. */
  readonly idleTimeoutMs?: number
  /** Total wall-clock ceiling for one turn. */
  readonly hardTimeoutMs?: number
  /** Records the pid, so a crashed Forge does not leave the agent running. */
  readonly orphans?: OrphanTracker
}

const DEFAULT_IDLE_TIMEOUT_MS = 600_000
const DEFAULT_HARD_TIMEOUT_MS = 1_800_000

/**
 * A `ProcessRunner` over pipes rather than a pty, for a turn that carries a prompt.
 *
 * The pty runner cannot do this. A pty *is* a terminal, so a child that requires piped
 * input sees a TTY and takes the interactive path — measured against the real CLI,
 * which answers "Input must be provided either through stdin or as a prompt argument"
 * however the bytes are written (#131). Passing the prompt as an argument instead is
 * what caused the original defect: it arrived empty, and every step got "What would
 * you like me to do?".
 *
 * ```
 * pty  + argv prompt   ->  prompt arrives empty
 * pty  + stdin prompt  ->  CLI refuses; it sees a TTY
 * pipe + stdin prompt  ->  works
 * ```
 *
 * The guarantees `ProcessManager` provides are not optional for a process that runs
 * for minutes and edits a repository, so they are reproduced here rather than dropped:
 * a sanitised environment, redacted output, an idle and a hard timeout, and orphan
 * tracking. What is deliberately *not* reproduced is escalating signal termination —
 * Windows has no POSIX signals, and `ProcessManager` already documents why the no-arg
 * kill is the only portable option.
 */
export function createPipeProcessRunner(options: PipeProcessRunnerOptions = {}): ProcessRunner {
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
  const hardTimeoutMs = options.hardTimeoutMs ?? DEFAULT_HARD_TIMEOUT_MS

  return async (command, args, runOptions) => {
    const env = buildChildEnv(process.env, runOptions.env ?? {})

    // Resolved against PATH and PATHEXT first, because `CreateProcess` does not search
    // PATH: a bare `claude` fails with ENOENT however it is spawned, which is exactly
    // how the first version of this runner broke. Shared with `ProcessManager` rather
    // than reimplemented — these Windows rules are easy to get subtly wrong twice.
    const executable = resolveCommand(command, env)

    // A `.cmd` or `.bat` shim is not directly executable on Windows: it is a batch
    // file, and `CreateProcess` needs a shell to interpret it. Everything else is
    // spawned directly, because `shell: true` re-parses the whole command line — an
    // executable path containing a space then breaks with "'C:\Program' is not
    // recognized", which is a different way to lose the argument this bug was about.
    const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)

    const child = spawn(needsShell ? `"${executable}"` : executable, [...args], {
      cwd: runOptions.cwd,
      env,
      shell: needsShell,
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    void options.orphans?.record({
      pid: child.pid ?? -1,
      command: `${executable} ${args.join(' ')}`.trim(),
      startedAt: new Date().toISOString(),
    })

    // Published so a pane can attach to the real run (#170). Neither `write` nor
    // `resize` is offered: this runner sends the prompt on stdin and closes it, and
    // a pipe has no window size. Declaring the absence lets a caller show "this
    // session cannot take input" instead of accepting text that goes nowhere —
    // which is the defect the dead input box in the workflow pane already was.
    runOptions.onProcess?.({})

    let stdout = ''
    let stderr = ''
    // Held in an object rather than a `let`: it is only ever assigned inside a callback,
    // which control-flow analysis cannot see, so a plain binding narrows to `null` and the
    // kill-reason handling below is reported as dead code. It is not — a timeout or a
    // cancellation sets it, and losing the suffix would lose the only explanation of why
    // the run ended.
    const killed: { reason: string | null } = { reason: null }

    const finish = (reason: string): void => {
      if (killed.reason !== null) return
      killed.reason = reason
      // No signal argument: Windows has no POSIX signals, and passing one throws
      // uncatchably from a deferred callback.
      child.kill()
    }

    let idleTimer: NodeJS.Timeout | undefined
    const touch = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer)
      idleTimer = setTimeout(() => {
        finish('idle-timeout')
      }, idleTimeoutMs)
    }

    const hardTimer = setTimeout(() => {
      finish('hard-timeout')
    }, hardTimeoutMs)

    const onAbort = (): void => {
      finish('cancelled')
    }
    runOptions.signal?.addEventListener('abort', onAbort, { once: true })
    if (runOptions.signal?.aborted === true) onAbort()

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk: string) => {
      touch()
      // Redacted as it arrives, not at the end: a live log renders these, and a secret
      // that reached the UI cannot be unseen by cleaning up the buffer afterwards.
      const clean = redactOutput(stripAnsi(chunk))
      stdout += clean
      runOptions.onStdout?.(clean)
    })

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk: string) => {
      touch()
      const clean = redactOutput(stripAnsi(chunk))
      stderr += clean
      runOptions.onStderr?.(clean)
    })

    if (runOptions.stdin !== undefined) {
      // Ended rather than left open: the CLI reads until EOF, so an unclosed stdin
      // means it waits for more prompt and the run hangs to the idle timeout.
      child.stdin.write(runOptions.stdin)
      child.stdin.end()
    } else {
      child.stdin.end()
    }

    touch()

    const exitCode = await new Promise<number>((resolve) => {
      child.on('error', (error: Error) => {
        stderr += error.message
        resolve(1)
      })
      child.on('close', (code) => {
        // A killed process reports null, and on some platforms 0. The reason decides,
        // not the number — the same rule the pty runner learned from Linux CI.
        if (killed.reason !== null) {
          resolve(code === null || code === 0 ? 1 : code)
          return
        }
        resolve(code ?? 1)
      })
    })

    if (idleTimer !== undefined) clearTimeout(idleTimer)
    clearTimeout(hardTimer)
    runOptions.signal?.removeEventListener('abort', onAbort)
    void options.orphans?.forget(child.pid ?? -1)

    return {
      exitCode,
      stdout,
      stderr:
        killed.reason === null ? stderr : `${stderr}${stderr === '' ? '' : '\n'}${killed.reason}`,
    }
  }
}
