import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { promptPacketSchema } from '@shared/domain'
import { removeTempDir } from '../../test/tempDir'
import { ProcessManager } from '../process/processManager'
import { ClaudeCliRuntime } from './claudeCliRuntime'
import { ClaudeTrustStore } from './claudeTrust'
import { HostedClaudeRuntime } from './hostedClaudeRuntime'
import { createPtyProcessRunner } from './ptyProcessRunner'

/**
 * Drives the real Claude CLI, end to end, through Forge's own adapter and runner.
 *
 * Skipped unless FORGE_REAL_AGENT=1, because it needs an authenticated CLI and costs a
 * real turn — neither is available in CI. It exists because every other test in this
 * repository injects a mock runner, which proves the wiring and never proves that a
 * CLI can actually be driven.
 */
describe.skipIf(process.env.FORGE_REAL_AGENT !== '1')('a real agent turn', () => {
  it('runs the actual CLI and returns its transcript', { timeout: 300_000 }, async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'forge-real-agent-'))
    const manager = new ProcessManager()

    const runtime = new ClaudeCliRuntime({
      runner: createPtyProcessRunner({ processes: manager, hardTimeoutMs: 240_000 }),
    })

    const session = await runtime.start({ repositoryPath: workDir, role: 'planner' })

    await runtime.send(
      session,
      promptPacketSchema.parse({
        role: 'planner',
        objective: 'Reply with exactly: FORGE_OK',
        constraints: [],
        rules: [],
        lockedDecisions: [],
        allowedPaths: [],
        forbiddenPaths: [],
        relevantFiles: [],
        reviewFindings: [],
        previousAttempt: null,
        completionCriteria: [],
        answeredQuestions: [],
      }),
    )

    let transcript = ''
    for await (const event of runtime.events(session)) {
      if (event.type === 'chunk') transcript += event.text
      if (event.type === 'state' && event.state === 'completed') break
      if (event.type === 'error') throw new Error(event.message)
    }

    expect(transcript.length).toBeGreaterThan(0)
    await runtime.dispose(session)
    await manager.killAll('done')
  })
})

/**
 * The same thing for the HOSTED path, which is what `src/main/index.ts` wires.
 *
 * The hosted runtime's completion signal is the CLI's own `Stop` hook, not the
 * screen — four screen-only rules were tried against the real CLI and all four
 * were wrong (`docs/CLI-FIELD-GUIDE.md` §9). That mechanism was verified with
 * throwaway probes that did not survive the session, so nothing in the
 * repository re-checked it. This does, and it is the check that would catch the
 * CLI changing its hook payload or its paste handling under us.
 *
 * Asserts the reply came through the hook rather than merely that the turn
 * ended: a screen-derived completion would also end the turn, and would be the
 * regression worth noticing.
 */
describe.skipIf(process.env.FORGE_REAL_AGENT !== '1')('a real hosted agent turn', () => {
  it('completes from the CLI’s own Stop hook', { timeout: 300_000 }, async () => {
    const workDir = mkdtempSync(join(tmpdir(), 'forge-real-hosted-'))
    const receiverDir = mkdtempSync(join(tmpdir(), 'forge-real-hosted-recv-'))
    const manager = new ProcessManager()

    // Pre-trusted for the same reason the workflow service does it: a directory
    // the CLI has not seen before blocks at startup on a safety-check dialog
    // that has nothing present to answer it (#166).
    await new ClaudeTrustStore().trust(workDir)

    const runtime = new HostedClaudeRuntime({
      processes: manager,
      hookReceiverDir: receiverDir,
    })

    const session = await runtime.start({
      repositoryPath: workDir,
      role: 'planner',
      // The hook path was measured under this mode specifically; the hint text
      // the earlier heuristics keyed on does not appear here at all.
      permissionMode: 'bypassPermissions',
    })

    const startedAt = Date.now()
    await runtime.send(
      session,
      promptPacketSchema.parse({
        role: 'planner',
        objective: 'Reply with exactly: FORGE_HOSTED_OK',
        constraints: [],
        rules: [],
        lockedDecisions: [],
        allowedPaths: [],
        forbiddenPaths: [],
        relevantFiles: [],
        reviewFindings: [],
        previousAttempt: null,
        completionCriteria: [],
        answeredQuestions: [],
      }),
    )

    let transcript = ''
    for await (const event of runtime.events(session)) {
      if (event.type === 'chunk') transcript += event.text
      if (event.type === 'state' && event.state === 'completed') break
      if (event.type === 'error') throw new Error(event.message)
    }

    // The hook payload carries the reply verbatim, so the marker must be in the
    // emitted chunk. Raw terminal output is deliberately NOT emitted as a chunk,
    // which is what makes this assertion evidence about the hook specifically.
    expect(transcript).toContain('FORGE_HOSTED_OK')

    // Reported rather than asserted as a bound: this is the number the field
    // guide quotes (a correct turn in ~16s once the paste fix landed), and a
    // hard threshold here would fail on a slow network instead of on a defect.
    // `warn` because the lint rule forbids `log` — the value of running this
    // test by hand is largely in reading that number.
    console.warn(`hosted turn completed in ${String(Date.now() - startedAt)}ms`)

    await runtime.dispose(session)
    await manager.killAll('done')
    await removeTempDir(workDir)
    await removeTempDir(receiverDir)
  })
})
