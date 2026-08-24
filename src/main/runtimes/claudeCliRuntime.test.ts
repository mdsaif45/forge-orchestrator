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

  it('streams output and yields parsed report when executed via runner', async () => {
    const mockRunner: ProcessRunner = (_cmd, _args, options) => {
      options.onStdout?.('Starting turn...\n')
      options.onStdout?.('Editing src/index.ts\n')
      options.onStdout?.('FORGE_REPORT_BEGIN\n')
      options.onStdout?.(
        JSON.stringify({
          status: 'completed',
          summary: 'Implemented test feature',
          filesChanged: ['src/index.ts'],
          commandsRun: ['npm test'],
          testsRun: true,
          openQuestions: [],
          assumptions: [],
        }) + '\n',
      )
      options.onStdout?.('FORGE_REPORT_END\n')
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
      if (ev.type === 'result') break
    }

    expect(events.some((e) => e.type === 'state' && e.state === 'working')).toBe(true)
    expect(events.some((e) => e.type === 'chunk' && e.text.includes('Editing'))).toBe(true)
    const resultEvent = events.find((e) => e.type === 'result')
    expect(resultEvent).toBeDefined()
    if (resultEvent?.type === 'result') {
      expect(resultEvent.report.summary).toBe('Implemented test feature')
      expect(resultEvent.report.filesChanged).toContain('src/index.ts')
    }

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
