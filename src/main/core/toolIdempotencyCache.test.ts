import { describe, expect, it } from 'vitest'
import { ToolIdempotencyCache } from './toolIdempotencyCache'

describe('Tool Idempotency Cache & Deduplication Engine (AGENT-010)', () => {
  it('caches read-only tool results and returns cached value on identical inputs', () => {
    const cache = new ToolIdempotencyCache()
    const args = { path: 'src/index.ts', encoding: 'utf-8' }

    expect(cache.get('read_file', args, 'commit-a')).toBeUndefined()

    const success = cache.set('read_file', args, 'file content 123', 'commit-a')
    expect(success).toBe(true)

    // Cache hit
    const cached = cache.get('read_file', args, 'commit-a')
    expect(cached).toBe('file content 123')

    const metrics = cache.getMetrics()
    expect(metrics.size).toBe(1)
    expect(metrics.hits).toBe(1)
    expect(metrics.misses).toBe(1)
  })

  it('differentiates entries when repository head commit changes', () => {
    const cache = new ToolIdempotencyCache()
    const args = { query: 'export function' }

    cache.set('grep', args, ['match 1'], 'commit-a')
    expect(cache.get('grep', args, 'commit-a')).toEqual(['match 1'])

    // Query on new commit misses
    expect(cache.get('grep', args, 'commit-b')).toBeUndefined()
  })

  it('bypasses cache and invalidates entries on mutating tool execution', () => {
    const cache = new ToolIdempotencyCache()
    cache.set('read_file', { path: 'test.ts' }, 'initial content', 'commit-a')
    expect(cache.get('read_file', { path: 'test.ts' }, 'commit-a')).toBe('initial content')

    // Attempting to set or execute a mutating tool
    const writeSet = cache.set('write_file', { path: 'test.ts', content: 'new' }, 'ok', 'commit-a')
    expect(writeSet).toBe(false)

    // Mutation invalidated all prior cached entries (Axiom A1)
    expect(cache.get('read_file', { path: 'test.ts' }, 'commit-a')).toBeUndefined()
    expect(cache.getMetrics().size).toBe(0)
  })

  it('evicts oldest entries when capacity ceiling is reached (Axiom A5)', () => {
    const cache = new ToolIdempotencyCache({ maxEntries: 2 })

    cache.set('tool_a', { id: 1 }, 'res-1', 'head')
    cache.set('tool_a', { id: 2 }, 'res-2', 'head')
    expect(cache.getMetrics().size).toBe(2)

    // Insert 3rd entry triggering LRU eviction
    cache.set('tool_a', { id: 3 }, 'res-3', 'head')
    const metrics = cache.getMetrics()
    expect(metrics.size).toBe(2)
    expect(metrics.evictions).toBe(1)

    // First entry was evicted
    expect(cache.get('tool_a', { id: 1 }, 'head')).toBeUndefined()
    expect(cache.get('tool_a', { id: 2 }, 'head')).toBe('res-2')
    expect(cache.get('tool_a', { id: 3 }, 'head')).toBe('res-3')
  })

  it('purges entries after TTL expiry', async () => {
    const cache = new ToolIdempotencyCache({ defaultTtlMs: 20 })
    cache.set('read_file', { p: 'a' }, 'value', 'head')

    expect(cache.get('read_file', { p: 'a' }, 'head')).toBe('value')

    await new Promise((r) => setTimeout(r, 30))

    expect(cache.get('read_file', { p: 'a' }, 'head')).toBeUndefined()
  })
})
