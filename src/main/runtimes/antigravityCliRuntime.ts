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
import type { ProcessRunner } from './claudeCliRuntime'

export interface AntigravityCliRuntimeOptions {
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

const ANTIGRAVITY_CAPABILITIES: readonly Capability[] = [
  'repo-read',
  'plan',
  'file-write',
  'test',
  'review',
  'terminal',
]

/**
 * Adapter for the Antigravity CLI (`agy`), communicating non-interactively and mapping to `IAgentRuntime`.
 */
export class AntigravityCliRuntime implements IAgentRuntime {
  readonly id = runtimeIdSchema.parse('antigravity-cli')
  readonly capabilities = ANTIGRAVITY_CAPABILITIES
  /** Spawns a real CLI process; its output is the agent's actual work. */
  readonly simulated = false

  private readonly executable: string
  private readonly runner: ProcessRunner | null
  private readonly now: () => string
  private readonly sessions = new Map<string, ActiveSession>()

  constructor(options: AntigravityCliRuntimeOptions = {}) {
    this.executable = options.executablePath ?? 'agy'
    this.runner = options.runner ?? null
    this.now = options.now ?? (() => new Date().toISOString())
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(options: SessionOptions): Promise<SessionHandle> {
    const handle: SessionHandle = {
      sessionId: sessionIdSchema.parse(`agy-sess-${randomUUID()}`),
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

    // A2/A3: see ClaudeCliRuntime.send for why a missing runner must fail loudly rather
    // than report synthetic success for work that never happened.
    if (this.runner === null) {
      session.state = 'failed'
      session.failure = 'AntigravityCliRuntime has no process runner configured; cannot execute'
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
      const result = await this.runner(this.executable, ['run', '--prompt', promptText], {
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
      })

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

      // See ClaudeCliRuntime.executeWithRunner: parsing and the single re-prompt on a
      // malformed reply belong to `exchange()`, which reads the `chunk` events already
      // pushed above. A `state: 'completed'` here is what tells its `collectTurn` to parse
      // the accumulated transcript itself, instead of this adapter fabricating a report when
      // parsing fails.
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
