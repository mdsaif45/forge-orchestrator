import { describe, expect, it } from 'vitest'
import { AntigravityCliRuntime } from './antigravityCliRuntime'
import type { ProcessRunner } from './claudeCliRuntime'
import { promptPacketSchema } from '@shared/domain'

describe('AntigravityCliRuntime Adapter (#25)', () => {
  it('initializes with full capabilities and starts a session', async () => {
    const runtime = new AntigravityCliRuntime()
    expect(runtime.id).toBe('antigravity-cli')
    expect(runtime.capabilities).toContain('repo-read')
    expect(runtime.capabilities).toContain('plan')
    expect(runtime.capabilities).toContain('file-write')

    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'planner',
    })
    expect(session.sessionId).toContain('agy-sess-')

    const status = await runtime.status(session)
    expect(status.state).toBe('idle')
    await runtime.dispose(session)
  })

  it('relays the process transcript as chunk events and ends the turn on completed', async () => {
    // Parsing the transcript into an AgentReport, and the single re-prompt on a malformed
    // reply, is `exchange()`'s job — this adapter's only responsibility is faithfully
    // relaying what the real process wrote and signalling when the turn is over.
    const mockRunner: ProcessRunner = (_cmd, _args, options) => {
      options.onStdout?.('Analyzing repository structure...\n')
      return Promise.resolve({ exitCode: 0, stdout: '', stderr: '' })
    }

    const runtime = new AntigravityCliRuntime({ runner: mockRunner })
    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'planner',
    })

    const packet = promptPacketSchema.parse({
      role: 'planner',
      objective: 'Plan architecture',
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
    expect(events.some((e) => e.type === 'chunk' && e.text.includes('Analyzing'))).toBe(true)
    expect(events.some((e) => e.type === 'result')).toBe(false)
    expect((await runtime.status(session)).state).toBe('completed')

    await runtime.dispose(session)
  })

  it('fails the session rather than fabricating a report when no runner is configured', async () => {
    // Regression test: see the equivalent ClaudeCliRuntime test.
    const runtime = new AntigravityCliRuntime()
    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'planner',
    })

    const packet = promptPacketSchema.parse({
      role: 'planner',
      objective: 'Plan architecture',
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
    expect(events.find((e) => e.type === 'error')).toBeDefined()
    const status = await runtime.status(session)
    expect(status.state).toBe('failed')
    expect(status.failure).toContain('no process runner configured')

    await runtime.dispose(session)
  })

  it('handles cancellation and disposes cleanly', async () => {
    const runtime = new AntigravityCliRuntime()
    const session = await runtime.start({
      repositoryPath: 'd:/test-repo',
      role: 'implementer',
    })

    await runtime.cancel(session, 'Workflow halted')
    const status = await runtime.status(session)
    expect(status.state).toBe('cancelled')
    expect(status.failure).toBe('Workflow halted')
    await runtime.dispose(session)
  })
})
