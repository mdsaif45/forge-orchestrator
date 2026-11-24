import { describe, expect, it } from 'vitest'
import { streamChat, ThinkingSplitter } from './chatStream'

/**
 * The streaming reader and the reasoning split.
 *
 * The splitter is stateful on purpose, and the cases that matter are the ones
 * where a boundary lands mid-tag — which is exactly what a slow network or a
 * token-at-a-time model produces, and what a per-chunk regex gets wrong while
 * looking correct on a fast local run.
 */

const join = (chunks: readonly { kind: string; text: string }[], kind: string): string =>
  chunks
    .filter((chunk) => chunk.kind === kind)
    .map((chunk) => chunk.text)
    .join('')

describe('ThinkingSplitter', () => {
  it('passes plain content straight through', () => {
    const splitter = new ThinkingSplitter()
    const out = [...splitter.push('hello world'), ...splitter.flush()]

    expect(join(out, 'content')).toBe('hello world')
    expect(join(out, 'reasoning')).toBe('')
  })

  it('separates a complete think block from the answer', () => {
    const splitter = new ThinkingSplitter()
    const out = [...splitter.push('<think>weighing it up</think>the answer'), ...splitter.flush()]

    expect(join(out, 'reasoning')).toBe('weighing it up')
    expect(join(out, 'content')).toBe('the answer')
  })

  it('handles a tag split across two arrivals', () => {
    // The case a stateless regex loses: the opening tag arrives in halves, so
    // neither chunk contains a complete marker.
    const splitter = new ThinkingSplitter()
    const out = [
      ...splitter.push('<thi'),
      ...splitter.push('nk>reasoning here</thi'),
      ...splitter.push('nk>done'),
      ...splitter.flush(),
    ]

    expect(join(out, 'reasoning')).toBe('reasoning here')
    expect(join(out, 'content')).toBe('done')
  })

  it('handles one character at a time', () => {
    // The degenerate case, and the strongest evidence the state machine is not
    // accidentally relying on chunk size.
    const splitter = new ThinkingSplitter()
    const source = 'a<think>b</think>c'
    const out = [
      ...source.split('').flatMap((character) => [...splitter.push(character)]),
      ...splitter.flush(),
    ]

    expect(join(out, 'content')).toBe('ac')
    expect(join(out, 'reasoning')).toBe('b')
  })

  it('emits unterminated reasoning on flush rather than dropping it', () => {
    // A model that is cut off mid-thought still said something; discarding it
    // would leave the user with an empty reply and no reason why.
    const splitter = new ThinkingSplitter()
    const out = [...splitter.push('<think>cut off'), ...splitter.flush()]

    expect(join(out, 'reasoning')).toBe('cut off')
  })

  it('never emits a partial tag as visible text', () => {
    // Held back deliberately: showing a bare "<thi" in the transcript would be
    // worse than showing nothing yet.
    const splitter = new ThinkingSplitter()
    const out = splitter.push('answer<thi')

    expect(join(out, 'content')).toBe('answer')
  })
})

/** A `fetch` that replays fixed lines as a real byte stream. */
const streamingFetch = (lines: readonly string[], ok = true): typeof fetch =>
  (() =>
    Promise.resolve({
      ok,
      status: ok ? 200 : 500,
      statusText: 'Error',
      text: () => Promise.resolve('boom'),
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          const encoder = new TextEncoder()
          for (const line of lines) controller.enqueue(encoder.encode(`${line}\n`))
          controller.close()
        },
      }),
    })) as unknown as typeof fetch

describe('streamChat over an OpenAI-compatible endpoint', () => {
  it('assembles server-sent deltas in order', async () => {
    const seen: string[] = []
    const result = await streamChat(
      {
        providerId: 'lmstudio',
        model: 'm',
        endpointUrl: 'http://localhost:1234/v1',
        messages: [{ role: 'user', content: 'hi' }],
      },
      (chunk) => seen.push(chunk.text),
      streamingFetch([
        'data: {"choices":[{"delta":{"content":"Hel"}}]}',
        'data: {"choices":[{"delta":{"content":"lo"}}]}',
        'data: [DONE]',
      ]),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toBe('Hello')
    // Streamed, not delivered whole: the caller saw it in pieces.
    expect(seen.length).toBeGreaterThan(1)
  })

  it('reads a provider’s own reasoning field when it has one', async () => {
    const result = await streamChat(
      {
        providerId: 'openrouter',
        model: 'm',
        endpointUrl: 'https://openrouter.ai/api/v1',
        messages: [{ role: 'user', content: 'hi' }],
      },
      () => undefined,
      streamingFetch([
        'data: {"choices":[{"delta":{"reasoning":"thinking"}}]}',
        'data: {"choices":[{"delta":{"content":"answer"}}]}',
      ]),
    )

    expect(result.reasoning).toBe('thinking')
    expect(result.content).toBe('answer')
  })

  it('skips a frame it cannot parse instead of failing the reply', async () => {
    // A keep-alive or comment line is not an error, and treating it as one would
    // discard a reply that was otherwise fine.
    const result = await streamChat(
      {
        providerId: 'lmstudio',
        model: 'm',
        endpointUrl: 'http://localhost:1234/v1',
        messages: [{ role: 'user', content: 'hi' }],
      },
      () => undefined,
      streamingFetch([
        ': keep-alive',
        'data: not json at all',
        'data: {"choices":[{"delta":{"content":"fine"}}]}',
      ]),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toBe('fine')
  })

  it('reports a failing status as an error, with no content', async () => {
    const result = await streamChat(
      {
        providerId: 'lmstudio',
        model: 'm',
        endpointUrl: 'http://localhost:1234/v1',
        messages: [{ role: 'user', content: 'hi' }],
      },
      () => undefined,
      streamingFetch([], false),
    )

    expect(result.ok).toBe(false)
    expect(result.content).toBe('')
    expect(result.error).toMatch(/500/)
  })

  it('refuses a provider with no endpoint rather than guessing one', async () => {
    const result = await streamChat(
      { providerId: 'mystery', model: 'm', messages: [] },
      () => undefined,
      streamingFetch([]),
    )

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no endpoint/i)
  })
})

describe('streamChat over Ollama', () => {
  it('reads newline-delimited objects, not server-sent events', async () => {
    const result = await streamChat(
      {
        providerId: 'ollama',
        model: 'qwen',
        endpointUrl: 'http://localhost:11434',
        messages: [{ role: 'user', content: 'hi' }],
      },
      () => undefined,
      streamingFetch([
        '{"message":{"content":"Hel"}}',
        '{"message":{"content":"lo"}}',
        '{"done":true}',
      ]),
    )

    expect(result.ok).toBe(true)
    expect(result.content).toBe('Hello')
  })

  it('splits inline think tags out of the content stream', async () => {
    // Measured against a local Qwen build: the reasoning is not a separate
    // field, it is tags inside content, arriving across several frames.
    const result = await streamChat(
      {
        providerId: 'ollama',
        model: 'qwen',
        endpointUrl: 'http://localhost:11434',
        messages: [{ role: 'user', content: 'hi' }],
      },
      () => undefined,
      streamingFetch([
        '{"message":{"content":"<think>let me"}}',
        '{"message":{"content":" consider</think>"}}',
        '{"message":{"content":"Hello!"}}',
      ]),
    )

    expect(result.reasoning).toBe('let me consider')
    expect(result.content).toBe('Hello!')
  })

  it('uses the thinking field when the model reports one separately', async () => {
    const result = await streamChat(
      {
        providerId: 'ollama',
        model: 'qwen',
        endpointUrl: 'http://localhost:11434',
        messages: [{ role: 'user', content: 'hi' }],
      },
      () => undefined,
      streamingFetch(['{"message":{"thinking":"weighing"}}', '{"message":{"content":"answer"}}']),
    )

    expect(result.reasoning).toBe('weighing')
    expect(result.content).toBe('answer')
  })
})
