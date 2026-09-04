import xterm from '@xterm/headless'
import {
  blockingPrompt,
  isPromptReady,
  promptKeystrokes,
  turnLooksComplete,
} from './interactiveTurn'

const { Terminal } = xterm

/**
 * One hosted CLI session: a real interactive process, with a terminal emulator
 * holding its screen.
 *
 * The emulator is not decoration. A hosted TUI paints with cursor addressing,
 * alternate screens, and repaints; reading it with a regex over raw bytes
 * destroyed an answer that was on screen and produced a false conclusion written
 * into a spike and an ADR. The emulator resolves what is actually displayed, and
 * is the same component the pane will render (`docs/CLI-FIELD-GUIDE.md`).
 *
 * ```
 * boot ──> wait for the prompt box ──> type a prompt ──> wait for idle
 *            │                                              │
 *      blocking dialog?                              screen text = the turn
 * ```
 *
 * The session outlives a turn. That is the point: it stays warm, so the next
 * step pays no cold-start cost.
 */
export interface HostedSessionOptions {
  /** Writes to the process. Supplied by whatever spawned it. */
  readonly write: (data: string) => void
  readonly cols?: number
  readonly rows?: number
  /** Injected so a test drives time instead of waiting on it. */
  readonly sleep?: (ms: number) => Promise<void>
  /** Bounds every wait, so a wedged CLI fails the step rather than hanging a run. */
  readonly timeoutMs?: number
}

export type TurnOutcome =
  | { readonly kind: 'answered'; readonly screen: string }
  | { readonly kind: 'blocked'; readonly on: 'trust' | 'permission'; readonly screen: string }
  | { readonly kind: 'timeout'; readonly screen: string }

const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class HostedSession {
  private readonly term: InstanceType<typeof Terminal>
  private readonly options: HostedSessionOptions
  private readonly sleep: (ms: number) => Promise<void>
  private readonly timeoutMs: number

  constructor(options: HostedSessionOptions) {
    this.options = options
    this.sleep = options.sleep ?? defaultSleep
    this.timeoutMs = options.timeoutMs ?? 600_000
    this.term = new Terminal({
      cols: options.cols ?? 120,
      rows: options.rows ?? 30,
      allowProposedApi: true,
    })
  }

  /**
   * Feeds output from the process into the emulator.
   *
   * Awaited, because `Terminal.write` is asynchronous: it buffers and parses on a
   * callback, so a synchronous read straight afterwards returns a blank screen.
   * Measured — every screen assertion failed until this was awaited, which would
   * have looked like the CLI producing nothing rather than a parse still pending.
   */
  receive(data: string): Promise<void> {
    return new Promise((resolve) => {
      this.term.write(data, resolve)
    })
  }

  /** Everything the emulator holds, scrollback included. */
  screen(): string {
    return this.readLines(0)
  }

  /**
   * Only the rows currently displayed, excluding scrollback.
   *
   * The busy indicator has to be judged on this rather than on the whole buffer.
   * A TUI repaints in place, but the emulator keeps what scrolled past, so
   * "esc to interrupt" from a finished turn stays readable forever — and a
   * completion check over the full buffer would never fire again after the first
   * turn. Measured: the second turn hung with its answer already on screen.
   */
  visible(): string {
    return this.readLines(this.term.buffer.active.baseY)
  }

  private readLines(from: number): string {
    const lines: string[] = []
    for (let y = from; y < this.term.buffer.active.length; y += 1) {
      const line = this.term.buffer.active.getLine(y)
      if (line) lines.push(line.translateToString(true))
    }
    return lines.join('\n')
  }

  /**
   * Waits until the session is ready for a prompt.
   *
   * Returns the blocking dialog instead when one is on screen. Both known dialogs
   * are pre-empted before launch, so reaching one means an assumption failed —
   * reported rather than absorbed, because silently waiting out the timeout is
   * how #166 looked like a hung process for hours.
   */
  async waitForPrompt(): Promise<'ready' | 'trust' | 'permission' | 'timeout'> {
    return this.pollUntil(() => {
      const screen = this.visible()
      const blocked = blockingPrompt(screen)
      if (blocked !== null) return blocked
      return isPromptReady(screen) ? 'ready' : null
    })
  }

  /**
   * Waits until the screen stops changing for `quietMs`, on top of
   * `waitForPrompt`'s caret check.
   *
   * Measured against the real CLI: the prompt caret is visible within the
   * first second of boot, well before MCP-authentication warnings,
   * SessionStart hook output, and plugin banners have finished painting. A
   * prompt typed as soon as the caret appears can be swallowed by that
   * trailing boot noise, or answered by the model as if it were part of the
   * banner rather than the user's instruction — measured directly: a real
   * turn sent right after `waitForPrompt` resolved got a reply about the
   * global CLAUDE.md's own caveman-mode instruction, not the task, because the
   * prompt landed mid-boot.
   *
   * Only needed once, for the very first turn on a freshly spawned process —
   * a resumed or already-idle session has no boot noise left to wait out.
   */
  async waitForBootSettled(quietMs = 1500): Promise<void> {
    const ready = await this.waitForPrompt()
    if (ready !== 'ready') return

    // Measured in poll ticks, not `Date.now()`. This method's whole purpose is
    // to wait out a real duration, and a caller that injects a fake `sleep` for
    // testability needs that duration to scale with the fake clock too — a
    // wall-clock deadline here takes the real 1.5s+ regardless of what `sleep`
    // resolves to, which is the exact "test that sleeps encodes one machine's
    // timing" problem this project's own tests exist to avoid.
    const pollMs = 250
    const quietTicks = Math.max(1, Math.ceil(quietMs / pollMs))
    const deadlineTicks = Math.ceil(this.timeoutMs / pollMs)

    let last = this.visible()
    let quietFor = 0

    for (let tick = 0; tick < deadlineTicks; tick += 1) {
      await this.sleep(pollMs)
      const now = this.visible()
      if (now !== last) {
        last = now
        quietFor = 0
      } else {
        quietFor += 1
        if (quietFor >= quietTicks) return
      }
    }
  }

  /**
   * Sends one prompt and waits for the turn to finish.
   *
   * The busy indicator is checked before the idle prompt box, because the box is
   * also present *before* a turn starts — treating its presence alone as
   * completion would return the previous turn's screen as this turn's answer.
   */
  async runTurn(prompt: string): Promise<TurnOutcome> {
    for (const key of promptKeystrokes(prompt)) {
      this.options.write(key.text)
      if (key.pauseMs > 0) await this.sleep(key.pauseMs)
    }

    // A turn is only "complete" once work has been observed. Without this the
    // very first poll sees the idle box the prompt was typed into and returns
    // immediately, before the agent has done anything at all.
    //
    // "Work" cannot mean the busy indicator alone: measured against the real CLI,
    // the caret is back on screen within a second of submitting while the agent is
    // still thinking, so a poll landing in that window called a 13s turn complete
    // before any answer existed. The screen must also CHANGE from what was there
    // when the prompt was sent.
    const submitted = this.visible()
    let sawWork = false

    const result = await this.pollUntil(() => {
      const screen = this.visible()

      const blocked = blockingPrompt(screen)
      if (blocked !== null) return blocked

      if (!turnLooksComplete(screen)) {
        sawWork = true
        return null
      }

      // An unchanged screen means nothing has happened yet, however idle it looks.
      if (screen !== submitted) sawWork = true

      return sawWork ? 'ready' : null
    })

    const screen = this.screen()
    if (result === 'ready') return { kind: 'answered', screen }
    if (result === 'timeout') return { kind: 'timeout', screen }
    return { kind: 'blocked', on: result, screen }
  }

  /**
   * Polls a predicate on a bounded loop.
   *
   * Bounded rather than open-ended so a wedged CLI fails the step with a reason
   * instead of hanging the workflow — and polled on a condition rather than a
   * fixed sleep, so a fast machine is not made to wait and a slow one is not cut
   * short.
   */
  private async pollUntil<T extends string>(check: () => T | null): Promise<T | 'timeout'> {
    const deadline = Date.now() + this.timeoutMs

    for (;;) {
      const hit = check()
      if (hit !== null) return hit
      if (Date.now() >= deadline) return 'timeout'
      await this.sleep(250)
    }
  }
}
