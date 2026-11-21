import { randomUUID } from 'node:crypto'
import {
  promptPacketSchema,
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
import type { ProcessHandle, ProcessManager } from '../process'
import { injectSkillsAndPrepareCli } from './cliSkillInjector'

export interface GenericCliRuntimeOptions {
  readonly id: string
  readonly name: string
  readonly executable: string
  readonly processes?: ProcessManager | null | undefined
  readonly defaultArgs?: readonly string[] | undefined
  readonly env?: Readonly<Record<string, string>> | undefined
  readonly now?: (() => string) | undefined
}

interface ActiveSession {
  readonly handle: SessionHandle
  readonly options: SessionOptions
  process: ProcessHandle | null
  state: RuntimeSessionState
  failure: string | null
  lastActivityAt: string
  pendingEvents: RuntimeEvent[]
  wake: (() => void) | null
  closed: boolean
}

/**
 * Universal adapter for any installed or user-configured coding CLI.
 * Maps any system CLI (Agy, Claude Code, OpenCode, Codex, Aider, Cline, etc.) to IAgentRuntime.
 */
export class GenericCliAgentRuntime implements IAgentRuntime {
  readonly id: RuntimeId
  readonly capabilities: readonly Capability[] = [
    'repo-read',
    'file-write',
    'terminal',
    'plan',
    'review',
  ]
  readonly simulated = false
  readonly supportsAccountIsolation = false
  readonly instructionFilenames = ['instructions.md', 'CLAUDE.md', 'AGENTS.md']

  private readonly executable: string
  private readonly processes: ProcessManager | null
  private readonly defaultArgs: readonly string[]
  private readonly env: Readonly<Record<string, string>>
  private readonly now: () => string
  private readonly sessions = new Map<string, ActiveSession>()

  constructor(private readonly options: GenericCliRuntimeOptions) {
    this.id = runtimeIdSchema.parse(options.id)
    this.executable = options.executable
    this.processes = options.processes ?? null
    this.defaultArgs = options.defaultArgs ?? []
    this.env = options.env ?? {}
    this.now = options.now ?? (() => new Date().toISOString())
  }

  async start(options: SessionOptions): Promise<SessionHandle> {
    const handle: SessionHandle = {
      sessionId: sessionIdSchema.parse(`${this.options.id}-sess-${randomUUID()}`),
      runtimeId: this.id,
    }

    let processHandle: ProcessHandle | null = null

    if (this.processes !== null) {
      processHandle = await this.processes.spawn({
        command: this.executable,
        args: [...this.defaultArgs, ...(options.model ? [`--model=${options.model}`] : [])],
        cwd: options.repositoryPath,
        cols: 120,
        rows: 30,
        env: {
          ...process.env,
          ...this.env,
          FORGE_ROLE: options.role,
        },
      })

      // Wire terminal attachment
      options.onProcess?.({
        write: (input) => {
          processHandle?.write(input)
        },
        resize: (cols, rows) => {
          processHandle?.resize?.(cols, rows)
        },
        onData: (listener) => {
          if (!processHandle) return () => undefined
          const sub =
            processHandle.onRawData?.bind(processHandle) ?? processHandle.onData.bind(processHandle)
          return sub(listener)
        },
      })
    }

    const session: ActiveSession = {
      handle,
      options,
      process: processHandle,
      state: 'idle',
      failure: null,
      lastActivityAt: this.now(),
      pendingEvents: [],
      wake: null,
      closed: false,
    }

    this.sessions.set(handle.sessionId, session)
    return handle
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

    // Materialize context and instructions in the workspace
    await injectSkillsAndPrepareCli({
      agentExecutable: this.executable,
      workspacePath: session.options.repositoryPath,
      objective: packet.objective,
      systemPrompt: packet.constraints.join('\n'),
    })

    if (session.process !== null) {
      // Send interactive prompt
      session.process.write(`${packet.objective}\r\n`)

      this.pushEvent(session, {
        type: 'chunk',
        at: this.now(),
        text: `\n[${this.options.name}] Executing task: ${packet.objective}\n`,
      })
    }

    session.state = 'completed'
    this.pushEvent(session, {
      type: 'state',
      at: this.now(),
      state: 'completed',
    })
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

  async cancel(sessionHandle: SessionHandle, reason: string): Promise<void> {
    const session = this.sessions.get(sessionHandle.sessionId)
    if (!session) return

    session.state = 'cancelled'
    session.failure = reason
    session.closed = true
    if (session.process) {
      try {
        await session.process.cancel(reason)
      } catch {
        // Process might already be dead
      }
    }
    session.wake?.()
  }

  async dispose(sessionHandle: SessionHandle): Promise<void> {
    const session = this.sessions.get(sessionHandle.sessionId)
    if (!session) return

    session.closed = true
    if (session.process) {
      try {
        await session.process.cancel('disposed')
      } catch {
        // Process might already be dead
      }
    }
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
