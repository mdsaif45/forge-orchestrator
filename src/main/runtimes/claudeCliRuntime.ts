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
import { observeStreamLine, takeCompleteLines } from './claudeStream'

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
    /**
     * Hands the caller a way to reach the running process (#170).
     *
     * The workflow pane used to spawn its own CLI session and render that, while
     * the agent doing the work ran unobserved. Attaching to the real one needs a
     * reference to it, and only the runner has that.
     *
     * `write` is optional because not every runner can accept input mid-run: a
     * pipe runner closes stdin after the prompt. Declared rather than faked, so a
     * caller can tell "this session cannot take input" from "input was ignored".
     */
    readonly onProcess?: (process: {
      readonly write?: (input: string) => void
      readonly resize?: (cols: number, rows: number) => void
    }) => void
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
        // No measured limit detector yet (#137); an ordinary error until one exists.
        providerLimit: false,
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
          // No measured limit detector yet (#137); an ordinary error until one exists.
          providerLimit: false,
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
    // Held across `onStdout` calls: a read boundary falls mid-line, so the tail of one
    // chunk is the head of the next (`takeCompleteLines`).
    let streamBuffer = ''
    // A holder rather than a `let`: control-flow analysis narrows `let x = false` to the
    // literal type and cannot see the `onStdout` closure assigning it, so the check after
    // the run is reported as always-falsy — while annotating the `let` trips the
    // inferrable-types rule instead. A mutable field is also honest about the aliasing.
    const stream = { limitReached: false }

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
          // `stream-json` rather than `json`, so tool calls and provider-limit signals
          // arrive while the turn is running instead of only at the end (#150). It
          // requires `--verbose`; without it the CLI emits the envelope alone and the
          // live view is blind again.
          '--output-format',
          'stream-json',
          '--verbose',
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
          // Forwarded so the caller can attach to the running process (#170).
          ...(session.options.onProcess === undefined
            ? {}
            : { onProcess: session.options.onProcess }),
          signal: session.abortController.signal,
          onStdout: (chunk) => {
            // Accumulated, and deliberately NOT emitted as a chunk.
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

            // Observed for the live view only (#150). Tool calls and provider limits are
            // emitted as they happen so a user can watch the work; assistant prose is
            // not, for the double-parse reason above — the reply text still reaches
            // `exchange()` exactly once, from the terminal result below.
            streamBuffer += chunk
            const { lines, rest } = takeCompleteLines(streamBuffer)
            streamBuffer = rest

            for (const line of lines) {
              const observed = observeStreamLine(line)

              for (const tool of observed.tools) {
                this.pushEvent(session, {
                  type: 'tool',
                  at: this.now(),
                  name: tool.name,
                  detail: tool.detail,
                })
              }

              if (observed.providerLimitReached) stream.limitReached = true
            }
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

      // A spent limit is checked before the empty-output case: the CLI reports the limit
      // *in* its output, so `accumulatedOutput` is never empty when one occurs and the
      // branch below could never see it. Lint caught this as an always-falsy condition —
      // the halt would have been unreachable in exactly the situation it exists for.
      if (stream.limitReached) {
        session.state = 'failed'
        session.failure = "The provider reported this account's rate limit is spent"
        this.pushEvent(session, {
          type: 'error',
          at: this.now(),
          message: session.failure,
          // Retrying now fails identically and burns an iteration on something no retry
          // can fix; the remedies are another account, another provider, or waiting (#147).
          retryable: false,
          providerLimit: true,
        })
        return
      }

      if (result.exitCode !== 0 && accumulatedOutput.trim() === '') {
        session.state = 'failed'
        session.failure = `CLI process exited with code ${String(result.exitCode)}: ${result.stderr}`
        this.pushEvent(session, {
          type: 'error',
          at: this.now(),
          message: session.failure,
          retryable: true,
          // A limit is handled above, where the output is non-empty; reaching here means
          // the process died without saying anything, which is an ordinary failure.
          providerLimit: false,
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

      // Reported, never estimated: these are the provider's own numbers, and a figure Forge
      // computed itself would be a guess wearing the same shape (A3). Emitted before the
      // terminal state so a consumer reading until `completed` still sees it.
      const usage = extractUsage(accumulatedOutput)
      if (usage !== null) {
        this.pushEvent(session, { type: 'usage', at: this.now(), ...usage })
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
        // No measured limit detector yet (#137); an ordinary error until one exists.
        providerLimit: false,
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
  // The transport is NDJSON since #150, so the envelope is one line among many rather
  // than the whole of stdout. Parsing the buffer as a single object — which is what
  // this did — returns null against a stream and silently falls back to raw stdout,
  // putting every intermediate JSON line into the text `parseAgentReport` reads.
  const result = findTerminalResult(output)
  if (result === null) return null

  const text = result.result
  return typeof text === 'string' ? text : null
}

/**
 * The terminal `result` line of an NDJSON turn, or a whole-buffer envelope.
 *
 * Scanned from the end: the reply is the last thing the CLI writes, and a turn whose
 * *content* mentions a result line should not be mistaken for the line itself. Falls
 * back to parsing the entire buffer so a build configured for `--output-format json`
 * still works — the two formats then differ only in how many lines they occupy.
 */
function findTerminalResult(output: string): Record<string, unknown> | null {
  const lines = output.split('\n')

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]?.trim() ?? ''
    if (!line.startsWith('{')) continue

    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed !== 'object' || parsed === null) continue

      const record = parsed as Record<string, unknown>
      if (record.type === 'result' || typeof record.result === 'string') return record
    } catch {
      // A partial or non-JSON line; keep scanning backwards.
    }
  }

  return null
}

/**
 * What the turn cost, from this CLI's result envelope.
 *
 * Field names are taken from a real envelope, not from documentation:
 *
 * ```
 * total_cost_usd  0.253878
 * usage           { input_tokens, output_tokens, cache_creation_input_tokens, ... }
 * ```
 *
 * Returns null when the output is not an envelope or carries no usage at all, so a change
 * of output format records nothing rather than recording zeros — a zero would be indexed
 * as a real measurement and quietly understate an account's consumption.
 */
function extractUsage(output: string): {
  readonly costUsd: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
} | null {
  // Read from the terminal result line, for the same reason as `extractResultText`:
  // under NDJSON the buffer is many lines, and the per-message `usage` figures on
  // intermediate `assistant` lines are partial. The result's totals are the turn's.
  const envelope = findTerminalResult(output)
  if (envelope === null) return null

  const numberOrNull = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null

  const usage =
    typeof envelope.usage === 'object' && envelope.usage !== null
      ? (envelope.usage as Record<string, unknown>)
      : null

  const costUsd = numberOrNull(envelope.total_cost_usd)
  const inputTokens = usage === null ? null : numberOrNull(usage.input_tokens)
  const outputTokens = usage === null ? null : numberOrNull(usage.output_tokens)

  if (costUsd === null && inputTokens === null && outputTokens === null) return null
  return { costUsd, inputTokens, outputTokens }
}
