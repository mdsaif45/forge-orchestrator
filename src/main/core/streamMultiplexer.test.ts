import { describe, expect, it } from 'vitest'
import {
  AgentStreamMultiplexer,
  type StreamTokenDelta,
  type StreamToolDelta,
} from './streamMultiplexer'

describe('AgentStreamMultiplexer (AGENT-014)', () => {
  it('accumulates streamed tokens and triggers token callbacks', () => {
    const tokensEmitted: StreamTokenDelta[] = []
    const mux = new AgentStreamMultiplexer({
      onToken: (delta) => tokensEmitted.push(delta),
    })

    mux.pushToken('Hello')
    mux.pushToken(' ')
    mux.pushToken('world!')

    expect(mux.getAccumulatedText()).toBe('Hello world!')
    expect(mux.getTokenCount()).toBe(3)
    expect(tokensEmitted).toHaveLength(3)
    expect(tokensEmitted[2]?.accumulatedText).toBe('Hello world!')

    const summary = mux.finalize()
    expect(summary.valid).toBe(true)
    expect(summary.totalTokens).toBe(3)
    expect(summary.completedText).toBe('Hello world!')
    expect(summary.formattedSummary).toContain('Total Tokens:   3')
  })

  it('stitches fragmented tool call names and JSON arguments across multiple tool indexes', () => {
    const toolDeltas: StreamToolDelta[] = []
    const mux = new AgentStreamMultiplexer({
      onTool: (delta) => toolDeltas.push(delta),
    })

    // Tool 0: readFile
    mux.pushToolDelta(0, 'read', '{"path":')
    mux.pushToolDelta(0, 'File', ' "src/main.ts"}')

    // Tool 1: runCommand
    mux.pushToolDelta(1, 'run', '{"com')
    mux.pushToolDelta(1, 'Command', 'mand": "npm test"}')

    expect(toolDeltas).toHaveLength(4)

    const summary = mux.finalize('tool_calls')
    expect(summary.valid).toBe(true)
    expect(summary.toolCalls).toHaveLength(2)

    const tool0 = summary.toolCalls[0]
    expect(tool0?.name).toBe('readFile')
    expect(tool0?.validJson).toBe(true)
    expect(tool0?.parsedArgs).toEqual({ path: 'src/main.ts' })

    const tool1 = summary.toolCalls[1]
    expect(tool1?.name).toBe('runCommand')
    expect(tool1?.validJson).toBe(true)
    expect(tool1?.parsedArgs).toEqual({ command: 'npm test' })
  })

  it('fails closed when token budget ceiling is exceeded (Axiom A5)', () => {
    const mux = new AgentStreamMultiplexer({ maxTokenBudget: 3 })
    mux.pushToken('T1')
    mux.pushToken('T2')
    mux.pushToken('T3')

    expect(() => mux.pushToken('T4')).toThrow('Token stream exceeded max token budget limit of 3')
  })

  it('fails closed when buffer byte limit is exceeded (Axiom A5)', () => {
    const mux = new AgentStreamMultiplexer({ maxBufferBytes: 10 })
    mux.pushToken('12345')

    expect(() => mux.pushToken('678901')).toThrow(
      'Stream buffer exceeded maximum byte capacity of 10 bytes',
    )
  })

  it('handles invalid tool JSON gracefully without throwing on finalize', () => {
    const mux = new AgentStreamMultiplexer()
    mux.pushToolDelta(0, 'corruptTool', '{"unterminatedJson:')

    const summary = mux.finalize()
    expect(summary.valid).toBe(true)
    expect(summary.toolCalls).toHaveLength(1)
    expect(summary.toolCalls[0]?.name).toBe('corruptTool')
    expect(summary.toolCalls[0]?.validJson).toBe(false)
    expect(summary.toolCalls[0]?.parsedArgs).toBeNull()
  })
})
