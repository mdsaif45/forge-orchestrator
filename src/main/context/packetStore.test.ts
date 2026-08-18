import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { compileContext, promptPacketSchema, type PromptPacket } from '@shared/domain'
import { taskIdSchema } from '@shared/domain'
import { PacketStore } from './packetStore'

/**
 * Packet snapshots.
 *
 * A step stores a reference, not a packet, so these tests are about the reference being
 * trustworthy: the same context must produce the same reference, and a reference must never
 * resolve to something other than what was written. Replay and audit both rest on that.
 */

let directory: string
let store: PacketStore

function packet(overrides: Partial<PromptPacket> = {}): PromptPacket {
  return promptPacketSchema.parse({
    role: 'implementer',
    objective: 'Correct the constant',
    constraints: [],
    rules: ['Never guess.'],
    lockedDecisions: [],
    allowedPaths: ['src/**'],
    forbiddenPaths: [],
    relevantFiles: ['src/math.ts'],
    reviewFindings: [],
    previousAttempt: { summary: 'Set it to 41', diffStat: '1 file, +1 -1' },
    completionCriteria: ['the tests pass'],
    answeredQuestions: [{ question: 'Which value?', answer: '42' }],
    ...overrides,
  })
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'forge-packets-'))
  store = new PacketStore({ directory })
})

afterEach(() => {
  rmSync(directory, { recursive: true, force: true })
})

describe('saving and loading', () => {
  it('round-trips a packet unchanged', async () => {
    const subject = packet()
    const reference = await store.save(subject)

    expect(await store.load(reference)).toEqual(subject)
  })

  it('preserves nested objects', async () => {
    // Regression, and the reason this store does not use `JSON.stringify`'s replacer-array
    // form: measured, that form applies the key list at every depth, so `previousAttempt`
    // serialised as `{}` and `answeredQuestions` lost its contents. A snapshot like that
    // would replay the wrong context with nothing to indicate anything was missing.
    const reference = await store.save(packet())
    const loaded = await store.load(reference)

    expect(loaded?.previousAttempt).toEqual({ summary: 'Set it to 41', diffStat: '1 file, +1 -1' })
    expect(loaded?.answeredQuestions).toEqual([{ question: 'Which value?', answer: '42' }])
    expect(loaded?.relevantFiles).toEqual(['src/math.ts'])
  })

  it('resolves an unknown reference to null rather than throwing', async () => {
    expect(await store.load('0'.repeat(32))).toBeNull()
  })
})

describe('content addressing', () => {
  it('gives identical packets the same reference and writes one file', async () => {
    const first = await store.save(packet())
    const second = await store.save(packet())

    expect(second).toBe(first)
    expect(readdirSync(directory)).toHaveLength(1)
  })

  it('gives different packets different references', async () => {
    const first = await store.save(packet())
    const second = await store.save(packet({ objective: 'Something else' }))

    expect(second).not.toBe(first)
    expect(readdirSync(directory)).toHaveLength(2)
  })

  it('is insensitive to key order', async () => {
    // A reference that depended on key order would break the audit property: the same
    // context, assembled by a different caller, would appear to be a different packet.
    const ordered = promptPacketSchema.parse({
      role: 'implementer',
      objective: 'Correct the constant',
      constraints: [],
      rules: ['Never guess.'],
      lockedDecisions: [],
      allowedPaths: ['src/**'],
      forbiddenPaths: [],
      relevantFiles: ['src/math.ts'],
      reviewFindings: [],
      previousAttempt: { summary: 'Set it to 41', diffStat: '1 file, +1 -1' },
      completionCriteria: ['the tests pass'],
      answeredQuestions: [{ question: 'Which value?', answer: '42' }],
    })

    // Rebuilt with the keys in reverse, which is what a differently-written caller produces.
    const reversed = promptPacketSchema.parse(Object.fromEntries(Object.entries(ordered).reverse()))

    expect(await store.save(reversed)).toBe(await store.save(ordered))
  })

  it('refuses a reference whose file no longer matches it', async () => {
    // The point of content addressing: a reference cannot resolve to a packet that has been
    // edited since. Returning the edited packet would let replay send different context
    // while claiming to send the original.
    const reference = await store.save(packet())
    const file = join(directory, `${reference}.json`)

    const tampered = JSON.parse(readFileSync(file, 'utf8')) as PromptPacket
    writeFileSync(
      file,
      JSON.stringify({ ...tampered, objective: 'Do something else entirely' }, null, 2),
    )

    expect(await store.load(reference)).toBeNull()
  })

  it('rejects a snapshot that is no longer a valid packet', async () => {
    // A file written by an older version with a different shape must fail loudly rather than
    // flow into a step as a plausible-looking packet. The hash is recomputed from the file,
    // so this reaches the schema rather than the mismatch check.
    const invalid = JSON.stringify({ role: 'implementer' }, null, 2)
    const { createHash } = await import('node:crypto')
    const reference = createHash('sha256').update(invalid).digest('hex').slice(0, 32)
    writeFileSync(join(directory, `${reference}.json`), invalid)

    await expect(store.load(reference)).rejects.toThrow()
  })
})

describe('with the context engine', () => {
  it('gives the same reference for the same compiled context', async () => {
    // The property a resumed step depends on: recompiling identical state and re-saving must
    // produce the same `contextRef`, which is what makes "did the resumed step send the same
    // context?" checkable rather than hopeful.
    const compileInput = {
      role: 'implementer' as const,
      task: {
        id: taskIdSchema.parse('7c9e6679-7425-40de-944b-e07fc1f90ae7'),
        objective: 'Correct the constant',
        constraints: [],
        completionCriteria: [{ kind: 'tests' as const, description: 'the tests pass', params: {} }],
        scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
        lockedDecisionIds: [],
        correctsTaskId: null,
        createdAt: '2026-08-19T10:00:00.000Z',
      },
      rules: [],
      lockedDecisions: [],
      files: [{ path: 'src/math.ts', inScope: true }],
      previousAttempt: null,
      reviewFindings: [],
      answeredQuestions: [],
    }

    const first = await store.save(compileContext(compileInput).packet)
    const second = await store.save(compileContext(compileInput).packet)

    expect(second).toBe(first)
  })
})
