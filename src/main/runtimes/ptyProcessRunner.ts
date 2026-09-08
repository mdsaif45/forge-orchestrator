import type { ProcessManager } from '../process/processManager'
import type { ProcessRunner } from './claudeCliRuntime'

export interface PtyProcessRunnerOptions {
  readonly processes: ProcessManager
  /** No output for this long ends the run. This is the hang detector. */
  readonly idleTimeoutMs?: number
  /** Total wall-clock ceiling for one turn. */
  readonly hardTimeoutMs?: number
}

/**
 * A `ProcessRunner` backed by the real pty, so an adapter can drive an actual CLI.
 *
 * `ProcessManager` already solves the parts that are genuinely hard on Windows — no
 * POSIX signals, `CreateProcess` not searching PATH, ConPTY splicing OSC sequences
 * into output, orphan tracking across a crash — so this is deliberately a thin
 * adaptation between two shapes rather than a second spawner.
 *
 * ```
 * ProcessRunner            ProcessManager
 *   onStdout(chunk)   <──  handle.onData        (redacted as it arrives)
 *   exitCode          <──  outcome.exitCode
 *   signal            <──  cancel()
 * ```
 *
 * One honest limitation: a pty is a single stream by construction, so stderr is
 * interleaved with stdout and cannot be separated. `onStderr` is therefore never
 * called, rather than being fed a guess about which bytes were which. Callers that
 * need the distinction cannot get it from a terminal — that is a property of ptys,
 * not of this code.
 */
export function createPtyProcessRunner(options: PtyProcessRunnerOptions): ProcessRunner {
  const { processes, idleTimeoutMs, hardTimeoutMs } = options

  return async (command, args, runOptions) => {
    const handle = await processes.spawn({
      command,
      args,
      cwd: runOptions.cwd,
      ...(runOptions.env === undefined ? {} : { env: runOptions.env }),
      ...(idleTimeoutMs === undefined ? {} : { idleTimeoutMs }),
      ...(hardTimeoutMs === undefined ? {} : { hardTimeoutMs }),
    })

    // Published before any output is consumed, so a pane attaching immediately
    // does not miss the first frames of the run (#170). A pty carries input as
    // well as output, so both `write` and `resize` are real here — unlike the
    // pipe runner, which closes stdin after the prompt.
    runOptions.onProcess?.({
      write: (input) => {
        handle.write(input)
      },
      resize: (cols, rows) => {
        handle.resize?.(cols, rows)
      },
      onData: (listener: (chunk: string) => void) => {
        const sub = handle.onRawData?.bind(handle) ?? handle.onData.bind(handle)
        return sub(listener)
      },
    })

    const unsubscribe = handle.onData((text) => {
      runOptions.onStdout?.(text)
    })

    if (runOptions.stdin !== undefined) {
      // A pty cannot carry stdin to a child that requires piped input: it *is* a
      // terminal, so the child sees a TTY and takes the interactive path. Measured
      // against the real CLI, which answers "Input must be provided either through
      // stdin or as a prompt argument" however the bytes are written (#131).
      //
      // Refused rather than silently ignored, because a prompt that vanishes is
      // exactly the defect this transport exists to fix. Use `createPipeProcessRunner`
      // for a call that carries stdin.
      throw new Error(
        'The pty runner cannot deliver stdin: a pty is a terminal, and a child requiring piped input will not read it. Use the pipe runner for this call.',
      )
    }

    // Cancellation reaches the child through the manager's escalating kill rather than
    // by rejecting here: a promise that resolves while the process keeps running would
    // leak an agent that still holds the worktree.
    const abort = runOptions.signal
    const onAbort = (): void => {
      void handle.cancel('cancelled by the workflow')
    }
    abort?.addEventListener('abort', onAbort, { once: true })
    if (abort?.aborted === true) onAbort()

    try {
      const outcome = await handle.completed

      // The reason is authoritative, not the code. A killed pty does not report a
      // consistent exit status across platforms: on Windows it comes back null, and on
      // Linux it can come back 0 — which CI caught, because trusting the code there
      // made a timeout or a cancellation read as a clean turn. Anything that did not
      // end by exiting on its own is a failure regardless of the number attached.
      const reportedCode = outcome.exitCode ?? 1
      const exitCode =
        outcome.reason === 'exited' ? reportedCode : reportedCode === 0 ? 1 : reportedCode

      return {
        exitCode,
        stdout: outcome.output,
        // A pty cannot separate the streams, so the failure reason is the only thing
        // here that genuinely belongs to stderr's role: saying why a run ended badly.
        stderr: outcome.failure ?? (outcome.reason === 'exited' ? '' : outcome.reason),
      }
    } finally {
      unsubscribe()
      abort?.removeEventListener('abort', onAbort)
    }
  }
}
