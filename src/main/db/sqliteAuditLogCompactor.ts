import { createHash } from 'node:crypto'
import { canonicalizeJson } from '../../shared/domain/canonicalJson'

export interface RawAuditEvent {
  eventId: string
  runId: string
  seq: number
  eventType: string
  payload: Record<string, unknown>
  timestamp: string
}

export interface CompactedAuditRecord {
  runId: string
  eventCount: number
  firstEventSeq: number
  lastEventSeq: number
  firstTimestamp: string
  lastTimestamp: string
  rollingHash: string
  merkleRoot: string
  eventTypeCounts: Record<string, number>
  compactedAt: string
}

export class SqliteAuditLogCompactor {
  public static computeEventDigest(event: RawAuditEvent): string {
    const serializedPayload = canonicalizeJson(event.payload)
    const content = `${event.eventId}:${String(event.seq)}:${event.eventType}:${serializedPayload}:${event.timestamp}`
    return createHash('sha256').update(content).digest('hex')
  }

  public static computeRollingHash(events: RawAuditEvent[]): string {
    let currentHash = '0'.repeat(64)
    for (const event of events) {
      const digest = SqliteAuditLogCompactor.computeEventDigest(event)
      currentHash = createHash('sha256').update(`${currentHash}:${digest}`).digest('hex')
    }
    return currentHash
  }

  public static computeMerkleRoot(events: RawAuditEvent[]): string {
    if (events.length === 0) {
      return createHash('sha256').update('').digest('hex')
    }

    let level = events.map((e) => SqliteAuditLogCompactor.computeEventDigest(e))

    while (level.length > 1) {
      const nextLevel: string[] = []
      for (let i = 0; i < level.length; i += 2) {
        const left = level[i]
        if (!left) {
          continue
        }
        const rightCandidate = i + 1 < level.length ? level[i + 1] : undefined
        const right = rightCandidate ?? left
        const combined = createHash('sha256').update(`${left}:${right}`).digest('hex')
        nextLevel.push(combined)
      }
      level = nextLevel
    }

    return level[0] ?? ''
  }

  public compactRunEvents(events: RawAuditEvent[]): CompactedAuditRecord {
    const firstRaw = events[0]
    if (!firstRaw || events.length === 0) {
      throw new Error('Cannot compact empty event collection')
    }

    const runId = firstRaw.runId
    for (const event of events) {
      if (event.runId !== runId) {
        throw new Error(
          `Heterogeneous runIds detected in event batch: expected "${runId}", got "${event.runId}"`,
        )
      }
    }

    const sorted = [...events].sort((a, b) => a.seq - b.seq)
    const eventCount = sorted.length
    const firstEvent = sorted[0]
    const lastEvent = sorted[sorted.length - 1]
    if (!firstEvent || !lastEvent) {
      throw new Error('Cannot compact empty event collection')
    }

    const eventTypeCounts: Record<string, number> = {}
    for (const ev of sorted) {
      eventTypeCounts[ev.eventType] = (eventTypeCounts[ev.eventType] ?? 0) + 1
    }

    const rollingHash = SqliteAuditLogCompactor.computeRollingHash(sorted)
    const merkleRoot = SqliteAuditLogCompactor.computeMerkleRoot(sorted)

    return {
      runId,
      eventCount,
      firstEventSeq: firstEvent.seq,
      lastEventSeq: lastEvent.seq,
      firstTimestamp: firstEvent.timestamp,
      lastTimestamp: lastEvent.timestamp,
      rollingHash,
      merkleRoot,
      eventTypeCounts,
      compactedAt: new Date().toISOString(),
    }
  }

  public verifyCompactionIntegrity(
    events: RawAuditEvent[],
    compaction: CompactedAuditRecord,
  ): boolean {
    if (events.length === 0 || events.length !== compaction.eventCount) {
      return false
    }

    const sorted = [...events].sort((a, b) => a.seq - b.seq)
    if (sorted[0]?.runId !== compaction.runId) {
      return false
    }

    const recomputedRolling = SqliteAuditLogCompactor.computeRollingHash(sorted)
    if (recomputedRolling !== compaction.rollingHash) {
      return false
    }

    const recomputedMerkle = SqliteAuditLogCompactor.computeMerkleRoot(sorted)
    if (recomputedMerkle !== compaction.merkleRoot) {
      return false
    }

    return true
  }
}
