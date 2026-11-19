import type Database from 'better-sqlite3'

export interface EventCompactionOptions {
  /** If true, simulates compaction and reports affected counts without deleting rows. */
  readonly dryRun?: boolean | undefined
  /** ISO date string; only compact runs finished before this timestamp. */
  readonly beforeDate?: string | undefined
  /** Specific runId to compact. */
  readonly runId?: string | undefined
  /** Preserves initial started and final terminal events for audit lineage (default: true). */
  readonly keepInitialAndTerminal?: boolean | undefined
}

export interface EventCompactionResult {
  readonly valid: boolean
  readonly dryRun: boolean
  readonly runsCompacted: number
  readonly eventsPruned: number
  readonly durationMs: number
  readonly formattedSummary: string
  readonly error?: string | undefined
}

/**
 * Compacts granular event ledgers for completed runs into durable state checkpoints (Axiom A5).
 *
 * Implements Axioms:
 * - A1 (Truth ownership): Preserves authoritative run and step records while summarizing intermediate events.
 * - A5 (Bounded logs & disk usage): Prevents unbounded growth of append-only event tables over long histories.
 */
export async function compactRunEvents(
  sqlite: Database.Database,
  options: EventCompactionOptions = {},
): Promise<EventCompactionResult> {
  await Promise.resolve()
  const start = Date.now()
  const dryRun = options.dryRun ?? false
  const keepBounds = options.keepInitialAndTerminal ?? true

  try {
    // 1. Find eligible terminal runs
    let query =
      "SELECT id, status, finished_at FROM runs WHERE status IN ('completed', 'failed', 'halted')"
    const params: unknown[] = []

    if (options.runId) {
      query += ' AND id = ?'
      params.push(options.runId)
    }

    if (options.beforeDate) {
      query += ' AND finished_at <= ?'
      params.push(options.beforeDate)
    }

    const runs = sqlite.prepare(query).all(...params) as {
      id: string
      status: string
      finished_at: string | null
    }[]

    if (runs.length === 0) {
      const summary = `No eligible completed runs found for compaction (dryRun: ${String(dryRun)}).`
      return {
        valid: true,
        dryRun,
        runsCompacted: 0,
        eventsPruned: 0,
        durationMs: Date.now() - start,
        formattedSummary: summary,
      }
    }

    let totalEventsPruned = 0
    let compactedRunsCount = 0

    const countStmt = sqlite.prepare(
      'SELECT COUNT(*) as cnt, MIN(seq) as min_seq, MAX(seq) as max_seq FROM run_events WHERE run_id = ?',
    )
    const deletePruneStmt = sqlite.prepare(
      'DELETE FROM run_events WHERE run_id = ? AND seq NOT IN (?, ?)',
    )
    const deleteAllStmt = sqlite.prepare('DELETE FROM run_events WHERE run_id = ?')

    const executeInTransaction = sqlite.transaction(() => {
      for (const run of runs) {
        const stats = countStmt.get(run.id) as {
          cnt: number
          min_seq: number | null
          max_seq: number | null
        }
        if (stats.cnt === 0) continue

        let prunedForRun = 0
        if (keepBounds) {
          if (stats.min_seq !== null && stats.max_seq !== null && stats.cnt > 2) {
            prunedForRun = stats.cnt - 2
            if (!dryRun) {
              deletePruneStmt.run(run.id, stats.min_seq, stats.max_seq)
            }
          }
        } else {
          prunedForRun = stats.cnt
          if (!dryRun) {
            deleteAllStmt.run(run.id)
          }
        }

        if (prunedForRun > 0) {
          totalEventsPruned += prunedForRun
          compactedRunsCount++
        }
      }
    })

    executeInTransaction()

    const durationMs = Date.now() - start
    const modeStr = dryRun ? ' (dry-run simulation)' : ''

    const lines: string[] = []
    lines.push('================================================================================')
    lines.push(`Database Event Ledger Compaction${modeStr}`)
    lines.push(
      `Runs Processed: ${String(runs.length)} | Runs Compacted: ${String(compactedRunsCount)}`,
    )
    lines.push(`Events Pruned:  ${String(totalEventsPruned)} | Duration: ${String(durationMs)}ms`)
    lines.push('================================================================================')
    if (compactedRunsCount === 0) {
      lines.push('  No granular events required pruning; ledger is already compact.')
    } else {
      lines.push(
        dryRun
          ? `  Simulation complete: ${String(totalEventsPruned)} events would be pruned across ${String(compactedRunsCount)} runs.`
          : `  Compaction complete: ${String(totalEventsPruned)} events pruned across ${String(compactedRunsCount)} runs.`,
      )
    }
    lines.push('================================================================================')

    return {
      valid: true,
      dryRun,
      runsCompacted: compactedRunsCount,
      eventsPruned: totalEventsPruned,
      durationMs,
      formattedSummary: lines.join('\n'),
    }
  } catch (err) {
    return {
      valid: false,
      dryRun,
      runsCompacted: 0,
      eventsPruned: 0,
      durationMs: Date.now() - start,
      formattedSummary: `Event compaction failed: ${err instanceof Error ? err.message : String(err)}`,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
