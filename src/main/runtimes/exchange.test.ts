import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { promptPacketSchema, REPORT_BEGIN, type PromptPacket } from '@shared/domain'
import { exchange } from './exchange'
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
