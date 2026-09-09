import { describe, expect, it } from 'vitest'
import { GenericCliAgentRuntime } from './genericCliRuntime'
import { promptPacketSchema } from '@shared/domain'

describe('GenericCliAgentRuntime', () => {
  it('instantiates with capabilities and starts/disposes a session', async () => {
    const runtime = new GenericCliAgentRuntime({
      id: 'agy',
      name: 'Agy',
      executable: 'agy',
    })

    expect(runtime.id).toBe('agy')
    expect(runtime.capabilities).toContain('repo-read')
    expect(runtime.capabilities).toContain('plan')
    expect(runtime.capabilities).toContain('file-write')
    expect(runtime.capabilities).toContain('review')

    const session = await runtime.start({
      repositoryPath: 'd:/mock/repo',
      role: 'planner',
    })

    expect(session.sessionId).toContain('agy-sess-')

    const status = await runtime.status(session)
    expect(status.state).toBe('idle')
    expect(status.failure).toBeNull()

    await runtime.dispose(session)
  })

  it('handles prompt sending and state transitions', async () => {
    const runtime = new GenericCliAgentRuntime({
      id: 'opencode',
      name: 'OpenCode',
      executable: 'opencode',
    })

    const session = await runtime.start({
      repositoryPath: 'd:/mock/repo',
      role: 'implementer',
    })

    const packet = promptPacketSchema.parse({
      role: 'implementer',
      objective: 'Implement feature X',
      constraints: ['no regressions'],
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
    for await (const event of runtime.events(session)) {
      events.push(event)
      if (event.type === 'state' && event.state === 'completed') {
        break
      }
    }

    expect(events.some((e) => e.type === 'state' && e.state === 'completed')).toBe(true)
    await runtime.dispose(session)
  })

  it('cancels session cleanly', async () => {
    const runtime = new GenericCliAgentRuntime({
      id: 'codex',
      name: 'Codex',
      executable: 'codex',
    })

    const session = await runtime.start({
      repositoryPath: 'd:/mock/repo',
      role: 'reviewer',
    })

    await runtime.cancel(session, 'User cancelled')
    const status = await runtime.status(session)
    expect(status.state).toBe('cancelled')
    expect(status.failure).toBe('User cancelled')

    await runtime.dispose(session)
  })
})
