import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  canHoldRole,
  hasDisqualifyingAssumptions,
  missingCapabilities,
  promptPacketSchema,
  runtimeEventSchema,
  type IAgentRuntime,
  type PromptPacket,
  type RuntimeEvent,
} from '@shared/domain'
import { GitService } from '../git'
import { IncapableRuntimeError, RuntimeRegistry, UnknownRuntimeError } from './registry'
import { MockAgentRuntime } from './mockRuntime'
import { SCENARIOS, type Scenario } from './scenario'

/**
 * The runtime abstraction and the scripted mock.
 *
 * The mock mutates a real temporary repository, so the dishonest scenarios are
 * genuinely dishonest: `liar` leaves the worktree untouched while claiming otherwise,
 * and a test can prove that with `git diff` rather than by trusting the fixture.
 */

let repoPath: string

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })
}

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'forge-runtime-'))
  git('init', '--quiet', '--initial-branch=main', '.')
  git('config', 'user.email', 'test@forge.local')
  git('config', 'user.name', 'Forge Test')
  git('config', 'commit.gpgsign', 'false')
  writeFileSync(join(repoPath, 'package.json'), '{ "name": "subject" }\n')
  execFileSync('node', ['-e', `require('fs').mkdirSync(${JSON.stringify(join(repoPath, 'src'))})`])
  writeFileSync(join(repoPath, 'src', 'math.ts'), 'export const answer = 41\n')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'base')
})

afterEach(() => {
  rmSync(repoPath, { recursive: true, force: true })
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

/** Drives one scenario to completion and returns every event it produced. */
async function run(
  scenario: Scenario,
  options: { readonly sends?: number } = {},
): Promise<{ readonly runtime: IAgentRuntime; readonly events: RuntimeEvent[] }> {
  const runtime = new MockAgentRuntime({ scenario })
  const session = await runtime.start({ repositoryPath: repoPath, role: 'implementer' })

  const collected: RuntimeEvent[] = []
  const reading = (async () => {
    for await (const event of runtime.events(session)) {
      collected.push(event)
    }
  })()

  for (let index = 0; index < (options.sends ?? 1); index += 1) {
    await runtime.send(session, packet())
  }

  // Disposal is what ends the stream, for every scenario. The runtime deliberately
  // does not close it on reaching a terminal state: a caller driving several steps
  // would otherwise lose the events of every step after the first.
  await runtime.dispose(session)

  await reading
  return { runtime, events: collected }
}

describe('the runtime registry', () => {
  it('resolves a registered runtime', () => {
    const registry = new RuntimeRegistry()
    const runtime = new MockAgentRuntime({ scenario: SCENARIOS.happy })
    registry.register(runtime)

    expect(registry.resolve(runtime.id)).toBe(runtime)
    expect(registry.has(runtime.id)).toBe(true)
    expect(registry.ids()).toEqual([runtime.id])
  })

  it('names what is registered when an id is unknown', () => {
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.happy, id: 'mock:one' }))

    // A bare "not found" would leave the user guessing what they could have used.
    expect(() => registry.resolve('missing')).toThrow(UnknownRuntimeError)
    expect(() => registry.resolve('missing')).toThrow(/mock:one/)
  })

  it('refuses a duplicate id rather than overwriting', () => {
    // Two adapters answering to one id would make which one runs depend on
    // registration order — an unreproducible bug waiting to happen.
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.happy, id: 'mock:dup' }))

    expect(() => {
      registry.register(new MockAgentRuntime({ scenario: SCENARIOS.liar, id: 'mock:dup' }))
    }).toThrow(/already registered/)
  })

  it('refuses a role the runtime cannot perform, naming the missing capability', () => {
    const registry = new RuntimeRegistry()
    const readOnly = new MockAgentRuntime({ scenario: SCENARIOS.readOnly })
    registry.register(readOnly)

    // Checked at binding time, not step time: otherwise this surfaces only once a
    // workflow is running, with a half-finished task to clean up.
    expect(() => registry.resolveForRole(readOnly.id, 'implementer')).toThrow(IncapableRuntimeError)
    expect(() => registry.resolveForRole(readOnly.id, 'implementer')).toThrow(/file-write/)

    // The same runtime is fine as a reviewer.
    expect(registry.resolveForRole(readOnly.id, 'reviewer')).toBe(readOnly)
  })

  it('lists only the runtimes eligible for a role', () => {
    const registry = new RuntimeRegistry()
    const full = new MockAgentRuntime({ scenario: SCENARIOS.happy, id: 'mock:full' })
    const readOnly = new MockAgentRuntime({ scenario: SCENARIOS.readOnly, id: 'mock:ro' })
    registry.register(full)
    registry.register(readOnly)

    expect(registry.candidatesForRole('implementer').map((r) => r.id)).toEqual(['mock:full'])
    expect(
      registry
        .candidatesForRole('reviewer')
        .map((r) => r.id)
        .sort(),
    ).toEqual(['mock:full', 'mock:ro'])
  })
})

describe('capability checks', () => {
  it('allows any runtime to hold any role it can perform', () => {
    // A6 in one assertion: roles are capability-based, not identity-based, which is
    // what makes planner and builder swappable.
    expect(canHoldRole(['repo-read', 'plan'], 'planner')).toBe(true)
    expect(canHoldRole(['repo-read', 'file-write'], 'implementer')).toBe(true)
    expect(canHoldRole(['repo-read', 'review'], 'reviewer')).toBe(true)
  })

  it('rejects a role whose capabilities are absent', () => {
    expect(canHoldRole(['repo-read'], 'implementer')).toBe(false)
    expect(missingCapabilities(['repo-read'], 'implementer')).toEqual(['file-write'])
  })

  it('needs no capability for the roles Forge performs itself', () => {
    expect(canHoldRole([], 'system')).toBe(true)
    expect(canHoldRole([], 'user')).toBe(true)
  })
})

describe('the mock runtime', () => {
  it('emits a validated event stream', async () => {
    const { events } = await run(SCENARIOS.happy)

    // Every event must satisfy the shared schema: an adapter that produced a
    // malformed event would otherwise fail deep inside the engine instead of here.
    for (const event of events) {
      expect(runtimeEventSchema.parse(event)).toBeTruthy()
    }

    expect(events.map((event) => event.type)).toEqual([
      'state',
      'state',
      'chunk',
      'chunk',
      'tool',
      'result',
      'state',
    ])
  })

  it('is deterministic across runs, timestamps included', async () => {
    // Two runs of one scenario must produce identical events. The clock is injected
    // and starts from a fixed origin precisely so this holds — a wall clock would
    // make a snapshotted prompt packet comparison report a change that never
    // happened.
    const first = await run(SCENARIOS.happy)
    const second = await run(SCENARIOS.happy)

    expect(second.events).toEqual(first.events)
    // Timestamps specifically, since they are the part a real clock would break.
    expect(second.events.map((event) => event.at)).toEqual(first.events.map((event) => event.at))
  })

  it('really changes the worktree, so evidence paths are exercised', async () => {
    await run(SCENARIOS.happy)

    expect(readFileSync(join(repoPath, 'src', 'math.ts'), 'utf8')).toBe(
      'export const answer = 42\n',
    )

    const diff = await new GitService({ repositoryPath: repoPath }).diffWorktree('HEAD')
    expect(diff.files.map((file) => file.path)).toEqual(['src/math.ts'])
  })

  it('exposes the liar: the report claims a change the repository does not show', async () => {
    // This is axiom A3's reason to exist, and the case a well-behaved mock could never
    // produce. The reconciliation itself is #34; this proves the fixture is honest
    // about being dishonest.
    const { events } = await run(SCENARIOS.liar)
    const result = events.find((event) => event.type === 'result')

    expect(result?.type === 'result' && result.report.filesChanged).toEqual(['src/math.ts'])
    expect(result?.type === 'result' && result.report.testsRun).toBe(true)

    const diff = await new GitService({ repositoryPath: repoPath }).diffWorktree('HEAD')
    expect(diff.files).toEqual([])
    expect(diff.patch.trim()).toBe('')
  })

  it('writes outside the allowed paths in the scope-creep scenario', async () => {
    await run(SCENARIOS.scopeCreep)

    const diff = await new GitService({ repositoryPath: repoPath }).diffWorktree('HEAD')

    // package.json is outside `src/**`, which the policy layer must halt on (#34/#37).
    expect(diff.files.map((file) => file.path).sort()).toEqual(['package.json', 'src/math.ts'])
  })

  it('raises a question with evidence rather than guessing', async () => {
    const { events } = await run(SCENARIOS.question)
    const result = events.find((event) => event.type === 'result')

    expect(result?.type === 'result' && result.report.status).toBe('question')
    const question = result?.type === 'result' ? result.report.openQuestions.at(0) : undefined
    // R2: a question without an evidence trail is rejected back to the agent.
    expect(question?.evidence.length).toBeGreaterThan(0)
    expect(question?.recommendation).toBe('403')
  })

  it('flags an admitted assumption as disqualifying', async () => {
    const { events } = await run(SCENARIOS.assumer)
    const result = events.find((event) => event.type === 'result')

    // R1 makes an assumption a violation, not a note, so the engine halts on it
    // rather than accepting the work.
    expect(result?.type === 'result' && hasDisqualifyingAssumptions(result.report)).toBe(true)
  })

  it('runs a correction loop across two sends', async () => {
    const { events } = await run(SCENARIOS.correction, { sends: 2 })
    const results = events.filter((event) => event.type === 'result')

    expect(results).toHaveLength(2)
    expect(readFileSync(join(repoPath, 'src', 'math.ts'), 'utf8')).toBe(
      'export const answer = 42\n',
    )
  })

  it('reports a crash as retryable', async () => {
    const { events } = await run(SCENARIOS.crash)
    const error = events.find((event) => event.type === 'error')

    expect(error?.type === 'error' && error.retryable).toBe(true)
    // R8: a crash may leave a partial edit, and the changeset must surface it rather
    // than hide it.
    expect(readFileSync(join(repoPath, 'src', 'math.ts'), 'utf8')).toBe('export const answer = \n')
  })

  it('reports an auth failure as NOT retryable', async () => {
    // Measured from the real CLI in the #20 spike: a retry cannot fix a missing
    // credential, and retrying would spend the iteration budget on a certainty.
    const { events } = await run(SCENARIOS.authFailure)
    const error = events.find((event) => event.type === 'error')

    expect(error?.type === 'error' && error.retryable).toBe(false)
    expect(error?.type === 'error' && error.message).toMatch(/authenticate/i)
  })

  it('goes silent without terminating, which the no-progress detector must catch', async () => {
    const runtime = new MockAgentRuntime({ scenario: SCENARIOS.timeout })
    const session = await runtime.start({ repositoryPath: repoPath, role: 'implementer' })

    await runtime.send(session, packet())
    const status = await runtime.status(session)

    // Still `working` with no result: nothing in the runtime will ever end this, so
    // the caller's own bound has to (#29).
    expect(status.state).toBe('working')
    expect(status.failure).toBeNull()

    await runtime.dispose(session)
  })

  it('refuses work after a terminal state', async () => {
    const runtime = new MockAgentRuntime({ scenario: SCENARIOS.authFailure })
    const session = await runtime.start({ repositoryPath: repoPath, role: 'implementer' })
    await runtime.send(session, packet())

    await expect(runtime.send(session, packet())).rejects.toThrow(/failed/)
  })

  it('refuses a send past the end of the script', async () => {
    const runtime = new MockAgentRuntime({ scenario: SCENARIOS.happy })
    const session = await runtime.start({ repositoryPath: repoPath, role: 'implementer' })
    await runtime.send(session, packet())

    // Silence would make an over-driven test look like it passed.
    await expect(runtime.send(session, packet())).rejects.toThrow(/nothing to run/)
  })

  it('cancels cleanly and treats a second cancel as a no-op', async () => {
    const runtime = new MockAgentRuntime({ scenario: SCENARIOS.timeout })
    const session = await runtime.start({ repositoryPath: repoPath, role: 'implementer' })
    await runtime.send(session, packet())

    await runtime.cancel(session, 'user stopped the workflow')
    expect((await runtime.status(session)).state).toBe('cancelled')

    // A workflow halting for its own reasons may cancel a session that just ended;
    // making that an error would turn a benign race into a spurious failure.
    await expect(runtime.cancel(session, 'again')).resolves.toBeUndefined()
  })

  it('disposes idempotently', async () => {
    const runtime = new MockAgentRuntime({ scenario: SCENARIOS.happy })
    const session = await runtime.start({ repositoryPath: repoPath, role: 'implementer' })

    await runtime.dispose(session)
    await expect(runtime.dispose(session)).resolves.toBeUndefined()
  })

  it('keeps sessions independent', async () => {
    const runtime = new MockAgentRuntime({ scenario: SCENARIOS.happy })
    const first = await runtime.start({ repositoryPath: repoPath, role: 'implementer' })
    const second = await runtime.start({ repositoryPath: repoPath, role: 'implementer' })

    expect(first.sessionId).not.toBe(second.sessionId)

    await runtime.send(first, packet())
    expect((await runtime.status(first)).state).toBe('completed')
    // The second session has its own step cursor.
    expect((await runtime.status(second)).state).toBe('idle')
  })
})

describe('every scenario', () => {
  it('is a valid script that reaches a defined outcome', async () => {
    // #22's definition of done: every terminal state reachable without a real agent.
    const outcomes = new Map<string, string>()

    for (const [name, scenario] of Object.entries(SCENARIOS)) {
      rmSync(repoPath, { recursive: true, force: true })
      repoPath = mkdtempSync(join(tmpdir(), 'forge-runtime-'))
      git('init', '--quiet', '--initial-branch=main', '.')
      git('config', 'user.email', 'test@forge.local')
      git('config', 'user.name', 'Forge Test')
      git('config', 'commit.gpgsign', 'false')
      writeFileSync(join(repoPath, 'package.json'), '{}\n')
      git('add', '-A')
      git('commit', '--quiet', '-m', 'base')

      const runtime = new MockAgentRuntime({ scenario })
      const session = await runtime.start({ repositoryPath: repoPath, role: 'implementer' })

      for (const _step of scenario.steps) {
        await runtime.send(session, packet())
      }

      outcomes.set(name, (await runtime.status(session)).state)
      await runtime.dispose(session)
    }

    expect(Object.fromEntries(outcomes)).toEqual({
      happy: 'completed',
      correction: 'completed',
      question: 'completed',
      assumer: 'completed',
      liar: 'completed',
      scopeCreep: 'completed',
      readOnly: 'completed',
      timeout: 'working',
      crash: 'failed',
      authFailure: 'failed',
      // A `text` ending returns to idle rather than completing: the session stays alive
      // waiting for the next instruction, which is how a real multi-step CLI behaves.
      textReply: 'idle',
      noReport: 'idle',
      malformedTwice: 'idle',
      noProgress: 'completed',
    })
  })
})

describe('axiom A6', () => {
  it('runs the whole flow with only a mock registered', async () => {
    // #21's definition of done. Nothing in this test names a provider: it registers a
    // runtime, resolves it by role, drives it, and reads the evidence.
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.happy }))

    const [only] = registry.list()
    expect(only).toBeDefined()
    if (only === undefined) return

    const runtime = registry.resolveForRole(only.id, 'implementer')
    const session = await runtime.start({ repositoryPath: repoPath, role: 'implementer' })
    await runtime.send(session, packet())

    const status = await runtime.status(session)
    expect(status.state).toBe('completed')

    const diff = await new GitService({ repositoryPath: repoPath }).diffWorktree('HEAD')
    expect(diff.files).toHaveLength(1)

    await runtime.dispose(session)
    expect(existsSync(repoPath)).toBe(true)
  })
})
