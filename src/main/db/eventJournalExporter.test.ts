import { describe, expect, it } from 'vitest'
import {
  exportEventJournal,
  verifyEventJournalHashChain,
  type RawLedgerEvent,
} from './eventJournalExporter'

describe('EventJournalExporter (STATE-008)', () => {
  const events: RawLedgerEvent[] = [
    {
      id: 'ev-1',
      runId: 'run-100',
      seq: 1,
      type: 'run.started',
      timestamp: '2026-11-19T07:00:00.000Z',
      payload: { mode: 'direct-task' },
    },
    {
      id: 'ev-2',
      runId: 'run-100',
      seq: 2,
      type: 'step.started',
      timestamp: '2026-11-19T07:00:01.000Z',
      payload: { stepId: 'step-1', role: 'coder' },
    },
    {
      id: 'ev-3',
      runId: 'run-100',
      seq: 3,
      type: 'step.completed',
      timestamp: '2026-11-19T07:00:05.000Z',
      payload: { stepId: 'step-1', exitCode: 0 },
    },
    {
      id: 'ev-4',
      runId: 'run-100',
      seq: 4,
      type: 'run.completed',
      timestamp: '2026-11-19T07:00:06.000Z',
      payload: { exitCode: 0 },
    },
  ]

  it('exports a monotonic sequence of events with valid cryptographic hash chaining', () => {
    const report = exportEventJournal('run-100', events)
    expect(report.valid).toBe(true)
    expect(report.eventCount).toBe(4)
    expect(report.sequenceGaps).toEqual([])
    expect(report.terminalHash).toBeDefined()
    expect(report.journalEntries[0]?.prevHash).toBe(report.genesisHash)
    expect(report.journalEntries[1]?.prevHash).toBe(report.journalEntries[0]?.hash)

    // Verify hash chain
    const verification = verifyEventJournalHashChain(report.journalEntries)
    expect(verification.valid).toBe(true)
    expect(verification.eventCount).toBe(4)
    expect(verification.terminalHash).toBe(report.terminalHash)
  })

  it('detects sequence gaps and fails closed (A1, A2)', () => {
    const gappedEvents: RawLedgerEvent[] = [
      events[0]!,
      // Skipping seq 2
      events[2]!,
      events[3]!,
    ]

    const report = exportEventJournal('run-100', gappedEvents)
    expect(report.valid).toBe(false)
    expect(report.sequenceGaps).toContain(2)
  })

  it('detects event payload tampering or hash corruption (A3)', () => {
    const report = exportEventJournal('run-100', events)

    // Tamper with payload in entry 2
    const tamperedEntries = report.journalEntries.map((e, idx) => {
      if (idx === 1) {
        return {
          ...e,
          payload: { stepId: 'step-1', role: 'malicious-attacker' },
        }
      }
      return e
    })

    const verification = verifyEventJournalHashChain(tamperedEntries)
    expect(verification.valid).toBe(false)
    expect(verification.brokenSeq).toBe(2)
  })

  it('handles empty event ledgers deterministically', () => {
    const report = exportEventJournal('run-empty', [])
    expect(report.valid).toBe(true)
    expect(report.eventCount).toBe(0)
    expect(report.terminalHash).toBe(report.genesisHash)

    const verification = verifyEventJournalHashChain(report.journalEntries)
    expect(verification.valid).toBe(true)
  })
})
