import { describe, it, expect, vi } from 'vitest'
import { discoverOllamaModels } from './ollamaDiscovery'

describe('discoverOllamaModels (AGENT-004)', () => {
  it('handles offline / unreachable Ollama daemon gracefully without throwing', async () => {
    const mockFetch = vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED 127.0.0.1:11434'))

    const result = await discoverOllamaModels({
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    expect(result.reachable).toBe(false)
    expect(result.models).toEqual([])
    expect(result.error).toMatch(/ECONNREFUSED/i)
  })

  it('handles non-200 HTTP response from endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 502,
      statusText: 'Bad Gateway',
    })

    const result = await discoverOllamaModels({
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    expect(result.reachable).toBe(false)
    expect(result.models).toEqual([])
    expect(result.error).toMatch(/HTTP 502: Bad Gateway/i)
  })

  it('discovers installed models and identifies coding capabilities', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/tags')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              models: [
                {
                  name: 'qwen2.5-coder:7b',
                  model: 'qwen2.5-coder:7b',
                  size: 4682000000,
                  modified_at: '2026-10-01T12:00:00Z',
                  details: {
                    family: 'qwen2',
                    parameter_size: '7B',
                    quantization_level: 'Q4_K_M',
                  },
                },
                {
                  name: 'llama3.1:8b',
                  model: 'llama3.1:8b',
                  size: 4920000000,
                  modified_at: '2026-09-15T10:00:00Z',
                  details: {
                    family: 'llama',
                    parameter_size: '8B',
                    quantization_level: 'Q4_K_M',
                  },
                },
              ],
            }),
        })
      }
      if (url.endsWith('/api/show')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              capabilities: ['tools', 'thinking'],
            }),
        })
      }
      return Promise.reject(new Error(`Unexpected url ${url}`))
    })

    const result = await discoverOllamaModels({
      fetchImpl: mockFetch as unknown as typeof fetch,
    })

    expect(result.reachable).toBe(true)
    expect(result.error).toBeNull()
    expect(result.models).toHaveLength(2)

    const qwen = result.models[0]
    expect(qwen?.name).toBe('qwen2.5-coder:7b')
    expect(qwen?.family).toBe('qwen2')
    expect(qwen?.parameterSize).toBe('7B')
    expect(qwen?.quantization).toBe('Q4_K_M')
    expect(qwen?.isCodingModel).toBe(true)
    expect(qwen?.capabilities.tools).toBe(true)
    expect(qwen?.capabilities.thinking).toBe(true)
    expect(qwen?.capabilities.source).toBe('reported')

    const llama = result.models[1]
    expect(llama?.name).toBe('llama3.1:8b')
    expect(llama?.isCodingModel).toBe(false)
  })

  it('skips probing when probeCapabilities is false', async () => {
    const mockFetch = vi.fn().mockImplementation((url: string) => {
      if (url.endsWith('/api/tags')) {
        return Promise.resolve({
          ok: true,
          json: () =>
            Promise.resolve({
              models: [
                {
                  name: 'qwen2.5-coder:7b',
                  model: 'qwen2.5-coder:7b',
                  size: 4682000000,
                  modified_at: '2026-10-01T12:00:00Z',
                },
              ],
            }),
        })
      }
      return Promise.reject(new Error(`Should not call ${url}`))
    })

    const result = await discoverOllamaModels({
      fetchImpl: mockFetch as unknown as typeof fetch,
      probeCapabilities: false,
    })

    expect(result.reachable).toBe(true)
    expect(result.models).toHaveLength(1)
    expect(result.models[0]?.capabilities.source).toBe('assumed')
  })
})
