import { describe, expect, it } from 'vitest'
import { AgentScratchpadBuffer } from './agentScratchpadBuffer'

describe('AgentScratchpadBuffer (AGENT-022)', () => {
  it('stores and retrieves scratchpad entries with access tracking', () => {
    const buffer = new AgentScratchpadBuffer({ maxEntries: 5, maxTotalBytes: 1024 })
    buffer.set('hypothesis.issue368', 'Investigating working memory buffer', {
      tags: ['research', 'memory'],
      isPinned: true,
    })

    expect(buffer.has('hypothesis.issue368')).toBe(true)
    const entry = buffer.get('hypothesis.issue368')
    expect(entry).toBeDefined()
    expect(entry?.value).toBe('Investigating working memory buffer')
    expect(entry?.isPinned).toBe(true)
    expect(entry?.tags).toEqual(['research', 'memory'])
    expect(entry?.accessCount).toBe(2) // 1 in set, 1 in get
  })

  it('evicts least recently used entries when maxEntries is exceeded, protecting pinned entries', () => {
    const buffer = new AgentScratchpadBuffer({ maxEntries: 2, maxTotalBytes: 4096 })

    buffer.set('k1', 'val1', { isPinned: true })
    buffer.set('k2', 'val2')
    // k1 is pinned, k2 is unpinned. Now insert k3 -> k2 should be evicted!
    buffer.set('k3', 'val3')

    expect(buffer.has('k1')).toBe(true) // Pinned, kept
    expect(buffer.has('k2')).toBe(false) // Evicted
    expect(buffer.has('k3')).toBe(true)
  })

  it('evicts entries by tag', () => {
    const buffer = new AgentScratchpadBuffer()
    buffer.set('note1', 'data1', { tags: ['temp'] })
    buffer.set('note2', 'data2', { tags: ['temp'] })
    buffer.set('note3', 'data3', { tags: ['permanent'] })

    const evicted = buffer.evictByTag('temp')
    expect(evicted).toBe(2)
    expect(buffer.has('note1')).toBe(false)
    expect(buffer.has('note2')).toBe(false)
    expect(buffer.has('note3')).toBe(true)
  })

  it('computes accurate buffer statistics and prompt markdown formatting', () => {
    const buffer = new AgentScratchpadBuffer({ maxEntries: 10, maxTotalBytes: 2048 })
    buffer.set('plan.step1', 'Decompose tasks', { isPinned: true })
    buffer.set('plan.step2', 'Execute workflows')

    const stats = buffer.getStats()
    expect(stats.totalEntries).toBe(2)
    expect(stats.pinnedEntriesCount).toBe(1)
    expect(stats.totalBytes).toBeGreaterThan(0)

    const formatted = buffer.formatForPromptContext()
    expect(formatted).toContain('### Working Memory Scratchpad')
    expect(formatted).toContain('- **plan.step1** [PINNED]:')
    expect(formatted).toContain('  Decompose tasks')
    expect(formatted).toContain('- **plan.step2**:')
  })

  it('throws error when setting empty key or exceeding max capacity', () => {
    const buffer = new AgentScratchpadBuffer({ maxEntries: 5, maxTotalBytes: 50 })
    expect(() => buffer.set('', 'empty')).toThrow('Scratchpad key cannot be empty.')
    expect(() =>
      buffer.set('massive_key', 'this string is intentionally much larger than 50 bytes total'),
    ).toThrow('Entry exceeds buffer capacity')
  })
})
