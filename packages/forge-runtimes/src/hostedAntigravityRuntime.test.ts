import { describe, expect, it } from 'vitest'
import type { RuntimeEvent } from '@forge/shared'
import type { ProcessManager } from './process/processManager'
import { claudeSessionId } from './claudeSession'
import { HostedAntigravityRuntime } from './hostedAntigravityRuntime'

const ESC = String.fromCharCode(27)
const CLEAR = `${ESC}[2J${ESC}[H`
const READY = `${CLEAR}----\r\n❯ Enter prompt (for shortcuts)\r\n----\r\n`
const WORKING = `${CLEAR}> the prompt\r\n* Searching...\r\nesc to interrupt\r\n`
const ANSWERED = `${CLEAR}> the prompt\r\n* done\r\n----\r\n❯ (for shortcuts)\r\n`

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
  new HostedAntigravityRuntime({ processes, sleep: () => new Promise((r) => setTimeout(r, 1)) })

const settle = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise<void>((r) => setTimeout(r, 5))
}

function packet() {
  return {
    role: 'planner' as const,
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

describe('HostedAntigravityRuntime argv and flags (#168)', () => {
  it('launches interactively with load-bearing --add-dir workspace flag', async () => {
    const { processes, state } = makeProcesses()
    await runtime(processes).start({ repositoryPath: 'd:/my-repo', role: 'planner' })

    expect(state.command).toBe('agy')
    expect(state.args).toContain('--add-dir=d:/my-repo')
    // No headless/stream flags
    expect(state.args).not.toContain('--output-format=stream-json')
    expect(state.args).not.toContain('--safe-mode')
    expect(state.args).not.toContain('--permission-mode')
  })

  it('maps permission modes to Go flags for agy', async () => {
    const { processes: p1, state: s1 } = makeProcesses()
    await runtime(p1).start({
      repositoryPath: 'd:/my-repo',
      role: 'planner',
      permissionMode: 'plan',
    })
    expect(s1.args).toContain('--mode=plan')

    const { processes: p2, state: s2 } = makeProcesses()
    await runtime(p2).start({
      repositoryPath: 'd:/my-repo',
      role: 'implementer',
      permissionMode: 'acceptEdits',
    })
    expect(s2.args).toContain('--mode=accept-edits')

    const { processes: p3, state: s3 } = makeProcesses()
    await runtime(p3).start({
      repositoryPath: 'd:/my-repo',
      role: 'implementer',
      permissionMode: 'bypassPermissions',
    })
    expect(s3.args).toContain('--mode=auto')
    expect(s3.args).toContain('--dangerously-skip-permissions')
  })

  it('attaches --conversation when resumeKey is provided', async () => {
    const { processes, state } = makeProcesses()
    const resumeKey = { workflowId: 'wf-1', stepIndex: 0, iteration: 1 }
    await runtime(processes).start({
      repositoryPath: 'd:/my-repo',
      role: 'implementer',
      resumeKey,
    })

    expect(state.args).toContain(`--conversation=${claudeSessionId(resumeKey)}`)
  })

  it('wires onProcess callback to attach terminal pane', async () => {
    const { processes } = makeProcesses()
    let attached = false
    await runtime(processes).start({
      repositoryPath: 'd:/my-repo',
      role: 'implementer',
      onProcess: () => {
        attached = true
      },
    })

    expect(attached).toBe(true)
  })
})

describe('HostedAntigravityRuntime preflight refusal (#168)', () => {
  it('detects pre-flight eligibility check failure and reports retryable: true, providerLimit: false', async () => {
    const { processes, state } = makeProcesses()
    const rt = runtime(processes)
    const handle = await rt.start({ repositoryPath: 'd:/my-repo', role: 'planner' })

    // Simulate pre-flight eligibility failure in stdout
    state.emit('Eligibility check failed: failed to get profile picture\r\n')

    const events: RuntimeEvent[] = []
    const collectPromise = (async () => {
      for await (const ev of rt.events(handle)) {
        events.push(ev)
        if (ev.type === 'error') break
      }
    })()

    await rt.send(handle, packet())

    await collectPromise

    const errorEvent = events.find(
      (e): e is Extract<RuntimeEvent, { type: 'error' }> => e.type === 'error',
    )
    expect(errorEvent).toBeDefined()
    if (errorEvent) {
      expect(errorEvent.retryable).toBe(true)
      expect(errorEvent.providerLimit).toBe(false)
      expect(errorEvent.message).toMatch(/pre-flight eligibility check failed/i)
    }

    const st = await rt.status(handle)
    expect(st.state).toBe('failed')
  })

  it('handles clean prompt answer when no preflight refusal occurs', async () => {
    const { processes, state } = makeProcesses()
    const rt = runtime(processes)
    const handle = await rt.start({ repositoryPath: 'd:/my-repo', role: 'planner' })

    const events: RuntimeEvent[] = []
    const collectPromise = (async () => {
      for await (const ev of rt.events(handle)) {
        events.push(ev)
        if (ev.type === 'state' && ev.state === 'completed') break
      }
    })()

    // Emit initial ready prompt
    state.emit(READY)
    const sendPromise = rt.send(handle, packet())
    await settle()
    state.emit(WORKING)
    await settle()
    state.emit(ANSWERED)

    await sendPromise
    await collectPromise

    const completedState = events.find((e) => e.type === 'state' && e.state === 'completed')
    expect(completedState).toBeDefined()

    const st = await rt.status(handle)
    expect(st.state).toBe('completed')
  })
})
