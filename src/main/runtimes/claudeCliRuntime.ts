import { randomUUID } from 'node:crypto'
import {
  DEFAULT_PERMISSION_MODE,
  renderPromptPacket,
  runtimeIdSchema,
  sessionIdSchema,
  type Capability,
  type IAgentRuntime,
  type PromptPacket,
  type RuntimeEvent,
  type RuntimeStatus,
  type SessionHandle,
  type SessionOptions,
} from '@shared/domain'
import { accountEnv } from '../accounts/accountAuth'

export interface ProcessRunnerResult {
  readonly exitCode: number
  readonly stdout: string
  readonly stderr: string
}

export type ProcessRunner = (
  command: string,
  args: readonly string[],
  options: {
    readonly cwd: string
    /** Added to the child's environment. Carries the account's home when one is bound. */
    readonly env?: Readonly<Record<string, string>>
    /**
     * Written to the child's stdin, then closed.
     *
     * The prompt travels this way rather than as an argument: a multi-line prompt
     * passed through `-p` on Windows reached the CLI empty, and the agent replied
     * "What would you like me to do?" to every step (#131). Stdin is not subject to
     * any of the quoting and re-parsing between here and the process.
     */
    readonly stdin?: string
    readonly onStdout?: (chunk: string) => void
    readonly onStderr?: (chunk: string) => void
    readonly signal?: AbortSignal
  },
) => Promise<ProcessRunnerResult>

export interface ClaudeCliRuntimeOptions {
  readonly executablePath?: string
  readonly runner?: ProcessRunner
  readonly now?: () => string
  /**
   * Resolves an account id to the isolated home holding its credential.
   *
   * Injected rather than resolved here so the adapter keeps no filesystem knowledge:
   * it knows a session may name an account, not where Forge stores one. Returns null
   * for an account that was never enrolled, which is a spawn-time failure rather than
   * a silent fall back to the machine's default identity — running as the wrong
   * account is the failure mode #111 exists to prevent.
   */
  readonly homeForAccount?: (accountId: string) => string | null
}

interface ActiveSession {
  readonly handle: SessionHandle
  readonly options: SessionOptions
  state: RuntimeStatus['state']
  failure: string | null
  lastActivityAt: string
  readonly pendingEvents: RuntimeEvent[]
  wake: (() => void) | null
  closed: boolean
  abortController: AbortController
}

const CLAUDE_CAPABILITIES: readonly Capability[] = [
  'repo-read',
  'plan',
  'file-write',
  'test',
  'review',
  'terminal',
]

/**
 * Adapter for the Claude CLI (`claude`), communicating non-interactively and mapping to `IAgentRuntime`.
 */
export class ClaudeCliRuntime implements IAgentRuntime {
  readonly id = runtimeIdSchema.parse('claude-cli')
  readonly capabilities = CLAUDE_CAPABILITIES
  /** Spawns a real CLI process; its output is the agent's actual work. */
  readonly simulated = false
  /**
   * The credential lives at `~/.claude/.credentials.json`, so a spawned process given
   * its own home directory authenticates as a different account (measured in #111).
   */
  readonly supportsAccountIsolation = true
  /** What this CLI would itself load, were it not running with that loading disabled. */
  readonly instructionFilenames = ['CLAUDE.md']

  private readonly executable: string
  private readonly runner: ProcessRunner | null
  private readonly now: () => string
  private readonly homeForAccount: ((accountId: string) => string | null) | null
  private readonly sessions = new Map<string, ActiveSession>()

  constructor(options: ClaudeCliRuntimeOptions = {}) {
    this.executable = options.executablePath ?? 'claude'
    this.runner = options.runner ?? null
    this.now = options.now ?? (() => new Date().toISOString())
    this.homeForAccount = options.homeForAccount ?? null
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(options: SessionOptions): Promise<SessionHandle> {
    const handle: SessionHandle = {
      sessionId: sessionIdSchema.parse(`claude-sess-${randomUUID()}`),
      runtimeId: this.id,
    }

    const session: ActiveSession = {
      handle,
      options,
      state: 'idle',
      failure: null,
      lastActivityAt: this.now(),
      pendingEvents: [],
      wake: null,
      closed: false,
      abortController: new AbortController(),
    }

    this.sessions.set(handle.sessionId, session)
    return handle
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async send(sessionHandle: SessionHandle, packet: PromptPacket): Promise<void> {
    const session = this.getSession(sessionHandle)
    if (session.closed) {
      throw new Error(`Session "${sessionHandle.sessionId}" is closed`)
    }

    session.state = 'working'
    session.lastActivityAt = this.now()
    this.pushEvent(session, {
      type: 'state',
      at: session.lastActivityAt,
      state: 'working',
    })

    const promptText = renderPromptPacket(packet)

    // A2/A3: there is no meaning to "run the Claude CLI" without something that actually
    // spawns it. A runtime built without a runner previously reported synthetic success for
    // work it never did, which is the exact failure mode this product exists to catch in
    // agents — it cannot be acceptable in Forge's own adapter. Misconfiguration must fail
    // loudly, not degrade into a fabricated report.
    if (this.runner === null) {
      session.state = 'failed'
      session.failure = 'ClaudeCliRuntime has no process runner configured; cannot execute'
      this.pushEvent(session, {
        type: 'error',
        at: this.now(),
        message: session.failure,
        retryable: false,
      })
      return
    }

    // Resolved before spawning, and fatal when it fails. A session naming an account
    // Forge cannot locate must not quietly run as the machine's default identity: the
    // work would succeed, be attributed to the wrong account, and consume the wrong
    // quota — invisibly. Same reasoning as the missing-runner case above.
    let accountHome: string | null = null
    if (session.options.accountId !== undefined) {
      accountHome = this.homeForAccount?.(session.options.accountId) ?? null

      if (accountHome === null) {
        session.state = 'failed'
        session.failure = `Account "${session.options.accountId}" has no enrolled home; sign in to it before running work as that account`
        this.pushEvent(session, {
          type: 'error',
          at: this.now(),
          message: session.failure,
          retryable: false,
        })
        return
      }
    }

    void this.executeWithRunner(session, promptText, accountHome)
  }

  private async executeWithRunner(
    session: ActiveSession,
    promptText: string,
    accountHome: string | null,
  ): Promise<void> {
    if (!this.runner) return

    let accumulatedOutput = ''

    try {
      const result = await this.runner(
        this.executable,
        // The prompt is NOT an argument here. Passed through `-p` on Windows it reached
        // the CLI empty, and every step got "What would you like me to do?" — the
        // dogfood run in #130 halted on that, reported as a protocol violation because
        // an agent with no instructions has nothing to report. It goes over stdin
        // instead (#131), which no quoting layer can touch.
        //
        // `--permission-mode` matters for the opposite reason: without it the CLI denies
        // every tool call and waits for an approval a `-p` run can never give, so the
        // agent could reason and never read a file or write a change.
        //
        // `--safe-mode` disables the ambient customisations a spawned agent would
        // otherwise inherit from whoever's machine it runs on — CLAUDE.md, plugins,
        // hooks, MCP servers. That is not tidiness: a hook on this machine blocked the
        // prompt outright with "UserPromptSubmit operation blocked by hook", so the
        // agent never saw it. Forge decides what enters an agent's context (A1), and a
        // packet that survives only on an unconfigured machine is not a packet.
        //
        // Chosen over `--bare`, which isolates the same things but forces API-key auth
        // and so cannot be used with a Pro subscription (measured in the #20 spike).
        [
          '-p',
          '--output-format',
          'json',
          '--safe-mode',
          '--permission-mode',
          session.options.permissionMode ?? DEFAULT_PERMISSION_MODE,
        ],
        {
          cwd: session.options.repositoryPath,
          stdin: promptText,
          // `accountEnv` rather than the two variables inline: it is the one place that
          // decides what isolating a process to an account means, and enrolment already
          // depends on it. Two copies would be two places to get Windows wrong.
          ...(accountHome === null ? {} : { env: accountEnv(accountHome) }),
          signal: session.abortController.signal,
          onStdout: (chunk) => {
            // Accumulated, deliberately NOT emitted as a chunk.
            //
            // `exchange()` builds the reply from chunk text, and `parseAgentReport`
            // takes the *first* REPORT_BEGIN it finds. Emitting the raw envelope as
            // well as the unwrapped text put two copies of the block in that reply —
            // the escaped one first — so the parse ran across both and failed on the
            // backslashes. That is the second half of #130: the agent had already
            // fixed the bug correctly and the workflow halted anyway.
            //
            // The envelope is a wire format, not a transcript. Only the unwrapped text
            // below is emitted.
            accumulatedOutput += chunk
            session.lastActivityAt = this.now()
          },
          onStderr: (chunk) => {
            session.lastActivityAt = this.now()
            this.pushEvent(session, {
              type: 'chunk',
              at: session.lastActivityAt,
              text: chunk,
            })
          },
        },
      )

      if (result.exitCode !== 0 && accumulatedOutput.trim() === '') {
        session.state = 'failed'
        session.failure = `CLI process exited with code ${String(result.exitCode)}: ${result.stderr}`
        this.pushEvent(session, {
          type: 'error',
          at: this.now(),
          message: session.failure,
          retryable: true,
        })
        return
      }

      // `--output-format json` wraps the reply in an envelope, so the agent's text —
      // and the report block inside it — arrives JSON-escaped in the `result` field.
      // Parsing the raw stdout finds the escaped copy and fails with "Unexpected token
      // '\', \"\\n{\\n \\\"s\"... is not valid JSON", which is what halted the dogfood
      // run *after* the agent had correctly fixed the bug (#130).
      //
      // Unwrapped here rather than in `exchange()`: the envelope is this CLI's output
      // format, and `exchange()` must stay ignorant of any provider's wire shape (A6).
      // Falls back to the raw output when it is not an envelope, so a change of output
      // format degrades to using stdout rather than emitting nothing at all.
      const replyText = extractResultText(accumulatedOutput) ?? accumulatedOutput
      if (replyText !== '') {
        this.pushEvent(session, {
          type: 'chunk',
          at: this.now(),
          text: replyText,
        })
      }

      // The turn's raw transcript has already reached the caller as `chunk` events above.
      // Parsing it into an `AgentReport` and re-prompting once on a malformed reply is
      // `exchange()`'s job (`shared/domain/protocol.ts`, `runtimes/exchange.ts`) — it is the
      // one place that logic exists, and duplicating a parse here previously meant a
      // malformed report from a real CLI was silently replaced with a fabricated "completed"
      // result instead of failing or getting the correction retry the protocol promises.
      // Ending the turn on `state: 'completed'` is exactly what tells `exchange()`'s
      // `collectTurn` to parse the accumulated text itself.
      session.state = 'completed'
      this.pushEvent(session, {
        type: 'state',
        at: this.now(),
        state: 'completed',
      })
    } catch (err: unknown) {
      if (session.abortController.signal.aborted) {
        session.state = 'cancelled'
        return
      }
      session.state = 'failed'
      session.failure = err instanceof Error ? err.message : String(err)
      this.pushEvent(session, {
        type: 'error',
        at: this.now(),
        message: session.failure,
        retryable: true,
      })
    }
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
        if (event !== undefined) {
          yield event
        }
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async status(sessionHandle: SessionHandle): Promise<RuntimeStatus> {
    const session = this.getSession(sessionHandle)
    return {
      sessionId: sessionHandle.sessionId,
      state: session.state,
      failure: session.failure,
      lastActivityAt: session.lastActivityAt,
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async cancel(sessionHandle: SessionHandle, reason: string): Promise<void> {
    const session = this.getSession(sessionHandle)
    session.abortController.abort()
    session.state = 'cancelled'
    session.failure = reason
    session.lastActivityAt = this.now()

    this.pushEvent(session, {
      type: 'state',
      at: session.lastActivityAt,
      state: 'cancelled',
    })
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async dispose(sessionHandle: SessionHandle): Promise<void> {
    const session = this.sessions.get(sessionHandle.sessionId)
    if (session === undefined) return

    session.closed = true
    if (session.wake !== null) {
      session.wake()
    }
    this.sessions.delete(sessionHandle.sessionId)
  }

  private getSession(handle: SessionHandle): ActiveSession {
    const session = this.sessions.get(handle.sessionId)
    if (session === undefined) {
      throw new Error(`Unknown session "${handle.sessionId}"`)
    }
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
 * The agent's text, unwrapped from the CLI's result envelope.
 *
 * Returns null when the output is not an envelope, so a change of output format
 * degrades to using the raw stdout rather than losing the reply entirely. The
 * envelope's own error signalling is deliberately not interpreted here — `is_error`
 * and the exit code are handled above, and this function answers one question: where
 * is the text the agent wrote.
 */
function extractResultText(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed.startsWith('{')) return null

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null) return null

    const result = (parsed as { readonly result?: unknown }).result
    return typeof result === 'string' ? result : null
  } catch {
    // Not JSON, or truncated. The raw output already reached the caller as chunks.
    return null
  }
}
