import { detectCapabilities, type ModelCapabilities } from './capabilities'

/**
 * Metadata for a locally installed Ollama model discovered via `/api/tags`.
 */
export interface OllamaModelInfo {
  readonly name: string
  readonly model: string
  readonly family: string | null
  readonly parameterSize: string | null
  readonly quantization: string | null
  readonly sizeBytes: number
  readonly modifiedAt: string
  readonly isCodingModel: boolean
  readonly capabilities: ModelCapabilities
}

export interface OllamaDiscoveryResult {
  readonly reachable: boolean
  readonly endpoint: string
  readonly models: readonly OllamaModelInfo[]
  readonly error: string | null
}

const CODING_MODEL_PATTERNS = [
  /coder/i,
  /deepseek-coder/i,
  /starcoder/i,
  /codeqwen/i,
  /codellama/i,
  /wizardcoder/i,
]

function isCodingModel(name: string, family: string | null): boolean {
  if (CODING_MODEL_PATTERNS.some((pat) => pat.test(name))) {
    return true
  }
  if (family !== null && CODING_MODEL_PATTERNS.some((pat) => pat.test(family))) {
    return true
  }
  return false
}

interface RawOllamaTagEntry {
  readonly name?: unknown
  readonly model?: unknown
  readonly size?: unknown
  readonly modified_at?: unknown
  readonly details?: {
    readonly family?: unknown
    readonly parameter_size?: unknown
    readonly quantization_level?: unknown
  }
}

/**
 * Discovers locally available Ollama models by querying the `/api/tags` endpoint
 * and probing model capabilities via `/api/show`.
 *
 * Never throws: an unreachable daemon returns `{ reachable: false, models: [], error }`
 * so callers can degrade gracefully without crashing.
 */
export async function discoverOllamaModels(options?: {
  readonly endpointUrl?: string | undefined
  readonly probeCapabilities?: boolean | undefined
  readonly fetchImpl?: typeof fetch | undefined
}): Promise<OllamaDiscoveryResult> {
  const fetchImpl = options?.fetchImpl ?? fetch
  const base = (options?.endpointUrl ?? 'http://127.0.0.1:11434').replace(/\/$/, '')
  const shouldProbe = options?.probeCapabilities ?? true

  try {
    const res = await fetchImpl(`${base}/api/tags`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    })

    if (!res.ok) {
      return {
        reachable: false,
        endpoint: base,
        models: [],
        error: `Ollama endpoint returned HTTP ${String(res.status)}: ${res.statusText}`,
      }
    }

    const body: unknown = await res.json()
    if (typeof body !== 'object' || body === null || !('models' in body)) {
      return {
        reachable: true,
        endpoint: base,
        models: [],
        error: 'Malformed response from Ollama: "models" array missing',
      }
    }

    const rawList = body.models
    if (!Array.isArray(rawList)) {
      return {
        reachable: true,
        endpoint: base,
        models: [],
        error: null,
      }
    }

    const discovered: OllamaModelInfo[] = []

    for (const item of rawList) {
      if (typeof item !== 'object' || item === null) continue
      const raw = item as RawOllamaTagEntry
      const name = typeof raw.name === 'string' ? raw.name : ''
      if (name === '') continue

      const model = typeof raw.model === 'string' ? raw.model : name
      const sizeBytes = typeof raw.size === 'number' ? raw.size : 0
      const modifiedAt = typeof raw.modified_at === 'string' ? raw.modified_at : ''
      const details = raw.details

      const family =
        details && typeof details.family === 'string' && details.family.trim() !== ''
          ? details.family
          : null
      const parameterSize =
        details &&
        typeof details.parameter_size === 'string' &&
        details.parameter_size.trim() !== ''
          ? details.parameter_size
          : null
      const quantization =
        details &&
        typeof details.quantization_level === 'string' &&
        details.quantization_level.trim() !== ''
          ? details.quantization_level
          : null

      let capabilities: ModelCapabilities = {
        tools: true,
        vision: false,
        thinking: false,
        source: 'assumed',
      }

      if (shouldProbe) {
        capabilities = await detectCapabilities(
          {
            providerId: 'ollama',
            model: name,
            endpointUrl: base,
          },
          fetchImpl,
        )
      }

      discovered.push({
        name,
        model,
        family,
        parameterSize,
        quantization,
        sizeBytes,
        modifiedAt,
        isCodingModel: isCodingModel(name, family),
        capabilities,
      })
    }

    return {
      reachable: true,
      endpoint: base,
      models: discovered,
      error: null,
    }
  } catch (err) {
    return {
      reachable: false,
      endpoint: base,
      models: [],
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
