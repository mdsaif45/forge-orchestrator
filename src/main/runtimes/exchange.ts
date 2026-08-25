import {
  assessReport,
  parseAgentReport,
  renderPromptPacket,
  REPORT_BEGIN,
  REPORT_END,
  type AgentReport,
  type IAgentRuntime,
  type PromptPacket,
  type ProtocolErrorCode,
  type ReportAssessment,
  type RuntimeEvent,
  type SessionHandle,
} from '@shared/domain'

/**
 * One request/response exchange with an agent, including the single re-prompt.
 *
 * Lives in main rather than in `shared` because it drives a runtime, while everything it
 * uses to interpret the reply is pure and lives in `shared/domain/protocol.ts`. The split
 * keeps the parsing rules testable without a runtime, which is where most of the
 * interesting cases are.
 *
 * ```
 * send(packet) ──> collect events ──> parse
 *                                      │ ok        -> assess -> done
 *                                      │ malformed -> re-prompt ONCE with the error
 *                                                       │ ok        -> assess -> done
 *                                                       │ malformed -> fail the step
 * ```
 *
 * Exactly one retry, per the issue. A second attempt at the same malformed output is a
 * model that cannot follow the protocol, and looping would spend the workflow's iteration
 * budget discovering that repeatedly.
 */

export type ExchangeOutcome =
  | {
      readonly ok: true
      readonly report: AgentReport
      readonly assessment: ReportAssessment
      /** True when the first reply was malformed and the retry succeeded. */
      readonly retried: boolean
      readonly transcript: readonly string[]
    }
  | {
      readonly ok: false
      /** `protocol` when the agent never produced a valid report; `runtime` when it broke. */
      readonly failure: 'protocol' | 'runtime'
      readonly code: ProtocolErrorCode | null
      readonly message: string
      readonly retried: boolean
      /**
       * The provider refused because the account's limit is spent (#137).
       *
       * Carried through rather than re-derived: the adapter decided this, and core has no
       * way to tell a limit from any other runtime error without reading provider-specific
       * text, which A6 forbids.
       */
      readonly providerLimit: boolean
      readonly transcript: readonly string[]
    }

/**
 * Waits for one turn's worth of events.
 *
 * A turn ends at a `result` event, an `error`, or a terminal state. `chunk` text is
 * accumulated because that is where a real CLI puts the report — the structured `result`
 * event exists for runtimes that can produce one directly, and the mock does, so both paths
 * are handled rather than assumed.
 */
async function collectTurn(events: AsyncIterator<RuntimeEvent>): Promise<
  | { readonly kind: 'report'; readonly report: AgentReport }
  | { readonly kind: 'text'; readonly text: string }
  | {
      readonly kind: 'error'
      readonly message: string
      readonly retryable: boolean
      readonly providerLimit: boolean
    }
> {
  let text = ''
  // A session emits `idle` when it starts, before any instruction has been sent, and that
  // queued event is still in the stream when the first turn begins. Ending on it would cut
  // turn one short with no output at all, so `idle` only counts once work has been seen.
  let working = false

  for (;;) {
    const next = await events.next()
    if (next.done === true) {
      return { kind: 'text', text }
    }

    const event = next.value

    switch (event.type) {
      case 'chunk': {
        text += event.text
        break
      }

      case 'result': {
        // A runtime that already produced a structured report has done the protocol's job
        // for it; there is nothing to extract.
        return { kind: 'report', report: event.report }
      }

      case 'error': {
        return {
          kind: 'error',
          message: event.message,
          retryable: event.retryable,
          providerLimit: event.providerLimit,
        }
      }

      case 'state': {
        if (event.state === 'working') {
          working = true
          break
        }

        // `idle` ends a turn as much as a terminal state does: it means the runtime has
        // finished this instruction and is waiting for the next one. A session that stays
        // alive across steps never reaches `completed`, so waiting only for terminal states
        // would hang on exactly the runtimes that support multi-step work.
        if (event.state === 'idle') {
          if (working) return { kind: 'text', text }
          break
        }

        if (
          event.state === 'completed' ||
          event.state === 'failed' ||
          event.state === 'cancelled'
        ) {
          return { kind: 'text', text }
        }
        break
      }

      case 'tool':
      case 'usage': {
        // Recorded by the caller through its own event subscription; not part of the reply.
        // Listed rather than left to a default, so a new event type is a decision here
        // instead of silently doing nothing.
        break
      }
    }
  }
}

/**
 * Sends a packet and returns a validated report, re-prompting once if the reply is
 * malformed.
 *
 * The retry feeds the validation error back verbatim. A vague "your report was invalid"
 * would make the second attempt a guess, and the whole reason for validating with a schema
 * is that the failure is specific enough to act on.
 */
export async function exchange(
  runtime: IAgentRuntime,
  session: SessionHandle,
  packet: PromptPacket,
): Promise<ExchangeOutcome> {
  const events = runtime.events(session)[Symbol.asyncIterator]()
  const transcript: string[] = []

  /**
   * Runs one attempt.
   *
   * `retry` is only ever returned for a first attempt, but the signature does not try to
   * express that — the caller below reads it once and never again, and encoding the
   * distinction in the type would cost more than it explains.
   */
  const attempt = async (
    prompt: PromptPacket,
    correction: string | null,
  ): Promise<ExchangeOutcome | { readonly retry: string }> => {
    // The correction travels *on* the packet. It used to be concatenated onto a local
    // string that was pushed to the transcript while `prompt` was sent unchanged — and
    // since every adapter renders from the packet, the correction reached no agent. The
    // transcript recorded a re-prompt that never happened, so a halt after two identical
    // attempts read as "the agent ignored the correction" (#135).
    const sent: PromptPacket =
      correction === null ? prompt : { ...prompt, correction: correctionNotice(correction) }

    transcript.push(renderPromptPacket(sent))
    await runtime.send(session, sent)

    const turn = await collectTurn(events)

    if (turn.kind === 'error') {
      return {
        ok: false,
        failure: 'runtime',
        code: null,
        message: turn.message,
        retried: correction !== null,
        providerLimit: turn.providerLimit,
        transcript,
      }
    }

    if (turn.kind === 'report') {
      return {
        ok: true,
        report: turn.report,
        assessment: assessReport(turn.report),
        retried: correction !== null,
        transcript,
      }
    }

    transcript.push(turn.text)
    const parsed = parseAgentReport(turn.text)

    if (parsed.ok) {
      return {
        ok: true,
        report: parsed.report,
        assessment: assessReport(parsed.report),
        retried: correction !== null,
        transcript,
      }
    }

    // Already the retry: stop rather than loop.
    if (correction !== null) {
      return {
        ok: false,
        failure: 'protocol',
        code: parsed.code,
        message: parsed.message,
        retried: true,
        providerLimit: false,
        transcript,
      }
    }

    return { retry: parsed.message }
  }

  const first = await attempt(packet, null)
  if (!('retry' in first)) return first

  const second = await attempt(packet, first.retry)
  if (!('retry' in second)) return second

  // Unreachable: `attempt` returns a `retry` only when `correction` is null, and it is not
  // here. Handled rather than cast, so a future change to that invariant surfaces as a
  // real failure instead of a lie about the return type.
  return {
    ok: false,
    failure: 'protocol',
    code: null,
    message: 'The agent did not produce a valid report after a correction',
    retried: true,
    providerLimit: false,
    transcript,
  }
}

/**
 * The correction appended on the retry.
 *
 * States the actual validation failure and repeats the fences, because the two things that
 * go wrong are a missing block and a missing field, and each needs the other's remedy
 * restated to be unambiguous.
 */
function correctionNotice(error: string): string {
  return `YOUR PREVIOUS REPLY WAS REJECTED

${error}

Reply again with the work you already did, in exactly one block delimited by
${REPORT_BEGIN} and ${REPORT_END}. Do not redo the work; only fix the report.`
}
