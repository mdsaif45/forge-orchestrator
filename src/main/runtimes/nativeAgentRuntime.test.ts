import { describe, expect, it } from 'vitest'
import { promptPacketSchema, type PromptPacket, type RuntimeEvent } from '@shared/domain'
import type { runAgentTurn } from '../providers/agentTurn'
import { NativeAgentRuntime, type NativeAgentRuntimeOptions } from './nativeAgentRuntime'

/**
 * These assert the runtime's own contract — how a turn's events become runtime
 * events, and what state a failure leaves behind. The turn is injected, so no
 * provider is reached and nothing here depends on a model's behaviour.
 */

/**
 * Built through the schema rather than written out, so a new required field
 * fails here instead of these tests silently exercising a packet the app would
 * never send.
 */
const packet: PromptPacket = promptPacketSchema.parse({
  role: 'implementer',
  objective: 'change the thing',
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

/**
 * A turn result with only the fields a test cares about spelled out.
 *
 * The full type is wide and every field is required; restating it per case
 * would bury the one value each test is actually about.
 */
const turnResult = (
  fields: Partial<Awaited<ReturnType<typeof runAgentTurn>>>,
): Awaited<ReturnType<typeof runAgentTurn>> => ({
  ok: true,
  content: '',
  reasoning: '',
  toolsUsed: [],
  rounds: 1,
  error: null,
  stoppedAtLimit: false,
  plan: {
    capabilities: { tools: true, vision: false, thinking: false, source: 'reported' },
    usedTools: false,
  },
  ...fields,
})

const runtimeWith = (
  runTurn: NonNullable<NativeAgentRuntimeOptions['runTurn']>,
  resolveModel: NativeAgentRuntimeOptions['resolveModel'] = () => ({
    providerId: 'ollama',
    model: 'llama3.2',
  }),
) => new NativeAgentRuntime({ resolveModel, runTurn })

/**
 * Everything the runtime has queued for a session.
 *
 * Reads the queue rather than iterating `events()`: a hosted session stays open
 * for the next prompt, so the iterator never completes and draining it would
 * need a timeout — which encodes this machine's timing into the test. Disposing
 * first ends the stream on a condition instead, so the loop terminates because
 * the session closed, not because a clock expired.
 */
const drain = async (
  runtime: NativeAgentRuntime,
  handle: Awaited<ReturnType<NativeAgentRuntime['start']>>,
): Promise<readonly RuntimeEvent[]> => {
  const collected: RuntimeEvent[] = []
  const iterator = runtime.events(handle)[Symbol.asyncIterator]()

  // The first pull is what resolves the session, and it returns immediately
  // because `send` has already queued events. Only then dispose: doing it first
  // would delete the session before the generator ever looked it up.
  const first = await iterator.next()
  if (first.done !== true) collected.push(first.value)
  await runtime.dispose(handle)

  for (let next = await iterator.next(); next.done !== true; next = await iterator.next()) {
    collected.push(next.value)
  }

  return collected
}

describe('NativeAgentRuntime', () => {
  it('reports tool progress as a tool event, never as report text', async () => {
    // The regression this pins: exchange() accumulates every chunk into the text
    // it parses a report out of, so a tool progress line arriving as a chunk
    // corrupts the report rather than informing the user.
    const runtime = runtimeWith((_request, onEvent) => {
      onEvent({ kind: 'tool', text: 'read_file src/index.ts' })
      onEvent({ kind: 'reasoning', text: 'thinking about it' })
      return Promise.resolve(turnResult({ content: '{"status":"done"}' }))
    })

    const handle = await runtime.start({ repositoryPath: '.', role: 'implementer' })
    await runtime.send(handle, packet)
    const events = await drain(runtime, handle)

    const names = events.flatMap((e) => (e.type === 'tool' ? [e.name] : []))
    expect(names).toEqual(['read_file src/index.ts'])

    // Exactly one chunk, and it is the answer — not the reasoning, not the tool.
    const chunks = events.flatMap((e) => (e.type === 'chunk' ? [e.text] : []))
    expect(chunks).toEqual(['{"status":"done"}'])
  })

  it('asks which model to use at send time, so a change mid-session takes effect', async () => {
    const seen: string[] = []
    let model = 'llama3.2'
    const runtime = runtimeWith(
      (request) => {
        seen.push(request.model)
        return Promise.resolve(turnResult({ content: 'ok' }))
      },
      () => ({ providerId: 'ollama', model }),
    )

    const handle = await runtime.start({ repositoryPath: '.', role: 'implementer' })
    await runtime.send(handle, packet)
    model = 'qwen2.5-coder'
    await runtime.send(handle, packet)

    expect(seen).toEqual(['llama3.2', 'qwen2.5-coder'])
  })

  it('marks a round-cap stop retryable and an unreachable provider not', async () => {
    for (const [stoppedAtLimit, retryable] of [
      [true, true],
      [false, false],
    ] as const) {
      const runtime = runtimeWith(() =>
        Promise.resolve(turnResult({ ok: false, error: 'no', stoppedAtLimit })),
      )

      const handle = await runtime.start({ repositoryPath: '.', role: 'implementer' })
      await runtime.send(handle, packet)
      // Before draining: draining disposes the session, and a disposed session
      // has no status to report.
      expect((await runtime.status(handle)).state).toBe('failed')

      const events = await drain(runtime, handle)
      const errors = events.flatMap((e) => (e.type === 'error' ? [e.retryable] : []))
      expect(errors).toEqual([retryable])
    }
  })

  it('says no model is selected rather than failing against a guessed one', async () => {
    // The regression: a hardcoded default model failed as "model not found"
    // against a model the user never chose, which points at the provider
    // instead of at the empty setting.
    let called = false
    const runtime = runtimeWith(
      () => {
        called = true
        return Promise.resolve(turnResult({}))
      },
      () => null,
    )

    const handle = await runtime.start({ repositoryPath: '.', role: 'implementer' })
    await runtime.send(handle, packet)

    expect(called).toBe(false)
    const events = await drain(runtime, handle)
    const messages = events.flatMap((e) => (e.type === 'error' ? [e.message] : []))
    expect(messages).toEqual(['No model is selected. Choose one in Settings, then run again.'])
  })

  it('never claims to be simulated, because it does real work', () => {
    const runtime = runtimeWith(() => Promise.resolve(turnResult({ content: 'x' })))
    expect(runtime.simulated).toBe(false)
    // No account to isolate: one configured endpoint or key serves every session.
    expect(runtime.supportsAccountIsolation).toBe(false)
  })
})
