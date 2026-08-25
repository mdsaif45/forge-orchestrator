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
  /**
   * The credential lives in the Windows Credential Manager under a single fixed target
   * name, not on the filesystem, so no environment a process is given changes which
   * identity it reads (measured in #111). Concurrent sessions share one account.
   */
  readonly supportsAccountIsolation = false
  /**
   * Which of these agy itself would read is not measured — the CLI's session expired
   * before it could be tested, and its `--help` documents neither. Both are listed
   * because Forge reads the file and puts it in the packet regardless of what the CLI
   * would have done, so the cost of including a name the CLI ignores is nil while
   * omitting one a repository actually uses would silently drop its instructions.
   */
  readonly instructionFilenames = ['AGENTS.md', 'CLAUDE.md']

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
        // No measured limit detector yet (#137); an ordinary error until one exists.
        providerLimit: false,
      })
      return
    }

    void this.executeWithRunner(session, promptText)
  }

  private async executeWithRunner(session: ActiveSession, promptText: string): Promise<void> {
    if (!this.runner) return

    let accumulatedOutput = ''

    try {
      // Every element here was found by a failing attempt, not by reading `--help`.
      // None of it matches the Claude adapter, which is what the adapter layer is for:
      //
      //   prompt        `-p=<prompt>` attached, Go-style. Passing it as a separate
      //                 argument makes agy take the *next flag* as its prompt and
      //                 ignore the real one.
      //   --add-dir     Required. Without it agy reports a well-formed success while
      //                 editing somewhere else entirely — cwd alone does not establish
      //                 the workspace, and it invents one rather than failing.
      //   permissions   `--mode` (not `--permission-mode`, which is rejected outright),
      //                 and `accept-edits` rather than Claude's `acceptEdits`.
      //                 accept-edits alone still auto-denies the `command` permission,
      //                 so a role that must run commands needs the blunt flag.
      const result = await this.runner(this.executable, this.argsFor(session, promptText), {
        cwd: session.options.repositoryPath,
        signal: session.abortController.signal,
        onStdout: (chunk) => {
          // Accumulated, deliberately not emitted. `--output-format=json` wraps the
          // reply, so the report block arrives JSON-escaped inside `response`. Emitting
          // the envelope alongside the unwrapped text would put two copies of the block
          // in the reply, and `parseAgentReport` takes the first it finds — the escaped
          // one — and fails on the backslashes. Same defect as #130 on the Claude side.
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
      })

      if (result.exitCode !== 0 && accumulatedOutput.trim() === '') {
        session.state = 'failed'
        session.failure = `CLI process exited with code ${String(result.exitCode)}: ${result.stderr}`
        this.pushEvent(session, {
          type: 'error',
          at: this.now(),
          message: session.failure,
          retryable: true,
          // No measured limit detector yet (#137); an ordinary error until one exists.
          providerLimit: false,
        })
        return
      }

      // agy's envelope is `{ response, status, conversation_id, usage }` — a different
      // shape from Claude's `{ result, is_error, ... }`, so nothing is shared between
      // the two extractors. Falls back to the raw output when it does not parse, so a
      // change of output format degrades to using stdout rather than emitting nothing.
      const replyText = extractResponseText(accumulatedOutput) ?? accumulatedOutput
      if (replyText !== '') {
        this.pushEvent(session, {
          type: 'chunk',
          at: this.now(),
          text: replyText,
        })
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
        // No measured limit detector yet (#137); an ordinary error until one exists.
        providerLimit: false,
      })
    }
  }

  /**
   * The command line for one turn.
   *
   * Split out because none of it is shareable with the Claude adapter and all of it was
   * measured rather than documented — keeping it in one named place means the next
   * person changes it deliberately.
   */
  private argsFor(session: ActiveSession, promptText: string): readonly string[] {
    // `writeFiles` is not on the session, but the permission mode the orchestrator
    // derived from it is: a role that may write gets `acceptEdits`, a read-only role
    // gets something else (#130).
    const mayWrite = (session.options.permissionMode ?? DEFAULT_PERMISSION_MODE) === 'acceptEdits'

    return [
      // Attached, not separated. `-p <prompt>` makes agy take the following flag as its
      // prompt and silently drop the real one.
      `-p=${promptText}`,
      '--output-format=json',
      // Declares the workspace. Its absence is the worst failure found in either
      // adapter: agy reports `status: SUCCESS` with a plausible report and edits a
      // directory it invented, leaving the repository untouched.
      `--add-dir=${session.options.repositoryPath}`,
      // `--mode=accept-edits` still auto-denies the `command` permission, and agy has no
      // `--settings` flag to carry a narrower allow-rule, so a role that must run
      // commands needs the blunt one. Scoped to roles that already hold write
      // permission; Forge's reconciler and scope enforcement remain the real boundary.
      ...(mayWrite ? ['--dangerously-skip-permissions'] : ['--mode=accept-edits']),
    ]
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
 * The agent's text, unwrapped from agy's result envelope.
 *
 * Deliberately not shared with the Claude adapter's equivalent: agy returns
 * `{ response, status, conversation_id }` where Claude returns `{ result, is_error }`,
 * and a single function guessing at both would silently pick the wrong field the next
 * time either vendor changes shape.
 *
 * Returns null when the output is not an envelope, so the caller falls back to raw
 * stdout rather than losing the reply. The envelope's `status` is not interpreted here:
 * agy reports `SUCCESS` even for a turn in which every tool call was denied and nothing
 * was produced, so it is not a signal that work happened — the report and the
 * reconciler decide that.
 */
function extractResponseText(output: string): string | null {
  const trimmed = output.trim()
  if (!trimmed.startsWith('{')) return null

  try {
    const parsed: unknown = JSON.parse(trimmed)
    if (typeof parsed !== 'object' || parsed === null) return null

    const response = (parsed as { readonly response?: unknown }).response
    return typeof response === 'string' ? response : null
  } catch {
    return null
  }
}
