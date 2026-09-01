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
import { claudeSessionId } from './claudeSession'
import { HostedSession } from './hostedSession'

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
}

interface ActiveSession {
  readonly handle: SessionHandle
  readonly options: SessionOptions
  readonly hosted: HostedSession
  readonly process: ProcessHandle
  state: RuntimeStatus['state']
  failure: string | null
  lastActivityAt: string
  readonly pendingEvents: RuntimeEvent[]
  wake: (() => void) | null
  closed: boolean
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
  private readonly sessions = new Map<string, ActiveSession>()

  constructor(options: HostedClaudeRuntimeOptions = {}) {
    this.executable = options.executablePath ?? 'claude'
    this.processes = options.processes ?? null
    this.now = options.now ?? (() => new Date().toISOString())
    this.sleep = options.sleep
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
      state: 'idle',
      failure: null,
      lastActivityAt: this.now(),
      pendingEvents: [],
      wake: null,
      closed: false,
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
    const subscribe = process.onRawData?.bind(process) ?? process.onData.bind(process)
    subscribe((chunk: string) => {
      session.lastActivityAt = this.now()
      void hosted.receive(chunk)
      this.pushEvent(session, { type: 'chunk', at: session.lastActivityAt, text: chunk })
    })

    // Published so the caller can attach a pane to the real process (#170).
    options.onProcess?.({
      write: (input) => {
        process.write(input)
      },
      resize: (cols, rows) => {
        process.resize?.(cols, rows)
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

    const outcome = await session.hosted.runTurn(renderPromptPacket(packet))

    if (outcome.kind === 'blocked') {
      this.fail(session, `The CLI stopped on a ${outcome.on} dialog mid-turn`, true)
      return
    }

    if (outcome.kind === 'timeout') {
      this.fail(session, 'The turn did not finish within its budget', true)
      return
    }

    // The screen is the transcript. `exchange()` parses the report out of the
    // chunk text it has already received, exactly as it does for the headless
    // adapter — a `completed` state is what tells it the turn is over.
    session.state = 'completed'
    this.pushEvent(session, { type: 'state', at: this.now(), state: 'completed' })
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
