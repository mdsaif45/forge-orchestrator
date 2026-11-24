/**
 * SQLite Write-Ahead Log (WAL) frame index checkpoint and truncation monitor.
 *
 * Tracks WAL frame page indexes, uncheckpointed frame accumulation, and long-running
 * reader locks causing truncation starvation, emitting prioritized checkpoint mode
 * advisories (PASSIVE, FULL, RESTART, TRUNCATE) (A1, A4).
 */

export type WalCheckpointMode = 'PASSIVE' | 'FULL' | 'RESTART' | 'TRUNCATE'
export type WalUrgency = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL'

export interface WalReaderLock {
  readonly readerId: string
  readonly startFrame: number
  readonly acquiredAt: number
  readonly durationMs: number
  readonly isStarvingCheckpoint: boolean
}

export interface WalFrameStats {
  readonly totalFrames: number
  readonly checkpointedFrames: number
  readonly uncheckpointedFrames: number
  readonly framePageSizeBytes: number
  readonly walSizeBytes: number
  readonly activeReadersCount: number
}

export interface WalTruncationAdvisory {
  readonly isTruncationFeasible: boolean
  readonly recommendedMode: WalCheckpointMode
  readonly urgency: WalUrgency
  readonly starvingReaders: readonly WalReaderLock[]
  readonly uncheckpointedFrames: number
  readonly walSizeBytes: number
  readonly reason: string
}

export interface WalMonitorConfig {
  /** Duration in ms after which an active reader is considered starving checkpoints. Defaults to 10000ms. */
  readonly starvationThresholdMs?: number | undefined
  /** Maximum uncheckpointed frame threshold before elevating urgency. Defaults to 1000. */
  readonly maxUncheckpointedFramesThreshold?: number | undefined
  /** Standard SQLite page frame size in bytes. Defaults to 4096. */
  readonly framePageSizeBytes?: number | undefined
}

export class SqliteWalFrameTruncationMonitor {
  private readonly starvationThresholdMs: number
  private readonly maxUncheckpointedFramesThreshold: number
  private readonly framePageSizeBytes: number

  private totalFrames = 0
  private checkpointedFrames = 0
  private readonly activeReaders = new Map<string, { startFrame: number; acquiredAt: number }>()

  constructor(config: WalMonitorConfig = {}) {
    this.starvationThresholdMs = Math.max(10, config.starvationThresholdMs ?? 10_000)
    this.maxUncheckpointedFramesThreshold = Math.max(
      10,
      config.maxUncheckpointedFramesThreshold ?? 1000,
    )
    this.framePageSizeBytes = Math.max(512, config.framePageSizeBytes ?? 4096)
  }

  /**
   * Registers or updates an active reader transaction with its starting WAL frame index.
   */
  registerReaderLock(
    readerId: string,
    startFrame: number,
    acquiredAt: number = Date.now(),
  ): WalReaderLock {
    if (!readerId || readerId.trim().length === 0) {
      throw new Error('readerId cannot be empty')
    }
    const safeFrame = Math.max(0, startFrame)
    this.activeReaders.set(readerId, { startFrame: safeFrame, acquiredAt })

    const now = Date.now()
    const durationMs = now - acquiredAt
    const isStarvingCheckpoint = durationMs > this.starvationThresholdMs

    return {
      readerId,
      startFrame: safeFrame,
      acquiredAt,
      durationMs,
      isStarvingCheckpoint,
    }
  }

  /**
   * Releases an active reader transaction.
   */
  releaseReaderLock(readerId: string): boolean {
    return this.activeReaders.delete(readerId)
  }

  /**
   * Updates current WAL frame progress from sqlite3_wal_checkpoint metrics.
   */
  updateFrameStats(totalFrames: number, checkpointedFrames: number): WalFrameStats {
    this.totalFrames = Math.max(0, totalFrames)
    this.checkpointedFrames = Math.min(this.totalFrames, Math.max(0, checkpointedFrames))

    const uncheckpointedFrames = this.totalFrames - this.checkpointedFrames
    const walSizeBytes = this.totalFrames * this.framePageSizeBytes

    return {
      totalFrames: this.totalFrames,
      checkpointedFrames: this.checkpointedFrames,
      uncheckpointedFrames,
      framePageSizeBytes: this.framePageSizeBytes,
      walSizeBytes,
      activeReadersCount: this.activeReaders.size,
    }
  }

  /**
   * Evaluates active reader locks and WAL frame progress to recommend a checkpoint mode.
   */
  evaluateAdvisory(now: number = Date.now()): WalTruncationAdvisory {
    const uncheckpointed = this.totalFrames - this.checkpointedFrames
    const walSizeBytes = this.totalFrames * this.framePageSizeBytes

    const starvingReaders: WalReaderLock[] = []
    for (const [readerId, data] of this.activeReaders.entries()) {
      const durationMs = now - data.acquiredAt
      const isStarving = durationMs > this.starvationThresholdMs
      if (isStarving) {
        starvingReaders.push({
          readerId,
          startFrame: data.startFrame,
          acquiredAt: data.acquiredAt,
          durationMs,
          isStarvingCheckpoint: true,
        })
      }
    }

    // Case 1: Starving readers blocking checkpoint progress
    if (starvingReaders.length > 0) {
      const urgency: WalUrgency =
        uncheckpointed > this.maxUncheckpointedFramesThreshold ? 'CRITICAL' : 'HIGH'
      return {
        isTruncationFeasible: false,
        recommendedMode: 'RESTART',
        urgency,
        starvingReaders,
        uncheckpointedFrames: uncheckpointed,
        walSizeBytes,
        reason: `${String(starvingReaders.length)} reader(s) exceed starvation threshold (${String(this.starvationThresholdMs)}ms). Recommend RESTART checkpoint.`,
      }
    }

    // Case 2: Active non-starving readers present
    if (this.activeReaders.size > 0) {
      return {
        isTruncationFeasible: false,
        recommendedMode: 'PASSIVE',
        urgency: 'LOW',
        starvingReaders: [],
        uncheckpointedFrames: uncheckpointed,
        walSizeBytes,
        reason: `${String(this.activeReaders.size)} active reader(s) in progress. Recommend PASSIVE non-blocking checkpoint.`,
      }
    }

    // Case 3: No active readers, all frames checkpointed -> TRUNCATE feasible
    if (uncheckpointed === 0) {
      return {
        isTruncationFeasible: true,
        recommendedMode: 'TRUNCATE',
        urgency: 'LOW',
        starvingReaders: [],
        uncheckpointedFrames: 0,
        walSizeBytes,
        reason: 'Zero active readers and all frames checkpointed. TRUNCATE checkpoint is feasible.',
      }
    }

    // Case 4: No active readers, but uncheckpointed frames remain
    const isOverThreshold = uncheckpointed > this.maxUncheckpointedFramesThreshold
    return {
      isTruncationFeasible: false,
      recommendedMode: 'FULL',
      urgency: isOverThreshold ? 'HIGH' : 'MEDIUM',
      starvingReaders: [],
      uncheckpointedFrames: uncheckpointed,
      walSizeBytes,
      reason: `Zero active readers with ${String(uncheckpointed)} uncheckpointed frame(s). Recommend FULL checkpoint.`,
    }
  }

  /**
   * Retrieves all currently tracked reader locks.
   */
  getReaderLocks(now: number = Date.now()): readonly WalReaderLock[] {
    const locks: WalReaderLock[] = []
    for (const [readerId, data] of this.activeReaders.entries()) {
      const durationMs = now - data.acquiredAt
      locks.push({
        readerId,
        startFrame: data.startFrame,
        acquiredAt: data.acquiredAt,
        durationMs,
        isStarvingCheckpoint: durationMs > this.starvationThresholdMs,
      })
    }
    return locks
  }

  /**
   * Clears all state.
   */
  clear(): void {
    this.totalFrames = 0
    this.checkpointedFrames = 0
    this.activeReaders.clear()
  }
}
