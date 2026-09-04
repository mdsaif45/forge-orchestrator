import { describe, expect, it } from 'vitest'
import { observeStreamLine, takeCompleteLines } from './claudeStream'

/**
 * Every fixture line below was recorded from the installed Claude CLI on 2026-08-31 by
 * running a real turn that used tools, then trimmed for length. Asserting against
 * invented shapes would prove only that the parser matches my recollection, which is
 * exactly the guess A2 forbids.
 */
const INIT =
  '{"type":"system","subtype":"init","cwd":"/tmp/x","session_id":"7ed681d3","tools":["Read"],"model":"claude-sonnet-5"}'
const TOOL_GLOB =
  '{"type":"assistant","message":{"content":[{"type":"tool_use","id":"t1","name":"Glob","input":{"pattern":"**/main.rs"}}],"usage":{"input_tokens":2,"output_tokens":86}},"session_id":"7ed681d3"}'
const TOOL_RESULT =
  '{"type":"user","message":{"content":[{"type":"tool_result","content":"main.rs"}]},"session_id":"7ed681d3"}'
const RATE_OK =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"allowed","resetsAt":1788165000,"rateLimitType":"five_hour"}}'
/** Measured on a turn that COMPLETED NORMALLY by falling back to overage. */
const RATE_OVERAGE =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1788165000,"rateLimitType":"five_hour","overageStatus":"allowed_warning","isUsingOverage":true,"overageInUse":true}}'
/** Both the primary window and the overage fallback refused: the account is spent. */
const RATE_SPENT =
  '{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1788165000,"rateLimitType":"five_hour","overageStatus":"rejected","isUsingOverage":false}}'
const TEXT =
  '{"type":"assistant","message":{"content":[{"type":"text","text":"Prints hi."}],"usage":{"input_tokens":5,"output_tokens":9}},"session_id":"7ed681d3"}'
const RESULT =
  '{"type":"result","subtype":"success","is_error":false,"result":"Prints hi.","session_id":"7ed681d3","total_cost_usd":0.2655,"usage":{"input_tokens":2,"output_tokens":9}}'

describe('takeCompleteLines', () => {
  it('holds an incomplete trailing line back', () => {
    const { lines, rest } = takeCompleteLines('{"a":1}\n{"b":2}\n{"c":')
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    expect(rest).toBe('{"c":')
  })

  it('reassembles an object split across two reads', () => {
    // The failure this guards: parsing per chunk drops the fragment, and when the
    // fragment happens to be the terminal `result`, the turn never completes.
    const first = takeCompleteLines('{"type":"resu')
    expect(first.lines).toEqual([])

    const second = takeCompleteLines(`${first.rest}lt","is_error":false}\n`)
    expect(second.lines).toEqual(['{"type":"result","is_error":false}'])
    expect(second.rest).toBe('')
  })

  it('drops blank lines without losing the tail', () => {
    const { lines, rest } = takeCompleteLines('{"a":1}\n\n\n{"b":2}\nx')
    expect(lines).toEqual(['{"a":1}', '{"b":2}'])
    expect(rest).toBe('x')
  })
})

describe('observeStreamLine', () => {
  it('reports a tool invocation with its name and input', () => {
    const observed = observeStreamLine(TOOL_GLOB)
    expect(observed.tools).toEqual([{ name: 'Glob', detail: '{"pattern":"**/main.rs"}' }])
  })

  it('truncates a large tool input, because it is a display detail not evidence', () => {
    const big = JSON.stringify({
      type: 'assistant',
      message: {
        content: [{ type: 'tool_use', name: 'Write', input: { content: 'x'.repeat(5000) } }],
      },
    })
    const detail = observeStreamLine(big).tools[0]?.detail ?? ''
    expect(detail.length).toBeLessThan(400)
    expect(detail.endsWith('…')).toBe(true)
  })

  it('ignores tool results, which can be an entire file', () => {
    expect(observeStreamLine(TOOL_RESULT)).toMatchObject({ tools: [], text: '' })
  })

  it('collects assistant prose', () => {
    expect(observeStreamLine(TEXT).text).toBe('Prints hi.')
  })

  it('does not treat an allowed rate-limit event as a limit', () => {
    // Measured: this arrives on healthy turns. Treating every occurrence as a limit
    // would halt a run that is working (#137).
    expect(observeStreamLine(RATE_OK).providerLimitReached).toBe(false)
  })

  it('does not halt when the primary window is spent but overage still serves', () => {
    // Measured: status "rejected" with overageStatus "allowed_warning" on a turn that
    // completed normally. Treating status alone as a limit halted a working run.
    expect(observeStreamLine(RATE_OVERAGE).providerLimitReached).toBe(false)
  })

  it('treats a limit as spent only when the overage fallback is refused too', () => {
    expect(observeStreamLine(RATE_SPENT).providerLimitReached).toBe(true)
  })

  it('reads the terminal result, its error flag, and the session id', () => {
    expect(observeStreamLine(RESULT).result).toEqual({
      text: 'Prints hi.',
      isError: false,
      // Captured so a later step can resume this session (M9).
      sessionId: '7ed681d3',
    })
  })

  it('reads cost and tokens from the result', () => {
    expect(observeStreamLine(RESULT).usage).toEqual({
      costUsd: 0.2655,
      inputTokens: 2,
      outputTokens: 9,
    })
  })

  it('observes nothing from a system line', () => {
    expect(observeStreamLine(INIT)).toMatchObject({ tools: [], text: '', result: null })
  })

  it('survives a non-JSON line rather than throwing', () => {
    // ConPTY splices OSC title sequences into the stream mid-word, and the CLI prints
    // banners before the transport starts.
    expect(() => observeStreamLine(']0;titlenot json')).not.toThrow()
    expect(observeStreamLine('not json').result).toBeNull()
  })

  it('survives a JSON line that is not an object', () => {
    expect(observeStreamLine('42').result).toBeNull()
    expect(observeStreamLine('null').tools).toEqual([])
  })

  it('reads a whole recorded turn in order', () => {
    const transcript = [INIT, TOOL_GLOB, TOOL_RESULT, RATE_OK, TEXT, RESULT]
    const tools = transcript.flatMap((line) => observeStreamLine(line).tools.map((t) => t.name))
    const text = transcript.map((line) => observeStreamLine(line).text).join('')
    const result = transcript.map((line) => observeStreamLine(line).result).find((r) => r !== null)

    expect(tools).toEqual(['Glob'])
    expect(text).toBe('Prints hi.')
    expect(result?.isError).toBe(false)
  })
})
