import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  promptPacketSchema,
  renderPromptPacket,
  REPORT_BEGIN,
  runtimeIdSchema,
  sessionIdSchema,
  type Capability,
  type IAgentRuntime,
  type PromptPacket,
  type SessionOptions,
  type RuntimeEvent,
  type RuntimeStatus,
  type SessionHandle,
} from '@shared/domain'
import { exchange, type ExchangeOutcome } from './exchange'
import { MockAgentRuntime } from './mockRuntime'
import { SCENARIOS, type Scenario } from './scenario'

/**
 * The exchange: packet out, validated report in, one re-prompt.
 *
 * Driven through a real runtime rather than by calling the parser directly, because the
 * behaviour under test is the *sequence* — send, collect a turn's events, parse, and on
 * failure send again with the validation error attached. The parsing rules themselves are
 * covered in `shared/domain/protocol.test.ts`.
 */

let workDir: string

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'forge-exchange-'))
})

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true })
})

function packet(overrides: Partial<PromptPacket> = {}): PromptPacket {
  return promptPacketSchema.parse({
    role: 'implementer',
    objective: 'Correct the constant',
    constraints: [],
    rules: ['Never guess.'],
    lockedDecisions: [],
    allowedPaths: ['src/**'],
    forbiddenPaths: [],
    relevantFiles: [],
    reviewFindings: [],
    previousAttempt: null,
    completionCriteria: [],
    answeredQuestions: [],
    ...overrides,
  })
}

async function run(scenario: Scenario) {
  const runtime = new MockAgentRuntime({ scenario })
  const session = await runtime.start({ repositoryPath: workDir, role: 'implementer' })

  try {
    return await exchange(runtime, session, packet())
  } finally {
    await runtime.dispose(session)
  }
}

describe('a structured result', () => {
  it('is used directly, with no extraction needed', async () => {
    // A runtime that already produces a validated report has done the protocol's job for
    // it. Both paths exist because a real CLI prints prose while the mock can do either.
    const outcome = await run(SCENARIOS.happy)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.report.summary).toBe('Corrected the constant')
    expect(outcome.assessment.verdict).toBe('accept')
    expect(outcome.retried).toBe(false)
  })
})

describe('a report printed as prose', () => {
  it('is extracted from the surrounding chatter', async () => {
    // The path a real adapter takes: stdout with narration around a fenced block.
    const outcome = await run(SCENARIOS.textReply)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.report.filesChanged).toEqual(['src/math.ts'])
    expect(outcome.retried).toBe(false)
  })

  it('sends the rendered packet, including the reply instructions', async () => {
    const outcome = await run(SCENARIOS.textReply)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    const [sent] = outcome.transcript
    expect(sent).toContain('ROLE\nimplementer')
    expect(sent).toContain('1. Never guess.')
    // Without this the agent has no way to know what shape to reply in.
    expect(sent).toContain(REPORT_BEGIN)
  })
})

describe('the single re-prompt', () => {
  it('recovers when the agent forgets the report block', async () => {
    const outcome = await run(SCENARIOS.noReport)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.retried).toBe(true)
    expect(outcome.report.summary).toBe('Corrected the constant')
  })

  it('feeds the actual validation error back, not a generic complaint', async () => {
    // The whole reason for validating with a schema is that the failure is specific
    // enough to act on; a vague "invalid report" would make the retry a guess.
    const outcome = await run(SCENARIOS.noReport)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return

    const correction = outcome.transcript.find((entry) => entry.includes('REJECTED'))
    expect(correction).toBeDefined()
    expect(correction).toContain(REPORT_BEGIN)
    // And it tells the agent not to redo the work, only the report.
    expect(correction).toMatch(/do not redo the work/i)
  })

  it('gives up after one retry rather than looping', async () => {
    // A model that cannot follow the protocol twice will not follow it a third time, and
    // looping would spend the workflow's iteration budget discovering that repeatedly.
    const outcome = await run(SCENARIOS.malformedTwice)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure).toBe('protocol')
    expect(outcome.code).toBe('schema-violation')
    expect(outcome.retried).toBe(true)
    // Two prompts and two replies: the retry happened, and nothing beyond it.
    expect(outcome.transcript.filter((entry) => entry.includes('ROLE'))).toHaveLength(2)
  })
})

describe('what a valid report means', () => {
  it('routes a question to the user and pauses', async () => {
    const outcome = await run(SCENARIOS.question)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.assessment.verdict).toBe('await-user')
    expect(outcome.report.openQuestions).toHaveLength(1)
    // R2: the evidence trail is what distinguishes a question from "I don't know".
    expect(outcome.report.openQuestions.at(0)?.evidence.length).toBeGreaterThan(0)
  })

  it('halts on an admitted assumption', async () => {
    const outcome = await run(SCENARIOS.assumer)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    // Structurally valid, and still not acceptable: R1 makes an assumption a violation.
    expect(outcome.assessment.verdict).toBe('halt-assumption')
  })

  it('accepts a liar, because this layer cannot detect one', async () => {
    // Stated explicitly so the boundary is not mistaken for a gap: the report is
    // well-formed, so the protocol accepts it. Catching the lie needs a real diff (#34).
    const outcome = await run(SCENARIOS.liar)

    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.assessment.verdict).toBe('accept')
    expect(outcome.report.filesChanged).toEqual(['src/math.ts'])
  })
})

describe('a runtime that breaks', () => {
  it('reports a crash as a runtime failure, not a protocol one', async () => {
    // The distinction decides whether a retry could help: a crash may be worth retrying,
    // a malformed report is a protocol problem.
    const outcome = await run(SCENARIOS.crash)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure).toBe('runtime')
    expect(outcome.code).toBeNull()
  })

  it('reports an auth failure as a runtime failure', async () => {
    const outcome = await run(SCENARIOS.authFailure)

    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.failure).toBe('runtime')
    expect(outcome.message).toMatch(/authenticate/i)
  })
})

/**
 * A runtime that records the packets it is handed, and replies with a malformed report
 * the first time and a valid one the second.
 *
 * Records the *packet*, not the transcript. The defect this covers wrote the correction
 * into the transcript and sent the unchanged packet, so a transcript assertion passed
 * while no agent ever saw a correction — the only witness is what `send` received.
 */
class RecordingRuntime implements IAgentRuntime {
  readonly id = runtimeIdSchema.parse('recording')
  // Widened, not `as const`: an `as const` tuple is not assignable to the interface's
  // `readonly Capability[]`, and the resulting mismatch degrades the whole class to an
  // error type rather than pointing at this line.
  readonly capabilities: readonly Capability[] = ['repo-read', 'plan', 'file-write', 'review']
  readonly simulated = true
  readonly supportsAccountIsolation = false

  readonly received: PromptPacket[] = []
  private readonly queue: RuntimeEvent[] = []
  private wake: (() => void) | null = null

  start(_options: SessionOptions): Promise<SessionHandle> {
    return Promise.resolve({ sessionId: sessionIdSchema.parse('rec-1'), runtimeId: this.id })
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async send(_session: SessionHandle, packet: PromptPacket): Promise<void> {
    this.received.push(packet)

    const text =
      this.received.length === 1
        ? 'I finished the work but forgot the fences.'
        : `${REPORT_BEGIN}\n{"status":"completed","summary":"Done","filesChanged":[],"commandsRun":[],"testsRun":false,"assumptions":[],"openQuestions":[]}\nFORGE_REPORT_END`

    this.push({ type: 'chunk', at: '2026-01-01T00:00:00.000Z', text })
    this.push({ type: 'state', at: '2026-01-01T00:00:00.000Z', state: 'completed' })
  }

  async *events(_session: SessionHandle): AsyncIterable<RuntimeEvent> {
    for (;;) {
      if (this.queue.length === 0) {
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
        this.wake = null
      }
      while (this.queue.length > 0) {
        const event = this.queue.shift()
        if (event !== undefined) yield event
      }
    }
  }

  status(_session: SessionHandle): Promise<RuntimeStatus> {
    return {
      sessionId: sessionIdSchema.parse('rec-1'),
      state: 'idle',
      failure: null,
      lastActivityAt: '2026-01-01T00:00:00.000Z',
    }
  }

  cancel(_session: SessionHandle, _reason: string): Promise<void> {
    return Promise.resolve()
  }

  dispose(_session: SessionHandle): Promise<void> {
    return Promise.resolve()
  }

  private push(event: RuntimeEvent): void {
    this.queue.push(event)
    if (this.wake !== null) {
      this.wake()
      this.wake = null
    }
  }
}

describe('the correction on the re-prompt', () => {
  it('reaches the agent, because a runtime renders from the packet it is sent', async () => {
    const runtime = new RecordingRuntime()
    // Annotated because `tsconfig.test.json` does not resolve this class's inferred
    // return type under the lint program, which then reports the argument below as
    // untyped. The annotation is the assertion that it is a SessionHandle.
    const session: SessionHandle = await runtime.start({
      repositoryPath: workDir,
      role: 'reviewer',
    })

    const packet = promptPacketSchema.parse({
      role: 'reviewer',
      objective: 'Review the change',
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

    const outcome = await exchange(runtime, session, packet)

    expect(outcome.ok).toBe(true)
    expect(outcome.retried).toBe(true)
    expect(runtime.received).toHaveLength(2)

    // The first attempt carries no correction; the second must.
    expect(runtime.received[0]?.correction).toBeNull()
    expect(runtime.received[1]?.correction).not.toBeNull()
    expect(runtime.received[1]?.correction).toContain('REJECTED')

    // And it must survive rendering, since that is the text the process receives.
    const rendered = renderPromptPacket(runtime.received[1]!)
    expect(rendered).toContain('REJECTED')
    expect(rendered).toContain('Do not redo the work')

    // The two attempts must differ. Byte-identical retries were the actual bug: a real
    // agent gave the same malformed reply twice and the run halted blaming the agent.
    expect(renderPromptPacket(runtime.received[0]!)).not.toEqual(rendered)
  })
})

describe('event forwarding (#152)', () => {
  const runObserved = async (
    scenario: Scenario,
    onEvent?: (event: RuntimeEvent) => void,
  ): Promise<ExchangeOutcome> => {
    const runtime = new MockAgentRuntime({ scenario })
    const session = await runtime.start({ repositoryPath: workDir, role: 'implementer' })
    try {
      return await exchange(runtime, session, packet(), onEvent)
    } finally {
      await runtime.dispose(session)
    }
  }

  it('produces an identical outcome with and without an observer', async () => {
    // The contract that makes streaming safe to add: observing must not change the
    // protocol. A fresh runtime per run, because a session is consumed by its turn.
    const withoutObserver = await runObserved(SCENARIOS.happy)

    const seen: RuntimeEvent[] = []
    const withObserver = await runObserved(SCENARIOS.happy, (event) => seen.push(event))

    expect(withObserver).toEqual(withoutObserver)
    expect(seen.length).toBeGreaterThan(0)
  })

  it('forwards a tool event, which is the whole point of the live view', async () => {
    const seen: RuntimeEvent[] = []
    await runObserved(SCENARIOS.happy, (event) => seen.push(event))

    expect(seen.some((event) => event.type === 'tool')).toBe(true)
  })

  it('forwards terminal events, not only the ones before them', async () => {
    // A consumer that stopped at the last non-terminal event would show a step that
    // starts and never visibly ends.
    const seen: RuntimeEvent[] = []
    await runObserved(SCENARIOS.happy, (event) => seen.push(event))

    const terminal = seen.filter(
      (event) =>
        event.type === 'result' ||
        event.type === 'error' ||
        (event.type === 'state' && event.state !== 'working'),
    )
    expect(terminal.length).toBeGreaterThan(0)
  })

  it('keeps forwarding across the re-prompt, not just the first attempt', async () => {
    // `noReport` replies without a report block, which triggers the single correction
    // re-prompt. Observation has to survive that second turn, or the live view goes
    // blank at exactly the moment a user most needs to see what is happening.
    const seen: RuntimeEvent[] = []
    const outcome = await runObserved(SCENARIOS.noReport, (event) => seen.push(event))

    expect(outcome.retried).toBe(true)
    // Two turns' worth of `working` transitions is what shows the retry really ran.
    const working = seen.filter((e) => e.type === 'state' && e.state === 'working')
    expect(working.length).toBeGreaterThanOrEqual(2)
  })
})
