/**
 * Parses the Claude CLI's `--output-format stream-json` transport.
 *
 * ```
 * NDJSON line ──> classify ──> RuntimeEvent(s)
 *                     │
 *                     ├─ assistant.text      -> (accumulated, NOT emitted per block)
 *                     ├─ assistant.tool_use  -> tool
 *                     ├─ usage on a message  -> usage
 *                     ├─ rate_limit_event    -> (inspected; only a spent limit matters)
 *                     └─ result              -> terminal; carries the reply text
 * ```
 *
 * Pure on purpose: it takes text and returns events, so the shapes below can be
 * asserted against a fixture recorded from the real CLI without spawning anything.
 * A6 also applies — this file names a provider's wire format, which is why it lives in
 * `main/runtimes/` and never in `shared/`.
 *
 * **Assistant text is deliberately not emitted per block.** `parseAgentReport` takes the
 * first `FORGE_REPORT_BEGIN` it finds, so emitting streamed prose *and* the final reply
 * would put two copies of the report block in the transcript `exchange()` assembles.
 * That is the defect described at length in `claudeCliRuntime.ts` (#130): the agent had
 * already done the work correctly and the workflow halted on a double parse. Streaming
 * text is therefore reported separately from the reply text, and the adapter decides
 * which one reaches the transcript.
 */

/** One line of the CLI's NDJSON, reduced to what Forge acts on. */
export interface StreamObservation {
  /** Tool invocations, in the order the agent made them. */
  readonly tools: readonly { readonly name: string; readonly detail: string }[]
  /** Assistant prose, for display only — never for parsing a report. */
  readonly text: string
  /** Present only on the terminal `result` line. */
  readonly result: {
    readonly text: string
    readonly isError: boolean
    readonly sessionId: string | null
  } | null
  /** Token and cost figures, when the provider reported them. */
  readonly usage: {
    readonly costUsd: number | null
    readonly inputTokens: number | null
    readonly outputTokens: number | null
  } | null
  /**
   * Set when the provider says the account's limit is spent.
   *
   * `rate_limit_event` arrives on ordinary turns too, with `status: "allowed"` — treating
   * every occurrence as a limit would halt a healthy run (#137/#147). Only a status other
   * than `allowed` is a limit.
   */
  readonly providerLimitReached: boolean
}

const EMPTY: StreamObservation = {
  tools: [],
  text: '',
  result: null,
  usage: null,
  providerLimitReached: false,
}

const asRecord = (value: unknown): Record<string, unknown> | null =>
  typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null

const asString = (value: unknown): string | null => (typeof value === 'string' ? value : null)

const asNumber = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

/**
 * Splits a stdout buffer into complete NDJSON lines, returning the incomplete tail.
 *
 * A read boundary falls anywhere, so the last line of a chunk is usually a fragment.
 * Parsing per chunk instead of per line would discard it and lose whole events —
 * including, at the wrong moment, the terminal `result`.
 */
export function takeCompleteLines(buffer: string): {
  readonly lines: readonly string[]
  readonly rest: string
} {
  const parts = buffer.split('\n')
  // The final element is either an empty string (buffer ended in a newline) or a
  // fragment; either way it is not yet a complete line.
  const rest = parts.pop() ?? ''
  return { lines: parts.filter((line) => line.trim() !== ''), rest }
}

/** Reduces one NDJSON line to what Forge acts on. Unknown shapes observe nothing. */
export function observeStreamLine(line: string): StreamObservation {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch {
    // A non-JSON line is normal: ConPTY splices OSC title sequences into the stream,
    // and the CLI prints banners before the transport starts.
    return EMPTY
  }

  const message = asRecord(parsed)
  if (message === null) return EMPTY

  switch (asString(message.type)) {
    case 'assistant':
      return observeAssistant(message)
    case 'rate_limit_event':
      return observeRateLimit(message)
    case 'result':
      return observeResult(message)
    case null:
    default:
      // `system`, `user` (tool results), a line with no `type` at all, and anything the
      // CLI adds later. Tool *results* are deliberately ignored: they can be enormous (a
      // whole file's contents), and the invocation is what tells the user what the agent
      // is doing.
      return EMPTY
  }
}

function observeAssistant(message: Record<string, unknown>): StreamObservation {
  const inner = asRecord(message.message)
  if (inner === null) return EMPTY

  const blocks = Array.isArray(inner.content) ? inner.content : []
  const tools: { name: string; detail: string }[] = []
  let text = ''

  for (const raw of blocks) {
    const block = asRecord(raw)
    if (block === null) continue

    if (asString(block.type) === 'text') {
      text += asString(block.text) ?? ''
      continue
    }

    if (asString(block.type) === 'tool_use') {
      const name = asString(block.name)
      if (name === null) continue
      // The input is truncated rather than stored whole: a Write's input carries an
      // entire file, and this is a display detail, not evidence.
      const input = block.input === undefined ? '' : JSON.stringify(block.input)
      tools.push({ name, detail: input.length > 300 ? `${input.slice(0, 300)}…` : input })
    }
  }

  return { ...EMPTY, tools, text, usage: readUsage(inner.usage) }
}

function observeRateLimit(message: Record<string, unknown>): StreamObservation {
  const info = asRecord(message.rate_limit_info)
  if (info === null) return EMPTY

  const status = asString(info.status)
  const overageStatus = asString(info.overageStatus)

  // `status` alone is NOT a limit. Measured on a turn that completed normally:
  //
  //   {"status":"rejected","rateLimitType":"five_hour",
  //    "overageStatus":"allowed_warning","isUsingOverage":true,"overageInUse":true}
  //
  // The primary window was exhausted and the request was served from overage — the work
  // succeeded. An earlier version of this treated any non-`allowed` status as spent, and
  // halted a real run that was working. The account is only actually spent when the
  // fallback is refused too, so both must be non-allowed before Forge stops (#147).
  const primarySpent = status !== null && status !== 'allowed'
  const overageSpent =
    overageStatus !== null && overageStatus !== 'allowed' && !overageStatus.startsWith('allowed')

  return { ...EMPTY, providerLimitReached: primarySpent && overageSpent }
}

function observeResult(message: Record<string, unknown>): StreamObservation {
  return {
    ...EMPTY,
    result: {
      text: asString(message.result) ?? '',
      isError: message.is_error === true,
      sessionId: asString(message.session_id),
    },
    usage: readUsage(message.usage, asNumber(message.total_cost_usd)),
  }
}

function readUsage(raw: unknown, costUsd: number | null = null): StreamObservation['usage'] {
  const usage = asRecord(raw)
  if (usage === null) return costUsd === null ? null : { costUsd, ...EMPTY_TOKENS }

  const inputTokens = asNumber(usage.input_tokens)
  const outputTokens = asNumber(usage.output_tokens)
  if (costUsd === null && inputTokens === null && outputTokens === null) return null

  return { costUsd, inputTokens, outputTokens }
}

const EMPTY_TOKENS = { inputTokens: null, outputTokens: null } as const
