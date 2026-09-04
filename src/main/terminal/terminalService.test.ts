import { describe, expect, it, vi } from 'vitest'
import { agentSessionKey, AgentSessionRegistry, type AttachableProcess } from './sessionRegistry'
import { TerminalService } from './terminalService'
import type { ProcessManager } from '../process/processManager'
import type { ProjectService } from '../projects/projectService'

describe('TerminalService', () => {
  it('attaches to published agent sessions and streams output', () => {
    const sessions = new AgentSessionRegistry()
    const emitted: { terminalId: string; chunk: string }[] = []

    let dataCallback: ((chunk: string) => void) | undefined
    const mockAgentProcess: AttachableProcess = {
      write: vi.fn(),
      resize: vi.fn(),
      onData: (listener) => {
        dataCallback = listener
        return () => undefined
      },
    }

    const service = new TerminalService({
      processes: {} as ProcessManager,
      projects: {} as ProjectService,
      sessions,
      emitData: (payload) => emitted.push(payload),
      emitExit: vi.fn(),
    })

    const key = agentSessionKey('wf-100', 1)
    sessions.publish(key, mockAgentProcess)

    expect(dataCallback).toBeDefined()
    dataCallback?.('chunk 1; ')
    dataCallback?.('chunk 2;')

    expect(emitted).toEqual([
      { terminalId: key, chunk: 'chunk 1; ' },
      { terminalId: key, chunk: 'chunk 2;' },
    ])
    expect(service.getBuffer(key)).toBe('chunk 1; chunk 2;')
  })

  it('forwards write and resize to attached agent session', () => {
    const sessions = new AgentSessionRegistry()
    const writeFn = vi.fn()
    const resizeFn = vi.fn()

    const mockAgentProcess: AttachableProcess = {
      write: writeFn,
      resize: resizeFn,
    }

    const service = new TerminalService({
      processes: {} as ProcessManager,
      projects: {} as ProjectService,
      sessions,
      emitData: vi.fn(),
      emitExit: vi.fn(),
    })

    const key = agentSessionKey('wf-100', 0)
    sessions.publish(key, mockAgentProcess)

    service.write(key, 'ls\n')
    expect(writeFn).toHaveBeenCalledWith('ls\n')

    service.resize(key, 120, 40)
    expect(resizeFn).toHaveBeenCalledWith(120, 40)
  })

  it('returns empty string when no buffer is stored for terminalId', () => {
    const service = new TerminalService({
      processes: {} as ProcessManager,
      projects: {} as ProjectService,
      emitData: vi.fn(),
      emitExit: vi.fn(),
    })

    expect(service.getBuffer('non-existent')).toBe('')
  })
})
