/**
 * Streams a chat completion from an OpenAI-compatible or Ollama endpoint.
 *
 * Separate from the IPC handler because there are two wire formats to read and a
 * reasoning/answer split to maintain, and none of that is about IPC. The handler
 * stays a thin adapter over this.
 *
 * ```
 * ollama    POST /api/chat            newline-delimited JSON objects
 * openai    POST /v1/chat/completions Server-Sent Events, `data: ` prefixed
 * ```
 *
 * Both are read incrementally from the response body rather than awaited whole,
 * which is the entire point: a reply that only appears once it is finished tells
 * the user nothing about whether the model is working or wedged.
 */

/** What a caller receives as the stream progresses. */
export interface ChatStreamChunk {
  /**
   * Whether this text is the model's visible reasoning or its actual answer.
   *
   * Some models emit both. Measured with a local Qwen build, whose reasoning
   * arrives wrapped in `<think>` tags inside the ordinary content stream — so
   * the split has to be recovered here rather than read from a separate field.
   */
  readonly kind: 'reasoning' | 'content'
  readonly text: string
}

export interface ChatStreamRequest {
  readonly providerId: string
  readonly model: string
  readonly endpointUrl?: string | undefined
  readonly apiKey?: string | undefined
  readonly systemPrompt?: string | undefined
  readonly messages: readonly { readonly role: string; readonly content: string }[]
}

export interface ChatStreamResult {
  readonly ok: boolean
  readonly content: string
  readonly reasoning: string
  readonly error: string | null
}

/** Where a provider id points when no endpoint was configured. */
export const DEFAULT_ENDPOINTS: Readonly<Record<string, string>> = {
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  mistral: 'https://api.mistral.ai/v1',
  lmstudio: 'http://localhost:1234/v1',
}

/** Ollama speaks its own protocol on its own port; everything else is /v1-shaped. */
export function isOllama(request: {
  readonly providerId: string
  readonly endpointUrl?: string | undefined
}): boolean {
  return request.providerId === 'ollama' || (request.endpointUrl?.includes('11434') ?? false)
}

export function chatCompletionsUrl(endpoint: string): string {
  const base = endpoint.replace(/\/$/, '')
  if (base.endsWith('/chat/completions')) return base
  return base.endsWith('/v1') ? `${base}/chat/completions` : `${base}/v1/chat/completions`
}

/**
 * Splits a content stream into reasoning and answer as it arrives.
 *
 * Stateful across chunks because a `<think>` tag can be split across network
 * reads — the opening tag in one chunk and the closing tag several chunks later,
 * or even a single tag arriving in two pieces. A stateless per-chunk regex looks
 * correct on a fast local model and drops text the moment a boundary lands
 * mid-tag.
 */
export class ThinkingSplitter {
  private inThinking = false
  private pending = ''

  push(text: string): readonly ChatStreamChunk[] {
    this.pending += text
    const out: ChatStreamChunk[] = []

    for (;;) {
      const marker = this.inThinking ? '</think>' : '<think>'
      const at = this.pending.indexOf(marker)

      if (at === -1) {
        // Only a trailing run that could still become the marker is held back —
        // found by looking for the longest suffix of `pending` that is a prefix
        // of the marker. Withholding a fixed number of characters instead
        // truncated the tail of ordinary text, since most text is not a partial
        // tag at all ("answer" arrived as "answ").
        const keep = partialMarkerLength(this.pending, marker)
        const safe = this.pending.length - keep
        if (safe > 0) {
          const emit = this.pending.slice(0, safe)
          this.pending = this.pending.slice(safe)
          out.push({ kind: this.inThinking ? 'reasoning' : 'content', text: emit })
        }
        return out
      }

      const before = this.pending.slice(0, at)
      if (before !== '') {
        out.push({ kind: this.inThinking ? 'reasoning' : 'content', text: before })
      }
      this.pending = this.pending.slice(at + marker.length)
      this.inThinking = !this.inThinking
    }
  }

  /** Whatever is still held back once the stream ends. */
  flush(): readonly ChatStreamChunk[] {
    if (this.pending === '') return []
    const out = [{ kind: this.inThinking ? 'reasoning' : 'content', text: this.pending } as const]
    this.pending = ''
    return out
  }
}

/**
 * How many trailing characters of `text` could still grow into `marker`.
 *
 * Zero for ordinary text, which is the common case and must not be delayed.
 * Returns the length of the longest suffix that is also a prefix of the marker,
 * so `answer<thi` holds back four and emits the rest.
 */
function partialMarkerLength(text: string, marker: string): number {
  const most = Math.min(text.length, marker.length - 1)
  for (let length = most; length > 0; length -= 1) {
    if (marker.startsWith(text.slice(text.length - length))) return length
  }
  return 0
}

/**
 * Reads one line at a time out of a byte stream.
 *
 * Both wire formats are line-oriented, and neither guarantees a chunk boundary
 * falls on a newline, so a partial line has to survive to the next read.
 */
async function* lines(body: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    let newline = buffer.indexOf('\n')
    while (newline !== -1) {
      yield buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      newline = buffer.indexOf('\n')
    }
  }

  if (buffer.trim() !== '') yield buffer
}

/**
 * Runs the request, calling `onChunk` as text arrives.
 *
 * Never throws for a provider-side failure: the outcome is returned so the
 * caller can show what went wrong, which is the same envelope discipline the
 * IPC boundary uses.
 */
export async function streamChat(
  request: ChatStreamRequest,
  onChunk: (chunk: ChatStreamChunk) => void,
  fetchImpl: typeof fetch = fetch,
): Promise<ChatStreamResult> {
  const messages = [
    ...(request.systemPrompt === undefined || request.systemPrompt === ''
      ? []
      : [{ role: 'system', content: request.systemPrompt }]),
    ...request.messages.map((message) => ({ role: message.role, content: message.content })),
  ]

  const ollama = isOllama(request)
  const endpoint = request.endpointUrl ?? DEFAULT_ENDPOINTS[request.providerId] ?? ''

  if (!ollama && endpoint === '') {
    return {
      ok: false,
      content: '',
      reasoning: '',
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

  const splitter = new ThinkingSplitter()
  let content = ''
  let reasoning = ''

  const take = (chunk: ChatStreamChunk): void => {
    if (chunk.text === '') return
    if (chunk.kind === 'reasoning') reasoning += chunk.text
    else content += chunk.text
    onChunk(chunk)
  }

  try {
    const res = await fetchImpl(url, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: request.model, messages, stream: true }),
    })

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText)
      return {
        ok: false,
        content: '',
        reasoning: '',
        error: `${ollama ? 'Ollama' : 'API'} error (${String(res.status)}): ${detail}`,
      }
    }

    if (res.body === null) {
      return { ok: false, content: '', reasoning: '', error: 'The response carried no body.' }
    }

    for await (const line of lines(res.body)) {
      const trimmed = line.trim()
      if (trimmed === '') continue

      // SSE frames the payload; Ollama sends the object bare.
      const payload = ollama ? trimmed : trimmed.startsWith('data:') ? trimmed.slice(5).trim() : ''
      if (payload === '' || payload === '[DONE]') continue

      let parsed: unknown
      try {
        parsed = JSON.parse(payload)
      } catch {
        // A frame Forge does not understand is skipped rather than failing the
        // whole reply: a keep-alive or a comment line is not an error.
        continue
      }

      for (const chunk of readDelta(parsed, ollama)) {
        for (const split of chunk.kind === 'content' ? splitter.push(chunk.text) : [chunk]) {
          take(split)
        }
      }
    }

    for (const chunk of splitter.flush()) take(chunk)

    return { ok: true, content, reasoning, error: null }
  } catch (err) {
    return {
      ok: false,
      content,
      reasoning,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * Pulls the text out of one parsed frame.
 *
 * A `reasoning`/`reasoning_content` field is read directly where a provider
 * offers one — several do, and it is more reliable than recovering the split
 * from inline tags. Content still goes through the splitter, because a model can
 * emit `<think>` inside content even on a provider that also has the field.
 */
function readDelta(frame: unknown, ollama: boolean): readonly ChatStreamChunk[] {
  if (typeof frame !== 'object' || frame === null) return []
  const out: ChatStreamChunk[] = []

  if (ollama) {
    const message = (frame as { message?: { content?: unknown; thinking?: unknown } }).message
    if (typeof message?.thinking === 'string' && message.thinking !== '') {
      out.push({ kind: 'reasoning', text: message.thinking })
    }
    if (typeof message?.content === 'string' && message.content !== '') {
      out.push({ kind: 'content', text: message.content })
    }
    return out
  }

  const delta = (
    frame as {
      choices?: {
        delta?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown }
      }[]
    }
  ).choices?.[0]?.delta

  const think = typeof delta?.reasoning === 'string' ? delta.reasoning : delta?.reasoning_content
  if (typeof think === 'string' && think !== '') {
    out.push({ kind: 'reasoning', text: think })
  }
  if (typeof delta?.content === 'string' && delta.content !== '') {
    out.push({ kind: 'content', text: delta.content })
  }
  return out
}
