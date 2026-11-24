import { describe, it, expect } from 'vitest'
import Database from 'better-sqlite3'
import {
  computeJournalDiff,
  auditDatabaseJournalRange,
  type LedgerEventInput,
} from './journalDiffAuditor'

describe('journalDiffAuditor (STATE-017)', () => {
  describe('computeJournalDiff', () => {
    it('accurately groups entity mutations and detects sequence continuity', () => {
      const events: LedgerEventInput[] = [
        {
          seq: 1,
          type: 'run.created',
          aggregateId: 'run-100',
          payload: { status: 'pending', task: 'initial' },
        },
        {
          seq: 2,
          type: 'run.updated',
          aggregateId: 'run-100',
          payload: { status: 'running', task: 'initial' },
        },
        {
          seq: 3,
          type: 'step.started',
          aggregateId: 'step-200',
          payload: { name: 'build' },
        },
      ]

      const report = computeJournalDiff(events)

      expect(report.fromSeq).toBe(1)
      expect(report.toSeq).toBe(3)
      expect(report.isContiguous).toBe(true)
      expect(report.sequenceGaps).toHaveLength(0)
      expect(report.entitiesAffected).toBe(2)

      const runDelta = report.deltas.find((d) => d.entityId === 'run-100')
      expect(runDelta?.mutationKind).toBe('created')
      expect(runDelta?.diffProperties).toEqual(['status'])
      expect(runDelta?.beforeState?.status).toBe('pending')
      expect(runDelta?.afterState?.status).toBe('running')

      expect(report.compensatingEvents).toHaveLength(2)
      expect(report.compensatingEvents[0]?.inverseEventType).toBe('run.reverted')
      expect(report.compensatingEvents[0]?.payload.status).toBe('pending')
    })

    it('detects sequence gaps accurately (Axiom A1)', () => {
      const gappedEvents: LedgerEventInput[] = [
        { seq: 10, type: 'run.created', aggregateId: 'run-1' },
        { seq: 12, type: 'run.updated', aggregateId: 'run-1' }, // Missing 11
        { seq: 15, type: 'run.updated', aggregateId: 'run-1' }, // Missing 13, 14
      ]

      const report = computeJournalDiff(gappedEvents)

      expect(report.isContiguous).toBe(false)
      expect(report.sequenceGaps).toEqual([11, 13])
      expect(report.formattedSummary).toContain('GAPS DETECTED (2)')
    })

    it('handles empty events gracefully', () => {
      const report = computeJournalDiff([])
      expect(report.totalEventsAnalyzed).toBe(0)
      expect(report.isContiguous).toBe(true)
    })
  })

  describe('auditDatabaseJournalRange with SQLite', () => {
    it('queries events table and audits deltas', () => {
      const db = new Database(':memory:')
      db.exec(`
        CREATE TABLE events (
          seq INTEGER PRIMARY KEY,
          type TEXT NOT NULL,
          project_id TEXT,
          id TEXT,
          payload TEXT,
          occurred_at TEXT NOT NULL
        );
        INSERT INTO events (seq, type, project_id, id, payload, occurred_at)
        VALUES
          (1, 'artifact.created', 'art-1', 'id-1', '{"path": "a.txt", "size": 100}', '2026-11-21T00:00:00Z'),
          (2, 'artifact.updated', 'art-1', 'id-1', '{"path": "a.txt", "size": 250}', '2026-11-21T00:01:00Z');
      `)

      const report = auditDatabaseJournalRange(db, 1, 2)
      expect(report.totalEventsAnalyzed).toBe(2)
      expect(report.entitiesAffected).toBe(1)
      expect(report.deltas[0]?.diffProperties).toEqual(['size'])

      db.close()
    })
  })
})
