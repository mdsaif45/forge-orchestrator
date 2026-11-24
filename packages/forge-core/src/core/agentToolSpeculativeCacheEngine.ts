import { createHash } from 'node:crypto'

/**
 * Speculative tool execution cache and cross-turn memoization engine.
 *
 * Implements deterministic fingerprint hashing, TTL expiration, workspace
 * hash invalidation, and LRU bounded memory management (A1, A4, A5).
 */

export interface SpeculativeCacheConfig {
  /** Maximum number of entries retained before LRU eviction. Defaults to 500. */
  readonly maxEntries?: number | undefined
  /** Maximum combined output byte size retained in memory. Defaults to 10MB. */
  readonly maxTotalBytes?: number | undefined
  /** Default entry time-to-live in milliseconds. Defaults to 5 minutes (300,000ms). */
  readonly defaultTtlMs?: number | undefined
  /** Maximum byte size for a single entry. Items larger than this are skipped. Defaults to 1MB. */
  readonly maxItemBytes?: number | undefined
}

export interface SpeculativeCacheEntry {
  readonly key: string
  readonly toolName: string
  readonly argsHash: string
  readonly workspaceHash: string
  readonly output: string
  readonly ok: boolean
  readonly createdAt: number
  readonly expiresAt: number
  lastAccessedAt: number
  accessCount: number
  readonly byteSize: number
}

export interface SpeculativeCacheStats {
  readonly hits: number
  readonly misses: number
  readonly evictions: number
  readonly entryCount: number
  readonly totalBytes: number
  readonly oldestEntryAgeMs: number
}

export interface CacheEvaluationReport {
  readonly toolName: string
  readonly hit: boolean
  readonly key: string
  readonly cachedOutput?: string | undefined
  readonly reason: 'hit' | 'miss_not_found' | 'miss_expired' | 'miss_workspace_mismatch'
  readonly stats: SpeculativeCacheStats
}

/**
 * Computes a deterministic canonical JSON string with recursively sorted object keys.
 */
function canonicalizeJson(val: unknown): string {
  if (val === null || typeof val !== 'object') {
    return JSON.stringify(val)
  }
  if (Array.isArray(val)) {
    return `[${val.map((item) => canonicalizeJson(item)).join(',')}]`
  }
  const obj = val as Record<string, unknown>
  const sortedKeys = Object.keys(obj).sort()
  const entries = sortedKeys.map((k) => `${JSON.stringify(k)}:${canonicalizeJson(obj[k])}`)
  return `{${entries.join(',')}}`
}

export class AgentToolSpeculativeCacheEngine {
  private readonly maxEntries: number
  private readonly maxTotalBytes: number
  private readonly defaultTtlMs: number
  private readonly maxItemBytes: number

  private readonly entries = new Map<string, SpeculativeCacheEntry>()
  private hits = 0
  private misses = 0
  private evictions = 0
  private currentTotalBytes = 0

  constructor(config: SpeculativeCacheConfig = {}) {
    this.maxEntries = Math.max(1, config.maxEntries ?? 500)
    this.maxTotalBytes = Math.max(1024, config.maxTotalBytes ?? 10 * 1024 * 1024)
    this.defaultTtlMs = Math.max(1000, config.defaultTtlMs ?? 5 * 60 * 1000)
    this.maxItemBytes = Math.max(256, config.maxItemBytes ?? 1024 * 1024)
  }

  /**
   * Computes a deterministic SHA-256 cache key from tool name, normalized parameters, and workspace fingerprint.
   */
  computeCacheKey(
    toolName: string,
    args: Record<string, unknown>,
    workspaceHash: string,
  ): { key: string; argsHash: string } {
    const canonicalArgs = canonicalizeJson(args)
    const argsHash = createHash('sha256').update(canonicalArgs).digest('hex')
    const key = createHash('sha256')
      .update(`${toolName}:${argsHash}:${workspaceHash}`)
      .digest('hex')
    return { key, argsHash }
  }

  /**
   * Look up a cached tool result.
   */
  get(
    toolName: string,
    args: Record<string, unknown>,
    workspaceHash: string,
    now: number = Date.now(),
  ): SpeculativeCacheEntry | null {
    const { key } = this.computeCacheKey(toolName, args, workspaceHash)
    const entry = this.entries.get(key)

    if (!entry) {
      this.misses += 1
      return null
    }

    // Check workspace mismatch (fail-closed if workspace hash differs)
    if (entry.workspaceHash !== workspaceHash) {
      this.entries.delete(key)
      this.currentTotalBytes -= entry.byteSize
      this.misses += 1
      return null
    }

    // Check TTL expiration
    if (now >= entry.expiresAt) {
      this.entries.delete(key)
      this.currentTotalBytes -= entry.byteSize
      this.misses += 1
      return null
    }

    // Cache hit: update LRU access metrics
    entry.lastAccessedAt = now
    entry.accessCount += 1
    this.hits += 1

    // Move to end of Map to maintain LRU order
    this.entries.delete(key)
    this.entries.set(key, entry)

    return entry
  }

  /**
   * Stores a tool execution result into the speculative cache.
   */
  set(
    toolName: string,
    args: Record<string, unknown>,
    workspaceHash: string,
    result: { ok: boolean; output: string },
    ttlMs?: number,
    now: number = Date.now(),
  ): SpeculativeCacheEntry | null {
    const byteSize = Buffer.byteLength(result.output, 'utf8') + 128

    // Reject items exceeding per-item ceiling
    if (byteSize > this.maxItemBytes) {
      return null
    }

    const { key, argsHash } = this.computeCacheKey(toolName, args, workspaceHash)
    const existing = this.entries.get(key)
    if (existing) {
      this.currentTotalBytes -= existing.byteSize
      this.entries.delete(key)
    }

    // Evict items until capacity constraints are met
    this.ensureCapacity(byteSize)

    const effectiveTtl = Math.max(1000, ttlMs ?? this.defaultTtlMs)
    const entry: SpeculativeCacheEntry = {
      key,
      toolName,
      argsHash,
      workspaceHash,
      output: result.output,
      ok: result.ok,
      createdAt: now,
      expiresAt: now + effectiveTtl,
      lastAccessedAt: now,
      accessCount: 1,
      byteSize,
    }

    this.entries.set(key, entry)
    this.currentTotalBytes += byteSize
    return entry
  }

  /**
   * Evaluates a tool call lookup and generates a structured forensic evaluation report.
   */
  evaluate(
    toolName: string,
    args: Record<string, unknown>,
    workspaceHash: string,
    now: number = Date.now(),
  ): CacheEvaluationReport {
    const { key } = this.computeCacheKey(toolName, args, workspaceHash)
    const entry = this.entries.get(key)

    if (!entry) {
      this.misses += 1
      return {
        toolName,
        hit: false,
        key,
        reason: 'miss_not_found',
        stats: this.getStats(now),
      }
    }

    if (entry.workspaceHash !== workspaceHash) {
      this.entries.delete(key)
      this.currentTotalBytes -= entry.byteSize
      this.misses += 1
      return {
        toolName,
        hit: false,
        key,
        reason: 'miss_workspace_mismatch',
        stats: this.getStats(now),
      }
    }

    if (now >= entry.expiresAt) {
      this.entries.delete(key)
      this.currentTotalBytes -= entry.byteSize
      this.misses += 1
      return {
        toolName,
        hit: false,
        key,
        reason: 'miss_expired',
        stats: this.getStats(now),
      }
    }

    entry.lastAccessedAt = now
    entry.accessCount += 1
    this.hits += 1
    this.entries.delete(key)
    this.entries.set(key, entry)

    return {
      toolName,
      hit: true,
      key,
      cachedOutput: entry.output,
      reason: 'hit',
      stats: this.getStats(now),
    }
  }

  /**
   * Invalidates all cache entries that do not match the updated workspace state.
   */
  invalidateWorkspace(currentWorkspaceHash: string): number {
    let purged = 0
    for (const [key, entry] of this.entries.entries()) {
      if (entry.workspaceHash !== currentWorkspaceHash) {
        this.currentTotalBytes -= entry.byteSize
        this.entries.delete(key)
        purged += 1
      }
    }
    return purged
  }

  /**
   * Invalidates all cached entries for a given tool name.
   */
  invalidateTool(toolName: string): number {
    let purged = 0
    for (const [key, entry] of this.entries.entries()) {
      if (entry.toolName === toolName) {
        this.currentTotalBytes -= entry.byteSize
        this.entries.delete(key)
        purged += 1
      }
    }
    return purged
  }

  /**
   * Prunes all entries whose TTL has passed.
   */
  pruneExpired(now: number = Date.now()): number {
    let pruned = 0
    for (const [key, entry] of this.entries.entries()) {
      if (now >= entry.expiresAt) {
        this.currentTotalBytes -= entry.byteSize
        this.entries.delete(key)
        pruned += 1
      }
    }
    return pruned
  }

  /**
   * Clears all entries and resets metric counters.
   */
  clear(): void {
    this.entries.clear()
    this.currentTotalBytes = 0
    this.hits = 0
    this.misses = 0
    this.evictions = 0
  }

  /**
   * Returns live engine statistics.
   */
  getStats(now: number = Date.now()): SpeculativeCacheStats {
    let oldestAge = 0
    for (const entry of this.entries.values()) {
      const age = Math.max(0, now - entry.createdAt)
      if (age > oldestAge) {
        oldestAge = age
      }
    }

    return {
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      entryCount: this.entries.size,
      totalBytes: this.currentTotalBytes,
      oldestEntryAgeMs: oldestAge,
    }
  }

  private ensureCapacity(incomingBytes: number): void {
    while (
      this.entries.size >= this.maxEntries ||
      (this.currentTotalBytes + incomingBytes > this.maxTotalBytes && this.entries.size > 0)
    ) {
      // Oldest item is the first element in Map iteration order
      const oldestKey = this.entries.keys().next().value
      if (!oldestKey) break
      const oldestEntry = this.entries.get(oldestKey)
      if (oldestEntry) {
        this.currentTotalBytes -= oldestEntry.byteSize
        this.entries.delete(oldestKey)
        this.evictions += 1
      }
    }
  }
}
