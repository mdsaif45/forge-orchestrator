import { randomUUID } from 'node:crypto'
import {
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
    readonly onStdout?: (chunk: string) => void
    readonly onStderr?: (chunk: string) => void
    readonly signal?: AbortSignal
  },
) => Promise<ProcessRunnerResult>

export interface ClaudeCliRuntimeOptions {
  readonly executablePath?: string
  readonly runner?: ProcessRunner
  readonly now?: () => string
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

  private readonly executable: string
  private readonly runner: ProcessRunner | null
  private readonly now: () => string
  private readonly sessions = new Map<string, ActiveSession>()

  constructor(options: ClaudeCliRuntimeOptions = {}) {
    this.executable = options.executablePath ?? 'claude'
    this.runner = options.runner ?? null
    this.now = options.now ?? (() => new Date().toISOString())
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

    void this.executeWithRunner(session, promptText)
  }

  private async executeWithRunner(session: ActiveSession, promptText: string): Promise<void> {
    if (!this.runner) return

    let accumulatedOutput = ''

    try {
      const result = await this.runner(
        this.executable,
        ['-p', promptText, '--output-format', 'json'],
        {
          cwd: session.options.repositoryPath,
          signal: session.abortController.signal,
          onStdout: (chunk) => {
            accumulatedOutput += chunk
            session.lastActivityAt = this.now()
            this.pushEvent(session, {
              type: 'chunk',
              at: session.lastActivityAt,
              text: chunk,
            })
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
