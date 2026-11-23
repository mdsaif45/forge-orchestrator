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
} from '@forge/shared'
import type { ProcessHandle, ProcessManager } from './process/processManager'
import { checkAntigravityPreflightRefusal } from './antigravityPreflight'
import { claudeSessionId } from './claudeSession'
import { HostedSession } from './hostedSession'

export interface HostedAntigravityRuntimeOptions {
  readonly executablePath?: string
  readonly processes?: ProcessManager
  readonly now?: () => string
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
  dialogWatchCancelled: boolean
  bootSettled: boolean
  accumulatedRaw: string
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
 * The Antigravity CLI hosted as an authentic interactive session on a pseudo-terminal.
 *
 * Implements Issue #168:
 * - Launched interactively into a hosted terminal (ConPTY / node-pty).
 * - Adheres strictly to Go-style flag conventions (`-p=<prompt>`, `--add-dir=<path>`, `--mode=<mode>`).
 * - Workspace is explicitly established with `--add-dir` (load-bearing; prevents invented directories).
 * - Pre-flight eligibility refusals ("Eligibility check failed: failed to get profile picture")
 *   are caught and marked retryable: true, explicitly not attributed to the agent's failure.
 */
export class HostedAntigravityRuntime implements IAgentRuntime {
  readonly id = runtimeIdSchema.parse('antigravity-cli-hosted')
  readonly capabilities = ANTIGRAVITY_CAPABILITIES
  readonly simulated = false
  readonly supportsAccountIsolation = false
  readonly instructionFilenames: readonly string[] = []

  private readonly executable: string
  private readonly processes: ProcessManager | null
  private readonly now: () => string
  private readonly sleep: ((ms: number) => Promise<void>) | undefined
  private readonly sessions = new Map<string, ActiveSession>()

  constructor(options: HostedAntigravityRuntimeOptions = {}) {
    this.executable = options.executablePath ?? 'agy'
    this.processes = options.processes ?? null
    this.now = options.now ?? (() => new Date().toISOString())
    this.sleep = options.sleep
  }

  prepareWorkspace(_workspacePath: string): Promise<void> {
    // Workspace preparation for agy (no custom trust file required)
    return Promise.resolve()
  }

  async start(options: SessionOptions): Promise<SessionHandle> {
    if (this.processes === null) {
      throw new Error('HostedAntigravityRuntime has no process manager configured; cannot execute')
    }

    const handle: SessionHandle = {
      sessionId: sessionIdSchema.parse(`agy-hosted-${randomUUID()}`),
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
      dialogWatchCancelled: false,
      bootSettled: false,
      accumulatedRaw: '',
    }

    const subscribe = process.onRawData?.bind(process) ?? process.onData.bind(process)
    subscribe((chunk: string) => {
      session.lastActivityAt = this.now()
      session.accumulatedRaw += chunk
      void hosted.receive(chunk)
    })

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

    // Check if preflight eligibility refused before starting work / waiting for boot
    const preflight = checkAntigravityPreflightRefusal(
      session.accumulatedRaw,
      session.hosted.screen(),
    )
    if (preflight.refused) {
      this.fail(
        session,
        preflight.reason ??
          'The Antigravity CLI refused before starting the turn (pre-flight eligibility check failed); no work was attempted',
        true,
      )
      return
    }

    if (!session.bootSettled) {
      await session.hosted.waitForBootSettled()
      session.bootSettled = true
    }

    const promptText = renderPromptPacket(packet)

    // Execute turn via hosted session emulator
    const outcome = await session.hosted.runTurn(promptText)

    // Re-check preflight refusal on screen output after turn attempt
    const postPreflight = checkAntigravityPreflightRefusal(
      session.accumulatedRaw,
      session.hosted.screen(),
    )
    if (postPreflight.refused) {
      this.fail(
        session,
        postPreflight.reason ??
          'The Antigravity CLI refused before starting the turn (pre-flight eligibility check failed); no work was attempted',
        true,
      )
      return
    }

    if (outcome.kind === 'blocked') {
      this.fail(
        session,
        `The Antigravity CLI is blocked waiting for interactive approval: ${outcome.on}`,
        false,
      )
      return
    }

    if (outcome.kind === 'timeout') {
      this.fail(session, 'Turn timed out waiting for the Antigravity CLI to finish', true)
      return
    }

    // Reply answered cleanly
    this.pushEvent(session, {
      type: 'chunk',
      at: this.now(),
      text: outcome.screen,
    })

    session.state = 'completed'
    this.pushEvent(session, {
      type: 'state',
      at: this.now(),
      state: 'completed',
    })
  }

  status(sessionHandle: SessionHandle): Promise<RuntimeStatus> {
    const session = this.getSession(sessionHandle)
    return Promise.resolve({
      sessionId: session.handle.sessionId,
      state: session.state,
      failure: session.failure,
      lastActivityAt: session.lastActivityAt,
    })
  }

  async *events(sessionHandle: SessionHandle): AsyncIterable<RuntimeEvent> {
    const session = this.getSession(sessionHandle)

    while (!session.closed || session.pendingEvents.length > 0) {
      const next = session.pendingEvents.shift()
      if (next !== undefined) {
        yield next
        continue
      }

      await new Promise<void>((resolve) => {
        session.wake = resolve
      })
    }
  }

  async cancel(sessionHandle: SessionHandle, reason?: string): Promise<void> {
    const session = this.getSession(sessionHandle)
    if (session.closed) return

    await session.process.cancel(reason)
    session.state = 'cancelled'
    session.failure = reason ?? 'Cancelled by caller'
    session.lastActivityAt = this.now()
    this.pushEvent(session, {
      type: 'state',
      at: session.lastActivityAt,
      state: 'cancelled',
    })
    this.close(session)
  }

  async dispose(sessionHandle: SessionHandle): Promise<void> {
    const session = this.sessions.get(sessionHandle.sessionId)
    if (session === undefined) return
    this.close(session)
    await session.process.cancel('dispose')
    this.sessions.delete(sessionHandle.sessionId)
  }

  private argsFor(options: SessionOptions): readonly string[] {
    const mode = options.permissionMode ?? DEFAULT_PERMISSION_MODE

    return [
      `--add-dir=${options.repositoryPath}`,
      ...(options.resumeKey === undefined
        ? []
        : [`--conversation=${claudeSessionId(options.resumeKey)}`]),
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
      providerLimit: false,
    })
  }

  private close(session: ActiveSession): void {
    session.closed = true
    session.dialogWatchCancelled = true
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
 * Maps Forge permissions into Antigravity CLI flags.
 *
 * `--mode` accepts: accept-edits, auto, plan.
 * `--dangerously-skip-permissions` auto-approves all tool permission requests.
 * Agy rejects `--permission-mode` outright.
 */
function permissionArgs(mode: PermissionMode): readonly string[] {
  if (mode === 'bypassPermissions' || mode === 'auto') {
    return ['--mode=auto', '--dangerously-skip-permissions']
  }
  if (mode === 'acceptEdits') {
    return ['--mode=accept-edits']
  }
  return ['--mode=plan']
}
