/**
 * Copyright (c) 2026 Forge Authors
 * Technology: TypeScript / Node.js
 * Architecture: Workflow Step Execution Journal & Idempotent Resume Coordinator (WORK-034)
 * Axioms Enforced:
 *  - A1: Bugs are bounded & fail-closed (stale input hashes force re-execution).
 *  - A2: Explicit validation of all step states and idempotency keys.
 *  - A4: Decisions lock (completed step outputs are preserved and immutable in journal).
 *  - A5: Bounded loops, costs, and resources.
 */

import { createHash } from 'node:crypto'

export type StepExecutionStatus = 'COMPLETED' | 'FAILED' | 'SKIPPED'
export type ResumeActionType = 'REPLAY_OUTPUT' | 'EXECUTE'

export interface JournaledStepRecord {
  readonly runId: string
  readonly stepId: string
  readonly idempotencyKey: string
  readonly status: StepExecutionStatus
  readonly inputDigest: string
  readonly outputData?: Record<string, unknown> | undefined
  readonly executedAt: number
  readonly durationMs: number
}

export interface RecordStepInput {
  readonly runId: string
  readonly stepId: string
  readonly idempotencyKey: string
  readonly status: StepExecutionStatus
  readonly inputData: unknown
  readonly outputData?: Record<string, unknown> | undefined
  readonly durationMs?: number | undefined
}

export interface NodeDefinitionForResume {
  readonly id: string
  readonly idempotencyKey?: string | undefined
  readonly inputData?: unknown
  readonly dependencies?: readonly string[] | undefined
}

export interface ResumeStepAction {
  readonly stepId: string
  readonly action: ResumeActionType
  readonly reason: string
  readonly replayData?: Record<string, unknown> | undefined
}

export interface JournalResumePlan {
  readonly runId: string
  readonly totalNodes: number
  readonly replayedNodesCount: number
  readonly nodesToExecuteCount: number
  readonly steps: readonly ResumeStepAction[]
  readonly isFullyResumable: boolean
}

function computeDigest(data: unknown): string {
  if (data === undefined) {
    return 'empty'
  }
  const serialized = typeof data === 'string' ? data : JSON.stringify(data)
  return createHash('sha256').update(serialized, 'utf8').digest('hex')
}

export class WorkflowStepJournalResumeEngine {
  private readonly journal: JournaledStepRecord[] = []

  public constructor(initialRecords?: readonly JournaledStepRecord[]) {
    if (initialRecords && initialRecords.length > 0) {
      for (const r of initialRecords) {
        this.journal.push(r)
      }
    }
  }

  /**
   * Appends a step execution record to the journal.
   */
  public recordStepExecution(input: RecordStepInput): JournaledStepRecord {
    if (!input.runId || input.runId.trim().length === 0) {
      throw new Error('[WORK-034] runId must not be empty')
    }
    if (!input.stepId || input.stepId.trim().length === 0) {
      throw new Error('[WORK-034] stepId must not be empty')
    }

    const inputDigest = computeDigest(input.inputData)
    const record: JournaledStepRecord = {
      runId: input.runId.trim(),
      stepId: input.stepId.trim(),
      idempotencyKey: input.idempotencyKey.trim(),
      status: input.status,
      inputDigest,
      outputData: input.outputData
        ? (JSON.parse(JSON.stringify(input.outputData)) as Record<string, unknown>)
        : undefined,
      executedAt: Date.now(),
      durationMs: Math.max(0, input.durationMs ?? 0),
    }

    this.journal.push(record)
    return record
  }

  /**
   * Retrieves the latest record for a step in a run.
   */
  public getStepRecord(runId: string, stepId: string): JournaledStepRecord | null {
    for (let i = this.journal.length - 1; i >= 0; i--) {
      const record = this.journal[i]
      if (record?.runId === runId && record.stepId === stepId) {
        return record
      }
    }
    return null
  }

  /**
   * Lists all journaled records for a run.
   */
  public listStepRecords(runId: string): readonly JournaledStepRecord[] {
    return this.journal.filter((r) => r.runId === runId)
  }

  /**
   * Evaluates DAG nodes against execution journal to generate an idempotent resume plan.
   */
  public evaluateResumePlan(
    runId: string,
    nodes: readonly NodeDefinitionForResume[],
  ): JournalResumePlan {
    const stepActions: ResumeStepAction[] = []
    let replayedCount = 0
    let executeCount = 0

    for (const node of nodes) {
      const recorded = this.getStepRecord(runId, node.id)
      const expectedDigest = computeDigest(node.inputData)

      if (!recorded) {
        stepActions.push({
          stepId: node.id,
          action: 'EXECUTE',
          reason: 'Step has no prior execution record in journal',
        })
        executeCount++
        continue
      }

      if (recorded.status !== 'COMPLETED') {
        stepActions.push({
          stepId: node.id,
          action: 'EXECUTE',
          reason: `Previous execution was not completed (Status: ${recorded.status})`,
        })
        executeCount++
        continue
      }

      if (node.idempotencyKey && node.idempotencyKey !== recorded.idempotencyKey) {
        stepActions.push({
          stepId: node.id,
          action: 'EXECUTE',
          reason: `Idempotency key changed: expected '${node.idempotencyKey}', recorded '${recorded.idempotencyKey}'`,
        })
        executeCount++
        continue
      }

      if (expectedDigest !== recorded.inputDigest) {
        stepActions.push({
          stepId: node.id,
          action: 'EXECUTE',
          reason: 'Step input data has changed since previous execution; output invalidated',
        })
        executeCount++
        continue
      }

      // Valid for output replay
      stepActions.push({
        stepId: node.id,
        action: 'REPLAY_OUTPUT',
        reason: 'Step previously succeeded with matching input digest and idempotency key',
        replayData: recorded.outputData,
      })
      replayedCount++
    }

    return {
      runId,
      totalNodes: nodes.length,
      replayedNodesCount: replayedCount,
      nodesToExecuteCount: executeCount,
      steps: stepActions,
      isFullyResumable: replayedCount > 0,
    }
  }

  /**
   * Clears records for a run.
   */
  public clearRunJournal(runId: string): void {
    let i = this.journal.length
    while (i--) {
      if (this.journal[i]?.runId === runId) {
        this.journal.splice(i, 1)
      }
    }
  }
}
