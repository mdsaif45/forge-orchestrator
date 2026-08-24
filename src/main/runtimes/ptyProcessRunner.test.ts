import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../test/tempDir'
import { ProcessManager } from '../process/processManager'
import { createPtyProcessRunner } from './ptyProcessRunner'

/**
 * The runner against real processes, not a mock.
 *
 * Every adapter test so far has injected a fake runner, which proves the adapter's
 * logic and nothing about whether a CLI can actually be driven. This is the layer
 * where that stops being an assumption, so it spawns genuine children.
 */

let workDir: string
let manager: ProcessManager

/** Node is guaranteed present, so it stands in for any CLI. */
function nodeScript(source: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ['-e', source] }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'forge-pty-runner-'))
  manager = new ProcessManager()
})

afterEach(async () => {
  await manager.killAll('test teardown')
  await removeTempDir(workDir)
})

describe('createPtyProcessRunner', () => {
  it('runs a real process and reports its output and exit code', async () => {
    const runner = createPtyProcessRunner({ processes: manager })
    const script = nodeScript('process.stdout.write("hello from the child")')

    const result = await runner(script.command, script.args, { cwd: workDir })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello from the child')
  })

  it('streams output as it arrives, not only at the end', async () => {
    const runner = createPtyProcessRunner({ processes: manager })
    const script = nodeScript('process.stdout.write("streamed")')

    const chunks: string[] = []
    await runner(script.command, script.args, {
      cwd: workDir,
      onStdout: (chunk) => chunks.push(chunk),
    })

    // The adapter turns these into `chunk` events, which is what a live log renders.
    expect(chunks.join('')).toContain('streamed')
  })

  it('passes the account environment to the child', async () => {
    // The whole point of the account work: a spawned CLI must read the credential of
    // the account it was bound to, which it finds through this environment (#111).
    const runner = createPtyProcessRunner({ processes: manager })
    const script = nodeScript('process.stdout.write(String(process.env.FORGE_TEST_HOME))')

    const result = await runner(script.command, script.args, {
      cwd: workDir,
      env: { FORGE_TEST_HOME: 'D:/forge/accounts/acct-1/home' },
    })

    expect(result.stdout).toContain('D:/forge/accounts/acct-1/home')
  })

  it('reports a non-zero exit as non-zero', async () => {
    const runner = createPtyProcessRunner({ processes: manager })
    const script = nodeScript('process.exit(3)')

    const result = await runner(script.command, script.args, { cwd: workDir })

    expect(result.exitCode).toBe(3)
  })

  it('does not report a killed run as a success', async () => {
    // A killed pty reports its status inconsistently across platforms: null on
    // Windows, and 0 on Linux — which CI caught. Either one read as success would let
    // a hang look like a clean turn, an unverified claim of exactly the kind A3
    // exists to prevent. The run's reason decides, not the number.
    const runner = createPtyProcessRunner({ processes: manager, hardTimeoutMs: 300 })
    const script = nodeScript('setInterval(() => {}, 1000)')

    const result = await runner(script.command, script.args, { cwd: workDir })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).not.toBe('')
  })

  it('kills the child when the caller aborts', async () => {
    // Cancellation has to reach the process. Resolving while it keeps running would
    // leak an agent that still holds the worktree.
    const runner = createPtyProcessRunner({ processes: manager })
    const script = nodeScript('setInterval(() => {}, 1000)')
    const controller = new AbortController()

    const running = runner(script.command, script.args, {
      cwd: workDir,
      signal: controller.signal,
    })

    controller.abort()
    const result = await running

    expect(result.exitCode).not.toBe(0)
  })
})

describe('a killed run never reads as success', () => {
  /**
   * Exercises the platform difference directly, rather than relying on whichever
   * behaviour this machine happens to have.
   *
   * The real failure came from Linux CI, where a killed pty reported `exitCode: 0`
   * while Windows reported null. A test that only spawns a real process proves one
   * platform and silently skips the other, which is how this reached CI at all.
   */
  function outcomeWith(reason: string, exitCode: number | null) {
    return {
      runId: 'run-1',
      reason,
      exitCode,
      signal: null,
      durationMs: 1,
      output: 'partial work',
      truncated: false,
      failure: null,
    }
  }

  function managerReporting(outcome: ReturnType<typeof outcomeWith>): ProcessManager {
    return {
      spawn: () =>
        Promise.resolve({
          runId: 'run-1',
          onData: () => () => undefined,
          completed: Promise.resolve(outcome),
          write: () => undefined,
          cancel: () => Promise.resolve(),
        }),
    } as unknown as ProcessManager
  }

  it.each([
    ['hard-timeout', 0, 'linux reports 0 for a killed pty'],
    ['hard-timeout', null, 'windows reports null'],
    ['idle-timeout', 0, 'a hang detected by silence'],
    ['cancelled', 0, 'a user cancellation'],
    ['spawn-failed', 0, 'the process never started'],
  ])('%s with exitCode %s is a failure (%s)', async (reason, exitCode) => {
    const runner = createPtyProcessRunner({
      processes: managerReporting(outcomeWith(reason, exitCode)),
    })

    const result = await runner('irrelevant', [], { cwd: workDir })

    expect(result.exitCode).not.toBe(0)
  })

  it('leaves a genuine clean exit alone', async () => {
    // The other half: a process that really did exit 0 must not be turned into a
    // failure by this rule.
    const runner = createPtyProcessRunner({ processes: managerReporting(outcomeWith('exited', 0)) })

    const result = await runner('irrelevant', [], { cwd: workDir })

    expect(result.exitCode).toBe(0)
  })
})
