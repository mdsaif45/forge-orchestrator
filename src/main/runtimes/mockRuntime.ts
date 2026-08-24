import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  runtimeIdSchema,
  sessionIdSchema,
  type AgentSessionId,
  type Capability,
  type IAgentRuntime,
  type PromptPacket,
  type RuntimeEvent,
  type RuntimeStatus,
  type SessionHandle,
  type SessionOptions,
} from '@shared/domain'
import type { Scenario } from './scenario'

/**
 * A scripted runtime, for building the engine without a real agent.
 *
 * Two properties make it useful rather than merely convenient:
 *
 *   1. **It really mutates the worktree.** A mock that only returned a report would
 *      let the evidence layer be written against imaginary diffs; the `liar` scenario
 *      is only meaningful if the repository genuinely stays unchanged while the report
 *      claims otherwise.
 *   2. **It is deterministic.** No timers, no randomness, no wall-clock ordering. The
 *      clock is injected, so a test asserting an event sequence cannot flake — which is
 *      the same reason `CLAUDE.md` forbids sleeping in tests.
 *
 * Delays are expressed as a count of awaited microtasks rather than milliseconds, for
 * the same reason: a duration encodes one machine's timing into the test.
 */

export interface MockRuntimeOptions {
  readonly scenario: Scenario
  /** Defaults to `mock:<scenario name>`, so several mocks can coexist. */
  readonly id?: string
  /**
   * Injected clock. Defaults to a fixed instant that advances one second per call, so
   * timestamps are ordered and reproducible without touching the real clock.
   */
  readonly now?: () => string
}

interface SessionState {
  readonly handle: SessionHandle
  readonly options: SessionOptions
  /** Which scenario step the next `send` consumes. */
  stepIndex: number
  state: RuntimeStatus['state']
  failure: string | null
  lastActivityAt: string
  /** Events produced but not yet consumed by `events()`. */
  readonly pending: RuntimeEvent[]
  /** Resolves when new events arrive, so `events()` waits without polling. */
  wake: (() => void) | null
  closed: boolean
}

function fixedClock(): () => string {
  // A fixed origin rather than Date.now(): two runs of the same scenario must produce
  // identical timestamps, or a snapshot comparison would fail for no real reason.
  let tick = 0
  return () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString()
}

export class MockAgentRuntime implements IAgentRuntime {
  readonly id
  /** Scripted by construction: every reply comes from a scenario, not an agent. */
  readonly simulated = true
  /** Nothing real to isolate, so concurrency is never constrained by an account. */
  readonly supportsAccountIsolation = true
  readonly capabilities: readonly Capability[]

  private readonly scenario: Scenario
  private readonly now: () => string
  private readonly sessions = new Map<string, SessionState>()
  private sessionCounter = 0

  constructor(options: MockRuntimeOptions) {
    this.scenario = options.scenario
    this.id = runtimeIdSchema.parse(options.id ?? `mock:${options.scenario.name}`)
    this.capabilities = options.scenario.capabilities
    this.now = options.now ?? fixedClock()
  }

  // Satisfies the async IAgentRuntime contract; a real adapter awaits a spawned
  // process here.
  // eslint-disable-next-line @typescript-eslint/require-await
  async start(options: SessionOptions): Promise<SessionHandle> {
    this.sessionCounter += 1
    const sessionId: AgentSessionId = sessionIdSchema.parse(
      `${this.id}#${String(this.sessionCounter)}`,
    )

    const handle: SessionHandle = { sessionId, runtimeId: this.id }
    const at = this.now()

    this.sessions.set(sessionId, {
      handle,
      options,
      stepIndex: 0,
      state: 'idle',
      failure: null,
      lastActivityAt: at,
      pending: [{ type: 'state', at, state: 'idle' }],
      wake: null,
      closed: false,
    })

    return handle
  }

  /**
   * Runs the next scripted step.
   *
   * The packet is accepted and ignored: what a scenario does is fixed in advance, which
   * is the point — a mock that reacted to its input would be a second implementation to
   * debug rather than a fixture. Callers asserting on packet contents test the context
   * engine (#30) instead.
   */
  async send(session: SessionHandle, _packet: PromptPacket): Promise<void> {
    const state = this.require(session)

    if (state.state === 'cancelled' || state.state === 'failed') {
      throw new Error(`Session ${session.sessionId} is ${state.state} and cannot accept work`)
    }

    const step = this.scenario.steps[state.stepIndex]
    if (step === undefined) {
      throw new Error(
        `Scenario "${this.scenario.name}" has ${String(this.scenario.steps.length)} step(s); a further send has nothing to run`,
      )
    }
    state.stepIndex += 1

    this.emit(state, { type: 'state', at: this.now(), state: 'working' })
    state.state = 'working'

    for (const line of step.narration) {
      this.emit(state, { type: 'chunk', at: this.now(), text: line })
    }

    for (const tool of step.tools) {
      this.emit(state, { type: 'tool', at: this.now(), name: tool.name, detail: tool.detail })
    }

    // Applied before the report, so a test sees work-then-claim, as with a real agent.
    for (const edit of step.edits) {
      await this.applyEdit(state.options.repositoryPath, edit.path, edit.contents)
    }

    switch (step.ending) {
      case 'report': {
        if (step.report === null) {
          throw new Error(
            `Scenario "${this.scenario.name}" step ${String(state.stepIndex)} ends with a report but declares none`,
          )
        }

        this.emit(state, { type: 'result', at: this.now(), report: step.report })
        state.state = 'completed'
        this.emit(state, { type: 'state', at: this.now(), state: 'completed' })
        return
      }

      case 'text': {
        // Raw stdout and no structured result, which is how a real CLI behaves: the
        // protocol has to extract a report from prose. This is the only ending that
        // exercises parsing and the re-prompt.
        this.emit(state, { type: 'chunk', at: this.now(), text: step.replyText ?? '' })
        state.state = 'idle'
        this.emit(state, { type: 'state', at: this.now(), state: 'idle' })
        return
      }

      case 'silent': {
        // Deliberately emits nothing further and leaves the state as `working`. The
        // caller's own timeout has to end this, which is exactly what #29 must handle.
        return
      }

      case 'crash': {
        state.state = 'failed'
        state.failure = 'The runtime exited unexpectedly'
        this.emit(state, {
          type: 'error',
          at: this.now(),
          message: state.failure,
          retryable: true,
        })
        this.emit(state, { type: 'state', at: this.now(), state: 'failed' })
        return
      }

      case 'authFailure': {
        state.state = 'failed'
        // Wording taken from what the #20 spike measured from the real CLI.
        state.failure = 'Failed to authenticate: OAuth session expired and could not be refreshed'
        this.emit(state, {
          type: 'error',
          at: this.now(),
          message: state.failure,
          // Not retryable: a retry cannot fix a missing credential, and retrying would
          // burn the workflow's iteration budget on a certainty.
          retryable: false,
        })
        this.emit(state, { type: 'state', at: this.now(), state: 'failed' })
        return
      }
    }
  }

  /**
   * Streams events until the session reaches a terminal state.
   *
   * An async generator rather than an emitter, so back-pressure and early exit come
   * from the language: a consumer that `break`s stops the iteration, and `finally`
   * releases the waiter.
   */
  events(session: SessionHandle): AsyncIterable<RuntimeEvent> {
    const state = this.require(session)

    return {
      [Symbol.asyncIterator]: async function* (this: MockAgentRuntime) {
        // Runs until the session is disposed. Deliberately *not* until a terminal
        // state: a scenario may be driven through several steps, and the first step
        // reaching `completed` must not end a stream the caller is still reading.
        // `dispose` is the one thing that means "no more events are coming".
        while (!state.closed) {
          if (state.pending.length > 0) {
            // Drained as one batch, so an `emit` during iteration cannot interleave
            // into a half-consumed array.
            for (const event of state.pending.splice(0, state.pending.length)) {
              yield event
            }
            continue
          }

          // The queue is empty *and* the waiter is installed in the same synchronous
          // turn. Setting `wake` after an await would lose any `emit` that landed in
          // between — a lost wakeup, which is exactly how this hung for scenarios
          // whose steps perform no file edit and therefore never yield to the
          // microtask queue.
          await new Promise<void>((resolve) => {
            state.wake = resolve
          })
        }

        // Disposal may race a final `emit`, so anything still queued is delivered
        // rather than dropped.
        for (const event of state.pending.splice(0, state.pending.length)) {
          yield event
        }
      }.bind(this),
    }
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- see start()
  async status(session: SessionHandle): Promise<RuntimeStatus> {
    const state = this.require(session)

    return {
      sessionId: state.handle.sessionId,
      state: state.state,
      failure: state.failure,
      lastActivityAt: state.lastActivityAt,
    }
  }

  /**
   * Stops the session.
   *
   * Cancelling an already-terminal session is a no-op rather than an error: a workflow
   * that halts for its own reasons may cancel a session that has just finished, and
   * making that a failure would turn a benign race into a spurious error.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- see start()
  async cancel(session: SessionHandle, reason: string): Promise<void> {
    const state = this.require(session)
    if (isTerminal(state.state)) return

    state.state = 'cancelled'
    state.failure = reason
    this.emit(state, { type: 'state', at: this.now(), state: 'cancelled' })
  }

  /** Idempotent, so a `finally` block need not guard against a second call. */
  // eslint-disable-next-line @typescript-eslint/require-await -- see start()
  async dispose(session: SessionHandle): Promise<void> {
    const state = this.sessions.get(session.sessionId)
    if (state === undefined) return

    state.closed = true
    state.wake?.()
    this.sessions.delete(session.sessionId)
  }

  private require(session: SessionHandle): SessionState {
    const state = this.sessions.get(session.sessionId)
    if (state === undefined) {
      throw new Error(`Unknown session "${session.sessionId}"`)
    }

    return state
  }

  private emit(state: SessionState, event: RuntimeEvent): void {
    state.pending.push(event)
    state.lastActivityAt = event.at

    // Hand the waiter over before calling it: the consumer may synchronously come back
    // for more, and a stale `wake` would then be invoked twice.
    const wake = state.wake
    state.wake = null
    wake?.()
  }

  private async applyEdit(
    repositoryPath: string,
    relativePath: string,
    contents: string | null,
  ): Promise<void> {
    const absolute = join(repositoryPath, relativePath)

    if (contents === null) {
      await rm(absolute, { force: true })
      return
    }

    await mkdir(dirname(absolute), { recursive: true })
    await writeFile(absolute, contents, 'utf8')
  }
}

function isTerminal(state: RuntimeStatus['state']): boolean {
  return state === 'completed' || state === 'failed' || state === 'cancelled'
}
