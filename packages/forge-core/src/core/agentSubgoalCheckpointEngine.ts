import { createHash, randomUUID } from 'node:crypto'

export interface SubgoalTaskItem {
  id: string
  title: string
  status: 'PENDING' | 'IN_PROGRESS' | 'COMPLETED' | 'FAILED'
  resultSummary?: string | undefined
}

export interface SubgoalCheckpointInput {
  runId: string
  subgoalId: string
  phase: string
  stepIndex: number
  tasks: SubgoalTaskItem[]
  workingMemorySnapshot?: Record<string, unknown> | undefined
  completedTurnsCount?: number | undefined
}

export interface SubgoalCheckpoint {
  checkpointId: string
  version: number
  timestamp: string
  timestampMs: number
  runId: string
  subgoalId: string
  phase: string
  stepIndex: number
  tasks: SubgoalTaskItem[]
  workingMemorySnapshot: Record<string, unknown>
  completedTurnsCount: number
  checksum: string
}

export interface SubgoalCheckpointPayload {
  payloadVersion: number
  data: Omit<SubgoalCheckpoint, 'checksum'>
  checksum: string
}

export interface WarmContextHydrationResult {
  resumedStepIndex: number
  activeSubtasks: SubgoalTaskItem[]
  completedCount: number
  pendingCount: number
  canResume: boolean
  promptContextNote: string
}

export class AgentSubgoalCheckpointEngine {
  private readonly version: number
  private readonly clock: () => number

  constructor(options: { version?: number; clock?: () => number } = {}) {
    this.version = options.version ?? 1
    this.clock = options.clock ?? (() => Date.now())
  }

  serialize(input: SubgoalCheckpointInput): SubgoalCheckpointPayload {
    if (!input.runId || typeof input.runId !== 'string') {
      throw new Error('runId is required for subgoal checkpoint serialization')
    }
    if (!input.subgoalId || typeof input.subgoalId !== 'string') {
      throw new Error('subgoalId is required for subgoal checkpoint serialization')
    }

    const now = this.clock()
    const checkpointId = `chk_${randomUUID().slice(0, 8)}`

    const data: Omit<SubgoalCheckpoint, 'checksum'> = {
      checkpointId,
      version: this.version,
      timestamp: new Date(now).toISOString(),
      timestampMs: now,
      runId: input.runId,
      subgoalId: input.subgoalId,
      phase: input.phase,
      stepIndex: Math.max(0, input.stepIndex),
      tasks: input.tasks.map((t) => ({ ...t })),
      workingMemorySnapshot: { ...(input.workingMemorySnapshot ?? {}) },
      completedTurnsCount: input.completedTurnsCount ?? 0,
    }

    const checksum = this.computeChecksum(data)

    return {
      payloadVersion: this.version,
      data,
      checksum,
    }
  }

  deserializeAndValidate(raw: string | SubgoalCheckpointPayload): SubgoalCheckpoint {
    let payload: unknown
    if (typeof raw === 'string') {
      try {
        payload = JSON.parse(raw)
      } catch {
        throw new Error('CHECKPOINT_CORRUPTED: Malformed JSON checkpoint payload')
      }
    } else {
      payload = raw
    }

    if (
      typeof payload !== 'object' ||
      payload === null ||
      !('data' in payload) ||
      !('checksum' in payload) ||
      typeof (payload as { checksum: unknown }).checksum !== 'string'
    ) {
      throw new Error('CHECKPOINT_INVALID: Checkpoint payload missing required data or checksum')
    }

    const validatedPayload = payload as SubgoalCheckpointPayload
    const expectedChecksum = this.computeChecksum(validatedPayload.data)
    if (expectedChecksum !== validatedPayload.checksum) {
      throw new Error(
        'CHECKPOINT_TAMPERED: Checksum mismatch. Checkpoint data may be corrupted or modified.',
      )
    }

    return {
      ...validatedPayload.data,
      checksum: validatedPayload.checksum,
    }
  }

  hydrateWarmContext(checkpoint: SubgoalCheckpoint): WarmContextHydrationResult {
    let completedCount = 0
    let pendingCount = 0
    const activeSubtasks: SubgoalTaskItem[] = []

    for (const task of checkpoint.tasks) {
      if (task.status === 'COMPLETED') {
        completedCount += 1
      } else {
        pendingCount += 1
        activeSubtasks.push(task)
      }
    }

    const note = [
      `[WARM SESSION RECOVERY] Resumed from checkpoint ${checkpoint.checkpointId} (Phase: ${checkpoint.phase}, Step: ${String(checkpoint.stepIndex)})`,
      `Progress: ${String(completedCount)} completed, ${String(pendingCount)} remaining out of ${String(checkpoint.tasks.length)} subtasks.`,
    ].join('\n')

    return {
      resumedStepIndex: checkpoint.stepIndex + 1,
      activeSubtasks,
      completedCount,
      pendingCount,
      canResume: pendingCount > 0,
      promptContextNote: note,
    }
  }

  formatSummary(checkpoint: SubgoalCheckpoint): string {
    return [
      `=== Subgoal Checkpoint ${checkpoint.checkpointId} ===`,
      `Run: ${checkpoint.runId} | Subgoal: ${checkpoint.subgoalId} | Phase: ${checkpoint.phase}`,
      `Step: ${String(checkpoint.stepIndex)} | Turns: ${String(checkpoint.completedTurnsCount)} | Checksum: ${checkpoint.checksum.slice(0, 12)}...`,
      `Tasks (${String(checkpoint.tasks.length)}): ${String(checkpoint.tasks.filter((t) => t.status === 'COMPLETED').length)} completed, ${String(checkpoint.tasks.filter((t) => t.status !== 'COMPLETED').length)} remaining`,
    ].join('\n')
  }

  private computeChecksum(data: unknown): string {
    const canonicalJson = JSON.stringify(data)
    return createHash('sha256').update(canonicalJson).digest('hex')
  }
}
