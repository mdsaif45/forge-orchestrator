import { DEFAULT_ENDPOINTS, isOllama } from './chatStream'

/**
 * What a model can actually do, asked of the provider rather than of the user.
 *
 * Forge previously showed a "Tools" toggle, which put the question to the
 * person least able to answer it: capability is a property of the model, and
 * enabling tools on one that has none produces a broken turn rather than a
 * refusal. Measured on a local Ollama, the answer differs per model and is
 * already published:
 *
 * ```
 * Qwen3.5-…:4b       completion · vision · tools · thinking
 * deepseek-r1:7b     completion · tools · thinking
 * qwen2.5-coder:1.5b completion · tools · insert
 * gemma3:12b         completion · vision            <- no tools at all
 * ```
 *
 * So it is detected. An unknown provider is assumed tool-capable, because every
 * OpenAI-compatible endpoint of consequence supports tool calling and the
 * failure mode of guessing wrong is one refused turn with a named error, not
 * silent breakage.
 */

export interface ModelCapabilities {
  readonly tools: boolean
  readonly vision: boolean
  /** The model emits reasoning of its own, so Forge should expect and split it. */
  readonly thinking: boolean
  /**
   * How the answer was reached, so the UI can distinguish a fact from a default.
   *
   * `reported` came from the provider. `assumed` is Forge's default for a
   * provider with no capability endpoint. `unreachable` means the provider could
   * not be asked, which is not the same as a model that lacks the feature.
   */
  readonly source: 'reported' | 'assumed' | 'unreachable'
}

const ASSUMED: ModelCapabilities = {
  tools: true,
  vision: false,
  thinking: false,
  source: 'assumed',
}

/**
 * Asks the provider what the model supports.
 *
 * Never throws and never blocks a turn: an unreachable provider returns the
 * assumed set with `source: 'unreachable'` so the caller can proceed and say
 * why it is guessing.
 */
export async function detectCapabilities(
  request: {
    readonly providerId: string
    readonly model: string
    readonly endpointUrl?: string | undefined
    readonly apiKey?: string | undefined
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ModelCapabilities> {
  if (!isOllama(request)) {
    // No OpenAI-compatible provider publishes per-model capabilities, so there
    // is nothing to ask. Reported as assumed rather than dressed up as fact.
    const endpoint = request.endpointUrl ?? DEFAULT_ENDPOINTS[request.providerId] ?? ''
    return endpoint === '' ? { ...ASSUMED, source: 'unreachable' } : ASSUMED
  }

  const base = (request.endpointUrl ?? 'http://localhost:11434').replace(/\/$/, '')

  try {
    const res = await fetchImpl(`${base}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: request.model }),
    })

    if (!res.ok) return { ...ASSUMED, source: 'unreachable' }

    const body: unknown = await res.json()
    const raw = (body as { capabilities?: unknown }).capabilities
    if (!Array.isArray(raw)) return { ...ASSUMED, source: 'unreachable' }

    const listed = new Set(raw.filter((entry): entry is string => typeof entry === 'string'))

    return {
      tools: listed.has('tools'),
      vision: listed.has('vision'),
      thinking: listed.has('thinking'),
      source: 'reported',
    }
  } catch {
    return { ...ASSUMED, source: 'unreachable' }
  }
}

/** Kept briefly so a conversation does not re-ask on every message. */
const cache = new Map<string, { readonly at: number; readonly value: ModelCapabilities }>()
const CACHE_MS = 60_000

export async function cachedCapabilities(
  request: {
    readonly providerId: string
    readonly model: string
    readonly endpointUrl?: string | undefined
    readonly apiKey?: string | undefined
  },
  fetchImpl: typeof fetch = fetch,
): Promise<ModelCapabilities> {
  const key = `${request.providerId}|${request.model}|${request.endpointUrl ?? ''}`
  const hit = cache.get(key)
  // Expires rather than living forever: pulling a new model, or swapping which
  // one an alias points at, changes the answer.
  if (hit !== undefined && Date.now() - hit.at < CACHE_MS) return hit.value

  const value = await detectCapabilities(request, fetchImpl)
  cache.set(key, { at: Date.now(), value })
  return value
}

/** Clears the cache. For tests, and for a future "re-scan models" action. */
export function forgetCapabilities(): void {
  cache.clear()
}
