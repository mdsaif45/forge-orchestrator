import { appendFileSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../test/tempDir'
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

/**
 * Polls until a condition holds, rather than settling a fixed number of ticks.
 *
 * The hook path waits out `waitForBootSettled`, which needs several consecutive
 * polls where the screen does not change. How many macrotasks that takes depends
 * on the host, so a fixed count encodes one machine's timing — and worse, any
 * screen written while that wait is running resets it, so a test that paints too
 * early hangs instead of failing usefully.
 */
const until = async (condition: () => boolean): Promise<void> => {
  for (let i = 0; i < 400 && !condition(); i += 1) {
    await new Promise<void>((r) => setTimeout(r, 5))
  }
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

/**
 * The hook-driven path, which is what the app actually runs.
 *
 * Every test above drives the screen-only `runTurn` fallback, reached only when
 * no `hookReceiverDir` is configured. `src/main/index.ts` does configure one, so
 * a real workflow takes `runTurnByHook` instead — the branch that was verified
 * against the real CLI but had no test of its own. These cover all three ways
 * its race can end (hook, dialog, timeout) plus how the prompt is delivered and
 * when the hooks are installed, using the real `ClaudeHookBridge` against a
 * temp worktree so the log-file contract is exercised rather than mocked.
 */
describe('HostedClaudeRuntime hook-driven turns', () => {
  const dirs: string[] = []

  afterEach(async () => {
    for (const dir of dirs.splice(0)) await removeTempDir(dir)
  })

  const makeDirs = (): { worktree: string; receiverDir: string } => {
    const worktree = mkdtempSync(join(tmpdir(), 'forge-hosted-hook-'))
    const receiverDir = mkdtempSync(join(tmpdir(), 'forge-hosted-recv-'))
    dirs.push(worktree, receiverDir)
    return { worktree, receiverDir }
  }

  /** Stands in for the CLI's own hook runner: appends exactly what the receiver would. */
  const fireStopHook = (worktree: string, lastAssistantMessage: string): void => {
    appendFileSync(
      join(worktree, '.claude', 'forge-hooks.jsonl'),
      `${JSON.stringify({
        kind: 'stop',
        at: Date.now(),
        raw: JSON.stringify({
          session_id: 'sess-1',
          last_assistant_message: lastAssistantMessage,
        }),
      })}\n`,
      'utf8',
    )
  }

  /**
   * A fake clock that still keeps durations in PROPORTION, unlike the flat 1ms
   * `sleep` the screen-only tests above use.
   *
   * `runTurnByHook` races the turn deadline (600s) against the dialog poll
   * (500ms). A `sleep` that ignores its argument collapses those to the same
   * duration, so the deadline can win a race it should never win and every
   * outcome becomes arbitrary. Measured: with a flat 1ms sleep the dialog test
   * reported "did not finish within its budget" instead of the dialog.
   */
  const hookRuntime = (processes: ProcessManager, receiverDir: string) =>
    new HostedClaudeRuntime({
      processes,
      hookReceiverDir: receiverDir,
      sleep: (ms) => new Promise((r) => setTimeout(r, Math.max(1, Math.round(ms / 500)))),
    })

  it('completes the turn from the Stop hook, emitting the reply exactly once', async () => {
    // The reply arrives whole in the hook payload, and exchange() accumulates
    // every `chunk` it sees into the text it parses a report from. Emitting the
    // message twice — once here and once from raw terminal output — would feed
    // it a doubled transcript (#130).
    const { worktree, receiverDir } = makeDirs()
    const { processes, state } = makeProcesses()
    const hosted = hookRuntime(processes, receiverDir)
    const session = await hosted.start({ repositoryPath: worktree, role: 'implementer' })

    const chunks: string[] = []
    const states: string[] = []
    const collecting = (async () => {
      for await (const event of hosted.events(session)) {
        if (event.type === 'chunk') chunks.push(event.text)
        if (event.type === 'state') {
          states.push(event.state)
          if (event.state === 'completed') break
        }
      }
    })()

    state.emit(READY)
    const sending = hosted.send(session, packet())

    // Wait for the prompt to actually be submitted before painting anything
    // else: the first turn waits out boot noise, and a screen written during
    // that wait resets it.
    await until(() => state.written.includes('\r'))

    // The screen stays busy: completion must come from the hook, not from the
    // screen looking idle — the distinction the four rejected heuristics missed.
    state.emit(WORKING)
    fireStopHook(worktree, 'REPORT: the work is done')

    await sending
    await collecting

    expect(chunks).toEqual(['REPORT: the work is done'])
    expect(states.at(-1)).toBe('completed')
  })

  it('delivers the prompt as a bracketed paste, submitted separately', async () => {
    // Measured: a ~1300-char prompt written plainly is captured by the CLI's own
    // paste-timing heuristic with no markers saying where it began, and only the
    // tail survives to what gets submitted (#169).
    const { worktree, receiverDir } = makeDirs()
    const { processes, state } = makeProcesses()
    const hosted = hookRuntime(processes, receiverDir)
    const session = await hosted.start({ repositoryPath: worktree, role: 'implementer' })

    state.emit(READY)
    const sending = hosted.send(session, packet())
    await until(() => state.written.includes('\r'))
    fireStopHook(worktree, 'done')
    await sending

    const pasted = state.written.find((w) => w.includes(`${ESC}[200~`)) ?? ''
    expect(pasted).toContain(`${ESC}[200~`)
    expect(pasted).toContain(`${ESC}[201~`)
    // The objective must be inside the markers, not stranded outside them.
    expect(pasted.slice(pasted.indexOf(`${ESC}[200~`))).toContain('the prompt')
    // Enter is its own write: inside the paste it would be literal text.
    expect(state.written.at(-1)).toBe('\r')
  })

  it('fails retryably when a dialog appears mid-turn, since no Stop will ever fire', async () => {
    // A blocked turn produces no `Stop` at all, so the screen watch is the only
    // thing that can notice it. Without this arm the race would sit on the
    // hook until the whole turn budget expired.
    const { worktree, receiverDir } = makeDirs()
    const { processes, state } = makeProcesses()
    const hosted = hookRuntime(processes, receiverDir)
    const session = await hosted.start({ repositoryPath: worktree, role: 'implementer' })

    state.emit(READY)
    const sending = hosted.send(session, packet())
    await until(() => state.written.includes('\r'))
    state.emit(PERMISSION)
    await sending

    const status = await hosted.status(session)
    expect(status.state).toBe('failed')
    expect(status.failure).toMatch(/permission dialog/i)
  })

  it('fails the turn when neither the hook nor a dialog arrives in budget', async () => {
    // The budget has to outlast the boot-settle wait but still expire, or the
    // turn fails for the wrong reason ("never presented a prompt") and the test
    // would pass while proving nothing about the timeout arm.
    const { worktree, receiverDir } = makeDirs()
    const { processes, state } = makeProcesses()
    const hosted = hookRuntime(processes, receiverDir)
    const session = await hosted.start({
      repositoryPath: worktree,
      role: 'implementer',
      // Scaled by the fake clock above to ~100ms: long enough for the prompt to
      // be typed and the race to start, short enough to expire during the test.
      timeoutMs: 50_000,
    })

    state.emit(READY)
    const sending = hosted.send(session, packet())
    await until(() => state.written.includes('\r'))
    // Busy forever: no Stop hook is ever fired, and no dialog ever painted.
    state.emit(WORKING)
    await sending

    const status = await hosted.status(session)
    expect(status.state).toBe('failed')
    expect(status.failure).toMatch(/budget/i)
  })

  it('installs the hooks before the CLI spawns, so the first turn already reports', async () => {
    // Installing after spawn would leave turn one on the fallback path, which is
    // exactly the unreliable behaviour hooks exist to replace.
    const { worktree, receiverDir } = makeDirs()
    const { processes } = makeProcesses()
    await hookRuntime(processes, receiverDir).start({
      repositoryPath: worktree,
      role: 'planner',
    })

    const settings = JSON.parse(
      readFileSync(join(worktree, '.claude', 'settings.local.json'), 'utf8'),
    ) as { hooks?: Record<string, unknown> }
    expect(Object.keys(settings.hooks ?? {})).toContain('Stop')
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
