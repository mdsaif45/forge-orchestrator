import { describe, expect, it, vi } from 'vitest'
import { HostedSession } from './hostedSession'

const ESC = String.fromCharCode(27)

/**
 * Time is injected, never waited on. A test that sleeps encodes one machine's
 * timing; these drive the clock so a slow CI box and a fast laptop agree.
 */
const makeSession = (options: { timeoutMs?: number } = {}) => {
  const written: string[] = []
  // Yields to the macrotask queue rather than resolving instantly. A microtask
  // resolve spins the poll loop to its deadline without ever letting the test
  // feed the next screen, which reads as a timeout in a session that is fine.
  const session = new HostedSession({
    write: (data) => written.push(data),
    sleep: () => new Promise<void>((r) => setTimeout(r, 1)),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  })
  return { session, written }
}

/** Lets the polling loop observe a screen the test has just written. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i += 1) await new Promise<void>((r) => setTimeout(r, 5))
}

/**
 * A real TUI repaints in place: it clears and redraws rather than appending, so a
 * busy indicator is *overwritten* when the turn ends. Fixtures that simply append
 * lines leave "esc to interrupt" on screen forever and make a finished turn look
 * like a running one — which is exactly what these fixtures got wrong first.
 *
 * `CLEAR` is the escape the CLI itself emits (erase display, cursor home).
 */
const CLEAR = `${ESC}[2J${ESC}[H`

/** Screens trimmed from real emulator output against the installed CLI. */
const READY = `${CLEAR}----
> Try "edit"
----
? for shortcuts
`
const WORKING = `${CLEAR}> do the thing
* Searching for 1 pattern...
esc to interrupt
`
const ANSWERED = `${CLEAR}> do the thing
  read 1 file
* 42
----
> 
? for shortcuts
`
const TRUST = `${CLEAR}Quick safety check: Is this a project you created or one you trust?
`
const PERMISSION = `${CLEAR}Bash command
  Read data.txt
Do you want to proceed?
 1. Yes
`

describe('HostedSession', () => {
  it('reports the screen the emulator resolves, not the raw bytes', async () => {
    const { session } = makeSession()
    // Cursor addressing and colour: a regex over raw bytes destroyed an answer
    // that was on screen once already, which is why an emulator holds this.
    await session.receive('[2J[H[38;2;215;119;87mhello[m')
    expect(session.screen()).toContain('hello')
    expect(session.screen()).not.toContain('38;2;215')
  })

  it('waits for the prompt box before reporting ready', async () => {
    const { session } = makeSession({ timeoutMs: 50 })
    await session.receive('Claude Code v2.1.209\r\nWelcome back\r\n')

    // Booting is not ready: typing here sends characters into whatever is on
    // screen, which during a trust dialog means they vanish (#166).
    expect(await session.waitForPrompt()).toBe('timeout')

    await session.receive(READY)
    expect(await session.waitForPrompt()).toBe('ready')
  })

  it('reports a trust dialog instead of waiting it out', async () => {
    const { session } = makeSession({ timeoutMs: 50 })
    await session.receive(TRUST)
    expect(await session.waitForPrompt()).toBe('trust')
  })

  it('reports a permission dialog instead of waiting it out', async () => {
    const { session } = makeSession({ timeoutMs: 50 })
    await session.receive(PERMISSION)
    expect(await session.waitForPrompt()).toBe('permission')
  })

  it('types the prompt and submits it', async () => {
    const { session, written } = makeSession({ timeoutMs: 10 })
    await session.receive(READY)
    await session.runTurn('do the thing')

    expect(written).toEqual(['do the thing', '\r'])
  })

  it('does not call a turn complete before any work is seen', async () => {
    // The prompt box is on screen *before* the turn starts. Treating its
    // presence alone as completion returns the previous screen as this turn's
    // answer — the agent has done nothing yet.
    const { session } = makeSession({ timeoutMs: 30 })
    await session.receive(READY)

    const outcome = await session.runTurn('do the thing')
    expect(outcome.kind).toBe('timeout')
  })

  it('completes once work is seen and the session returns to idle', async () => {
    const { session } = makeSession({ timeoutMs: 5_000 })
    await session.receive(READY)

    const running = session.runTurn('do the thing')
    // Work appears, then the answer and an idle prompt.
    await session.receive(WORKING)
    await settle()
    await session.receive(ANSWERED)

    const outcome = await running
    expect(outcome.kind).toBe('answered')
    if (outcome.kind !== 'answered') return
    expect(outcome.screen).toContain('42')
  })

  it('reports a mid-turn permission dialog rather than treating it as an answer', async () => {
    // Measured: a real turn ran its tools and then stopped here with nothing
    // present to answer. Absorbing it would report the dialog text as the reply.
    const { session } = makeSession({ timeoutMs: 5_000 })
    await session.receive(READY)

    const running = session.runTurn('do the thing')
    await session.receive(WORKING)
    await settle()
    await session.receive(PERMISSION)

    const outcome = await running
    expect(outcome.kind).toBe('blocked')
    if (outcome.kind !== 'blocked') return
    expect(outcome.on).toBe('permission')
  })

  it('bounds the wait so a wedged CLI fails the step rather than hanging the run', async () => {
    const { session } = makeSession({ timeoutMs: 30 })
    await session.receive(READY)

    const running = session.runTurn('do the thing')
    await session.receive(WORKING)

    const outcome = await running
    expect(outcome.kind).toBe('timeout')
  })

  it('stays usable for a second turn', async () => {
    // The session is warm by construction: it answers many prompts and never
    // exits on its own, which is what removes the cold-start cost per stage.
    const { session, written } = makeSession({ timeoutMs: 5_000 })
    await session.receive(READY)

    const first = session.runTurn('first')
    await session.receive(WORKING)
    await settle()
    await session.receive(ANSWERED)
    expect((await first).kind).toBe('answered')

    const second = session.runTurn('second')
    await session.receive(WORKING)
    await settle()
    await session.receive(ANSWERED)
    expect((await second).kind).toBe('answered')

    expect(written).toEqual(['first', '\r', 'second', '\r'])
  })

  it('does not wait on the wall clock', async () => {
    // A test that sleeps encodes one machine's timing. This asserts the injected
    // clock is the only one used.
    const sleep = vi.fn(() => Promise.resolve())
    const session = new HostedSession({ write: () => undefined, sleep, timeoutMs: 20 })
    await session.receive('booting')

    await session.waitForPrompt()
    expect(sleep).toHaveBeenCalled()
  })
})
