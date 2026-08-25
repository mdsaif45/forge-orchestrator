import { EventEmitter } from 'node:events'
import { accessSync, constants } from 'node:fs'
import { appendFile, mkdir } from 'node:fs/promises'
import { delimiter, isAbsolute, join } from 'node:path'
import { spawn as spawnPty, type IPty } from 'node-pty'
import type { OrphanTracker } from './orphans'
import { buildChildEnv, redactOutput, stripAnsi, withheldEnvNames } from './redact'

/**
 * Owns every child process Forge starts.
 *
 * A pty rather than a plain pipe, because the CLIs Forge drives are interactive
 * programs: several change behaviour when stdout is not a TTY, and some refuse to run
 * at all. `node-pty` gives them the terminal they expect.
 *
 * On the dependency's packaging, which is platform-dependent in a way worth stating:
 *
 *   - `node-pty@1.1.0` ships prebuilds for `darwin-arm64/x64` and `win32-arm64/x64`, but
 *     **not `linux-x64`**. It therefore loads untouched under this repo's
 *     `ignore-scripts=true` on Windows and macOS, and must be compiled on Linux —
 *     handled by `npm run setup`, which builds only where no prebuild exists. CI is what
 *     established this: Windows passed while Linux failed to load the module at all.
 *   - where a prebuild exists it is N-API, so one binary serves both plain Node (ABI 127)
 *     and Electron. That is the same property that made `better-sqlite3` work here.
 *
 * The guarantees this class exists to provide:
 *
 * ```
 * spawn ──> stream ──> exit
 *   │         │
 *   │         ├── idle timeout   no output for N ms  ──> killed, reported
 *   │         └── hard timeout   wall clock exceeded ──> killed, reported
 *   │
 *   ├── cancel  posix: SIGINT ─> SIGTERM ─> SIGKILL   win32: pty.kill()
 *   ├── concurrency cap with a queue
 *   └── killAll() on app quit, so nothing is orphaned
 * ```
 *
 * Three platform behaviours were measured while building this, each of which would
 * otherwise have shipped as a bug:
 *
 *   - **Windows has no signals.** `pty.kill(signal)` throws "Signals not supported on
 *     windows." from inside a deferred callback, so a `try/catch` around the call cannot
 *     catch it — it becomes an uncaught exception. The no-argument form kills the ConPTY
 *     agent, which owns the console the whole child tree is attached to.
 *   - **Windows does not search PATH.** `spawn('git', …)` throws `File not found:`, so
 *     Forge resolves bare names itself rather than routing through a shell.
 *   - **ConPTY emits control codes mid-word**, including an OSC title sequence spliced
 *     into `git --version`'s output. Output is stripped before it is stored or matched.
 */

export interface ProcessManagerOptions {
  /**
   * How many processes may run at once. Further starts queue.
   *
   * Two by default, matching the design's "max 2 concurrent agents": each spawned agent
   * is a full CLI doing real work, and oversubscribing turns a slow run into a stalled
   * machine.
   */
  readonly maxConcurrent?: number
  /** Where per-run logs are written. No logs are kept when omitted. */
  readonly logDirectory?: string
  /** Cap per run, so one runaway process cannot fill the disk. */
  readonly maxLogBytes?: number
  /** Injected for tests, so timing assertions are not tied to the wall clock. */
  readonly now?: () => number
  /**
   * Records spawned pids so a crashed run's children can be killed on the next start.
   *
   * Optional because most tests do not need it, and because the tracker writes a file —
   * a test that only checks streaming should not have to manage one.
   */
  readonly orphans?: OrphanTracker
}

export interface SpawnRequest {
  readonly command: string
  readonly args: readonly string[]
  /** Working directory. Every relative path the child reports is relative to this. */
  readonly cwd: string
  /** Added to the sanitised parent environment. */
  readonly env?: Readonly<Record<string, string>>
  /** No output for this long ends the run. This is the hang detector. */
  readonly idleTimeoutMs?: number
  /** Total wall-clock ceiling for the run. */
  readonly hardTimeoutMs?: number
  readonly cols?: number
  readonly rows?: number
}

/** Why a run ended. Distinguishing these is what lets the engine decide about retries. */
export type ProcessOutcomeReason =
  'exited' | 'cancelled' | 'idle-timeout' | 'hard-timeout' | 'spawn-failed'

export interface ProcessOutcome {
  readonly runId: string
  readonly reason: ProcessOutcomeReason
  /** Null when the process was killed before reporting one. */
  readonly exitCode: number | null
  readonly signal: number | null
  readonly durationMs: number
  /** Redacted. Capped at `maxLogBytes`. */
  readonly output: string
  readonly truncated: boolean
  /** Set for `spawn-failed`, so the caller need not infer the cause. */
  readonly failure: string | null
}

export interface ProcessHandle {
  readonly runId: string
  /** Redacted output as it arrives, for a live log. */
  onData(listener: (text: string) => void): () => void
  /** Resolves when the run ends, however it ends. Never rejects. */
  readonly completed: Promise<ProcessOutcome>
  write(input: string): void
  /** Escalating termination. Safe to call more than once. */
  cancel(reason?: string): Promise<void>
}

interface Run {
  readonly runId: string
  readonly request: SpawnRequest
  readonly startedAt: number
  pty: IPty | null
  readonly emitter: EventEmitter
  output: string
  outputBytes: number
  truncated: boolean
  lastDataAt: number
  settled: boolean
  reason: ProcessOutcomeReason
  failure: string | null
  cancelling: boolean
  idleTimer: NodeJS.Timeout | null
  hardTimer: NodeJS.Timeout | null
  killTimers: NodeJS.Timeout[]
  resolve: (outcome: ProcessOutcome) => void
}

/**
 * Resolves a bare command name against PATH.
 *
 * `node-pty` on Windows passes the command straight to `CreateProcess`, which does **not**
 * search PATH the way a shell does — `spawn('git', …)` throws `File not found:` from the
 * pty constructor. Measured, not assumed: the same call works on POSIX and fails here.
 *
 * Resolution happens in Forge rather than by routing through a shell, because a shell
 * would reintroduce the injection surface that `execFile` was chosen to avoid in
 * `GitService`. An unresolvable name is returned unchanged, so the failure surfaces as a
 * normal `spawn-failed` outcome with the original name in the message.
 */
/* eslint-disable @typescript-eslint/dot-notation -- env is an index signature; bracket
   access is required by noPropertyAccessFromIndexSignature. */
/**
 * Resolves a bare command name against PATH and PATHEXT.
 *
 * Exported because the pipe runner needs the same resolution: `CreateProcess` does not
 * search PATH, so a bare `claude` fails with ENOENT however it is spawned. One
 * implementation rather than two, since the Windows rules here are the kind that get
 * subtly wrong on a second attempt (#131).
 */
export function resolveCommand(command: string, env: Readonly<Record<string, string>>): string {
  if (command.includes('/') || command.includes('\\') || isAbsolute(command)) return command

  const pathValue = env['PATH'] ?? env['Path'] ?? process.env['PATH'] ?? ''
  const directories = pathValue.split(delimiter).filter((entry) => entry !== '')

  // PATHEXT is how Windows knows `git` means `git.exe`; a bare name matches nothing.
  const extensions =
    process.platform === 'win32'
      ? (env['PATHEXT'] ?? process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';')
      : ['']

  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = join(directory, command + extension.toLowerCase())
      try {
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch {
        // Try the next combination.
      }
    }
  }

  return command
}
/* eslint-enable @typescript-eslint/dot-notation */

const DEFAULT_MAX_CONCURRENT = 2
const DEFAULT_MAX_LOG_BYTES = 2 * 1024 * 1024
/** Grace between escalating signals. Long enough for a clean exit, short enough to matter. */
const SIGNAL_GRACE_MS = 2_000

export class ProcessManager {
  private readonly maxConcurrent: number
  private readonly logDirectory: string | null
  private readonly maxLogBytes: number
  private readonly now: () => number
  private readonly orphans: OrphanTracker | null

  private readonly running = new Map<string, Run>()
  private readonly queue: (() => void)[] = []
  private counter = 0
  private disposed = false

  constructor(options: ProcessManagerOptions = {}) {
    this.maxConcurrent = options.maxConcurrent ?? DEFAULT_MAX_CONCURRENT
    this.logDirectory = options.logDirectory ?? null
    this.maxLogBytes = options.maxLogBytes ?? DEFAULT_MAX_LOG_BYTES
    this.now = options.now ?? Date.now
    this.orphans = options.orphans ?? null
  }

  /** How many runs are executing, as opposed to queued. */
  get activeCount(): number {
    return this.running.size
  }

  get queuedCount(): number {
    return this.queue.length
  }

  /**
   * Starts a process, queueing if the concurrency cap is reached.
   *
   * Resolves once the process is actually spawned, so a caller awaiting this has a
   * handle whose `runId` is meaningful. A spawn failure resolves too, with a handle
   * whose `completed` reports `spawn-failed` — a rejection here would force every
   * caller to handle two different error channels for one condition.
   */
  async spawn(request: SpawnRequest): Promise<ProcessHandle> {
    if (this.disposed) {
      throw new Error('ProcessManager has been disposed and cannot start new processes')
    }

    if (this.running.size >= this.maxConcurrent) {
      await new Promise<void>((resolve) => {
        this.queue.push(resolve)
      })
    }

    this.counter += 1
    const runId = `run-${String(this.counter).padStart(4, '0')}`

    let resolveCompleted!: (outcome: ProcessOutcome) => void
    const completed = new Promise<ProcessOutcome>((resolve) => {
      resolveCompleted = resolve
    })

    const run: Run = {
      runId,
      request,
      startedAt: this.now(),
      pty: null,
      emitter: new EventEmitter(),
      output: '',
      outputBytes: 0,
      truncated: false,
      lastDataAt: this.now(),
      settled: false,
      reason: 'exited',
      failure: null,
      cancelling: false,
      idleTimer: null,
      hardTimer: null,
      killTimers: [],
      resolve: resolveCompleted,
    }

    this.running.set(runId, run)

    // A sanitised environment, not `process.env`: Forge's own credentials must not reach
    // a child, and defaulting to drop means a new secret-shaped variable is excluded
    // without anyone remembering to exclude it (rule R7).
    const childEnv = buildChildEnv(process.env, request.env ?? {})

    try {
      run.pty = spawnPty(resolveCommand(request.command, childEnv), [...request.args], {
        cwd: request.cwd,
        env: childEnv,
        cols: request.cols ?? 120,
        rows: request.rows ?? 30,
      })
    } catch (error) {
      run.failure = error instanceof Error ? error.message : String(error)
      this.settle(run, 'spawn-failed')
      return this.handleFor(run, completed)
    }

    // Recorded immediately after the spawn, so a crash between here and the first output
    // still leaves a trace to reap on the next start.
    void this.orphans?.record({
      pid: run.pty.pid,
      command: `${request.command} ${request.args.join(' ')}`.trim(),
      startedAt: new Date(this.now()).toISOString(),
    })

    run.pty.onData((data) => {
      this.record(run, data)
    })

    run.pty.onExit(({ exitCode, signal }) => {
      this.settle(run, run.reason === 'exited' ? 'exited' : run.reason, exitCode, signal ?? null)
    })

    this.armTimers(run)

    return this.handleFor(run, completed)
  }

  private handleFor(run: Run, completed: Promise<ProcessOutcome>): ProcessHandle {
    return {
      runId: run.runId,
      onData: (listener) => {
        run.emitter.on('data', listener)
        return () => {
          run.emitter.off('data', listener)
        }
      },
      completed,
      write: (input) => {
        run.pty?.write(input)
      },
      cancel: async (reason = 'cancelled by Forge') => {
        await this.cancel(run.runId, reason)
      },
    }
  }

  /**
   * Records output, redacting before it is stored or emitted.
   *
   * Redaction happens here rather than at write time so a secret never reaches a
   * listener either — a live log rendered in the UI is as durable as a file once it is
   * on screen.
   */
  private record(run: Run, data: string): void {
    run.lastDataAt = this.now()

    // Stripped before redaction, and before anything stores or emits it. A pty makes the
    // child emit control codes, and ConPTY splices a title sequence *inside* a word — so
    // raw output cannot be matched against reliably, and a redaction pattern could be
    // defeated by an escape sequence landing mid-token.
    const safe = redactOutput(stripAnsi(data))
    const bytes = Buffer.byteLength(safe, 'utf8')

    if (run.outputBytes + bytes > this.maxLogBytes) {
      // Capped rather than rotated: the tail of a runaway process is rarely the useful
      // part, and an unbounded buffer is how one bad run exhausts memory.
      if (!run.truncated) {
        run.truncated = true
        run.output += `\n[output truncated at ${String(this.maxLogBytes)} bytes]\n`
      }
    } else {
      run.output += safe
      run.outputBytes += bytes
    }

    run.emitter.emit('data', safe)

    // Re-armed on every chunk: the idle timeout measures silence, not total duration.
    this.armIdleTimer(run)
  }

  private armTimers(run: Run): void {
    this.armIdleTimer(run)

    const hard = run.request.hardTimeoutMs
    if (hard !== undefined) {
      run.hardTimer = setTimeout(() => {
        void this.terminate(run, 'hard-timeout', `exceeded ${String(hard)}ms`)
      }, hard)
    }
  }

  private armIdleTimer(run: Run): void {
    const idle = run.request.idleTimeoutMs
    if (idle === undefined) return

    if (run.idleTimer !== null) clearTimeout(run.idleTimer)
    run.idleTimer = setTimeout(() => {
      // The definition of done: a hung process is killed and reported, never silently
      // stuck. A run that produces nothing for this long is treated as hung even
      // though the process is technically alive.
      void this.terminate(run, 'idle-timeout', `no output for ${String(idle)}ms`)
    }, idle)
  }

  async cancel(runId: string, reason = 'cancelled by Forge'): Promise<void> {
    const run = this.running.get(runId)
    if (run === undefined) return

    await this.terminate(run, 'cancelled', reason)
  }

  /**
   * Ends a run, escalating signals until the process is gone.
   *
   * ```
   * posix    SIGINT ──grace──> SIGTERM ──grace──> SIGKILL
   * win32    pty.kill()   — one shot; signals are not supported at all
   * ```
   *
   * Routed through the pty rather than `process.kill(pid)` either way: the pty owns the
   * console (Windows) or the process group (POSIX) that the child's own children are
   * attached to, so killing it takes the tree. Killing the pid alone would leave a
   * spawned shell's grandchildren running against the user's repository.
   */
  private async terminate(run: Run, reason: ProcessOutcomeReason, detail: string): Promise<void> {
    if (run.settled || run.cancelling) return
    run.cancelling = true
    run.reason = reason
    run.failure = detail

    const pty = run.pty
    if (pty === null) {
      this.settle(run, reason)
      return
    }

    this.clearTimers(run)

    // `kill()` with no argument on both platforms, and escalation only where signals
    // exist. Measured in `node-pty@1.1.0`: `WindowsTerminal.kill(signal)` throws
    // "Signals not supported on windows." for *any* signal, and it throws from inside a
    // deferred callback, so a try/catch around the call cannot catch it — it surfaces as
    // an uncaught exception that takes the process down.
    //
    // The no-argument form is not a weaker kill on Windows: it closes the pty and kills
    // the ConPTY agent, which owns the console the child and its descendants are attached
    // to, so the tree goes with it. That is the same guarantee the POSIX path reaches via
    // signals, arrived at differently.
    const kill = (signal?: string): void => {
      try {
        if (signal === undefined || process.platform === 'win32') {
          pty.kill()
        } else {
          pty.kill(signal)
        }
      } catch {
        // Already exited between the settled check and this call.
      }
    }

    const escalate = (signal: string, delay: number): void => {
      const timer = setTimeout(() => {
        if (run.settled) return
        kill(signal)
      }, delay)
      run.killTimers.push(timer)
    }

    // SIGINT first because it is what Ctrl-C sends: a well-behaved CLI treats it as
    // "stop cleanly", which is what rule R8 asks for.
    kill(process.platform === 'win32' ? undefined : 'SIGINT')

    if (process.platform !== 'win32') {
      escalate('SIGTERM', SIGNAL_GRACE_MS)
      escalate('SIGKILL', SIGNAL_GRACE_MS * 2)
    }

    // Resolves when the process actually exits — `onExit` settles the run — rather than
    // when the signal was sent. A caller awaiting `cancel()` needs the former, since the
    // point of cancelling is that the process is gone afterwards.
    await new Promise<void>((resolve) => {
      if (run.settled) {
        resolve()
        return
      }
      run.emitter.once('settled', resolve)
    })
  }

  private settle(
    run: Run,
    reason: ProcessOutcomeReason,
    exitCode: number | null = null,
    signal: number | null = null,
  ): void {
    if (run.settled) return
    run.settled = true

    this.clearTimers(run)
    for (const timer of run.killTimers) clearTimeout(timer)
    run.killTimers.length = 0

    const outcome: ProcessOutcome = {
      runId: run.runId,
      reason,
      exitCode,
      signal,
      durationMs: this.now() - run.startedAt,
      output: run.output,
      truncated: run.truncated,
      failure: run.failure,
    }

    this.running.delete(run.runId)
    if (run.pty !== null) void this.orphans?.forget(run.pty.pid)
    run.resolve(outcome)
    run.emitter.emit('settled')

    // Written after resolving, so a slow disk cannot delay the caller. A failure to
    // persist a log must not fail the run itself.
    void this.persist(run, outcome).catch(() => undefined)

    const next = this.queue.shift()
    next?.()
  }

  private clearTimers(run: Run): void {
    if (run.idleTimer !== null) {
      clearTimeout(run.idleTimer)
      run.idleTimer = null
    }
    if (run.hardTimer !== null) {
      clearTimeout(run.hardTimer)
      run.hardTimer = null
    }
  }

  /** Writes the run's log, so a workflow step can link to what actually happened. */
  private async persist(run: Run, outcome: ProcessOutcome): Promise<void> {
    if (this.logDirectory === null) return

    await mkdir(this.logDirectory, { recursive: true })

    const header = [
      `run: ${outcome.runId}`,
      `command: ${run.request.command} ${run.request.args.join(' ')}`,
      `cwd: ${run.request.cwd}`,
      `reason: ${outcome.reason}`,
      `exitCode: ${String(outcome.exitCode)}`,
      `durationMs: ${String(outcome.durationMs)}`,
      // Recorded so the redaction decision is auditable rather than invisible.
      `withheldEnv: ${withheldEnvNames(process.env).join(', ')}`,
      '',
    ].join('\n')

    await appendFile(
      join(this.logDirectory, `${outcome.runId}.log`),
      header + outcome.output,
      'utf8',
    )
  }

  /**
   * Kills everything and refuses further spawns.
   *
   * Called on app quit. Without it, a killed Electron process leaves its agent CLIs
   * running against the user's repository with nothing supervising them — which is
   * worse than a crash, because the work keeps happening unobserved.
   */
  async killAll(reason = 'Forge is shutting down'): Promise<void> {
    this.disposed = true

    // Release anything waiting for a slot, so no caller is left pending forever.
    while (this.queue.length > 0) {
      this.queue.shift()?.()
    }

    // Every run in parallel: quit must not take the sum of each process's grace period.
    // `terminate` resolves once the process has actually exited, so this returning means
    // nothing is left running — which is the guarantee the app-quit handler needs.
    await Promise.all(
      [...this.running.values()].map((run) => this.terminate(run, 'cancelled', reason)),
    )
  }
}
