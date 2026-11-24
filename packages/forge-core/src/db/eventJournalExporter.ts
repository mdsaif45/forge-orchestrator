import { createHash } from 'node:crypto'

export interface RawLedgerEvent {
  readonly id: string
  readonly runId: string
  readonly stepId?: string | null | undefined
  readonly seq: number
  readonly type: string
  readonly timestamp: string
  readonly payload?: unknown
}

export interface JournalEntry {
  readonly seq: number
  readonly runId: string
  readonly stepId: string | null
  readonly type: string
  readonly timestamp: string
  readonly prevHash: string
  readonly hash: string
  readonly payload: unknown
}

export interface EventJournalExportReport {
  readonly valid: boolean
  readonly runId: string
  readonly eventCount: number
  readonly genesisHash: string
  readonly terminalHash: string
  readonly journalEntries: readonly JournalEntry[]
  readonly journalNdjson: string
  readonly sequenceGaps: readonly number[]
  readonly formattedSummary: string
  readonly error?: string | undefined
}

export interface JournalVerificationReport {
  readonly valid: boolean
  readonly eventCount: number
  readonly terminalHash: string
  readonly brokenSeq?: number | undefined
  readonly formattedSummary: string
  readonly error?: string | undefined
}

export const GENESIS_HASH = '0000000000000000000000000000000000000000000000000000000000000000'

function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex')
}

export function computeChainedEventHash(
  prevHash: string,
  seq: number,
  type: string,
  timestamp: string,
  payload: unknown,
): string {
  const payloadObj =
    typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>) : {}
  const payloadStr =
    typeof payload === 'string'
      ? payload
      : JSON.stringify(payloadObj, Object.keys(payloadObj).sort())
  const raw = `${prevHash}:${String(seq)}:${type}:${timestamp}:${payloadStr}`
  return sha256(raw)
}

/**
 * Validates sequence monotonicity and generates a cryptographically chained journal (Axioms A1, A3, A5).
 */
export function exportEventJournal(
  runId: string,
  rawEvents: readonly RawLedgerEvent[],
): EventJournalExportReport {
  if (rawEvents.length === 0) {
    return {
      valid: true,
      runId,
      eventCount: 0,
      genesisHash: GENESIS_HASH,
      terminalHash: GENESIS_HASH,
      journalEntries: [],
      journalNdjson: '',
      sequenceGaps: [],
      formattedSummary: `EVENT JOURNAL EXPORT: Run ${runId} has 0 events (Empty ledger)`,
    }
  }

  // Sort events by sequence number ascending
  const sorted = [...rawEvents].sort((a, b) => a.seq - b.seq)
  const sequenceGaps: number[] = []
  const journalEntries: JournalEntry[] = []

  let prevHash = GENESIS_HASH
  let expectedSeq = 1

  for (const ev of sorted) {
    if (ev.seq !== expectedSeq) {
      sequenceGaps.push(expectedSeq)
      expectedSeq = ev.seq + 1
    } else {
      expectedSeq++
    }

    const currentHash = computeChainedEventHash(prevHash, ev.seq, ev.type, ev.timestamp, ev.payload)

    const entry: JournalEntry = {
      seq: ev.seq,
      runId: ev.runId,
      stepId: ev.stepId ?? null,
      type: ev.type,
      timestamp: ev.timestamp,
      prevHash,
      hash: currentHash,
      payload: ev.payload ?? {},
    }

    journalEntries.push(entry)
    prevHash = currentHash
  }

  const valid = sequenceGaps.length === 0
  const terminalHash = prevHash
  const journalNdjson = journalEntries.map((e) => JSON.stringify(e)).join('\n')

  const formattedSummary = valid
    ? `EVENT JOURNAL EXPORT VALID\n` +
      `  Run ID:        ${runId}\n` +
      `  Events:        ${String(journalEntries.length)}\n` +
      `  Genesis Hash:  ${GENESIS_HASH}\n` +
      `  Terminal Hash: ${terminalHash}`
    : `EVENT JOURNAL EXPORT FAILED: Monotonicity violation\n` +
      `  Gaps detected at sequence: [${sequenceGaps.join(', ')}]`

  return {
    valid,
    runId,
    eventCount: journalEntries.length,
    genesisHash: GENESIS_HASH,
    terminalHash,
    journalEntries,
    journalNdjson,
    sequenceGaps,
    formattedSummary,
    error: valid ? undefined : `Sequence gaps detected at: ${sequenceGaps.join(', ')}`,
  }
}

/**
 * Cryptographically verifies an exported journal's hash chain and sequence monotonicity (Axiom A3).
 */
export function verifyEventJournalHashChain(
  journalEntries: readonly JournalEntry[],
): JournalVerificationReport {
  if (journalEntries.length === 0) {
    return {
      valid: true,
      eventCount: 0,
      terminalHash: GENESIS_HASH,
      formattedSummary: 'JOURNAL HASH CHAIN VERIFIED: 0 events (Empty ledger)',
    }
  }

  let prevHash = GENESIS_HASH

  for (const [i, entry] of journalEntries.entries()) {
    const expectedSeq = i + 1

    if (entry.seq !== expectedSeq) {
      const err = `Sequence gap or invalid order at index ${String(i)}: expected ${String(expectedSeq)}, got ${String(entry.seq)}`
      return {
        valid: false,
        eventCount: journalEntries.length,
        terminalHash: prevHash,
        brokenSeq: entry.seq,
        formattedSummary: `JOURNAL HASH CHAIN CORRUPTED: ${err}`,
        error: err,
      }
    }

    if (entry.prevHash !== prevHash) {
      const err = `Broken hash link at seq ${String(entry.seq)}: expected prevHash ${prevHash}, got ${entry.prevHash}`
      return {
        valid: false,
        eventCount: journalEntries.length,
        terminalHash: prevHash,
        brokenSeq: entry.seq,
        formattedSummary: `JOURNAL HASH CHAIN CORRUPTED: ${err}`,
        error: err,
      }
    }

    const recomputedHash = computeChainedEventHash(
      entry.prevHash,
      entry.seq,
      entry.type,
      entry.timestamp,
      entry.payload,
    )

    if (recomputedHash !== entry.hash) {
      const err = `Tampered event payload or hash at seq ${String(entry.seq)}`
      return {
        valid: false,
        eventCount: journalEntries.length,
        terminalHash: prevHash,
        brokenSeq: entry.seq,
        formattedSummary: `JOURNAL HASH CHAIN CORRUPTED: ${err}`,
        error: err,
      }
    }

    prevHash = entry.hash
  }

  return {
    valid: true,
    eventCount: journalEntries.length,
    terminalHash: prevHash,
    formattedSummary: `JOURNAL HASH CHAIN VERIFIED: ${String(journalEntries.length)} events verified (Terminal: ${prevHash})`,
  }
}
