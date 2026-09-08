/**
 * Parses the Antigravity CLI's `--output-format=stream-json` transport.
 *
 * ```
 * NDJSON line ──> event ──> RuntimeEvent(s)
 *                   │
 *                   ├─ init                        session/tool inventory (ignored)
 *                   ├─ step_update step_type=tool  -> tool, on the ACTIVE edge only
 *                   ├─ step_update usage           -> usage, accumulated per turn
 *                   └─ result                      -> terminal; carries the reply
 * ```
 *
 * Deliberately a separate module from `claudeStream.ts`. The two CLIs share no wire
 * shape at all — Claude emits Anthropic-style `assistant` messages with content blocks,
 * Antigravity emits `{"event":"step_update","step_update":{...}}` with `ACTIVE`/`DONE`
 * state transitions. A single "NDJSON parser" would be a union of two unrelated formats
 * pretending to be one thing. A6 keeps both here in `main/runtimes/`, never in `shared/`.
 *
 * Shapes below were recorded from the installed `agy` on 2026-08-31, not from docs.
 */

/** One line of the CLI's NDJSON, reduced to what Forge acts on. */
export interface AntigravityObservation {
  /** Tool invocations, reported once each when they start. */
  readonly tools: readonly { readonly name: string; readonly detail: string }[]
  /** Present only on the terminal `result` event. */
  readonly result: {
    readonly text: string
    readonly isError: boolean
    /** Antigravity's own id, for resuming with `--conversation` (M9). */
    readonly conversationId: string | null
    /**
     * Set when the CLI refused before doing any work.
     *
     * Measured, and intermittent on this machine: an eligibility probe that fetches the
     * account's profile picture fails with a network error and the whole turn returns
     * `status: "ERROR"` with `num_turns: 0`. It succeeded on retry roughly half the time.
     * Distinguished from a real failure because retrying is the correct response, and
     * because reporting it as the agent's failure would be a lie about whose fault it is.
     */
    readonly refusedBeforeStarting: boolean
  } | null
  /** Token counts, when the CLI reported them on a step or the result. */
  readonly usage: {
    readonly costUsd: number | null
    readonly inputTokens: number | null
    readonly outputTokens: number | null
  } | null
}

const EMPTY: AntigravityObservation = { tools: [], result: null, usage: null }

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/** Reduces one NDJSON line to what Forge acts on. Unknown shapes observe nothing. */
export function observeAntigravityLine(line: string): AntigravityObservation {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // Banners and ConPTY OSC sequences arrive on the same stream.
    return EMPTY
  }

  const message = asRecord(parsed)
  if (message === null) return EMPTY

  switch (asString(message.event)) {
    case 'step_update':
      return observeStepUpdate(message.step_update)
    case 'result':
      return observeResult(message.result)
    case null:
    default:
      // `init` carries the CWD, permission mode, and the CLI's whole tool inventory —
      // useful for a spike, noise for a live view.
      return EMPTY
  }
}

function observeStepUpdate(raw: unknown): AntigravityObservation {
  const step = asRecord(raw)
  if (step === null) return EMPTY

  const usage = readUsage(step.usage)

  if (asString(step.step_type) !== 'tool') {
    // `agent_response` steps carry usage but no text — the reply arrives whole in the
    // terminal result, so there is nothing to stream from them.
    return { ...EMPTY, usage }
  }

  // A tool appears twice: ACTIVE when it starts, DONE when it finishes with an `output`
  // field added. Only the ACTIVE edge is reported, so the timeline shows one row per
  // invocation rather than two, and shows it as the agent starts rather than after.
  if (asString(step.state) !== 'ACTIVE') return { ...EMPTY, usage }

  const name = asString(step.tool_name)
  if (name === null) return { ...EMPTY, usage }

  const info = asRecord(step.tool_info)
  const parameters = info === null ? undefined : info.parameters
  const detail = parameters === undefined ? '' : JSON.stringify(parameters)

  return {
    ...EMPTY,
    usage,
    tools: [{ name, detail: detail.length > 300 ? `${detail.slice(0, 300)}…` : detail }],
  }
}

function observeResult(raw: unknown): AntigravityObservation {
  const result = asRecord(raw)
  if (result === null) return EMPTY

  const status = asString(result.status)
  const isError = status !== null && status !== 'SUCCESS'

  // `num_turns: 0` with an error means the CLI never reached the model — the eligibility
  // probe above. A turn that ran and then failed has a non-zero count.
  const turns = asNumber(result.num_turns) ?? 0

  return {
    ...EMPTY,
    result: {
      text: asString(result.response) ?? '',
      isError,
      conversationId: asString(result.conversation_id),
      refusedBeforeStarting: isError && turns === 0,
    },
    usage: readUsage(result.usage),
  }
}

function readUsage(raw: unknown): AntigravityObservation['usage'] {
  const usage = asRecord(raw)
  if (usage === null) return null

  const inputTokens = asNumber(usage.input_tokens)
  const outputTokens = asNumber(usage.output_tokens)
  if (inputTokens === null && outputTokens === null) return null

  // This CLI reports no cost figure at all. Null rather than a computed estimate: a
  // number Forge derived itself would be indexed as the provider's own (A3). Its
  // `thinking_tokens` and `cache_read_tokens` have no field on the event yet — recorded
  // here as a known omission rather than folded into `outputTokens`, which would
  // overstate output.
  return { costUsd: null, inputTokens, outputTokens }
}
