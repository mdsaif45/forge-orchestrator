/**
 * STATE-009: Event store time-travel snapshot replay and state projection engine.
 * Deterministically reconstructs in-memory run and step state at arbitrary historical sequences (Axioms A1, A4).
 */

import { type RawLedgerEvent } from './eventJournalExporter'

export interface StepProjection {
  readonly stepId: string
  readonly status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  readonly startedAt?: string | undefined
  readonly finishedAt?: string | undefined
  readonly exitCode?: number | undefined
  readonly error?: string | undefined
}

export interface RunStateProjection {
  readonly valid: boolean
  readonly runId: string
  readonly cutoffSeq: number
  readonly totalEventsInStream: number
  readonly appliedEventsCount: number
  readonly projectedStatus: 'created' | 'running' | 'completed' | 'failed' | 'cancelled'
  readonly activeStepId: string | null
  readonly steps: Record<string, StepProjection>
  readonly transitionCount: number
  readonly formattedSummary: string
  readonly error?: string | undefined
}

/**
 * Replays sequential event log up to an optional sequence cutoff point (Axiom A1).
 */
export function replayEventLedger(
  runId: string,
  rawEvents: readonly RawLedgerEvent[],
  toSeq?: number,
): RunStateProjection {
  const sorted = [...rawEvents].sort((a, b) => a.seq - b.seq)
  const cutoff = toSeq !== undefined && toSeq >= 1 ? toSeq : Infinity

  let projectedStatus: RunStateProjection['projectedStatus'] = 'created'
  let activeStepId: string | null = null
  const steps: Record<string, StepProjection> = {}
  let appliedCount = 0

  for (const ev of sorted) {
    if (ev.seq > cutoff) {
      break
    }

    appliedCount++
    const type = ev.type.toLowerCase()
    const payload =
      typeof ev.payload === 'object' && ev.payload !== null
        ? (ev.payload as Record<string, unknown>)
        : {}

    // Process run-level transitions
    if (type === 'run:start' || type === 'run:started' || type === 'run.started') {
      projectedStatus = 'running'
    } else if (
      type === 'run:complete' ||
      type === 'run:completed' ||
      type === 'run.completed' ||
      type === 'run:finished'
    ) {
      projectedStatus = 'completed'
      activeStepId = null
    } else if (type === 'run:fail' || type === 'run:failed' || type === 'run.failed') {
      projectedStatus = 'failed'
      activeStepId = null
    } else if (type === 'run:cancel' || type === 'run:cancelled' || type === 'run.cancelled') {
      projectedStatus = 'cancelled'
      activeStepId = null
    }

    // Process step-level transitions
    const stepId = ev.stepId ?? (typeof payload.stepId === 'string' ? payload.stepId : null)

    if (stepId) {
      const existing = steps[stepId] ?? {
        stepId,
        status: 'pending',
      }

      if (type.includes('step:start') || type.includes('step.started')) {
        activeStepId = stepId
        steps[stepId] = {
          ...existing,
          status: 'running',
          startedAt: ev.timestamp,
        }
      } else if (type.includes('step:complete') || type.includes('step.completed')) {
        if (activeStepId === stepId) activeStepId = null
        steps[stepId] = {
          ...existing,
          status: 'completed',
          finishedAt: ev.timestamp,
          exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : 0,
        }
      } else if (type.includes('step:fail') || type.includes('step.failed')) {
        if (activeStepId === stepId) activeStepId = null
        steps[stepId] = {
          ...existing,
          status: 'failed',
          finishedAt: ev.timestamp,
          exitCode: typeof payload.exitCode === 'number' ? payload.exitCode : 1,
          error: typeof payload.error === 'string' ? payload.error : 'Step failed',
        }
      }
    }
  }

  const stepCount = Object.keys(steps).length
  const effectiveCutoff = cutoff === Infinity ? (sorted.at(-1)?.seq ?? 0) : cutoff

  const lines = [
    `EVENT STORE TIME-TRAVEL REPLAY: Run ${runId}`,
    `  Sequence Cutoff: ${String(effectiveCutoff)} (${String(appliedCount)} / ${String(sorted.length)} events applied)`,
    `  Projected Status: ${projectedStatus.toUpperCase()}`,
    `  Active Step:     ${activeStepId ?? 'none'}`,
    `  Tracked Steps:   ${String(stepCount)} steps`,
  ]

  for (const s of Object.values(steps)) {
    lines.push(
      `    - Step ${s.stepId}: ${s.status.toUpperCase()}${s.exitCode !== undefined ? ` (exit: ${String(s.exitCode)})` : ''}`,
    )
  }

  return {
    valid: true,
    runId,
    cutoffSeq: effectiveCutoff,
    totalEventsInStream: sorted.length,
    appliedEventsCount: appliedCount,
    projectedStatus,
    activeStepId,
    steps,
    transitionCount: appliedCount,
    formattedSummary: lines.join('\n'),
  }
}
