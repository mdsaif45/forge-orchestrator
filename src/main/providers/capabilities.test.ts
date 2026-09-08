import { beforeEach, describe, expect, it } from 'vitest'
import { cachedCapabilities, detectCapabilities, forgetCapabilities } from './capabilities'

/**
 * Capability detection.
 *
 * The point of the module is that it answers from the provider rather than from
 * a toggle, so the tests are about believing the provider when it speaks and
 * being honest about guessing when it does not.
 */

const jsonFetch = (body: unknown, ok = true) => {
  const calls: string[] = []
  const impl = ((url: string) => {
    calls.push(url)
    return Promise.resolve({
      ok,
      status: ok ? 200 : 404,
      json: () => Promise.resolve(body),
    })
  }) as unknown as typeof fetch
  return { impl, calls }
}

const ollama = { providerId: 'ollama', model: 'qwen', endpointUrl: 'http://localhost:11434' }

beforeEach(() => {
  forgetCapabilities()
})

describe('detectCapabilities against Ollama', () => {
  it('reports exactly what the provider lists', async () => {
    // The real shape, measured from a local Ollama.
    const { impl } = jsonFetch({ capabilities: ['completion', 'vision', 'tools', 'thinking'] })

    const caps = await detectCapabilities(ollama, impl)

    expect(caps).toEqual({ tools: true, vision: true, thinking: true, source: 'reported' })
  })

  it('reports a model with no tools as having none', async () => {
    // The case that makes a manual toggle actively harmful: enabling tools here
    // would send definitions the model cannot use.
    const { impl } = jsonFetch({ capabilities: ['completion', 'vision'] })

    const caps = await detectCapabilities(ollama, impl)

    expect(caps.tools).toBe(false)
    expect(caps.vision).toBe(true)
    expect(caps.source).toBe('reported')
  })

  it('asks the show endpoint, not the chat one', async () => {
    const { impl, calls } = jsonFetch({ capabilities: ['tools'] })

    await detectCapabilities(ollama, impl)

    expect(calls[0]).toContain('/api/show')
  })

  it('separates "could not ask" from "does not support"', async () => {
    // A 404 must not be recorded as a model without tools: the distinction is
    // the difference between a fact and a failure to establish one.
    const { impl } = jsonFetch({}, false)

    const caps = await detectCapabilities(ollama, impl)

    expect(caps.source).toBe('unreachable')
    expect(caps.tools).toBe(true)
  })

  it('survives a provider that answers with something unexpected', async () => {
    const { impl } = jsonFetch({ capabilities: 'not-an-array' })

    const caps = await detectCapabilities(ollama, impl)

    expect(caps.source).toBe('unreachable')
  })

  it('survives a thrown request', async () => {
    const impl = (() => Promise.reject(new Error('offline'))) as unknown as typeof fetch

    const caps = await detectCapabilities(ollama, impl)

    expect(caps.source).toBe('unreachable')
  })
})

describe('detectCapabilities for OpenAI-compatible providers', () => {
  it('assumes tools, because none publish capabilities', async () => {
    const { impl, calls } = jsonFetch({})

    const caps = await detectCapabilities(
      { providerId: 'lmstudio', model: 'm', endpointUrl: 'http://localhost:1234/v1' },
      impl,
    )

    expect(caps.tools).toBe(true)
    expect(caps.source).toBe('assumed')
    // Nothing to ask, so nothing was asked.
    expect(calls).toEqual([])
  })

  it('marks a provider with no endpoint as unreachable rather than assumed', async () => {
    const { impl } = jsonFetch({})

    const caps = await detectCapabilities({ providerId: 'mystery', model: 'm' }, impl)

    expect(caps.source).toBe('unreachable')
  })
})

describe('cachedCapabilities', () => {
  it('asks once for the same model', async () => {
    const { impl, calls } = jsonFetch({ capabilities: ['tools'] })

    await cachedCapabilities(ollama, impl)
    await cachedCapabilities(ollama, impl)

    expect(calls).toHaveLength(1)
  })

  it('asks again for a different model', async () => {
    // Keyed on the model, not the provider: two models on one Ollama differ,
    // which is the whole reason this module exists.
    const { impl, calls } = jsonFetch({ capabilities: ['tools'] })

    await cachedCapabilities(ollama, impl)
    await cachedCapabilities({ ...ollama, model: 'gemma' }, impl)

    expect(calls).toHaveLength(2)
  })
})
