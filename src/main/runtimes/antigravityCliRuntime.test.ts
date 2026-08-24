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

  it('streams output and yields parsed report when executed via runner', async () => {
    const mockRunner: ProcessRunner = (_cmd, _args, options) => {
      options.onStdout?.('Analyzing repository structure...\n')
      options.onStdout?.('FORGE_REPORT_BEGIN\n')
      options.onStdout?.(
        JSON.stringify({
          status: 'completed',
          summary: 'Analyzed codebase and proposed architecture plan',
          filesChanged: [],
          commandsRun: ['git status'],
          testsRun: false,
          openQuestions: [],
          assumptions: [],
        }) + '\n',
      )
      options.onStdout?.('FORGE_REPORT_END\n')
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
      if (ev.type === 'result') break
    }

    expect(events.some((e) => e.type === 'state' && e.state === 'working')).toBe(true)
    expect(events.some((e) => e.type === 'chunk' && e.text.includes('Analyzing'))).toBe(true)
    const resultEvent = events.find((e) => e.type === 'result')
    expect(resultEvent).toBeDefined()
    if (resultEvent?.type === 'result') {
      expect(resultEvent.report.summary).toBe('Analyzed codebase and proposed architecture plan')
    }

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
