import { describe, expect, it } from 'vitest'
import {
  AgentToolSpeculativeCacheEngine,
  type SpeculativeCacheConfig,
} from './agentToolSpeculativeCacheEngine'

describe('AgentToolSpeculativeCacheEngine (AGENT-029)', () => {
  it('computes deterministic keys regardless of argument key order', () => {
    const engine = new AgentToolSpeculativeCacheEngine()
    const key1 = engine.computeCacheKey(
      'read_file',
      { path: 'src/index.ts', verbose: true },
      'ws-hash-1',
    )
    const key2 = engine.computeCacheKey(
      'read_file',
      { verbose: true, path: 'src/index.ts' },
      'ws-hash-1',
    )

    expect(key1.key).toBe(key2.key)
    expect(key1.argsHash).toBe(key2.argsHash)
  })

  it('stores and retrieves cached tool outputs on matching workspace fingerprint', () => {
    const engine = new AgentToolSpeculativeCacheEngine()
    const now = 1_000_000

    engine.set(
      'read_file',
      { path: 'package.json' },
      'ws-100',
      { ok: true, output: '{"name": "forge"}' },
      10_000,
      now,
    )

    const hit = engine.get('read_file', { path: 'package.json' }, 'ws-100', now + 1000)
    expect(hit).not.toBeNull()
    expect(hit?.output).toBe('{"name": "forge"}')
    expect(hit?.accessCount).toBe(2)

    const stats = engine.getStats(now + 1000)
    expect(stats.hits).toBe(1)
    expect(stats.misses).toBe(0)
  })

  it('invalidates cache when workspace fingerprint changes', () => {
    const engine = new AgentToolSpeculativeCacheEngine()
    const now = 1_000_000

    engine.set(
      'list_dir',
      { path: '.' },
      'ws-initial',
      { ok: true, output: 'fileA\nfileB' },
      10_000,
      now,
    )

    // Lookup with altered workspace hash must return null (miss_workspace_mismatch)
    const miss = engine.get('list_dir', { path: '.' }, 'ws-modified', now + 500)
    expect(miss).toBeNull()

    const report = engine.evaluate('list_dir', { path: '.' }, 'ws-modified', now + 500)
    expect(report.hit).toBe(false)
    expect(report.reason).toBe('miss_not_found') // Was already evicted by previous get
  })

  it('expires entries past their TTL window', () => {
    const engine = new AgentToolSpeculativeCacheEngine({ defaultTtlMs: 5000 })
    const now = 1_000_000

    engine.set(
      'search_files',
      { query: 'foo' },
      'ws-1',
      { ok: true, output: 'src/foo.ts' },
      2000,
      now,
    )

    // Before expiration
    expect(engine.get('search_files', { query: 'foo' }, 'ws-1', now + 1000)).not.toBeNull()

    // After expiration
    expect(engine.get('search_files', { query: 'foo' }, 'ws-1', now + 2001)).toBeNull()
  })

  it('enforces LRU eviction when entry limit or byte budget is exceeded', () => {
    const config: SpeculativeCacheConfig = {
      maxEntries: 2,
      maxTotalBytes: 10_000,
    }
    const engine = new AgentToolSpeculativeCacheEngine(config)
    const now = 1_000_000

    engine.set('tool1', { id: 1 }, 'ws', { ok: true, output: 'out1' }, 10_000, now)
    engine.set('tool2', { id: 2 }, 'ws', { ok: true, output: 'out2' }, 10_000, now + 10)

    // Access tool1 to make tool2 least recently used
    engine.get('tool1', { id: 1 }, 'ws', now + 20)

    // Inserting 3rd entry must evict tool2
    engine.set('tool3', { id: 3 }, 'ws', { ok: true, output: 'out3' }, 10_000, now + 30)

    expect(engine.get('tool2', { id: 2 }, 'ws', now + 40)).toBeNull()
    expect(engine.get('tool1', { id: 1 }, 'ws', now + 40)).not.toBeNull()
    expect(engine.get('tool3', { id: 3 }, 'ws', now + 40)).not.toBeNull()

    const stats = engine.getStats(now + 40)
    expect(stats.evictions).toBe(1)
    expect(stats.entryCount).toBe(2)
  })

  it('prunes expired entries and supports bulk invalidation by tool or workspace', () => {
    const engine = new AgentToolSpeculativeCacheEngine()
    const now = 2_000_000

    engine.set('toolA', { q: 1 }, 'ws1', { ok: true, output: 'a' }, 1000, now)
    engine.set('toolA', { q: 2 }, 'ws2', { ok: true, output: 'b' }, 5000, now)
    engine.set('toolB', { q: 3 }, 'ws1', { ok: true, output: 'c' }, 5000, now)

    // Prune expired
    const pruned = engine.pruneExpired(now + 2000)
    expect(pruned).toBe(1)

    // Bulk invalidate workspace
    const purgedWs = engine.invalidateWorkspace('ws1')
    expect(purgedWs).toBe(1) // ws2 entry purged

    // Invalidate tool
    const purgedTool = engine.invalidateTool('toolB')
    expect(purgedTool).toBe(1)

    expect(engine.getStats().entryCount).toBe(0)
  })
})
