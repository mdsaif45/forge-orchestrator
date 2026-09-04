import { describe, expect, it } from 'vitest'
import type { ProcessManager } from '../process/processManager'
import { HostedClaudeRuntime } from './hostedClaudeRuntime'

const ESC = String.fromCharCode(27)
const CLEAR = `${ESC}[2J${ESC}[H`

/** A TUI repaints in place; fixtures that only append never clear the busy line. */
const READY = `${CLEAR}----\r\n> Try "edit"\r\n----\r\n? for shortcuts\r\n`
const WORKING = `${CLEAR}> the prompt\r\n* Searching...\r\nesc to interrupt\r\n`
const ANSWERED = `${CLEAR}> the prompt\r\n* done\r\n----\r\n> \r\n? for shortcuts\r\n`
const PERMISSION = `${CLEAR}Bash command\r\nDo you want to proceed?\r\n 1. Yes\r\n`

/**
 * Stands in for a spawned CLI: records argv and what was written, and lets the
 * test paint whatever screen it needs. No process is created, so these assert the
 * runtime's own behaviour rather than the CLI's.
 */
const makeProcesses = () => {
  const state = {
    args: [] as readonly string[],
    command: '',
    written: [] as string[],
    cancelled: null as string | null,
    emit: (_chunk: string): void => undefined,
  }

  const processes = {
    spawn: (request: { command: string; args: readonly string[] }) => {
      state.command = request.command
      state.args = request.args
      return Promise.resolve({
        runId: 'run-1',
        onData: (listener: (text: string) => void) => {
          state.emit = listener
          return () => undefined
        },
        completed: new Promise(() => undefined),
        write: (input: string) => state.written.push(input),
        resize: () => undefined,
        cancel: (reason?: string) => {
          state.cancelled = reason ?? 'cancelled'
          return Promise.resolve()
        },
      })
    },
  } as unknown as ProcessManager

  return { processes, state }
}

const runtime = (processes: ProcessManager) =>
  new HostedClaudeRuntime({ processes, sleep: () => new Promise((r) => setTimeout(r, 1)) })

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((r) => setTimeout(r, 5))
}

describe('HostedClaudeRuntime argv', () => {
  it('launches interactively, with no headless flags', async () => {
    // The whole point of hosting: no -p, no --output-format, no --safe-mode.
    // --safe-mode in particular disables the CLI's own hooks, which is the
    // mechanism this redesign exists to stop working around.
    const { processes, state } = makeProcesses()
    await runtime(processes).start({ repositoryPath: 'd:/repo', role: 'implementer' })

    expect(state.args).not.toContain('-p')
    expect(state.args).not.toContain('--output-format')
    expect(state.args).not.toContain('--safe-mode')
  })

  it('maps bypassPermissions to the flag the CLI actually has', async () => {
    const { processes, state } = makeProcesses()
    await runtime(processes).start({
      repositoryPath: 'd:/repo',
      role: 'implementer',
      permissionMode: 'bypassPermissions',
    })

    expect(state.args).toContain('--dangerously-skip-permissions')
    expect(state.args).not.toContain('--permission-mode')
  })

  it('names the session when a resume key is supplied', async () => {
    const { processes, state } = makeProcesses()
    await runtime(processes).start({
      repositoryPath: 'd:/repo',
      role: 'planner',
      resumeKey: { workflowId: 'wf-1', stepIndex: 0, iteration: 1 },
    })

    const id = state.args[state.args.indexOf('--session-id') + 1] ?? ''
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  })
})

describe('HostedClaudeRuntime declarations', () => {
  it('is a distinct runtime from the headless adapter', () => {
    // Registered alongside rather than replacing it, so both can run against the
    // same repository and be compared before anything is deleted.
    expect(new HostedClaudeRuntime().id).toBe('claude-cli-hosted')
  })

  it('claims no repository instruction files', () => {
    // The headless adapter declares CLAUDE.md because --safe-mode stops the CLI
    // reading it, so Forge injects it into the packet (#145). A hosted session
    // loads it itself; declaring the name would send the same instructions twice.
    expect(new HostedClaudeRuntime().instructionFilenames).toEqual([])
  })

  it('refuses to start without a process manager', async () => {
    // A2/A3: a runtime with nothing to spawn must fail loudly, never report
    // success for work that never happened.
    await expect(
      new HostedClaudeRuntime().start({ repositoryPath: 'd:/repo', role: 'planner' }),
    ).rejects.toThrow(/no process manager/i)
  })
})

describe('HostedClaudeRuntime turns', () => {
  it('waits for the prompt box, then types and completes a turn', async () => {
    const { processes, state } = makeProcesses()
    const hosted = runtime(processes)
    const session = await hosted.start({ repositoryPath: 'd:/repo', role: 'implementer' })

    const events: string[] = []
    const collecting = (async () => {
      for await (const event of hosted.events(session)) {
        events.push(event.type === 'state' ? `state:${event.state}` : event.type)
        if (event.type === 'state' && event.state === 'completed') break
      }
    })()

    state.emit(READY)
    const sending = hosted.send(session, packet())
    await settle()
    state.emit(WORKING)
    await settle()
    state.emit(ANSWERED)

    await sending
    await collecting

    expect(state.written.at(-1)).toBe('\r')
    expect(events).toContain('state:completed')
  })

  it('fails the step when the CLI stops on a dialog mid-turn', async () => {
    // Measured: a real turn ran its tools and then stopped on a permission
    // prompt with nothing present to answer. Absorbing that would report the
    // dialog text as the agent's reply.
    const { processes, state } = makeProcesses()
    const hosted = runtime(processes)
    const session = await hosted.start({ repositoryPath: 'd:/repo', role: 'implementer' })

    state.emit(READY)
    const sending = hosted.send(session, packet())
    await settle()
    state.emit(WORKING)
    await settle()
    state.emit(PERMISSION)
    await sending

    const status = await hosted.status(session)
    expect(status.state).toBe('failed')
    expect(status.failure).toMatch(/permission dialog/i)
  })

  it('kills the process on dispose', async () => {
    // A hosted session never exits on its own; it waits for the next prompt
    // forever. Without this every finished workflow leaves a CLI running against
    // a worktree that is about to be removed.
    const { processes, state } = makeProcesses()
    const hosted = runtime(processes)
    const session = await hosted.start({ repositoryPath: 'd:/repo', role: 'planner' })

    await hosted.dispose(session)
    expect(state.cancelled).toBe('disposed')
  })
})

function packet() {
  return {
    role: 'implementer' as const,
    objective: 'the prompt',
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
    correction: null,
    repositoryInstructions: null,
  }
}
