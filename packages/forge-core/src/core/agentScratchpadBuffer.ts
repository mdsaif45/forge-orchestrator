/**
 * AGENT-022: Agent Scratchpad Working Memory Buffer & Eviction Pruner.
 *
 * Implements a bounded in-memory scratchpad buffer for agent reasoning loops,
 * supporting LRU/tag-based eviction, size budgets, pinned entries, and structured
 * LLM prompt context injection formatting.
 */

export interface ScratchpadEntry {
  key: string
  value: string
  tags: string[]
  sizeBytes: number
  accessCount: number
  createdAt: string
  lastAccessedAt: string
  isPinned: boolean
}

export interface ScratchpadBufferOptions {
  maxEntries?: number | undefined
  maxTotalBytes?: number | undefined
}

export interface ScratchpadBufferStats {
  totalEntries: number
  totalBytes: number
  maxEntries: number
  maxTotalBytes: number
  pinnedEntriesCount: number
  oldestEntryKey?: string | undefined
  newestEntryKey?: string | undefined
}

const DEFAULT_MAX_ENTRIES = 20
const DEFAULT_MAX_TOTAL_BYTES = 32768 // 32 KB

export class AgentScratchpadBuffer {
  private readonly entries = new Map<string, ScratchpadEntry>()
  private readonly maxEntries: number
  private readonly maxTotalBytes: number

  constructor(options: ScratchpadBufferOptions = {}) {
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.maxTotalBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES

    if (this.maxEntries <= 0) {
      throw new Error('maxEntries must be greater than 0.')
    }
    if (this.maxTotalBytes <= 0) {
      throw new Error('maxTotalBytes must be greater than 0.')
    }
  }

  public set(
    key: string,
    value: string,
    options: { tags?: string[] | undefined; isPinned?: boolean | undefined } = {},
  ): ScratchpadEntry {
    const trimmedKey = key.trim()
    if (!trimmedKey) {
      throw new Error('Scratchpad key cannot be empty.')
    }

    const now = new Date().toISOString()
    const sizeBytes = Buffer.byteLength(`${trimmedKey}:${value}`, 'utf8')

    if (sizeBytes > this.maxTotalBytes) {
      throw new Error(
        `Entry exceeds buffer capacity: entry requires ${String(sizeBytes)} bytes, max is ${String(this.maxTotalBytes)} bytes.`,
      )
    }

    // If updating existing entry, remove old size first
    const existing = this.entries.get(trimmedKey)
    const accessCount = existing ? existing.accessCount + 1 : 1
    const createdAt = existing ? existing.createdAt : now
    const isPinned = options.isPinned ?? existing?.isPinned ?? false
    const tags = options.tags ?? existing?.tags ?? []

    const newEntry: ScratchpadEntry = {
      key: trimmedKey,
      value,
      tags,
      sizeBytes,
      accessCount,
      createdAt,
      lastAccessedAt: now,
      isPinned,
    }

    // Temporarily set new entry to calculate eviction needs
    this.entries.set(trimmedKey, newEntry)

    this.pruneBuffer()

    return newEntry
  }

  public get(key: string): ScratchpadEntry | undefined {
    const trimmedKey = key.trim()
    const entry = this.entries.get(trimmedKey)
    if (!entry) {
      return undefined
    }

    entry.accessCount += 1
    entry.lastAccessedAt = new Date().toISOString()
    return entry
  }

  public has(key: string): boolean {
    return this.entries.has(key.trim())
  }

  public delete(key: string): boolean {
    return this.entries.delete(key.trim())
  }

  public clear(): void {
    this.entries.clear()
  }

  public evictByTag(tag: string): number {
    let evictedCount = 0
    for (const [key, entry] of this.entries.entries()) {
      if (!entry.isPinned && entry.tags.includes(tag)) {
        this.entries.delete(key)
        evictedCount++
      }
    }
    return evictedCount
  }

  public getStats(): ScratchpadBufferStats {
    let totalBytes = 0
    let pinnedCount = 0
    let oldestTime = Infinity
    let newestTime = -Infinity
    let oldestKey: string | undefined
    let newestKey: string | undefined

    for (const entry of this.entries.values()) {
      totalBytes += entry.sizeBytes
      if (entry.isPinned) {
        pinnedCount++
      }

      const createdMs = Date.parse(entry.createdAt)
      if (createdMs < oldestTime) {
        oldestTime = createdMs
        oldestKey = entry.key
      }
      if (createdMs > newestTime) {
        newestTime = createdMs
        newestKey = entry.key
      }
    }

    return {
      totalEntries: this.entries.size,
      totalBytes,
      maxEntries: this.maxEntries,
      maxTotalBytes: this.maxTotalBytes,
      pinnedEntriesCount: pinnedCount,
      oldestEntryKey: oldestKey,
      newestEntryKey: newestKey,
    }
  }

  public formatForPromptContext(headerTitle = 'Working Memory Scratchpad'): string {
    if (this.entries.size === 0) {
      return ''
    }

    const lines: string[] = [`### ${headerTitle}`]
    for (const entry of this.entries.values()) {
      const pinBadge = entry.isPinned ? ' [PINNED]' : ''
      const tagBadge = entry.tags.length > 0 ? ` [${entry.tags.join(', ')}]` : ''
      lines.push(`- **${entry.key}**${pinBadge}${tagBadge}:`)
      lines.push(`  ${entry.value}`)
    }

    return lines.join('\n')
  }

  public toJSON(): ScratchpadEntry[] {
    return Array.from(this.entries.values())
  }

  private pruneBuffer(): void {
    let currentTotalBytes = 0
    for (const entry of this.entries.values()) {
      currentTotalBytes += entry.sizeBytes
    }

    // Evict unpinned entries while entry count or byte count exceeds limits
    while (
      (this.entries.size > this.maxEntries || currentTotalBytes > this.maxTotalBytes) &&
      this.hasEvictableEntries()
    ) {
      // Find least recently used unpinned entry
      let lruKey: string | null = null
      let oldestAccessTime = Infinity

      for (const [key, entry] of this.entries.entries()) {
        if (!entry.isPinned) {
          const accessMs = Date.parse(entry.lastAccessedAt)
          if (accessMs < oldestAccessTime) {
            oldestAccessTime = accessMs
            lruKey = key
          }
        }
      }

      if (lruKey) {
        const removed = this.entries.get(lruKey)
        if (removed) {
          currentTotalBytes -= removed.sizeBytes
          this.entries.delete(lruKey)
        }
      } else {
        break
      }
    }
  }

  private hasEvictableEntries(): boolean {
    for (const entry of this.entries.values()) {
      if (!entry.isPinned) {
        return true
      }
    }
    return false
  }
}
