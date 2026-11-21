import { describe, expect, it } from 'vitest'
import { SqliteAuditLogCompactor, type RawAuditEvent } from './sqliteAuditLogCompactor'

describe('SqliteAuditLogCompactor', () => {
  const sampleEvents: RawAuditEvent[] = [
    {
      eventId: 'ev-1',
      runId: 'run-alpha',
      seq: 1,
      eventType: 'run_started',
      payload: { mode: 'acceptEdits' },
      timestamp: '2026-11-21T10:00:00.000Z',
    },
    {
      eventId: 'ev-2',
      runId: 'run-alpha',
      seq: 2,
      eventType: 'tool_invoked',
      payload: { tool: 'file_read', path: 'src/main.ts' },
      timestamp: '2026-11-21T10:00:01.000Z',
    },
    {
      eventId: 'ev-3',
      runId: 'run-alpha',
      seq: 3,
      eventType: 'run_completed',
      payload: { exitCode: 0 },
      timestamp: '2026-11-21T10:00:05.000Z',
    },
  ]

  it('compacts raw audit events into verifiable summary record', () => {
    const compactor = new SqliteAuditLogCompactor()
    const record = compactor.compactRunEvents(sampleEvents)

    expect(record.runId).toBe('run-alpha')
    expect(record.eventCount).toBe(3)
    expect(record.firstEventSeq).toBe(1)
    expect(record.lastEventSeq).toBe(3)
    expect(record.firstTimestamp).toBe('2026-11-21T10:00:00.000Z')
    expect(record.lastTimestamp).toBe('2026-11-21T10:00:05.000Z')
    expect(record.rollingHash).toHaveLength(64)
    expect(record.merkleRoot).toHaveLength(64)
    expect(record.eventTypeCounts).toEqual({
      run_started: 1,
      tool_invoked: 1,
      run_completed: 1,
    })
  })

  it('verifies integrity of compaction record successfully against original events', () => {
    const compactor = new SqliteAuditLogCompactor()
    const record = compactor.compactRunEvents(sampleEvents)

    const isValid = compactor.verifyCompactionIntegrity(sampleEvents, record)
    expect(isValid).toBe(true)
  })

  it('fails verification when an event payload is tampered or corrupted', () => {
    const compactor = new SqliteAuditLogCompactor()
    const record = compactor.compactRunEvents(sampleEvents)

    const tamperedEvents: RawAuditEvent[] = [
      sampleEvents[0]!,
      {
        ...sampleEvents[1]!,
        payload: { tool: 'file_write', path: 'src/malicious.ts' }, // Tampered
      },
      sampleEvents[2]!,
    ]

    const isValid = compactor.verifyCompactionIntegrity(tamperedEvents, record)
    expect(isValid).toBe(false)
  })

  it('fails verification when events are missing or count mismatches', () => {
    const compactor = new SqliteAuditLogCompactor()
    const record = compactor.compactRunEvents(sampleEvents)

    const truncated = [sampleEvents[0]!, sampleEvents[1]!]
    const isValid = compactor.verifyCompactionIntegrity(truncated, record)
    expect(isValid).toBe(false)
  })

  it('rejects compacting empty collections or heterogeneous run IDs fail-closed', () => {
    const compactor = new SqliteAuditLogCompactor()
    expect(() => compactor.compactRunEvents([])).toThrow('Cannot compact empty event collection')

    const heterogeneous: RawAuditEvent[] = [
      sampleEvents[0]!,
      { ...sampleEvents[1]!, runId: 'run-other' },
    ]
    expect(() => compactor.compactRunEvents(heterogeneous)).toThrow('Heterogeneous runIds detected')
  })
})
