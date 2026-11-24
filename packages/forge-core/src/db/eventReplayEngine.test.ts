import { describe, expect, it } from 'vitest'
import { replayEventLedger } from './eventReplayEngine'
import { type RawLedgerEvent } from './eventJournalExporter'

describe('eventReplayEngine (STATE-009)', () => {
  const events: RawLedgerEvent[] = [
    {
      id: 'e1',
      runId: 'run-100',
      seq: 1,
      type: 'run:started',
      timestamp: '2026-11-19T03:00:00.000Z',
    },
    {
      id: 'e2',
      runId: 'run-100',
      seq: 2,
      type: 'step:start',
      stepId: 'step-1',
      timestamp: '2026-11-19T03:00:01.000Z',
    },
    {
      id: 'e3',
      runId: 'run-100',
      seq: 3,
      type: 'step:complete',
      stepId: 'step-1',
      payload: { exitCode: 0 },
      timestamp: '2026-11-19T03:00:02.000Z',
    },
    {
      id: 'e4',
      runId: 'run-100',
      seq: 4,
      type: 'step:start',
      stepId: 'step-2',
      timestamp: '2026-11-19T03:00:03.000Z',
    },
    {
      id: 'e5',
      runId: 'run-100',
      seq: 5,
      type: 'step:complete',
      stepId: 'step-2',
      payload: { exitCode: 0 },
      timestamp: '2026-11-19T03:00:04.000Z',
    },
    {
      id: 'e6',
      runId: 'run-100',
      seq: 6,
      type: 'run:completed',
      timestamp: '2026-11-19T03:00:05.000Z',
    },
  ]

  it('reconstructs final terminal state when replaying entire ledger', () => {
    const projection = replayEventLedger('run-100', events)

    expect(projection.valid).toBe(true)
    expect(projection.projectedStatus).toBe('completed')
    expect(projection.appliedEventsCount).toBe(6)
    expect(projection.activeStepId).toBeNull()
    expect(projection.steps['step-1']?.status).toBe('completed')
    expect(projection.steps['step-2']?.status).toBe('completed')
  })

  it('reconstructs historical time-travel state mid-run at sequence cutoff (A1, A4)', () => {
    // At sequence 4, step-2 was just started, run was running
    const projection = replayEventLedger('run-100', events, 4)

    expect(projection.valid).toBe(true)
    expect(projection.cutoffSeq).toBe(4)
    expect(projection.appliedEventsCount).toBe(4)
    expect(projection.projectedStatus).toBe('running')
    expect(projection.activeStepId).toBe('step-2')
    expect(projection.steps['step-1']?.status).toBe('completed')
    expect(projection.steps['step-2']?.status).toBe('running')
  })

  it('handles step failures and run failure status', () => {
    const failingEvents: RawLedgerEvent[] = [
      {
        id: 'e1',
        runId: 'run-200',
        seq: 1,
        type: 'run:started',
        timestamp: '2026-11-19T03:00:00.000Z',
      },
      {
        id: 'e2',
        runId: 'run-200',
        seq: 2,
        type: 'step:start',
        stepId: 'step-err',
        timestamp: '2026-11-19T03:00:01.000Z',
      },
      {
        id: 'e3',
        runId: 'run-200',
        seq: 3,
        type: 'step:fail',
        stepId: 'step-err',
        payload: { error: 'Disk full', exitCode: 2 },
        timestamp: '2026-11-19T03:00:02.000Z',
      },
      {
        id: 'e4',
        runId: 'run-200',
        seq: 4,
        type: 'run:failed',
        timestamp: '2026-11-19T03:00:03.000Z',
      },
    ]

    const projection = replayEventLedger('run-200', failingEvents)
    expect(projection.projectedStatus).toBe('failed')
    expect(projection.steps['step-err']?.status).toBe('failed')
    expect(projection.steps['step-err']?.error).toBe('Disk full')
    expect(projection.steps['step-err']?.exitCode).toBe(2)
  })

  it('returns valid created state on empty event stream', () => {
    const projection = replayEventLedger('run-empty', [])
    expect(projection.valid).toBe(true)
    expect(projection.projectedStatus).toBe('created')
    expect(projection.appliedEventsCount).toBe(0)
    expect(Object.keys(projection.steps).length).toBe(0)
  })
})
