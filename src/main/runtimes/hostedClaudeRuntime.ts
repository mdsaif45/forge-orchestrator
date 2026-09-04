import { randomUUID } from 'node:crypto'
import {
  DEFAULT_PERMISSION_MODE,
  renderPromptPacket,
  runtimeIdSchema,
  sessionIdSchema,
  type Capability,
  type IAgentRuntime,
  type PermissionMode,
  type PromptPacket,
  type RuntimeEvent,
  type RuntimeStatus,
  type SessionHandle,
  type SessionOptions,
} from '@shared/domain'
import type { ProcessHandle, ProcessManager } from '../process/processManager'
import { ClaudeHookBridge } from './claudeHooks'
import { claudeSessionId } from './claudeSession'
import { HostedSession } from './hostedSession'
import { blockingPrompt, promptKeystrokes } from './interactiveTurn'

/**
 * The Claude CLI hosted as a real interactive session, rather than spawned
 * headless once per turn.
 *
 * Registered alongside `ClaudeCliRuntime` rather than replacing it. The headless
 * path works today and produces real audits; this one is proven for a single turn
 * in a probe, not yet for a five-stage workflow with retries and reconciliation.
 * Two ids let both run against the same repository and be compared before
 * anything is deleted — replacing outright would leave no working path to fall
 * back to if this misbehaves mid-workflow.
 *
 * ```
 * start   spawn the CLI on a pty, wait for its prompt box
 * send    type the prompt, wait for the turn to finish
 * events  chunk/state, from the emulator's screen
 * dispose kill the process
 * ```
 *
 * What this buys, measured: a turn answered in ~8s where the headless path took
 * ~130s for the same work, and the session stays warm afterwards — the next turn
 * pays no cold start. See `docs/CLI-FIELD-GUIDE.md`.
 */
export interface HostedClaudeRuntimeOptions {
  readonly executablePath?: string
  readonly processes?: ProcessManager
  readonly now?: () => string
  /** Injected so a test drives time rather than waiting on it. */
  readonly sleep?: (ms: number) => Promise<void>
  /**
   * Where the shared hook receiver script is written. Required to learn turn
   * completion from the CLI's own `Stop` hook instead of the screen (#169) —
   * four screen-only rules were tried and all four were wrong, see
   * `docs/CLI-FIELD-GUIDE.md` §9. Optional only so existing unit tests that
   * never call `send` need not supply it.
   */
  readonly hookReceiverDir?: string
}

interface ActiveSession {
  readonly handle: SessionHandle
  readonly options: SessionOptions
  readonly hosted: HostedSession
  readonly process: ProcessHandle
  /** Null when no hook receiver directory was configured for this runtime. */
  readonly hooks: ClaudeHookBridge | null
  state: RuntimeStatus['state']
  failure: string | null
  lastActivityAt: string
  readonly pendingEvents: RuntimeEvent[]
  wake: (() => void) | null
  closed: boolean
  /**
   * Set once a turn's race has a winner, so the losing `watchForDialog` loop
   * stops polling instead of running forever in the background of the next
   * turn — a dialog watcher that never learns the turn ended would eventually
   * report a PRIOR turn's leftover dialog text as belonging to a new one.
   */
  dialogWatchCancelled: boolean
  /**
   * Whether the boot-settle wait has run for this process yet.
   *
   * Only the first turn needs it: a resumed or already-idle session has no
   * boot noise left to wait out, and re-running it on every turn would cost a
   * needless 1.5s+ pause per step.
   */
  bootSettled: boolean
}

const CLAUDE_CAPABILITIES: readonly Capability[] = [
  'repo-read',
  'plan',
  'file-write',
  'test',
  'review',
  'terminal',
]

export class HostedClaudeRuntime implements IAgentRuntime {
  /**
   * A distinct id from the headless adapter, so both can be registered and a
   * binding can choose between them.
   */
  readonly id = runtimeIdSchema.parse('claude-cli-hosted')
  readonly capabilities = CLAUDE_CAPABILITIES
  readonly simulated = false
  readonly supportsAccountIsolation = true
  /**
   * Empty, unlike the headless adapter's `['CLAUDE.md']`.
   *
   * That adapter runs with `--safe-mode`, which stops the CLI reading a
   * repository's own instructions, so Forge reads the file and puts it in the
   * packet itself (#145). A hosted session runs the CLI unmodified and it loads
   * `CLAUDE.md` on its own — declaring the name here would put the same
   * instructions in twice.
   */
  readonly instructionFilenames: readonly string[] = []

  private readonly executable: string
  private readonly processes: ProcessManager | null
  private readonly now: () => string
  private readonly sleep: ((ms: number) => Promise<void>) | undefined
  private readonly hookReceiverDir: string | null
  private readonly sessions = new Map<string, ActiveSession>()

  constructor(options: HostedClaudeRuntimeOptions = {}) {
    this.executable = options.executablePath ?? 'claude'
    this.processes = options.processes ?? null
    this.now = options.now ?? (() => new Date().toISOString())
    this.sleep = options.sleep
    this.hookReceiverDir = options.hookReceiverDir ?? null
  }

  async start(options: SessionOptions): Promise<SessionHandle> {
    // A2/A3: a runtime with nothing to spawn must fail loudly. Reporting success
    // for work that never happened is the exact failure this product exists to
    // catch in agents, and it cannot be acceptable in Forge's own adapter.
    if (this.processes === null) {
      throw new Error('HostedClaudeRuntime has no process manager configured; cannot execute')
    }

    const handle: SessionHandle = {
      sessionId: sessionIdSchema.parse(`claude-hosted-${randomUUID()}`),
      runtimeId: this.id,
    }

    // Installed before the CLI spawns, so its very first turn already reports
    // through the hook rather than the second one onward.
    let hooks: ClaudeHookBridge | null = null
    if (this.hookReceiverDir !== null) {
      hooks = new ClaudeHookBridge(options.repositoryPath, { receiverDir: this.hookReceiverDir })
      await hooks.install()
    }

    const process = await this.processes.spawn({
      command: this.executable,
      args: this.argsFor(options),
      cwd: options.repositoryPath,
      cols: 120,
      rows: 30,
    })

    const hosted = new HostedSession({
      write: (data) => {
        process.write(data)
      },
      ...(this.sleep === undefined ? {} : { sleep: this.sleep }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    })

    const session: ActiveSession = {
      handle,
      options,
      hosted,
      process,
      hooks,
      state: 'idle',
      failure: null,
      lastActivityAt: this.now(),
      pendingEvents: [],
      wake: null,
      closed: false,
      dialogWatchCancelled: false,
      bootSettled: false,
    }

    // RAW output, not the redacted stream. `ProcessManager` strips ANSI before
    // emitting `data` — correct for logs, since a redaction pattern must not be
    // defeatable by an escape landing mid-token — but an emulator given plain text
    // can never resolve a screen. Measured: with the stripped stream the turn
    // timed out at 240s where the same prompt answers in ~8s.
    //
    // Falls back to `onData` when a handle offers no raw channel, so a fake in a
    // test still drives the session; the screen is then approximate, which is
    // acceptable for a unit test and never used against a real CLI.
    // NOT re-emitted as a `chunk` RuntimeEvent here. Measured: exchange() reads
    // every `chunk` it sees and accumulates them into the text it parses a
    // report from (`case 'chunk': text += event.text`) — the same rule that
    // makes the headless adapters careful not to emit the wrapped envelope
    // alongside the unwrapped reply (#130). A live pane subscribes through
    // `onProcess.write`/raw output directly; the ONE clean `chunk` for
    // exchange() to parse comes from `runTurnByHook`, built from the hook's
    // exact reply text, not from raw ANSI-laden terminal output.
    const subscribe = process.onRawData?.bind(process) ?? process.onData.bind(process)
    subscribe((chunk: string) => {
      session.lastActivityAt = this.now()
      void hosted.receive(chunk)
    })

    // Published so the caller can attach a pane to the real process (#170).
    options.onProcess?.({
      write: (input) => {
        process.write(input)
      },
      resize: (cols, rows) => {
        process.resize?.(cols, rows)
      },
      onData: (listener) => {
        const sub = process.onRawData?.bind(process) ?? process.onData.bind(process)
        return sub(listener)
      },
    })

    this.sessions.set(handle.sessionId, session)
    return handle
  }

  async send(sessionHandle: SessionHandle, packet: PromptPacket): Promise<void> {
    const session = this.getSession(sessionHandle)
    if (session.closed) throw new Error(`Session "${sessionHandle.sessionId}" is closed`)

    session.state = 'working'
    session.lastActivityAt = this.now()
    this.pushEvent(session, { type: 'state', at: session.lastActivityAt, state: 'working' })

    // On the FIRST turn only: wait past the prompt box appearing until the
    // screen stops changing. Measured: the caret is visible within a second of
    // boot, while MCP-authentication warnings, SessionStart hook output, and
    // plugin banners keep painting for several seconds after. A prompt typed
    // as soon as the caret appears can be answered against that trailing
    // noise instead of the task — measured directly, a real turn got a reply
    // about the global CLAUDE.md's own instruction rather than the objective,
    // because it landed mid-boot.
    if (!session.bootSettled) {
      await session.hosted.waitForBootSettled()
      session.bootSettled = true
    }

    // The prompt box has to exist before anything is typed. Typing earlier sends
    // characters into whatever is on screen — during a trust dialog they vanish
    // entirely and the run appears to hang (#166).
    const ready = await session.hosted.waitForPrompt()
    if (ready !== 'ready') {
      this.fail(
        session,
        ready === 'timeout'
          ? 'The CLI never presented a prompt; it may still be starting or is wedged'
          : `The CLI is waiting on a ${ready} dialog that Forge cannot answer`,
        // A dialog means an assumption failed rather than the work being wrong,
        // so a retry after fixing it is meaningful.
        ready !== 'timeout',
      )
      return
    }

    if (session.hooks !== null) {
      await this.runTurnByHook(session, session.hooks, packet)
      return
    }

    // No hook bridge configured (only reachable in a test with no
    // hookReceiverDir): fall back to reading the screen, which is known to be
    // unreliable — see docs/CLI-FIELD-GUIDE.md §9.
    const outcome = await session.hosted.runTurn(renderPromptPacket(packet))

    if (outcome.kind === 'blocked') {
      this.fail(session, `The CLI stopped on a ${outcome.on} dialog mid-turn`, true)
      return
    }

    if (outcome.kind === 'timeout') {
      this.fail(session, 'The turn did not finish within its budget', true)
      return
    }

    session.state = 'completed'
    this.pushEvent(session, { type: 'state', at: this.now(), state: 'completed' })
  }

  /**
   * Delivers a prompt and learns completion from the CLI's own `Stop` hook.
   *
   * Verified against the real CLI: `Stop` fires with `last_assistant_message`
   * equal to the exact reply text — multi-line preserved — while the process is
   * STILL RUNNING, well before the four screen-only heuristics that were tried
   * and rejected (`docs/CLI-FIELD-GUIDE.md` §9) could tell the difference
   * between "still booting" and "turn finished".
   *
   * The screen is still typed into and still watched for a mid-turn dialog —
   * `blockingPrompt` on the live screen remains the only way to notice a
   * permission prompt appear, since a blocked turn produces no `Stop` at all.
   * The hook and the screen are racing signals for two different outcomes, not
   * two readings of the same one.
   */
  private async runTurnByHook(
    session: ActiveSession,
    hooks: ClaudeHookBridge,
    packet: PromptPacket,
  ): Promise<void> {
    session.dialogWatchCancelled = false

    const prompt = renderPromptPacket(packet)
    for (const key of promptKeystrokes(prompt)) {
      session.process.write(key.text)
      if (key.pauseMs > 0) await this.sleepFor(key.pauseMs)
    }

    const timeoutMs = session.options.timeoutMs ?? 600_000
    const deadline = this.sleepFor(timeoutMs).then(() => 'timeout' as const)

    const stopWatch = hooks.next().then((event) => ({ kind: 'stop' as const, event }))
    const dialogWatch = this.watchForDialog(session).then((on) => ({
      kind: 'dialog' as const,
      on,
    }))

    const winner = await Promise.race([stopWatch, dialogWatch, deadline])
    session.dialogWatchCancelled = true

    if (winner === 'timeout') {
      this.fail(session, 'The turn did not finish within its budget', true)
      return
    }

    if (winner.kind === 'dialog') {
      this.fail(session, `The CLI stopped on a ${winner.on} dialog mid-turn`, true)
      return
    }

    // The reply arrives whole from the hook; parseAgentReport (via exchange())
    // reads it from the accumulated chunk text exactly as it does for the
    // headless adapter, so it is emitted once here rather than left to have
    // already streamed in via raw output — the streamed copy still contains
    // ANSI-framed duplicates of the same text and must not be double-counted.
    if (winner.event.lastAssistantMessage !== null) {
      this.pushEvent(session, {
        type: 'chunk',
        at: this.now(),
        text: winner.event.lastAssistantMessage,
      })
    }

    session.state = 'completed'
    this.pushEvent(session, { type: 'state', at: this.now(), state: 'completed' })
  }

  /**
   * Polls the live screen only for a dialog appearing, at a much coarser
   * interval than the old completion polling needed — this is a fallback net,
   * not the primary signal.
   */
  private async watchForDialog(session: ActiveSession): Promise<'trust' | 'permission'> {
    for (;;) {
      if (session.dialogWatchCancelled) {
        // The caller has already decided via another branch of the race; stop
        // polling rather than resolving with a stale reading against the next
        // turn's screen.
        return new Promise<'trust' | 'permission'>(() => undefined)
      }
      const on = blockingPrompt(session.hosted.visible())
      if (on !== null) return on
      await this.sleepFor(500)
    }
  }

  private sleepFor(ms: number): Promise<void> {
    return this.sleep !== undefined ? this.sleep(ms) : new Promise((r) => setTimeout(r, ms))
  }

  async *events(sessionHandle: SessionHandle): AsyncIterable<RuntimeEvent> {
    const session = this.getSession(sessionHandle)

    while (!session.closed || session.pendingEvents.length > 0) {
      if (session.pendingEvents.length === 0) {
        await new Promise<void>((resolve) => {
          session.wake = resolve
        })
        session.wake = null
      }

      while (session.pendingEvents.length > 0) {
        const event = session.pendingEvents.shift()
        if (event !== undefined) yield event
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async status(sessionHandle: SessionHandle): Promise<RuntimeStatus> {
    const session = this.getSession(sessionHandle)
    return {
      sessionId: sessionHandle.sessionId,
      state: session.state,
      lastActivityAt: session.lastActivityAt,
      failure: session.failure,
    }
  }

  async cancel(sessionHandle: SessionHandle, reason: string): Promise<void> {
    const session = this.sessions.get(sessionHandle.sessionId)
    if (session === undefined) return

    session.state = 'cancelled'
    await session.process.cancel(reason)
    this.close(session)
  }

  async dispose(sessionHandle: SessionHandle): Promise<void> {
    const session = this.sessions.get(sessionHandle.sessionId)
    if (session === undefined) return

    // A hosted session never exits on its own — it waits for the next prompt
    // forever. Disposing has to kill it, or every finished workflow leaves a CLI
    // running against a worktree that is about to be removed.
    await session.process.cancel('disposed')
    this.close(session)
    this.sessions.delete(sessionHandle.sessionId)
  }

  /** The interactive argv. No `-p`, no `--output-format`, no `--safe-mode`. */
  private argsFor(options: SessionOptions): readonly string[] {
    const mode = options.permissionMode ?? DEFAULT_PERMISSION_MODE

    return [
      ...(options.resumeKey === undefined
        ? []
        : ['--session-id', claudeSessionId(options.resumeKey)]),
      ...permissionArgs(mode),
    ]
  }

  private fail(session: ActiveSession, message: string, retryable: boolean): void {
    session.state = 'failed'
    session.failure = message
    this.pushEvent(session, {
      type: 'error',
      at: this.now(),
      message,
      retryable,
      // A limit is detected from the CLI's own signal in the headless adapter; a
      // hosted screen has no equivalent yet, so this is never claimed here rather
      // than guessed from prose.
      providerLimit: false,
    })
  }

  private close(session: ActiveSession): void {
    session.closed = true
    session.dialogWatchCancelled = true
    session.hooks?.close()
    if (session.wake !== null) {
      session.wake()
      session.wake = null
    }
  }

  private getSession(handle: SessionHandle): ActiveSession {
    const session = this.sessions.get(handle.sessionId)
    if (session === undefined) throw new Error(`Unknown session "${handle.sessionId}"`)
    return session
  }

  private pushEvent(session: ActiveSession, event: RuntimeEvent): void {
    session.pendingEvents.push(event)
    if (session.wake !== null) {
      session.wake()
      session.wake = null
    }
  }
}

/**
 * Forge's permission vocabulary as this CLI's flags.
 *
 * `bypassPermissions` is not a value `--permission-mode` accepts; the CLI has a
 * differently named flag. Passing Forge's own word through unmapped is a
 * spawn-time failure on every writing step.
 */
function permissionArgs(mode: PermissionMode): readonly string[] {
  if (mode === 'bypassPermissions') return ['--dangerously-skip-permissions']
  return ['--permission-mode', mode]
}
