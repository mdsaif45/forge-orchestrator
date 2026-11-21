import { randomUUID } from 'node:crypto'
import {
  promptPacketSchema,
  renderPromptPacket,
  parseAgentReport,
  runtimeIdSchema,
  sessionIdSchema,
  type Capability,
  type IAgentRuntime,
  type PromptPacket,
  type RuntimeEvent,
  type RuntimeId,
  type RuntimeSessionState,
  type RuntimeStatus,
  type SessionHandle,
  type SessionOptions,
} from '@shared/domain'
import { createPipeProcessRunner } from './pipeProcessRunner'
import type { ProcessRunner } from './claudeCliRuntime'

export interface CustomCliRuntimeOptions {
  /** Runtime identifier, conventionally `custom:<slug>`. */
  readonly id: string
  /** Human-readable display name. */
  readonly name: string
  /** Executable binary or command name. */
  readonly command: string
  /** Arguments template with optional `{{prompt}}`, `{{workspace}}`, `{{role}}`. */
  readonly argsTemplate?: readonly string[] | undefined
  /** Custom environment variables passed to the child process. */
  readonly env?: Readonly<Record<string, string>> | undefined
  /** Declared capabilities for capability preflight and role binding. */
  readonly capabilities?: readonly Capability[] | undefined
  /** Instruction filenames to search and inject. */
  readonly instructionFilenames?: readonly string[] | undefined
  /** Injected process runner (defaults to pipe process runner). */
  readonly runner?: ProcessRunner | undefined
  /** Clock source for event timestamps. */
  readonly now?: (() => string) | undefined
}

interface ActiveSession {
  readonly handle: SessionHandle
  readonly options: SessionOptions
  state: RuntimeSessionState
  failure: string | null
  lastActivityAt: string
  pendingEvents: RuntimeEvent[]
  wake: (() => void) | null
  closed: boolean
  abortController: AbortController
}

const DEFAULT_CAPABILITIES: readonly Capability[] = [
  'repo-read',
  'file-write',
  'terminal',
  'plan',
  'review',
]

const DEFAULT_INSTRUCTION_FILENAMES = ['instructions.md', 'CLAUDE.md', 'AGENTS.md']

/**
 * Data-driven custom CLI runtime adapter.
 *
 * Implements IAgentRuntime for arbitrary external coding agent CLIs configured from
 * user data or .forgerc rather than compiled into Forge (Issue #174 / RUNTIME-001).
 *
 * Uses the report protocol (shared/domain/protocol.ts) to parse agent reports
 * delimited by FORGE_REPORT_BEGIN and FORGE_REPORT_END sent over stdin/stdout.
 */
export class CustomCliRuntime implements IAgentRuntime {
  readonly id: RuntimeId
  readonly capabilities: readonly Capability[]
  readonly simulated = false
  readonly supportsAccountIsolation = false
  readonly instructionFilenames: readonly string[]

  private readonly command: string
  private readonly argsTemplate: readonly string[]
  private readonly env: Readonly<Record<string, string>>
  private readonly runner: ProcessRunner
  private readonly now: () => string
  private readonly sessions = new Map<string, ActiveSession>()

  constructor(private readonly options: CustomCliRuntimeOptions) {
    this.id = runtimeIdSchema.parse(options.id)
    this.command = options.command
    this.argsTemplate = options.argsTemplate ?? []
    this.env = options.env ?? {}
    this.capabilities = options.capabilities ?? DEFAULT_CAPABILITIES
    this.instructionFilenames = options.instructionFilenames ?? DEFAULT_INSTRUCTION_FILENAMES
    this.runner = options.runner ?? createPipeProcessRunner()
    this.now = options.now ?? (() => new Date().toISOString())
  }

  get name(): string {
    return this.options.name
  }

  start(options: SessionOptions): Promise<SessionHandle> {
    const handle: SessionHandle = {
      sessionId: sessionIdSchema.parse(`${this.options.id}-sess-${randomUUID()}`),
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
    return Promise.resolve(handle)
  }

  async send(sessionHandle: SessionHandle, packet: PromptPacket): Promise<void> {
    const session = this.getSession(sessionHandle)
    if (session.closed) {
      throw new Error(`Session "${sessionHandle.sessionId}" is closed`)
    }

    promptPacketSchema.parse(packet)

    session.state = 'working'
    session.lastActivityAt = this.now()
    this.pushEvent(session, {
      type: 'state',
      at: session.lastActivityAt,
      state: 'working',
    })

    const promptText = renderPromptPacket(packet)

    // Check whether prompt token is present in args template, or should be passed via stdin
    const hasPromptArg = this.argsTemplate.some((arg) => arg.includes('{{prompt}}'))
    const stdinText = hasPromptArg ? undefined : promptText

    // Interpolate argument template tokens
    const args = this.argsTemplate.map((arg) => {
      let replaced = arg
      if (replaced.includes('{{prompt}}')) {
        replaced = replaced.replaceAll('{{prompt}}', promptText)
      }
      if (replaced.includes('{{objective}}')) {
        replaced = replaced.replaceAll('{{objective}}', packet.objective)
      }
      if (replaced.includes('{{workspace}}')) {
        replaced = replaced.replaceAll('{{workspace}}', session.options.repositoryPath)
      }
      if (replaced.includes('{{role}}')) {
        replaced = replaced.replaceAll('{{role}}', session.options.role)
      }
      return replaced
    })

    let accumulatedStdout = ''
    let accumulatedStderr = ''

    try {
      const runnerOpts = {
        cwd: session.options.repositoryPath,
        env: {
          ...this.env,
          FORGE_ROLE: session.options.role,
        },
        ...(stdinText !== undefined ? { stdin: stdinText } : {}),
        onStdout: (chunk: string) => {
          accumulatedStdout += chunk
          session.lastActivityAt = this.now()
          this.pushEvent(session, {
            type: 'chunk',
            at: session.lastActivityAt,
            text: chunk,
          })
        },
        onStderr: (chunk: string) => {
          accumulatedStderr += chunk
          session.lastActivityAt = this.now()
          this.pushEvent(session, {
            type: 'chunk',
            at: session.lastActivityAt,
            text: chunk,
          })
        },
        ...(session.options.onProcess ? { onProcess: session.options.onProcess } : {}),
      }

      const result = await this.runner(this.command, args, runnerOpts)

      // Parse authoritative report protocol
      const parsedReport = parseAgentReport(accumulatedStdout)

      if (parsedReport.ok) {
        session.state = 'completed'
        this.pushEvent(session, {
          type: 'result',
          at: this.now(),
          report: parsedReport.report,
        })
        this.pushEvent(session, {
          type: 'state',
          at: this.now(),
          state: 'completed',
        })
      } else if (result.exitCode === 0) {
        session.state = 'failed'
        session.failure = `Custom CLI "${this.options.name}" completed with exit code 0 but failed to emit a valid report: ${parsedReport.message}`
        this.pushEvent(session, {
          type: 'error',
          at: this.now(),
          message: session.failure,
          retryable: true,
          providerLimit: false,
        })
        this.pushEvent(session, {
          type: 'state',
          at: this.now(),
          state: 'failed',
        })
      } else {
        session.state = 'failed'
        const stderrMsg = accumulatedStderr || result.stderr
        session.failure = `Custom CLI "${this.options.name}" exited with code ${String(result.exitCode)}: ${stderrMsg || parsedReport.message}`
        this.pushEvent(session, {
          type: 'error',
          at: this.now(),
          message: session.failure,
          retryable: false,
          providerLimit: false,
        })
        this.pushEvent(session, {
          type: 'state',
          at: this.now(),
          state: 'failed',
        })
      }
    } catch (error) {
      session.state = 'failed'
      session.failure = error instanceof Error ? error.message : String(error)
      this.pushEvent(session, {
        type: 'error',
        at: this.now(),
        message: session.failure,
        retryable: false,
        providerLimit: false,
      })
      this.pushEvent(session, {
        type: 'state',
        at: this.now(),
        state: 'failed',
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
    const session = this.sessions.get(sessionHandle.sessionId)
    if (!session) return

    session.state = 'cancelled'
    session.failure = reason
    session.closed = true
    session.abortController.abort(reason)
    session.wake?.()
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async dispose(sessionHandle: SessionHandle): Promise<void> {
    const session = this.sessions.get(sessionHandle.sessionId)
    if (!session) return

    session.closed = true
    session.abortController.abort('disposed')
    session.wake?.()
    this.sessions.delete(sessionHandle.sessionId)
  }

  private getSession(handle: SessionHandle): ActiveSession {
    const session = this.sessions.get(handle.sessionId)
    if (!session) {
      throw new Error(`No active session "${handle.sessionId}"`)
    }
    return session
  }

  private pushEvent(session: ActiveSession, event: RuntimeEvent): void {
    session.pendingEvents.push(event)
    session.wake?.()
  }
}
