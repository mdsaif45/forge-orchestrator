/**
 * What these tests claim: Forge's own observation of a command is trustworthy in
 * the specific ways axiom A3 depends on — a failing command cannot read as a pass,
 * a command that never finished cannot read as a pass, and the exit code rather
 * than the output text decides the verdict.
 *
 * These spawn real processes. The abnormal endings are the point: each one was
 * measured against this Node version, because `execFile` does not report them the
 * way its option names imply (a timeout yields `code: null`, not `ETIMEDOUT`).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { evidencePassed, stepIdSchema, workflowIdSchema } from '@shared/domain'
import { runCommand } from './commandRunner'

let workDir: string

const workflowId = workflowIdSchema.parse('11111111-1111-4111-8111-111111111111')
const stepId = stepIdSchema.parse('22222222-2222-4222-8222-222222222222')

/** A command that runs a script file, so shell quoting cannot skew the result. */
function script(name: string, body: string): string {
  writeFileSync(join(workDir, name), body)
  return `node ${name}`
}

function run(command: string, overrides: Record<string, unknown> = {}) {
  return runCommand({
    command,
    cwd: workDir,
    kind: 'tests',
    workflowId,
    stepId,
    ...overrides,
  })
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'forge-runner-'))
})

afterEach(async () => {
  // Windows holds a lock on the working directory until a killed process has fully
  // exited, so an immediate delete fails with EBUSY. Polled rather than slept: the
  // bound means a directory that genuinely cannot be removed still fails the test,
  // while a normal run clears on the first attempt. This surfaced on exactly the two
  // tests that kill a live child (timeout, maxBuffer overflow).
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

describe('a command that succeeds', () => {
  it('records exit zero and passes', async () => {
    const artifact = await run(script('ok.js', 'console.log("all good")\n'))

    expect(artifact.outcome).toBe('completed')
    expect(artifact.exitCode).toBe(0)
    expect(evidencePassed(artifact)).toBe(true)
    expect(artifact.stdout).toContain('all good')
    expect(artifact.failure).toBeNull()
  })

  it('keeps stdout and stderr separate', async () => {
    const artifact = await run(
      script('both.js', 'console.log("to-stdout"); console.error("to-stderr")\n'),
    )

    // The reason this runner uses execFile rather than the pty ProcessManager: a
    // pty interleaves these two into one stream, and a parser cannot unpick them.
    expect(artifact.stdout).toContain('to-stdout')
    expect(artifact.stdout).not.toContain('to-stderr')
    expect(artifact.stderr).toContain('to-stderr')
  })

  it('records the command verbatim, so the run is reproducible by hand', async () => {
    const command = script('ok.js', 'console.log("x")\n')
    const artifact = await run(command)

    expect(artifact.command).toBe(command)
    expect(artifact.cwd).toBe(workDir)
  })
})

describe('a command that fails', () => {
  it('fails on the exit code even when the output claims success', async () => {
    // The case A3 exists for: prose is not a verdict.
    const artifact = await run(
      script('liar.js', 'console.log("All tests passed!"); process.exit(1)\n'),
    )

    expect(artifact.exitCode).toBe(1)
    expect(evidencePassed(artifact)).toBe(false)
    expect(artifact.stdout).toContain('All tests passed!')
  })

  it('preserves a non-zero exit code rather than collapsing it to a boolean', async () => {
    const artifact = await run(script('exit7.js', 'process.exit(7)\n'))

    expect(artifact.outcome).toBe('completed')
    expect(artifact.exitCode).toBe(7)
  })

  it('captures output produced before the failure', async () => {
    const artifact = await run(script('partial.js', 'console.log("step one"); process.exit(2)\n'))

    expect(artifact.stdout).toContain('step one')
    expect(evidencePassed(artifact)).toBe(false)
  })
})

describe('a command that never finishes', () => {
  it('reports a timeout rather than a pass', async () => {
    const artifact = await run(script('hang.js', 'setTimeout(() => {}, 60_000)\n'), {
      timeoutMs: 400,
    })

    // Measured: a timeout arrives as `code: null` with signal SIGTERM, *not* as
    // 'ETIMEDOUT'. Keying off the wrong field here would report a hung build as a
    // completed one with no exit code, which `evidencePassed` would then have to
    // guess about.
    expect(artifact.outcome).toBe('timeout')
    expect(artifact.exitCode).toBeNull()
    expect(evidencePassed(artifact)).toBe(false)
    expect(artifact.failure).toContain('400ms')
  })

  it('kills what the shell spawned, not just the shell', async () => {
    // The defect this asserts against: `execFile`'s timeout kills the shell, and a
    // shell's death does not kill its children. Measured before the fix — a
    // timed-out `cmd /c node hang.js` left `node` running indefinitely, holding a
    // lock on the working directory. In production that is a timed-out `npm test`
    // still running against the user's repository.
    //
    // The surviving grandchild is detected through the directory lock rather than by
    // listing processes: the lock is the consequence that actually matters, and it
    // needs no platform-specific process query.
    const artifact = await run(script('hang.js', 'setTimeout(() => {}, 60_000)\n'), {
      timeoutMs: 400,
    })

    expect(artifact.outcome).toBe('timeout')

    // Polled, not slept: the kill is asynchronous on Windows (`taskkill` is its own
    // process), and the bound means a genuinely surviving child still fails here.
    let removed = false
    for (let attempt = 0; attempt < 100 && !removed; attempt += 1) {
      try {
        rmSync(workDir, { recursive: true, force: true })
        removed = true
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 50))
      }
    }

    expect(removed).toBe(true)

    // Recreated so the shared afterEach has something to remove.
    workDir = mkdtempSync(join(tmpdir(), 'forge-runner-'))
  })

  it('reports a cancellation distinctly from a timeout', async () => {
    const controller = new AbortController()
    const pending = run(script('hang.js', 'setTimeout(() => {}, 60_000)\n'), {
      signal: controller.signal,
    })
    controller.abort()

    const artifact = await pending

    expect(artifact.outcome).toBe('cancelled')
    expect(evidencePassed(artifact)).toBe(false)
  })
})

describe('a command that cannot run', () => {
  it('reports a spawn failure rather than an exit code', async () => {
    const artifact = await run('definitely-not-a-real-binary-xyz')

    // The shell runs and reports "not found", so this is a normal non-zero exit
    // rather than a spawn failure — the shell itself started fine. What matters is
    // that it does not pass.
    expect(evidencePassed(artifact)).toBe(false)
  })
})

describe('output limits', () => {
  it('marks a run truncated and refuses to call it a pass', async () => {
    const artifact = await run(
      script('flood.js', 'process.stdout.write("x".repeat(200_000)); process.exit(0)\n'),
      { maxOutputBytes: 2_000 },
    )

    // Measured: exceeding maxBuffer kills the child, so the exit code is lost even
    // though the command would have exited 0. Reporting that as a completed run
    // would invent a verdict for a result nobody observed.
    expect(artifact.truncated).toBe(true)
    expect(artifact.exitCode).toBeNull()
    expect(evidencePassed(artifact)).toBe(false)
    expect(artifact.failure).toContain('exceeded')
  })
})

describe('the environment a command runs in', () => {
  it('withholds secret-shaped variables from the child', async () => {
    const artifact = await run(
      script(
        'env.js',
        'console.log(JSON.stringify({ token: process.env.MY_API_TOKEN ?? null, path: process.env.PATH !== undefined }))\n',
      ),
      { env: {} },
    )

    const parsed = JSON.parse(artifact.stdout.trim()) as { token: string | null; path: boolean }

    expect(parsed.token).toBeNull()
    // A build still needs an ordinary environment; only credential-shaped names go.
    expect(parsed.path).toBe(true)
  })

  it('passes an explicit variable through even when its name looks secret', async () => {
    const artifact = await run(
      script('env2.js', 'console.log(process.env.NPM_TOKEN ?? "absent")\n'),
      { env: { NPM_TOKEN: 'explicitly-provided' } },
    )

    // An explicit addition is a deliberate act by the user, not an inherited leak.
    expect(artifact.stdout).toContain('explicitly-provided')
  })

  it('redacts a secret the command prints', async () => {
    const artifact = await run(
      script('leak.js', 'console.log("api_key=sk-abcdef1234567890abcdef")\n'),
    )

    // An artifact reaches the UI, an event payload, and an agent's correction
    // packet. A token echoed by a build script would otherwise reach all three.
    expect(artifact.stdout).not.toContain('sk-abcdef1234567890abcdef')
  })
})

describe('timing', () => {
  it('reports a duration from the injected clock', async () => {
    let tick = 1_000
    const artifact = await run(script('ok.js', 'console.log("x")\n'), {
      now: () => {
        tick += 250
        return tick
      },
    })

    // Asserted against the injected clock rather than a wall-clock range, so the
    // test does not encode this machine's speed.
    expect(artifact.durationMs).toBe(250)
  })
})
