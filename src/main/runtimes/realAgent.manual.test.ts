import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { promptPacketSchema } from '@shared/domain'
import { ProcessManager } from '../process/processManager'
import { ClaudeCliRuntime } from './claudeCliRuntime'
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
