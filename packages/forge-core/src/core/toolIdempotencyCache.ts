import { createHash } from 'node:crypto'
import { z } from 'zod'

export const toolCacheConfigSchema = z.strictObject({
  /** Maximum number of entries stored before LRU eviction (default: 500, Axiom A5). */
  maxEntries: z.number().int().positive().default(500),
  /** Default Time-To-Live for cached tool results in milliseconds (default: 60,000ms = 1m). */
  defaultTtlMs: z.number().int().positive().default(60_000),
})

export type ToolCacheConfig = z.infer<typeof toolCacheConfigSchema>

export interface ToolCacheMetrics {
  readonly size: number
  readonly maxEntries: number
  readonly hits: number
  readonly misses: number
  readonly evictions: number
  readonly hitRatio: number
}

interface CacheEntry {
  readonly key: string
  readonly toolName: string
  readonly value: unknown
  readonly expiresAt: number
  lastAccessed: number
}

/** Known mutating tools that modify disk, git, or process states (Axioms A1, A3). */
const DEFAULT_MUTATING_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
  'create_file',
  'delete_file',
  'execute_command',
  'run_command',
  'git_commit',
  'git_checkout',
  'git_apply',
  'git_revert',
  'rollback_changes',
])

/**
 * Deterministic LRU idempotency cache for read-only agent tool invocations (Axioms A1, A3, A5).
 */
export class ToolIdempotencyCache {
  private readonly maxEntries: number
  private readonly defaultTtlMs: number
  private readonly cache = new Map<string, CacheEntry>()
  private hits = 0
  private misses = 0
  private evictions = 0

  constructor(options: Partial<ToolCacheConfig> = {}) {
    const validated = toolCacheConfigSchema.parse(options)
    this.maxEntries = validated.maxEntries
    this.defaultTtlMs = validated.defaultTtlMs
  }

  /**
   * Generates a deterministic SHA-256 fingerprint for tool invocation arguments.
   */
  public static computeKey(toolName: string, args: unknown, repoHead?: string): string {
    const canonicalArgs = JSON.stringify(args, Object.keys(args ?? {}).sort())
    const input = `${toolName}:${canonicalArgs}:${repoHead ?? 'HEAD'}`
    return createHash('sha256').update(input).digest('hex')
  }

  /**
   * Checks whether a tool is a mutation tool that must bypass caching.
   */
  public isMutatingTool(toolName: string): boolean {
    return DEFAULT_MUTATING_TOOLS.has(toolName.toLowerCase().trim())
  }

  /**
   * Attempts to retrieve a valid cached result for a read-only tool invocation.
   */
  public get(toolName: string, args: unknown, repoHead?: string): unknown {
    if (this.isMutatingTool(toolName)) {
      this.misses++
      return undefined
    }

    const key = ToolIdempotencyCache.computeKey(toolName, args, repoHead)
    const entry = this.cache.get(key)

    if (!entry) {
      this.misses++
      return undefined
    }

    const now = Date.now()
    if (now > entry.expiresAt) {
      this.cache.delete(key)
      this.misses++
      return undefined
    }

    // Refresh last accessed timestamp for LRU
    entry.lastAccessed = now
    this.hits++
    return entry.value
  }

  /**
   * Stores a read-only tool execution result in cache.
   * If the tool is mutating, bypasses storage and invalidates all cached entries.
   */
  public set(
    toolName: string,
    args: unknown,
    value: unknown,
    repoHead?: string,
    ttlMs?: number,
  ): boolean {
    if (this.isMutatingTool(toolName)) {
      // Invalidate cache on mutations to prevent stale reads
      this.clear()
      return false
    }

    const key = ToolIdempotencyCache.computeKey(toolName, args, repoHead)
    const now = Date.now()
    const expiresAt = now + (ttlMs ?? this.defaultTtlMs)

    // Enforce max capacity ceiling via LRU eviction (Axiom A5)
    if (!this.cache.has(key) && this.cache.size >= this.maxEntries) {
      this.evictOldest()
    }

    this.cache.set(key, {
      key,
      toolName,
      value,
      expiresAt,
      lastAccessed: now,
    })

    return true
  }

  private evictOldest(): void {
    let oldestKey: string | undefined
    let oldestTimestamp = Infinity

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTimestamp) {
        oldestTimestamp = entry.lastAccessed
        oldestKey = key
      }
    }

    if (oldestKey !== undefined) {
      this.cache.delete(oldestKey)
      this.evictions++
    }
  }

  /**
   * Explicitly signals that a mutating action occurred, invalidating read cache.
   */
  public invalidateOnMutation(toolName: string): boolean {
    if (this.isMutatingTool(toolName)) {
      this.clear()
      return true
    }
    return false
  }

  /**
   * Clears all cached entries and resets size.
   */
  public clear(): void {
    this.cache.clear()
  }

  /**
   * Returns current cache utilization and operational metrics.
   */
  public getMetrics(): ToolCacheMetrics {
    const totalRequests = this.hits + this.misses
    const hitRatio = totalRequests > 0 ? Math.round((this.hits / totalRequests) * 100) / 100 : 0

    return {
      size: this.cache.size,
      maxEntries: this.maxEntries,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRatio,
    }
  }
}
