import { describe, expect, it } from 'vitest'
import { observeAntigravityLine } from './antigravityStream'

/**
 * Recorded from the installed `agy` on 2026-08-31 by running a real turn that used
 * tools, then trimmed. The `init` line's tool inventory is ~50 entries in reality.
 */
const INIT =
  '{"event":"init","conversation_id":"c450c7c4","init":{"cwd":"/tmp/x","tools":["view_file","find_by_name"],"permission_mode":"request-review"}}'
const STEP_USER =
  '{"event":"step_update","step_update":{"conversation_id":"c450c7c4","step_index":0,"state":"DONE","step_type":"user_input"}}'
const STEP_RESPONSE =
  '{"event":"step_update","step_update":{"conversation_id":"c450c7c4","step_index":1,"state":"DONE","step_type":"agent_response","duration_seconds":42.6,"usage":{"input_tokens":7044,"output_tokens":532,"thinking_tokens":466,"cache_read_tokens":8094,"total_tokens":7576}}}'
const TOOL_ACTIVE =
  '{"event":"step_update","step_update":{"conversation_id":"c450c7c4","step_index":2,"state":"ACTIVE","step_type":"tool","tool_name":"find_by_name","tool_info":{"name":"find_by_name","parameters":{"Pattern":"main.rs","SearchDirectory":"/tmp/x"}}}}'
const TOOL_DONE =
  '{"event":"step_update","step_update":{"conversation_id":"c450c7c4","step_index":2,"state":"DONE","step_type":"tool","tool_name":"find_by_name","duration_seconds":0.21,"tool_info":{"name":"find_by_name","parameters":{"Pattern":"main.rs"},"output":"main.rs"}}}'
const RESULT_OK =
  '{"event":"result","result":{"conversation_id":"c450c7c4","status":"SUCCESS","response":"Prints hi.\\n","duration_seconds":22.3,"num_turns":2,"usage":{"input_tokens":18447,"output_tokens":330,"thinking_tokens":318,"cache_read_tokens":12135,"total_tokens":18777}}}'
/** Measured: an intermittent pre-flight refusal that never reached the model. */
const RESULT_INELIGIBLE =
  '{"event":"result","result":{"conversation_id":"","status":"ERROR","response":"","error":"Eligibility check failed: failed to get profile picture","duration_seconds":0,"num_turns":0,"usage":{"input_tokens":0,"output_tokens":0}}}'

describe('observeAntigravityLine', () => {
  it('reports a tool when it starts, with its parameters', () => {
    expect(observeAntigravityLine(TOOL_ACTIVE).tools).toEqual([
      { name: 'find_by_name', detail: '{"Pattern":"main.rs","SearchDirectory":"/tmp/x"}' },
    ])
  })

  it('does not report the same tool again when it finishes', () => {
    // A tool appears twice in the stream (ACTIVE then DONE). Reporting both would show
    // every invocation twice in the timeline.
    expect(observeAntigravityLine(TOOL_DONE).tools).toEqual([])
  })

  it('truncates a large tool parameter blob', () => {
    const big = JSON.stringify({
      event: 'step_update',
      step_update: {
        state: 'ACTIVE',
        step_type: 'tool',
        tool_name: 'write_to_file',
        tool_info: { parameters: { CodeContent: 'x'.repeat(5000) } },
      },
    })
    const detail = observeAntigravityLine(big).tools[0]?.detail ?? ''
    expect(detail.length).toBeLessThan(400)
    expect(detail.endsWith('…')).toBe(true)
  })

  it('reads usage from an agent_response step', () => {
    expect(observeAntigravityLine(STEP_RESPONSE).usage).toEqual({
      // This CLI reports no cost; null rather than an estimate Forge computed (A3).
      costUsd: null,
      inputTokens: 7044,
      outputTokens: 532,
    })
  })

  it('observes nothing actionable from user_input or init', () => {
    expect(observeAntigravityLine(STEP_USER)).toEqual({ tools: [], result: null, usage: null })
    expect(observeAntigravityLine(INIT)).toEqual({ tools: [], result: null, usage: null })
  })

  it('reads the terminal result and the conversation id', () => {
    expect(observeAntigravityLine(RESULT_OK).result).toEqual({
      text: 'Prints hi.\n',
      isError: false,
      // Captured so a later step can resume with --conversation (M9).
      conversationId: 'c450c7c4',
      refusedBeforeStarting: false,
    })
  })

  it('marks a pre-flight refusal as such, not as the agent failing', () => {
    // num_turns 0 with an error means the CLI never reached the model. Retrying is the
    // correct response; blaming the agent would be a lie about whose failure it is.
    const result = observeAntigravityLine(RESULT_INELIGIBLE).result
    expect(result?.isError).toBe(true)
    expect(result?.refusedBeforeStarting).toBe(true)
  })

  it('does not mark a genuine mid-turn failure as a pre-flight refusal', () => {
    const failed = RESULT_INELIGIBLE.replace('"num_turns":0', '"num_turns":3')
    expect(observeAntigravityLine(failed).result?.refusedBeforeStarting).toBe(false)
  })

  it('survives non-JSON and non-object lines', () => {
    expect(() => observeAntigravityLine(']0;title')).not.toThrow()
    expect(observeAntigravityLine('42').result).toBeNull()
  })

  it('reads a whole recorded turn in order', () => {
    const transcript = [INIT, STEP_USER, STEP_RESPONSE, TOOL_ACTIVE, TOOL_DONE, RESULT_OK]
    const tools = transcript.flatMap((l) => observeAntigravityLine(l).tools.map((t) => t.name))
    const result = transcript.map((l) => observeAntigravityLine(l).result).find((r) => r !== null)

    expect(tools).toEqual(['find_by_name'])
    expect(result?.isError).toBe(false)
  })
})
