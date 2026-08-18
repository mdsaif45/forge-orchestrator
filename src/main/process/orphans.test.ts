import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { isAlive, OrphanTracker } from './orphans'
import { ProcessManager } from './processManager'

/**
 * Orphan detection.
 *
 * `killAll()` covers an orderly quit. This covers the case it cannot: the app was killed,
 * so no shutdown hook ran, and its children are still working against the user's
 * repository. Real processes throughout — whether a pid is alive is an operating system
 * fact, and a mock would only assert the mock was called.
 */

let workDir: string
let trackerFile: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'forge-orphan-'))
  trackerFile = join(workDir, 'processes.json')
})

afterEach(async () => {
  // Windows holds a lock on a killed process's working directory until it has fully exited,
  // so an immediate delete fails with EBUSY. Polled rather than slept: the wait is bounded so
  // a directory that genuinely cannot be removed still fails the test, while a normal run
  // clears on the first or second attempt. This surfaced as an intermittent failure in the
  // test that kills a live process, which is exactly the one that leaves a lock behind.
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      rmSync(workDir, { recursive: true, force: true })
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 40))
    }
  }

  rmSync(workDir, { recursive: true, force: true })
})

describe('isAlive', () => {
  it('reports this process as alive', () => {
    expect(isAlive(process.pid)).toBe(true)
  })

  it('reports an unused pid as dead', () => {
    // A pid far above any plausible live process. Not guaranteed free in principle, but a
    // false positive here would only make the test lenient, not wrong.
    expect(isAlive(2 ** 30)).toBe(false)
  })
})

describe('recording', () => {
  it('writes what is running and removes it when it stops', async () => {
    const tracker = new OrphanTracker(trackerFile)

    await tracker.record({ pid: 4242, command: 'agent --run', startedAt: '2026-08-19T10:00:00Z' })
    expect(JSON.parse(readFileSync(trackerFile, 'utf8'))).toMatchObject({
      ownerPid: process.pid,
      processes: [{ pid: 4242, command: 'agent --run' }],
    })

    await tracker.forget(4242)
    // The file is removed rather than left holding an empty array: it records what is
    // running now, not a history.
    expect(existsSync(trackerFile)).toBe(false)
  })
})

describe('reaping a previous run', () => {
  it('kills a recorded process that is still alive', async () => {
    // The scenario: a previous Forge spawned an agent and then died without killing it.
    // Spawned with its own tracker so the pid comes from the same mechanism production
    // uses, rather than from a back door added for the test.
    const previousRun = join(workDir, 'previous-run.json')
    const manager = new ProcessManager({ orphans: new OrphanTracker(previousRun) })

    const handle = await manager.spawn({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("up"); setTimeout(() => {}, 120000)'],
      cwd: workDir,
    })

    await new Promise<void>((resolve) => {
      const off = handle.onData((text) => {
        if (text.includes('up')) {
          off()
          resolve()
        }
      })
    })

    for (let attempt = 0; attempt < 100 && !existsSync(previousRun); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    const recorded = JSON.parse(readFileSync(previousRun, 'utf8')) as {
      processes: { pid: number; command: string; startedAt: string }[]
    }
    const orphanPid = recorded.processes[0]?.pid ?? 0
    expect(isAlive(orphanPid)).toBe(true)

    // Rewritten with a dead owner, which is what a crashed run leaves behind.
    writeFileSync(trackerFile, JSON.stringify({ ownerPid: 2 ** 30, processes: recorded.processes }))

    const report = await new OrphanTracker(trackerFile).reap()

    expect(report.killed).toHaveLength(1)
    // Polled rather than assumed synchronous.
    for (let attempt = 0; attempt < 150 && isAlive(orphanPid); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    expect(isAlive(orphanPid)).toBe(false)
  })

  it('forgets a recorded process that is already gone', async () => {
    writeFileSync(
      trackerFile,
      JSON.stringify({
        ownerPid: 2 ** 30,
        processes: [{ pid: 2 ** 30 - 1, command: 'agent', startedAt: '2026-08-19T10:00:00Z' }],
      }),
    )

    const report = await new OrphanTracker(trackerFile).reap()

    expect(report.stale).toHaveLength(1)
    expect(report.killed).toEqual([])
  })

  it('leaves another live Forge instance alone', async () => {
    // The dangerous case. A record whose owner is still running means a *second* Forge, not
    // wreckage — killing its agents would be worse than leaving an orphan.
    writeFileSync(
      trackerFile,
      JSON.stringify({
        ownerPid: process.pid,
        processes: [{ pid: process.pid, command: 'agent', startedAt: '2026-08-19T10:00:00Z' }],
      }),
    )

    // A different owner pid, so this tracker is not the file's owner.
    const report = await new OrphanTracker(trackerFile, process.pid + 1).reap()

    expect(report.foreign).toHaveLength(1)
    expect(report.killed).toEqual([])
    expect(isAlive(process.pid)).toBe(true)
  })

  it('reports nothing when there is no record', async () => {
    const report = await new OrphanTracker(trackerFile).reap()

    expect(report).toEqual({ killed: [], stale: [], foreign: [] })
  })

  it('discards a corrupt record rather than failing to start', async () => {
    // It is a recovery aid; refusing to start because of it would turn a minor problem
    // into an outage.
    writeFileSync(trackerFile, 'this is not json')

    await expect(new OrphanTracker(trackerFile).reap()).resolves.toEqual({
      killed: [],
      stale: [],
      foreign: [],
    })
  })

  it('clears the record after reaping, so the next start finds nothing', async () => {
    writeFileSync(
      trackerFile,
      JSON.stringify({
        ownerPid: 2 ** 30,
        processes: [{ pid: 2 ** 30 - 1, command: 'agent', startedAt: '2026-08-19T10:00:00Z' }],
      }),
    )

    const tracker = new OrphanTracker(trackerFile)
    await tracker.reap()

    expect(existsSync(trackerFile)).toBe(false)
    await expect(tracker.reap()).resolves.toEqual({ killed: [], stale: [], foreign: [] })
  })
})

describe('integration with the process manager', () => {
  it('records a spawned process and forgets it on exit', async () => {
    const tracker = new OrphanTracker(trackerFile)
    const manager = new ProcessManager({ orphans: tracker })

    const handle = await manager.spawn({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("done")'],
      cwd: workDir,
    })

    await handle.completed

    // Poll: the tracker writes asynchronously and deliberately does not block the run.
    for (let attempt = 0; attempt < 100 && existsSync(trackerFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    expect(existsSync(trackerFile)).toBe(false)
    await manager.killAll('test teardown')
  })

  it('has a record on disk while a process is running', async () => {
    const tracker = new OrphanTracker(trackerFile)
    const manager = new ProcessManager({ orphans: tracker })

    const handle = await manager.spawn({
      command: process.execPath,
      args: ['-e', 'process.stdout.write("up"); setTimeout(() => {}, 60000)'],
      cwd: workDir,
    })

    // Wait for the process to prove it is alive rather than sleeping a guessed amount.
    await new Promise<void>((resolve) => {
      const off = handle.onData((text) => {
        if (text.includes('up')) {
          off()
          resolve()
        }
      })
    })

    for (let attempt = 0; attempt < 100 && !existsSync(trackerFile); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    // This is the file a crashed run would leave behind, which is the whole mechanism.
    expect(existsSync(trackerFile)).toBe(true)
    const record = JSON.parse(readFileSync(trackerFile, 'utf8')) as { processes: unknown[] }
    expect(record.processes).toHaveLength(1)

    await manager.killAll('test teardown')
  })
})
