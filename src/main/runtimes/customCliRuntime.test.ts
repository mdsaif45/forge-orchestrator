import { describe, expect, it } from 'vitest'
import { roleSchema, type PromptPacket, type RuntimeEvent } from '@shared/domain'
import { CustomCliRuntime } from './customCliRuntime'
import type { ProcessRunner, ProcessRunnerResult } from './claudeCliRuntime'
import { IncapableRuntimeError, RuntimeRegistry } from './registry'

function mockPacket(overrides: Partial<PromptPacket> = {}): PromptPacket {
  return {
    role: roleSchema.parse('implementer'),
    objective: 'Implement custom feature',
    constraints: ['Must compile cleanly'],
    rules: ['No assumptions'],
    lockedDecisions: [],
    allowedPaths: ['src/'],
    forbiddenPaths: [],
    relevantFiles: ['src/index.ts'],
    reviewFindings: [],
    previousAttempt: null,
    completionCriteria: ['All tests pass'],
    answeredQuestions: [],
    repositoryInstructions: null,
    correction: null,
    ...overrides,
  }
}

describe('CustomCliRuntime (RUNTIME-001 / Issue #174)', () => {
  it('instantiates with custom capabilities and registers in RuntimeRegistry', () => {
    const runtime = new CustomCliRuntime({
      id: 'custom:opencode',
      name: 'OpenCode CLI',
      command: 'opencode',
      capabilities: ['repo-read', 'file-write', 'plan'],
    })

    expect(runtime.id).toBe('custom:opencode')
    expect(runtime.name).toBe('OpenCode CLI')
    expect(runtime.capabilities).toEqual(['repo-read', 'file-write', 'plan'])
    expect(runtime.simulated).toBe(false)

    const registry = new RuntimeRegistry()
    registry.register(runtime)

    expect(registry.has('custom:opencode')).toBe(true)
    expect(registry.resolve('custom:opencode')).toBe(runtime)

    // Planner role only requires 'plan' and 'repo-read'
    expect(registry.resolveForRole('custom:opencode', 'planner')).toBe(runtime)

    // Reviewer role requires 'review', which is not in this custom CLI's declared capabilities
    expect(() => registry.resolveForRole('custom:opencode', 'reviewer')).toThrow(
      IncapableRuntimeError,
    )
  })

  it('interpolates argument templates and passes prompt via stdin when no {{prompt}} token is present', async () => {
    let capturedCommand = ''
    let capturedArgs: readonly string[] = []
    let capturedStdin: string | undefined = undefined

    const mockRunner: ProcessRunner = (command, args, options) => {
      capturedCommand = command
      capturedArgs = args
      capturedStdin = options.stdin
      options.onStdout?.(
        'Thinking...\nFORGE_REPORT_BEGIN\n{\n  "status": "completed",\n  "summary": "Done",\n  "filesChanged": [],\n  "commandsRun": [],\n  "testsRun": true,\n  "openQuestions": [],\n  "assumptions": []\n}\nFORGE_REPORT_END\n',
      )
      return Promise.resolve<ProcessRunnerResult>({
        exitCode: 0,
        stdout:
          'Thinking...\nFORGE_REPORT_BEGIN\n{\n  "status": "completed",\n  "summary": "Done",\n  "filesChanged": [],\n  "commandsRun": [],\n  "testsRun": true,\n  "openQuestions": [],\n  "assumptions": []\n}\nFORGE_REPORT_END\n',
        stderr: '',
      })
    }

    const runtime = new CustomCliRuntime({
      id: 'custom:aider',
      name: 'Aider',
      command: 'aider',
      argsTemplate: ['--yes', '--message', '{{objective}}', '--cwd', '{{workspace}}'],
      runner: mockRunner,
    })

    const handle = await runtime.start({
      repositoryPath: '/mock/repo',
      role: 'implementer',
    })

    await runtime.send(handle, mockPacket({ objective: 'Add login test' }))

    expect(capturedCommand).toBe('aider')
    expect(capturedArgs).toEqual(['--yes', '--message', 'Add login test', '--cwd', '/mock/repo'])
    expect(capturedStdin).toContain('Add login test')
    expect(capturedStdin).toContain('FORGE_REPORT_BEGIN')

    const status = await runtime.status(handle)
    expect(status.state).toBe('completed')
    expect(status.failure).toBeNull()

    const events: RuntimeEvent[] = []
    for await (const event of runtime.events(handle)) {
      events.push(event)
      if (event.type === 'result') break
    }

    const resultEvent = events.find((e) => e.type === 'result')
    expect(resultEvent).toBeDefined()
    if (resultEvent?.type === 'result') {
      expect(resultEvent.report.status).toBe('completed')
      expect(resultEvent.report.summary).toBe('Done')
    }
  })

  it('fails closed when the custom CLI outputs exit code 0 but omits the required report fence', async () => {
    const mockRunner: ProcessRunner = (_command, _args, options) => {
      options.onStdout?.('Just some casual chatter without any report blocks.\n')
      return Promise.resolve<ProcessRunnerResult>({
        exitCode: 0,
        stdout: 'Just some casual chatter without any report blocks.\n',
        stderr: '',
      })
    }

    const runtime = new CustomCliRuntime({
      id: 'custom:chatter',
      name: 'Chatter CLI',
      command: 'chatter',
      runner: mockRunner,
    })

    const handle = await runtime.start({
      repositoryPath: '/mock/repo',
      role: 'implementer',
    })

    await runtime.send(handle, mockPacket())

    const status = await runtime.status(handle)
    expect(status.state).toBe('failed')
    expect(status.failure).toContain('failed to emit a valid report')

    const events: RuntimeEvent[] = []
    for await (const event of runtime.events(handle)) {
      events.push(event)
      if (event.type === 'error') break
    }

    const errorEvent = events.find((e) => e.type === 'error')
    expect(errorEvent).toBeDefined()
    if (errorEvent?.type === 'error') {
      expect(errorEvent.retryable).toBe(true)
    }
  })

  it('fails closed when child process exits with non-zero exit code', async () => {
    const mockRunner: ProcessRunner = () => {
      return Promise.resolve<ProcessRunnerResult>({
        exitCode: 1,
        stdout: '',
        stderr: 'fatal: missing API key',
      })
    }

    const runtime = new CustomCliRuntime({
      id: 'custom:broken',
      name: 'Broken CLI',
      command: 'broken',
      runner: mockRunner,
    })

    const handle = await runtime.start({
      repositoryPath: '/mock/repo',
      role: 'implementer',
    })

    await runtime.send(handle, mockPacket())

    const status = await runtime.status(handle)
    expect(status.state).toBe('failed')
    expect(status.failure).toContain('exited with code 1')
    expect(status.failure).toContain('missing API key')
  })

  it('handles cancellation and disposal cleanly', async () => {
    const runtime = new CustomCliRuntime({
      id: 'custom:long',
      name: 'Long Running CLI',
      command: 'long-cmd',
    })

    const handle = await runtime.start({
      repositoryPath: '/mock/repo',
      role: 'implementer',
    })

    await runtime.cancel(handle, 'User cancelled workflow')
    const status = await runtime.status(handle)
    expect(status.state).toBe('cancelled')
    expect(status.failure).toBe('User cancelled workflow')

    await runtime.dispose(handle)
    await expect(runtime.status(handle)).rejects.toThrow(/No active session/)
  })
})
