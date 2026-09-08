import { chatCompletionsUrl, DEFAULT_ENDPOINTS, isOllama } from './chatStream'
import type { CompletionResult, LoopMessage, ToolCall } from './agentLoop'
import type { TOOL_DEFINITIONS } from './tools'

/**
 * One tool-calling completion, from an OpenAI-compatible or Ollama endpoint.
 *
 * Not streamed, unlike `chatStream`. A turn that calls tools is a sequence of
 * short requests whose useful output is the tool calls, not prose, and the
 * assembled JSON has to be complete before any call can be executed — streaming
 * it would mean buffering the whole thing anyway.
 *
 * The two providers differ in more than the URL here:
 *
 * ```
 * openai  tool_calls[].function.arguments   a JSON *string* to parse
 * ollama  tool_calls[].function.arguments   an object already
 * ```
 *
 * Both are normalised to the loop's `ToolCall`, so nothing downstream knows
 * which provider answered.
 */

export interface ToolCompletionRequest {
  readonly providerId: string
  readonly model: string
  readonly endpointUrl?: string | undefined
  readonly apiKey?: string | undefined
}

/**
 * Shapes the wire message a provider expects, from the loop's own message type.
 *
 * `arguments` is the one field the two providers genuinely disagree about, in
 * both directions. Measured against a running Ollama: sending the JSON *string*
 * the OpenAI format requires is rejected with
 * `400 Value looks like object, but can't find closing '}' symbol`, while the
 * object form is accepted. Reading is the mirror image — see `readToolCalls`.
 *
 * This only bites on the second round, once a tool result has to be sent back
 * with the assistant turn that requested it, which is why a single-round test
 * passes and a real multi-round turn does not.
 */
function toWireMessage(message: LoopMessage, ollama: boolean): Record<string, unknown> {
  if (message.role === 'tool') {
    return {
      role: 'tool',
      content: message.content,
      ...(message.toolCallId === undefined ? {} : { tool_call_id: message.toolCallId }),
    }
  }

  if (message.toolCalls !== undefined && message.toolCalls.length > 0) {
    return {
      role: 'assistant',
      content: message.content,
      tool_calls: message.toolCalls.map((call) => ({
        id: call.id,
        type: 'function',
        function: {
          name: call.name,
          arguments: ollama ? call.args : JSON.stringify(call.args),
        },
      })),
    }
  }

  return { role: message.role, content: message.content }
}

/**
 * Reads tool calls out of a provider's reply.
 *
 * Arguments arrive as a JSON string from OpenAI-compatible providers and as an
 * object from Ollama, and a small local model sometimes emits neither cleanly.
 * A call whose arguments cannot be parsed is passed on with empty arguments
 * rather than dropped, so the tool reports a missing-argument refusal the model
 * can act on — silently discarding the call would leave it waiting forever.
 */
function readToolCalls(raw: unknown): readonly ToolCall[] {
  if (!Array.isArray(raw)) return []

  return raw.flatMap((entry, index): ToolCall[] => {
    if (typeof entry !== 'object' || entry === null) return []
    const fn = (entry as { function?: { name?: unknown; arguments?: unknown } }).function
    const name = fn?.name
    if (typeof name !== 'string' || name === '') return []

    let args: Record<string, unknown> = {}
    const rawArgs = fn?.arguments
    if (typeof rawArgs === 'string' && rawArgs.trim() !== '') {
      try {
        const parsed: unknown = JSON.parse(rawArgs)
        if (typeof parsed === 'object' && parsed !== null) args = parsed as Record<string, unknown>
      } catch {
        // Left empty on purpose; see the note above.
      }
    } else if (typeof rawArgs === 'object' && rawArgs !== null) {
      args = rawArgs as Record<string, unknown>
    }

    const id = (entry as { id?: unknown }).id
    return [
      {
        id: typeof id === 'string' && id !== '' ? id : `call-${String(index)}`,
        name,
        args,
      },
    ]
  })
}

export async function completeWithTools(
  request: ToolCompletionRequest,
  messages: readonly LoopMessage[],
  tools: typeof TOOL_DEFINITIONS,
  fetchImpl: typeof fetch = fetch,
): Promise<CompletionResult> {
  const ollama = isOllama(request)
  const endpoint = request.endpointUrl ?? DEFAULT_ENDPOINTS[request.providerId] ?? ''

  if (!ollama && endpoint === '') {
    return {
      ok: false,
      content: '',
      reasoning: '',
      toolCalls: [],
      error: `No endpoint configured for provider "${request.providerId}".`,
    }
  }

  const url = ollama
    ? `${(request.endpointUrl ?? 'http://localhost:11434').replace(/\/$/, '')}/api/chat`
    : chatCompletionsUrl(endpoint)

  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (request.apiKey !== undefined && request.apiKey !== '') {
    headers.Authorization = `Bearer ${request.apiKey}`
  }

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        model: request.model,
        messages: messages.map((message) => toWireMessage(message, ollama)),
        tools,
        stream: false,
      }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText)
      return {
        ok: false,
        content: '',
        reasoning: '',
        toolCalls: [],
        error: `${ollama ? 'Ollama' : 'API'} error (${String(res.status)}): ${detail}`,
      }
    }

    const body: unknown = await res.json()
    const message = ollama
      ? (body as { message?: Record<string, unknown> }).message
      : (body as { choices?: { message?: Record<string, unknown> }[] }).choices?.[0]?.message

    if (message === undefined) {
      return {
        ok: false,
        content: '',
        reasoning: '',
        toolCalls: [],
        error: 'The provider returned no message.',
      }
    }

    const content = typeof message.content === 'string' ? message.content : ''
    const reasoningField = message.reasoning ?? message.reasoning_content ?? message.thinking
    const reasoning = typeof reasoningField === 'string' ? reasoningField : ''

    return {
      ok: true,
      content,
      reasoning,
      toolCalls: readToolCalls(message.tool_calls),
      error: null,
    }
  } catch (err) {
    return {
      ok: false,
      content: '',
      reasoning: '',
      toolCalls: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
