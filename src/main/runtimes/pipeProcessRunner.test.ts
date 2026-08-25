import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../test/tempDir'
import { createPipeProcessRunner } from './pipeProcessRunner'

/**
 * The pipe runner against real processes.
 *
 * The stdin case is the one that matters: #131 shipped because every test injected a
 * mock runner or passed a short single-line argument, and neither can observe what a
 * real child actually received.
 */

let workDir: string

function nodeScript(source: string): { command: string; args: string[] } {
  return { command: process.execPath, args: ['-e', source] }
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'forge-pipe-runner-'))
})

afterEach(async () => {
  await removeTempDir(workDir)
})

describe('createPipeProcessRunner', () => {
  it('delivers a realistic multi-line prompt through stdin, intact', async () => {
    // The #131 regression, stated as the thing that actually broke: a prompt with
    // newlines, quotes and JSON braces reached the CLI empty when passed as an
    // argument, and every step got "What would you like me to do?".
    const prompt = [
      'ROLE',
      'planner',
      '',
      'OBJECTIVE',
      'Fix add() in src/math.js — it subtracts but must sum.',
      '',
      'FORGE_REPORT_BEGIN',
      '{"status":"completed","filesChanged":["src/math.js"],"testsRun":true}',
      'FORGE_REPORT_END',
    ].join('\n')

    const out = join(workDir, 'received.txt')
    const script = nodeScript(
      `let s='';process.stdin.on('data',d=>s+=d).on('end',()=>require('fs').writeFileSync(${JSON.stringify(out)},s))`,
    )

    const runner = createPipeProcessRunner()
    await runner(script.command, script.args, { cwd: workDir, stdin: prompt })

    // Asserted byte-for-byte against what the child wrote, not against an exit code:
    // the process exited 0 in the failing case too.
    expect(readFileSync(out, 'utf8')).toBe(prompt)
  })

  it('captures output and reports a clean exit', async () => {
    const runner = createPipeProcessRunner()
    const script = nodeScript('process.stdout.write("hello from the child")')

    const result = await runner(script.command, script.args, { cwd: workDir })

    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello from the child')
  })

  it('streams output as it arrives', async () => {
    const runner = createPipeProcessRunner()
    const script = nodeScript('process.stdout.write("streamed")')

    const chunks: string[] = []
    await runner(script.command, script.args, {
      cwd: workDir,
      onStdout: (chunk) => chunks.push(chunk),
    })

    expect(chunks.join('')).toContain('streamed')
  })

  it('passes the account environment to the child', async () => {
    const runner = createPipeProcessRunner()
    const script = nodeScript('process.stdout.write(String(process.env.FORGE_TEST_HOME))')

    const result = await runner(script.command, script.args, {
      cwd: workDir,
      env: { FORGE_TEST_HOME: 'D:/forge/accounts/acct-1/home' },
    })

    expect(result.stdout).toContain('D:/forge/accounts/acct-1/home')
  })

  it('reports a non-zero exit as non-zero', async () => {
    const runner = createPipeProcessRunner()
    const script = nodeScript('process.exit(3)')

    const result = await runner(script.command, script.args, { cwd: workDir })

    expect(result.exitCode).toBe(3)
  })

  it('does not report a hard-timeout kill as success', async () => {
    // A killed child reports null on some platforms and 0 on others. The reason
    // decides, not the number — the rule the pty runner learned from Linux CI.
    const runner = createPipeProcessRunner({ hardTimeoutMs: 300 })
    const script = nodeScript('setInterval(() => {}, 1000)')

    const result = await runner(script.command, script.args, { cwd: workDir })

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('hard-timeout')
  })

  it('kills the child when the caller aborts', async () => {
    const runner = createPipeProcessRunner()
    const script = nodeScript('setInterval(() => {}, 1000)')
    const controller = new AbortController()

    const running = runner(script.command, script.args, {
      cwd: workDir,
      signal: controller.signal,
    })
    controller.abort()

    const result = await running

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).toContain('cancelled')
  })
})
