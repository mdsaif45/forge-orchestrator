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
import { runAgentTurn } from '../providers/agentTurn'

/**
 * Forge's own agent: a model plus the tool loop, with no CLI in between.
 *
 * The other runtimes host somebody else's coding agent and observe it. This one
 * *is* the agent — Forge owns the loop, the tools and the bounds, and the model
 * only decides what to call next. That makes it the one runtime that works with
 * any model from any provider: Ollama and LM Studio locally, or any
 * OpenAI-compatible endpoint with a key.
 *
 * ```
 * packet ──> renderPromptPacket ──> runAgentTurn ──┬─> tools (read/edit/run)
 *                                                  └─> model, N rounds
 *                        chunk + state events <────┘
 * ```
 *
 * Capability is asked of the provider per model rather than declared here, so a
 * model without tool support degrades to a plain completion instead of being
 * handed definitions it cannot use — see `providers/capabilities.ts`.
 */

export interface NativeAgentRuntimeOptions {
  /**
   * Which provider and model a session uses.
   *
   * Injected because the choice is user configuration, and this module must not
   * read the renderer's stored settings directly. `index.ts` owns the wiring.
   */
  readonly resolveModel: () => {
    readonly providerId: string
    readonly model: string
    readonly endpointUrl?: string | undefined
    readonly apiKey?: string | undefined
  }
  readonly now?: (() => string) | undefined
  /**
   * The turn itself, injectable so a test can drive this runtime's event
   * mapping and state machine without reaching a provider. Defaults to the
   * real loop; nothing in the app passes it.
   */
  readonly runTurn?: typeof runAgentTurn | undefined
}

interface ActiveSession {
  readonly handle: SessionHandle
  readonly options: SessionOptions
  state: RuntimeStatus['state']
  failure: string | null
  lastActivityAt: string
  readonly pending: RuntimeEvent[]
  wake: (() => void) | null
  closed: boolean
  cancelled: boolean
}

/**
 * Everything the loop's tools can do.
 *
 * Declared in full because the tools are Forge's own and always present; a
 * runtime that hosts a CLI has to declare what that CLI happens to support,
 * which is a different problem.
 */
const NATIVE_CAPABILITIES: readonly Capability[] = [
  'repo-read',
  'plan',
  'file-write',
  'test',
  'review',
  'terminal',
]

export class NativeAgentRuntime implements IAgentRuntime {
  readonly id = runtimeIdSchema.parse('forge-native-agent')
  readonly capabilities = NATIVE_CAPABILITIES
  /** Real work against a real repository, so never simulated. */
  readonly simulated = false
  /**
   * False: a provider is reached over HTTP with one configured key or endpoint,
   * so two concurrent sessions cannot hold different identities the way a
   * redirected CLI home can (#111).
   */
  readonly supportsAccountIsolation = false
  /**
   * Empty. Forge compiles the packet itself and the loop has no ambient config
   * to read, so there is no file whose contents would arrive twice.
   */
  readonly instructionFilenames: readonly string[] = []

  private readonly resolveModel: NativeAgentRuntimeOptions['resolveModel']
  private readonly runTurn: NonNullable<NativeAgentRuntimeOptions['runTurn']>
  private readonly now: () => string
  private readonly sessions = new Map<string, ActiveSession>()

  constructor(options: NativeAgentRuntimeOptions) {
    this.resolveModel = options.resolveModel
    this.runTurn = options.runTurn ?? runAgentTurn
    this.now = options.now ?? (() => new Date().toISOString())
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async start(options: SessionOptions): Promise<SessionHandle> {
    const handle: SessionHandle = {
      sessionId: sessionIdSchema.parse(`forge-native-${randomUUID()}`),
      runtimeId: this.id,
    }

    this.sessions.set(handle.sessionId, {
      handle,
      options,
      state: 'idle',
      failure: null,
      lastActivityAt: this.now(),
      pending: [],
      wake: null,
      closed: false,
      cancelled: false,
    })

    return handle
  }

  async send(sessionHandle: SessionHandle, packet: PromptPacket): Promise<void> {
    const session = this.get(sessionHandle)
    if (session.closed) throw new Error(`Session "${sessionHandle.sessionId}" is closed`)

    session.state = 'working'
    session.lastActivityAt = this.now()
    this.push(session, { type: 'state', at: session.lastActivityAt, state: 'working' })

    const model = this.resolveModel()

    const result = await this.runTurn(
      {
        providerId: model.providerId,
        model: model.model,
        endpointUrl: model.endpointUrl,
        apiKey: model.apiKey,
        repositoryPath: session.options.repositoryPath,
        // The rendered packet is the whole instruction: role, objective,
        // constraints, scope and the report format the orchestrator parses back.
        systemPrompt: renderPromptPacket(packet),
        messages: [{ role: 'user', content: packet.objective }],
      },
      (event) => {
        session.lastActivityAt = this.now()
        // Tool progress is surfaced as a `tool` runtime event rather than a
        // `chunk`, because exchange() accumulates every chunk into the text it
        // parses a report from — progress lines in there would corrupt it.
        if (event.kind === 'tool') {
          this.push(session, { type: 'tool', at: this.now(), name: event.text, detail: '' })
          return
        }
        if (event.kind === 'reasoning') return
        this.push(session, { type: 'chunk', at: this.now(), text: event.text })
      },
    )

    if (session.cancelled) return

    if (!result.ok) {
      session.state = 'failed'
      session.failure = result.error
      this.push(session, {
        type: 'error',
        at: this.now(),
        message: result.error ?? 'The turn produced no answer.',
        // A round-cap stop or a refused path is worth another attempt with a
        // different prompt; a provider that cannot be reached is not.
        retryable: result.stoppedAtLimit,
        providerLimit: false,
      })
      return
    }

    // Emitted once, whole, so the report parser sees exactly what the model
    // said — the same discipline the hosted CLI adapter follows.
    if (result.content !== '') {
      this.push(session, { type: 'chunk', at: this.now(), text: result.content })
    }

    session.state = 'completed'
    this.push(session, { type: 'state', at: this.now(), state: 'completed' })
  }

  async *events(sessionHandle: SessionHandle): AsyncIterable<RuntimeEvent> {
    const session = this.get(sessionHandle)

    while (!session.closed || session.pending.length > 0) {
      if (session.pending.length === 0) {
        await new Promise<void>((resolve) => {
          session.wake = resolve
        })
        session.wake = null
      }

      while (session.pending.length > 0) {
        const event = session.pending.shift()
        if (event !== undefined) yield event
      }
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async status(sessionHandle: SessionHandle): Promise<RuntimeStatus> {
    const session = this.get(sessionHandle)
    return {
      sessionId: sessionHandle.sessionId,
      state: session.state,
      lastActivityAt: session.lastActivityAt,
      failure: session.failure,
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async cancel(sessionHandle: SessionHandle, reason: string): Promise<void> {
    const session = this.sessions.get(sessionHandle.sessionId)
    if (session === undefined) return

    // The loop runs in-process and has no signal to interrupt, so cancellation
    // is recorded and the outcome discarded. Stated rather than papered over:
    // an in-flight provider request still completes before the turn unwinds.
    session.cancelled = true
    session.state = 'cancelled'
    session.failure = reason
    this.close(session)
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async dispose(sessionHandle: SessionHandle): Promise<void> {
    const session = this.sessions.get(sessionHandle.sessionId)
    if (session === undefined) return
    this.close(session)
    this.sessions.delete(sessionHandle.sessionId)
  }

  private close(session: ActiveSession): void {
    session.closed = true
    if (session.wake !== null) {
      session.wake()
      session.wake = null
    }
  }

  private get(handle: SessionHandle): ActiveSession {
    const session = this.sessions.get(handle.sessionId)
    if (session === undefined) throw new Error(`Unknown session "${handle.sessionId}"`)
    return session
  }

  private push(session: ActiveSession, event: RuntimeEvent): void {
    session.pending.push(event)
    if (session.wake !== null) {
      session.wake()
      session.wake = null
    }
  }
}
