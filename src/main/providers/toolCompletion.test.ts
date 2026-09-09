import { describe, expect, it } from 'vitest'
import { completeWithTools } from './toolCompletion'
import { TOOL_DEFINITIONS } from './tools'

/**
 * Reading tool calls off the wire.
 *
 * The two providers disagree about the shape of `arguments` — a JSON string
 * versus an object — and a small local model sometimes emits malformed JSON. All
 * three have to end up as the same `ToolCall`, because the loop above must not
 * know which provider answered.
 */

/** A `fetch` returning one fixed JSON body, and recording what was posted. */
const jsonFetch = (body: unknown, ok = true) => {
  const posted: unknown[] = []
  const impl = ((_url: string, init: { body: string }) => {
    posted.push(JSON.parse(init.body))
    return Promise.resolve({
      ok,
      status: ok ? 200 : 502,
      statusText: 'Bad Gateway',
      text: () => Promise.resolve('upstream died'),
      json: () => Promise.resolve(body),
    })
  }) as unknown as typeof fetch
  return { impl, posted }
}

const openai = { providerId: 'lmstudio', model: 'm', endpointUrl: 'http://localhost:1234/v1' }
const ollama = { providerId: 'ollama', model: 'qwen', endpointUrl: 'http://localhost:11434' }

describe('completeWithTools over an OpenAI-compatible endpoint', () => {
  it('parses arguments delivered as a JSON string', async () => {
    const { impl } = jsonFetch({
      choices: [
        {
          message: {
            content: '',
            tool_calls: [
              {
                id: 'c1',
                function: { name: 'read_file', arguments: '{"path":"src/a.ts"}' },
              },
            ],
          },
        },
      ],
    })

    const result = await completeWithTools(openai, [], TOOL_DEFINITIONS, impl)

    expect(result.ok).toBe(true)
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'read_file', args: { path: 'src/a.ts' } }])
  })

  it('sends the tool definitions, or the model can never call one', async () => {
    const { impl, posted } = jsonFetch({ choices: [{ message: { content: 'hi' } }] })

    await completeWithTools(openai, [{ role: 'user', content: 'hi' }], TOOL_DEFINITIONS, impl)

    const sent = posted[0] as { tools?: unknown[] }
    expect(Array.isArray(sent.tools)).toBe(true)
    expect(sent.tools).toHaveLength(TOOL_DEFINITIONS.length)
  })

  it('keeps a call whose arguments are malformed, so the tool can refuse it', async () => {
    // Dropping it would leave the model waiting for a result that never comes;
    // a missing-argument refusal is something it can act on.
    const { impl } = jsonFetch({
      choices: [
        {
          message: {
            tool_calls: [{ id: 'c1', function: { name: 'read_file', arguments: '{not json' } }],
          },
        },
      ],
    })

    const result = await completeWithTools(openai, [], TOOL_DEFINITIONS, impl)

    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'read_file', args: {} }])
  })

  it('discards an entry with no usable tool name', async () => {
    const { impl } = jsonFetch({
      choices: [{ message: { tool_calls: [{ id: 'c1', function: { arguments: '{}' } }] } }],
    })

    const result = await completeWithTools(openai, [], TOOL_DEFINITIONS, impl)

    expect(result.toolCalls).toEqual([])
  })

  it('reports an upstream failure rather than an empty answer', async () => {
    const { impl } = jsonFetch({}, false)

    const result = await completeWithTools(openai, [], TOOL_DEFINITIONS, impl)

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/502/)
  })

  it('refuses a provider with no endpoint by name', async () => {
    const { impl } = jsonFetch({})

    const result = await completeWithTools(
      { providerId: 'mystery', model: 'm' },
      [],
      TOOL_DEFINITIONS,
      impl,
    )

    expect(result.ok).toBe(false)
    expect(result.error).toMatch(/no endpoint/i)
  })
})

describe('completeWithTools over Ollama', () => {
  it('parses arguments delivered as an object', async () => {
    const { impl } = jsonFetch({
      message: {
        content: '',
        tool_calls: [{ function: { name: 'list_dir', arguments: { path: '.' } } }],
      },
    })

    const result = await completeWithTools(ollama, [], TOOL_DEFINITIONS, impl)

    expect(result.toolCalls).toHaveLength(1)
    expect(result.toolCalls[0]?.name).toBe('list_dir')
    expect(result.toolCalls[0]?.args).toEqual({ path: '.' })
  })

  it('synthesises an id when the provider omits one', async () => {
    // Ollama does not always send one, and the loop needs an id to tie the
    // result back to the call.
    const { impl } = jsonFetch({
      message: { tool_calls: [{ function: { name: 'list_dir', arguments: {} } }] },
    })

    const result = await completeWithTools(ollama, [], TOOL_DEFINITIONS, impl)

    expect(result.toolCalls[0]?.id).not.toBe('')
  })

  it('reads the thinking field when the model reports one', async () => {
    const { impl } = jsonFetch({ message: { content: 'answer', thinking: 'weighing' } })

    const result = await completeWithTools(ollama, [], TOOL_DEFINITIONS, impl)

    expect(result.reasoning).toBe('weighing')
    expect(result.content).toBe('answer')
  })
})

describe('a provider that cannot be reached', () => {
  it('names the provider and the endpoint, not just "fetch failed"', async () => {
    // Node's fetch throws `TypeError: fetch failed` for every transport
    // failure, and that string was passed straight through. A real workflow
    // stage halted with `[AGENT ERROR] fetch failed` against a stopped
    // Ollama — nothing in that names the address, the provider, or the fact
    // that the remedy is starting a local service.
    const dead = (() => Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch

    const result = await completeWithTools(ollama, [{ role: 'user', content: 'hi' }], [], dead)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('ollama')
    expect(result.error).toContain('http://localhost:11434')
    expect(result.error).toMatch(/is the service running/i)
    // The original cause is kept, not replaced: a TLS or DNS message is worth
    // reading, and a tidier sentence that discards it would be a guess.
    expect(result.error).toContain('fetch failed')
  })

  it('reports a non-transport failure without claiming the service is down', async () => {
    const broken = (() => Promise.reject(new TypeError('Invalid URL'))) as unknown as typeof fetch

    const result = await completeWithTools(ollama, [{ role: 'user', content: 'hi' }], [], broken)

    expect(result.ok).toBe(false)
    expect(result.error).toContain('Invalid URL')
    expect(result.error).not.toMatch(/is the service running/i)
  })
})

describe('message shaping', () => {
  it('sends a tool result with the id of the call it answers', async () => {
    const { impl, posted } = jsonFetch({ choices: [{ message: { content: 'ok' } }] })

    await completeWithTools(
      openai,
      [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c9', name: 'read_file', args: { path: 'a' } }],
        },
        { role: 'tool', content: 'file body', toolCallId: 'c9' },
      ],
      TOOL_DEFINITIONS,
      impl,
    )

    const sent = posted[0] as { messages: { role: string; tool_call_id?: string }[] }
    const toolMessage = sent.messages.find((m) => m.role === 'tool')
    expect(toolMessage?.tool_call_id).toBe('c9')
  })

  it('sends arguments as an OBJECT to Ollama, which rejects the string form', async () => {
    // Measured against a running Ollama: the JSON-string form the OpenAI format
    // requires comes back as
    // `400 Value looks like object, but can't find closing '}' symbol`.
    // It only bites on round two, when the assistant turn that requested a tool
    // has to be replayed alongside its result — so a single-round test passes
    // and a real multi-round turn fails.
    const { impl, posted } = jsonFetch({ message: { content: 'ok' } })

    await completeWithTools(
      ollama,
      [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }],
        },
      ],
      TOOL_DEFINITIONS,
      impl,
    )

    const sent = posted[0] as {
      messages: { tool_calls?: { function: { arguments: unknown } }[] }[]
    }
    expect(sent.messages[0]?.tool_calls?.[0]?.function.arguments).toEqual({ path: 'a.ts' })
  })

  it('re-serialises an assistant turn’s tool calls in the wire shape', async () => {
    const { impl, posted } = jsonFetch({ choices: [{ message: { content: 'ok' } }] })

    await completeWithTools(
      openai,
      [
        {
          role: 'assistant',
          content: '',
          toolCalls: [{ id: 'c1', name: 'read_file', args: { path: 'a.ts' } }],
        },
      ],
      TOOL_DEFINITIONS,
      impl,
    )

    const sent = posted[0] as {
      messages: { tool_calls?: { function: { name: string; arguments: string } }[] }[]
    }
    const call = sent.messages[0]?.tool_calls?.[0]
    expect(call?.function.name).toBe('read_file')
    // A string, not an object: that is what the wire format expects back.
    expect(JSON.parse(call?.function.arguments ?? '{}')).toEqual({ path: 'a.ts' })
  })
})
