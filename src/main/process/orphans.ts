import { readFile, unlink, writeFile } from 'node:fs/promises'
import { z } from 'zod'

/**
 * Tracks spawned process ids across restarts, so a crash cannot leave agents running.
 *
 * `ProcessManager.killAll()` handles an orderly quit. This handles the case it cannot: the
 * app was killed, so no shutdown hook ran, and the children it spawned are still working
 * against the user's repository with nothing supervising them. On the next start those are
 * orphans, and the next workflow would diff a tree something else is still editing.
 *
 * ```
 * spawn ──> record pid ──> ... crash ...
 *                              │
 *                       next start: read the file
 *                              │
 *                    still alive? ──yes──> kill
 *                              └──no───> forget
 * ```
 *
 * The file is written on every spawn and rewritten on every exit, so it stays small — the
 * record is "what is running now", not a history.
 */

const trackedProcessSchema = z.strictObject({
  pid: z.number().int().positive(),
  command: z.string().min(1),
  startedAt: z.string().min(1),
})

export type TrackedProcess = z.infer<typeof trackedProcessSchema>

const trackedFileSchema = z.strictObject({
  /**
   * The Forge process that recorded these.
   *
   * Compared on startup so an instance never treats *its own* children as orphans, and
   * more importantly so a second Forge running concurrently is not mistaken for a crashed
   * one — killing another instance's agents would be worse than leaving an orphan.
   */
  ownerPid: z.number().int().positive(),
  processes: z.array(trackedProcessSchema).readonly(),
})

export interface OrphanReport {
  /** Recorded by a previous run and still alive. Killed. */
  readonly killed: readonly TrackedProcess[]
  /** Recorded but already gone. Forgotten. */
  readonly stale: readonly TrackedProcess[]
  /** Skipped because another live Forge owns them. */
  readonly foreign: readonly TrackedProcess[]
}

/**
 * Whether a pid is currently alive.
 *
 * `kill(pid, 0)` sends no signal and only tests reachability — the portable way to ask,
 * and it works on Windows too where `process.kill` maps onto the platform's own
 * termination.
 *
 * `EPERM` means the process exists but belongs to someone else, which counts as alive: the
 * dangerous answer here is a false "dead", since that would leave a real orphan running.
 */
export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export class OrphanTracker {
  private tracked: TrackedProcess[] = []

  constructor(
    private readonly file: string,
    private readonly ownerPid: number = process.pid,
  ) {}

  async record(entry: TrackedProcess): Promise<void> {
    this.tracked.push(entry)
    await this.flush()
  }

  async forget(pid: number): Promise<void> {
    this.tracked = this.tracked.filter((entry) => entry.pid !== pid)
    await this.flush()
  }

  /**
   * Kills anything a previous run left behind.
   *
   * Called once during startup, before any workflow resumes. A process that is gone is
   * simply forgotten; one owned by a *live* Forge is left alone, because that is a second
   * instance rather than wreckage.
   */
  async reap(): Promise<OrphanReport> {
    const previous = await this.read()

    if (previous === null) {
      return { killed: [], stale: [], foreign: [] }
    }

    // A live owner means another Forge is running, not that this one crashed.
    if (previous.ownerPid !== this.ownerPid && isAlive(previous.ownerPid)) {
      return { killed: [], stale: [], foreign: previous.processes }
    }

    const killed: TrackedProcess[] = []
    const stale: TrackedProcess[] = []

    for (const entry of previous.processes) {
      if (!isAlive(entry.pid)) {
        stale.push(entry)
        continue
      }

      try {
        // No pty to route through: the previous run's handle died with it, so this is the
        // one place a raw pid kill is the only option available.
        process.kill(entry.pid)
        killed.push(entry)
      } catch {
        // Exited between the check and the kill, which is the same as stale.
        stale.push(entry)
      }
    }

    this.tracked = []
    await this.flush()

    return { killed, stale, foreign: [] }
  }

  private async read(): Promise<z.infer<typeof trackedFileSchema> | null> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = trackedFileSchema.safeParse(JSON.parse(raw))
      // A corrupt file is discarded rather than fatal: it is a recovery aid, and refusing
      // to start because of it would turn a minor problem into an outage.
      return parsed.success ? parsed.data : null
    } catch {
      return null
    }
  }

  private async flush(): Promise<void> {
    if (this.tracked.length === 0) {
      await unlink(this.file).catch(() => undefined)
      return
    }

    await writeFile(
      this.file,
      JSON.stringify({ ownerPid: this.ownerPid, processes: this.tracked }, null, 2),
      'utf8',
    )
  }
}
