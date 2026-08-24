import { describe, expect, it } from 'vitest'
import { ClaudeCliRuntime, type ProcessRunner } from './claudeCliRuntime'
import { promptPacketSchema } from '@shared/domain'

describe('ClaudeCliRuntime Adapter (#24)', () => {
  it('initializes with proper capabilities and starts a session', async () => {
    const runtime = new ClaudeCliRuntime()
    expect(runtime.id).toBe('claude-cli')
    expect(runtime.capabilities).toContain('repo-read')
    expect(runtime.capabilities).toContain('file-write')

    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'implementer',
    })
    expect(session.sessionId).toContain('claude-sess-')

    const status = await runtime.status(session)
    expect(status.state).toBe('idle')
    await runtime.dispose(session)
  })

  it('relays the process transcript as chunk events and ends the turn on completed', async () => {
    // Parsing the transcript into an AgentReport, and the single re-prompt on a malformed
    // reply, is `exchange()`'s job (see protocol.test.ts and exchange.test.ts) — this adapter's
    // only responsibility is faithfully relaying what the real process wrote and signalling
    // when the turn is over, not interpreting the content.
    const mockRunner: ProcessRunner = (_cmd, _args, options) => {
      options.onStdout?.('Starting turn...\n')
      options.onStdout?.('Editing src/index.ts\n')
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    }

    const runtime = new ClaudeCliRuntime({ runner: mockRunner })
    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'implementer',
    })

    const packet = promptPacketSchema.parse({
      role: 'implementer',
      objective: 'Build feature',
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
    })

    await runtime.send(session, packet)

    const events = []
    for await (const ev of runtime.events(session)) {
      events.push(ev)
      if (ev.type === 'state' && ev.state === 'completed') break
    }

    expect(events.some((e) => e.type === 'state' && e.state === 'working')).toBe(true)
    expect(events.some((e) => e.type === 'chunk' && e.text.includes('Editing'))).toBe(true)
    expect(events.some((e) => e.type === 'result')).toBe(false)
    expect((await runtime.status(session)).state).toBe('completed')

    await runtime.dispose(session)
  })

  it('fails the session rather than fabricating a report when no runner is configured', async () => {
    // Regression test: a ClaudeCliRuntime built without a way to spawn the real CLI has no
    // way to know what happened, and previously reported a synthetic "completed" result for
    // work that never ran — exactly the unverified claim Forge exists to catch in agents.
    const runtime = new ClaudeCliRuntime()
    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'implementer',
    })

    const packet = promptPacketSchema.parse({
      role: 'implementer',
      objective: 'Build feature',
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
    })

    await runtime.send(session, packet)

    const events = []
    for await (const ev of runtime.events(session)) {
      events.push(ev)
      if (ev.type === 'error') break
    }

    expect(events.some((e) => e.type === 'result')).toBe(false)
    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    const status = await runtime.status(session)
    expect(status.state).toBe('failed')
    expect(status.failure).toContain('no process runner configured')

    await runtime.dispose(session)
  })

  it('handles cancellation and marks session cancelled', async () => {
    const runtime = new ClaudeCliRuntime()
    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'planner',
    })

    await runtime.cancel(session, 'User cancelled')
    const status = await runtime.status(session)
    expect(status.state).toBe('cancelled')
    expect(status.failure).toBe('User cancelled')
    await runtime.dispose(session)
  })
})
