import { createHash } from 'node:crypto'

/**
 * Agent tool invocation idempotency deduplication ledger and state hash validator.
 *
 * Intercepts tool calls, computes deterministic cryptographic hashes over canonical
 * parameters and workspace snapshots, detects concurrent in-flight or recently completed
 * duplicate invocations, and enforces idempotency guarantees (A1, A4, A5).
 */

export type DeduplicationStatus = 'IN_FLIGHT' | 'COMPLETED' | 'EXPIRED' | 'NOT_FOUND'

export interface DeduplicationLedgerEntry {
  readonly fingerprint: string
  readonly toolName: string
  readonly paramsHash: string
  readonly workspaceHash?: string | undefined
  status: DeduplicationStatus
  readonly createdAt: number
  expiresAt: number
  result?: unknown
}

export interface DeduplicationEvaluation {
  readonly fingerprint: string
  readonly isDuplicate: boolean
  readonly canProceed: boolean
  readonly existingStatus?: DeduplicationStatus | undefined
  cachedResult?: unknown
  readonly reason: string
}

export interface LedgerConfig {
  /** Time-to-live in ms for ledger records before eviction. Defaults to 60000ms. */
  readonly defaultTtlMs?: number | undefined
  /** Maximum number of records retained before LRU pruning. Defaults to 1000. */
  readonly maxEntries?: number | undefined
}

export class AgentToolCallDeduplicationLedger {
  private readonly defaultTtlMs: number
  private readonly maxEntries: number
  private readonly entries = new Map<string, DeduplicationLedgerEntry>()

  constructor(config: LedgerConfig = {}) {
    this.defaultTtlMs = Math.max(10, config.defaultTtlMs ?? 60_000)
    this.maxEntries = Math.max(1, config.maxEntries ?? 1000)
  }

  /**
   * Deterministically canonicalizes a parameter object by sorting object keys recursively.
   */
  canonicalize(value: unknown): string {
    if (value === null || typeof value !== 'object') {
      return JSON.stringify(value)
    }

    if (Array.isArray(value)) {
      return `[${value.map((v) => this.canonicalize(v)).join(',')}]`
    }

    const obj = value as Record<string, unknown>
    const sortedKeys = Object.keys(obj).sort()
    const parts = sortedKeys.map((k) => `${JSON.stringify(k)}:${this.canonicalize(obj[k])}`)
    return `{${parts.join(',')}}`
  }

  /**
   * Computes SHA-256 fingerprint for tool invocation arguments and optional workspace hash.
   */
  computeFingerprint(
    toolName: string,
    params: Record<string, unknown>,
    workspaceHash?: string,
  ): { fingerprint: string; paramsHash: string } {
    const canonicalParams = this.canonicalize(params)
    const paramsHash = createHash('sha256').update(canonicalParams).digest('hex')

    const hasher = createHash('sha256')
    hasher.update(`tool:${toolName}|params:${paramsHash}`)
    if (workspaceHash) {
      hasher.update(`|ws:${workspaceHash}`)
    }
    const fingerprint = hasher.digest('hex')

    return { fingerprint, paramsHash }
  }

  /**
   * Evaluates inbound tool call for duplicates. If novel or expired, atomically registers IN_FLIGHT.
   */
  evaluateAndLock(
    toolName: string,
    params: Record<string, unknown>,
    workspaceHash?: string,
    ttlMs?: number,
  ): DeduplicationEvaluation {
    const now = Date.now()
    this.cleanupExpired(now)

    const { fingerprint, paramsHash } = this.computeFingerprint(toolName, params, workspaceHash)
    const existing = this.entries.get(fingerprint)

    if (existing) {
      if (existing.expiresAt > now) {
        if (existing.status === 'IN_FLIGHT') {
          return {
            fingerprint,
            isDuplicate: true,
            canProceed: false,
            existingStatus: 'IN_FLIGHT',
            reason: `Identical invocation for tool '${toolName}' is currently in flight.`,
          }
        }

        if (existing.status === 'COMPLETED') {
          return {
            fingerprint,
            isDuplicate: true,
            canProceed: false,
            existingStatus: 'COMPLETED',
            cachedResult: existing.result,
            reason: `Identical invocation for tool '${toolName}' already completed recently.`,
          }
        }
      } else {
        // Expired
        existing.status = 'EXPIRED'
      }
    }

    // Capacity limit enforcement: prune oldest if limit reached
    if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value
      if (oldestKey) {
        this.entries.delete(oldestKey)
      }
    }

    const effectiveTtl = Math.max(10, ttlMs ?? this.defaultTtlMs)
    const entry: DeduplicationLedgerEntry = {
      fingerprint,
      toolName,
      paramsHash,
      workspaceHash,
      status: 'IN_FLIGHT',
      createdAt: now,
      expiresAt: now + effectiveTtl,
    }

    this.entries.set(fingerprint, entry)

    return {
      fingerprint,
      isDuplicate: false,
      canProceed: true,
      existingStatus: 'NOT_FOUND',
      reason: 'First observed tool invocation registered in flight.',
    }
  }

  /**
   * Transitions an in-flight entry to COMPLETED with its return payload.
   */
  complete(fingerprint: string, result: unknown, ttlMs?: number): DeduplicationLedgerEntry {
    const entry = this.entries.get(fingerprint)
    if (!entry) {
      throw new Error(`Cannot complete unknown deduplication entry: ${fingerprint}`)
    }

    const now = Date.now()
    const effectiveTtl = Math.max(10, ttlMs ?? this.defaultTtlMs)

    entry.status = 'COMPLETED'
    entry.result = result
    entry.expiresAt = now + effectiveTtl

    return entry
  }

  /**
   * Releases or deletes an in-flight reservation (e.g., if execution failed).
   */
  release(fingerprint: string): boolean {
    return this.entries.delete(fingerprint)
  }

  /**
   * Retrieves an entry by fingerprint, updating its status if expired.
   */
  getEntry(fingerprint: string): DeduplicationLedgerEntry | undefined {
    const entry = this.entries.get(fingerprint)
    if (!entry) return undefined

    if (Date.now() > entry.expiresAt && entry.status !== 'EXPIRED') {
      entry.status = 'EXPIRED'
    }
    return entry
  }

  /**
   * Prunes all expired entries from the ledger.
   */
  cleanupExpired(now: number = Date.now()): number {
    let prunedCount = 0
    for (const [key, entry] of this.entries.entries()) {
      if (now > entry.expiresAt) {
        this.entries.delete(key)
        prunedCount += 1
      }
    }
    return prunedCount
  }

  /**
   * Clears all ledger entries.
   */
  clear(): void {
    this.entries.clear()
  }

  /**
   * Current number of tracked entries.
   */
  size(): number {
    return this.entries.size
  }
}
