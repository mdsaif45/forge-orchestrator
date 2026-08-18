import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProcessManager } from './processManager'
import { buildChildEnv, isSecretEnvName, redactOutput, stripAnsi, withheldEnvNames } from './redact'

const ESC = '\u001B'
const BEL = '\u0007'

/**
 * Real child processes, in a real pty.
 *
 * Nothing here is mocked: the guarantees under test — a hung process is killed, a
 * cancel takes the process tree with it, nothing is orphaned on quit — are properties
 * of the operating system, and a mock would only assert that the mock was called.
 *
 * Every wait is on a condition, never a duration, except where a timeout *is* the thing
 * being tested and the bound is deliberately generous.
 */

let workDir: string
let manager: ProcessManager

/** A portable way to run a short script: node is guaranteed present. */
function nodeScript(source: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ['-e', source] }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'forge-proc-'))
})

afterEach(async () => {
  await manager.killAll('test teardown')
  rmSync(workDir, { recursive: true, force: true })
})

describe('spawning and streaming', () => {
  it('captures output and reports a clean exit', async () => {
    manager = new ProcessManager()

    const handle = await manager.spawn({
      ...nodeScript('process.stdout.write("hello from the child")'),
      cwd: workDir,
    })

    const outcome = await handle.completed

    expect(outcome.reason).toBe('exited')
    expect(outcome.exitCode).toBe(0)
    expect(outcome.output).toContain('hello from the child')
  })

  it('reports a non-zero exit code rather than throwing', async () => {
    manager = new ProcessManager()

    const handle = await manager.spawn({
      ...nodeScript('process.exit(3)'),
      cwd: workDir,
    })

    const outcome = await handle.completed

    // A failing command is data, not an exception: the workflow decides what a failure
    // means, and a rejection here would force every caller to handle two channels.
    expect(outcome.reason).toBe('exited')
    expect(outcome.exitCode).toBe(3)
  })

  it('streams output to a live listener as it arrives', async () => {
    manager = new ProcessManager()
    const seen: string[] = []

    const handle = await manager.spawn({
      ...nodeScript('process.stdout.write("first\\n"); process.stdout.write("second\\n")'),
      cwd: workDir,
    })
    handle.onData((text) => seen.push(text))

    await handle.completed

    expect(seen.join('')).toContain('first')
    expect(seen.join('')).toContain('second')
  })

  it('runs in the requested working directory', async () => {
    manager = new ProcessManager()

    const handle = await manager.spawn({
      ...nodeScript('process.stdout.write(process.cwd())'),
      cwd: workDir,
    })

    const outcome = await handle.completed

    // Compared case-insensitively on the basename: Windows may report a short or
    // differently-cased path for the same directory, which the #18 work established.
    expect(outcome.output.toLowerCase()).toContain(
      (workDir.split(/[\\/]/).pop() ?? '').toLowerCase(),
    )
  })

  it('accepts input on stdin', async () => {
    manager = new ProcessManager()

    const handle = await manager.spawn({
      ...nodeScript(
        'process.stdin.on("data", (d) => { process.stdout.write("got:" + d.toString().trim()); process.exit(0) })',
      ),
      cwd: workDir,
    })

    handle.write('ping\r')
    const outcome = await handle.completed

    expect(outcome.output).toContain('got:ping')
  })

  it('reports a failure to spawn instead of rejecting', async () => {
    manager = new ProcessManager()

    const handle = await manager.spawn({
      command: join(workDir, 'does-not-exist-anywhere'),
      args: [],
      cwd: workDir,
    })

    const outcome = await handle.completed

    // Either the pty constructor throws (spawn-failed) or the shell reports a
    // non-zero exit. Both are legitimate on different platforms; what matters is that
    // the caller is told, and never left waiting.
    expect(['spawn-failed', 'exited']).toContain(outcome.reason)
    if (outcome.reason === 'exited') expect(outcome.exitCode).not.toBe(0)
  })
})

describe('timeouts', () => {
  it('kills a process that produces no output and reports why', async () => {
    // The definition of done: a hung process is killed by the idle timeout and
    // reported, not silently stuck.
    manager = new ProcessManager()

    const handle = await manager.spawn({
      // Sleeps far longer than the timeout and prints nothing.
      ...nodeScript('setTimeout(() => {}, 120000)'),
      cwd: workDir,
      idleTimeoutMs: 400,
    })

    const outcome = await handle.completed

    expect(outcome.reason).toBe('idle-timeout')
    expect(outcome.failure).toMatch(/no output/)
    // Bounded generously: the assertion is that it ended well before the process's own
    // 120s sleep, not that it ended at a precise moment.
    expect(outcome.durationMs).toBeLessThan(30_000)
  })

  it('does not fire the idle timeout while output keeps arriving', async () => {
    // The idle timeout measures silence, not duration: a chatty long-running process
    // must not be killed for being slow.
    //
    // The process runs for ~2.4s in 300ms bursts, well past the 800ms idle bound, so a
    // timer that was armed once instead of re-armed per chunk would kill it. Measured
    // while writing this: ConPTY *batches* writes, so the gaps this exercises are the
    // gaps between batches, not between individual `write` calls.
    manager = new ProcessManager()

    // Written to a file rather than passed with `-e`. A multi-statement script inside a
    // `-e` argument has to survive two levels of escaping before the child parses it, and
    // getting that wrong produces a child that dies of a SyntaxError — which looks exactly
    // like the bug under test.
    const script = join(workDir, 'tick.cjs')
    writeFileSync(
      script,
      [
        'let n = 0',
        'const t = setInterval(() => {',
        "  process.stdout.write('tick ' + n + '\\n')",
        '  if (++n === 8) { clearInterval(t); process.exit(0) }',
        '}, 300)',
      ].join('\n'),
    )

    // The bound accounts for a measured ConPTY behaviour: the final chunk arrives well
    // before the process exits — last data at ~2535ms, exit at ~3546ms, an ~800ms silent
    // tail. So an idle timeout must exceed the *tail*, not just the gap between chunks,
    // or a healthy process is killed as it finishes. Verified against raw node-pty, with
    // no Forge code involved, so this is the platform's behaviour rather than a bug here.
    const handle = await manager.spawn({
      command: process.execPath,
      args: [script],
      cwd: workDir,
      idleTimeoutMs: 1_500,
    })

    const outcome = await handle.completed

    expect(outcome.reason).toBe('exited')
    expect(outcome.exitCode).toBe(0)
    // Proves it genuinely outlived the idle bound rather than finishing inside it.
    expect(outcome.durationMs).toBeGreaterThan(800)
  })

  it('kills a process that exceeds the hard timeout even while chatty', async () => {
    // The hard timeout is the ceiling the idle timeout cannot provide: a process that
    // prints forever would reset the idle timer indefinitely.
    manager = new ProcessManager()

    const handle = await manager.spawn({
      ...nodeScript('setInterval(() => process.stdout.write("busy\\n"), 50)'),
      cwd: workDir,
      idleTimeoutMs: 10_000,
      hardTimeoutMs: 500,
    })

    const outcome = await handle.completed

    expect(outcome.reason).toBe('hard-timeout')
    expect(outcome.failure).toMatch(/exceeded/)
  })
})

describe('cancellation', () => {
  it('terminates a running process and resolves once it is gone', async () => {
    manager = new ProcessManager()

    const handle = await manager.spawn({
      ...nodeScript('process.stdout.write("up\\n"); setTimeout(() => {}, 120000)'),
      cwd: workDir,
    })

    // Waits for the process to prove it is alive rather than sleeping a guessed amount.
    await new Promise<void>((resolve) => {
      const off = handle.onData((text) => {
        if (text.includes('up')) {
          off()
          resolve()
        }
      })
    })

    await handle.cancel('user stopped the workflow')
    const outcome = await handle.completed

    expect(outcome.reason).toBe('cancelled')
    expect(outcome.failure).toBe('user stopped the workflow')
  })

  it('kills the whole process tree, not just the parent', async () => {
    // The definition of done. A shell that spawns a child is the realistic case: killing
    // only the parent leaves the grandchild running against the user's repository, which
    // is why cancel goes through the pty rather than process.kill(pid).
    manager = new ProcessManager()
    const markerPath = join(workDir, 'grandchild-alive.txt').split('\\').join('/')

    const handle = await manager.spawn({
      ...nodeScript(`
        const { spawn } = require('node:child_process')
        // The grandchild rewrites the marker every 100ms while it lives.
        const child = spawn(process.execPath, ['-e', 'setInterval(() => require("node:fs").writeFileSync(' + JSON.stringify(${JSON.stringify(markerPath)}) + ', String(Date.now())), 100)'], { stdio: 'ignore' })
        process.stdout.write('spawned:' + child.pid + '\\n')
        setTimeout(() => {}, 120000)
      `),
      cwd: workDir,
    })

    await new Promise<void>((resolve) => {
      const off = handle.onData((text) => {
        if (text.includes('spawned:')) {
          off()
          resolve()
        }
      })
    })

    // Wait until the grandchild has actually written the marker at least once, so the
    // test is not racing its startup.
    for (let i = 0; i < 200; i += 1) {
      try {
        readFileSync(markerPath, 'utf8')
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 25))
      }
    }

    await handle.cancel('cancelled from the UI')
    await handle.completed

    const afterCancel = readFileSync(markerPath, 'utf8')

    // Poll for longer than the grandchild's own interval. If it were still alive it
    // would have rewritten the marker several times over.
    for (let i = 0; i < 12; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(readFileSync(markerPath, 'utf8')).toBe(afterCancel)
  })

  it('treats a second cancel as a no-op', async () => {
    manager = new ProcessManager()

    const handle = await manager.spawn({
      ...nodeScript('setTimeout(() => {}, 60000)'),
      cwd: workDir,
    })

    await handle.cancel('first')
    await expect(handle.cancel('second')).resolves.toBeUndefined()
  })
})

describe('concurrency', () => {
  it('runs at most the configured number of processes at once', async () => {
    manager = new ProcessManager({ maxConcurrent: 2 })

    const started: Promise<unknown>[] = []
    const handles = []

    for (let index = 0; index < 2; index += 1) {
      handles.push(
        await manager.spawn({
          ...nodeScript('setTimeout(() => {}, 30000)'),
          cwd: workDir,
        }),
      )
    }

    expect(manager.activeCount).toBe(2)

    // A third start must queue rather than run.
    let thirdStarted = false
    const third = manager
      .spawn({ ...nodeScript('process.exit(0)'), cwd: workDir })
      .then((handle) => {
        thirdStarted = true
        return handle
      })
    started.push(third)

    // Give the queued spawn every chance to run if the cap were broken.
    for (let i = 0; i < 10; i += 1) await Promise.resolve()
    expect(thirdStarted).toBe(false)
    expect(manager.queuedCount).toBe(1)

    // Freeing a slot lets it through.
    await handles[0]?.cancel('making room')
    const thirdHandle = await third
    await thirdHandle.completed

    expect(thirdStarted).toBe(true)
  })

  it('releases queued starts when killAll runs, so no caller hangs', async () => {
    manager = new ProcessManager({ maxConcurrent: 1 })

    await manager.spawn({ ...nodeScript('setTimeout(() => {}, 30000)'), cwd: workDir })
    const queued = manager.spawn({ ...nodeScript('process.exit(0)'), cwd: workDir })

    await manager.killAll('shutting down')

    // Without this, a queued caller would wait forever on a manager that is gone.
    await expect(queued).resolves.toBeDefined()
  })
})

describe('shutdown', () => {
  it('kills every child, so nothing is orphaned on app quit', async () => {
    // A killed Electron process that leaves agent CLIs running against the repository
    // is worse than a crash: the work keeps happening with nothing supervising it.
    manager = new ProcessManager()

    const first = await manager.spawn({
      ...nodeScript('setTimeout(() => {}, 60000)'),
      cwd: workDir,
    })
    const second = await manager.spawn({
      ...nodeScript('setTimeout(() => {}, 60000)'),
      cwd: workDir,
    })

    await manager.killAll('Forge is shutting down')

    expect(manager.activeCount).toBe(0)
    expect((await first.completed).reason).toBe('cancelled')
    expect((await second.completed).reason).toBe('cancelled')
  })

  it('refuses new work after shutdown', async () => {
    manager = new ProcessManager()
    await manager.killAll()

    await expect(manager.spawn({ ...nodeScript('process.exit(0)'), cwd: workDir })).rejects.toThrow(
      /disposed/,
    )
  })
})

describe('log capture', () => {
  it('writes a per-run log with the command and outcome', async () => {
    const logDirectory = join(workDir, 'logs')
    manager = new ProcessManager({ logDirectory })

    const handle = await manager.spawn({
      ...nodeScript('process.stdout.write("logged output")'),
      cwd: workDir,
    })
    const outcome = await handle.completed

    // The log is written after the outcome resolves, so poll for it rather than
    // assuming the write has landed.
    let contents = ''
    for (let i = 0; i < 100 && contents === ''; i += 1) {
      try {
        contents = readFileSync(join(logDirectory, `${outcome.runId}.log`), 'utf8')
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 20))
      }
    }

    expect(contents).toContain(`run: ${outcome.runId}`)
    expect(contents).toContain('reason: exited')
    expect(contents).toContain('logged output')
  })

  it('caps the log rather than growing without bound', async () => {
    manager = new ProcessManager({ maxLogBytes: 512 })

    const handle = await manager.spawn({
      ...nodeScript('for (let i = 0; i < 4000; i += 1) process.stdout.write("xxxxxxxxxx")'),
      cwd: workDir,
    })
    const outcome = await handle.completed

    expect(outcome.truncated).toBe(true)
    expect(outcome.output).toContain('output truncated')
    // Bounded, with headroom for the truncation notice itself.
    expect(Buffer.byteLength(outcome.output, 'utf8')).toBeLessThan(2048)
  })

  it('writes nothing when no log directory is configured', async () => {
    manager = new ProcessManager()

    const handle = await manager.spawn({ ...nodeScript('process.exit(0)'), cwd: workDir })
    await handle.completed

    expect(readdirSync(workDir)).toEqual([])
  })
})

describe('secret handling', () => {
  it('withholds secret-shaped variables from the child environment', async () => {
    // Rule R7. Forge cannot stop a child reading .env itself, but it must not hand a
    // credential over, and it must not help one into a log.
    manager = new ProcessManager()

    const handle = await manager.spawn({
      ...nodeScript(
        'process.stdout.write(JSON.stringify({ token: process.env.FORGE_TEST_TOKEN ?? null, plain: process.env.FORGE_TEST_PLAIN ?? null }))',
      ),
      cwd: workDir,
      env: { FORGE_TEST_PLAIN: 'visible' },
    })

    const outcome = await handle.completed

    expect(outcome.output).toContain('"plain":"visible"')
    expect(outcome.output).toContain('"token":null')
  })

  it('classifies names by shape, not by vendor', () => {
    // A6 as much as R7: a list naming providers would miss the next one and would put
    // provider names into core.
    expect(isSecretEnvName('GITHUB_TOKEN')).toBe(true)
    expect(isSecretEnvName('SOME_API_KEY')).toBe(true)
    expect(isSecretEnvName('DB_PASSWORD')).toBe(true)
    expect(isSecretEnvName('AWS_SECRET_ACCESS_KEY')).toBe(true)
    expect(isSecretEnvName('SESSION_ID')).toBe(true)

    expect(isSecretEnvName('PATH')).toBe(false)
    expect(isSecretEnvName('HOME')).toBe(false)
    expect(isSecretEnvName('GIT_TERMINAL_PROMPT')).toBe(false)
  })

  it('passes an explicitly supplied value through, even if secret-shaped', () => {
    // A caller passing a value has decided to; the default-drop applies to inheritance.
    const env = buildChildEnv({ INHERITED_TOKEN: 'no' }, { EXPLICIT_TOKEN: 'yes' })

    expect(env.INHERITED_TOKEN).toBeUndefined()
    expect(env.EXPLICIT_TOKEN).toBe('yes')
  })

  it('reports which names were withheld, so the decision is auditable', () => {
    expect(withheldEnvNames({ A_TOKEN: 'x', PATH: '/usr/bin' })).toEqual(['A_TOKEN'])
  })
})

describe('output redaction', () => {
  it('redacts a bearer token', () => {
    const text = redactOutput('Authorization: Bearer abcdef1234567890XYZ')
    expect(text).not.toContain('abcdef1234567890XYZ')
    expect(text).toContain('[redacted]')
  })

  it('redacts a key=value assignment but keeps the key', () => {
    // The key is diagnostic — knowing *what* was withheld is useful; the value is not.
    const text = redactOutput('GITHUB_TOKEN=ghp_realsecretvalue123')
    expect(text).not.toContain('ghp_realsecretvalue123')
    expect(text).toContain('GITHUB_TOKEN=')
  })

  it('redacts a JWT', () => {
    const jwt =
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U'
    expect(redactOutput(`token is ${jwt}`)).not.toContain(jwt)
  })

  it('redacts credentials embedded in a URL but keeps the scheme', () => {
    const text = redactOutput('cloning https://user:hunter2@example.com/repo.git')
    expect(text).not.toContain('hunter2')
    expect(text).toContain('https://')
  })

  it('redacts a private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----'
    expect(redactOutput(pem)).not.toContain('MIIEowIBAAKCAQEA')
  })

  it('leaves ordinary output untouched', () => {
    const text = 'Compiled 42 files in 1.3s\n  src/math.ts -> out/math.js'
    expect(redactOutput(text)).toBe(text)
  })

  it('redacts before output reaches a listener or a log', async () => {
    // Redaction at capture time, not write time: a live log rendered in the UI is as
    // durable as a file once it is on screen.
    manager = new ProcessManager()
    const seen: string[] = []

    const handle = await manager.spawn({
      ...nodeScript('process.stdout.write("MY_API_KEY=supersecretvalue999\\n")'),
      cwd: workDir,
    })
    handle.onData((text) => seen.push(text))

    const outcome = await handle.completed

    expect(seen.join('')).not.toContain('supersecretvalue999')
    expect(outcome.output).not.toContain('supersecretvalue999')
  })
})

describe('the environment sanitiser', () => {
  it('drops undefined values rather than passing "undefined" through', () => {
    const env = buildChildEnv({ SET: 'yes', UNSET: undefined })

    expect(env.SET).toBe('yes')
    expect('UNSET' in env).toBe(false)
  })
})

/** Kept last: it needs git, and a failure here should not mask the rest. */
describe('a real repository', () => {
  it('resolves a bare command name against PATH', async () => {
    // Regression: `node-pty` on Windows hands the command straight to CreateProcess,
    // which does not search PATH — `spawn('git', …)` threw "File not found:" from the
    // constructor. Adapters pass bare names, so Forge resolves them itself rather than
    // routing through a shell, which would reintroduce an injection surface.
    manager = new ProcessManager()

    const handle = await manager.spawn({ command: 'git', args: ['--version'], cwd: workDir })
    const outcome = await handle.completed

    expect(outcome.reason).toBe('exited')
    expect(outcome.exitCode).toBe(0)
    expect(outcome.output).toMatch(/git version/i)
  })

  it('runs a git command in the worktree it was given', async () => {
    manager = new ProcessManager()

    execFileSync('git', ['init', '--quiet', '--initial-branch=main', '.'], { cwd: workDir })
    writeFileSync(join(workDir, 'a.txt'), 'x\n')

    const handle = await manager.spawn({
      command: 'git',
      args: ['status', '--porcelain'],
      cwd: workDir,
    })
    const outcome = await handle.completed

    expect(outcome.exitCode).toBe(0)
    expect(outcome.output).toContain('a.txt')
  })
})

describe('terminal control sequences', () => {
  it('strips CSI sequences', () => {
    expect(stripAnsi(`${ESC}[2J${ESC}[mclean`)).toBe('clean')
  })

  it('strips an OSC title sequence spliced inside a word', () => {
    // Measured from a real `git --version` through ConPTY: the title sequence lands
    // between the "g" and the "it version", so a naive match against raw pty output
    // fails even though the command ran perfectly.
    const raw = `${ESC}[Hg${ESC}]0;C:/Program Files/Git/bin/git.exe${BEL}${ESC}[?25hit version 2.51.0`

    expect(/git version/i.test(raw)).toBe(false)
    expect(stripAnsi(raw)).toContain('git version 2.51.0')
  })

  it('leaves plain text untouched', () => {
    expect(stripAnsi('nothing to strip here')).toBe('nothing to strip here')
  })

  it('strips before storing, so captured output is legible', async () => {
    // The point of doing this in the manager: a consumer matches on process output
    // without needing to know a pty was involved.
    manager = new ProcessManager()

    const handle = await manager.spawn({ command: 'git', args: ['--version'], cwd: workDir })
    const outcome = await handle.completed

    expect(outcome.output).toMatch(/git version/i)
  })
})
