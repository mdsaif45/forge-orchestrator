import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../test/tempDir'
import { runAgentLoop, type CompletionResult, type LoopMessage } from './agentLoop'
import type { ToolContext } from './tools'

/**
 * The tool-calling loop.
 *
 * The model is scripted so the loop's own behaviour is what is under test: that
 * it feeds real tool results back, stops when the model answers, and stops
 * anyway when it does not.
 */

const dirs: string[] = []

const makeWorkspace = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'forge-loop-'))
  dirs.push(root)
  mkdirSync(join(root, 'src'))
  writeFileSync(join(root, 'src', 'math.ts'), 'export const answer = 40\n')
  return root
}

const tools = (root: string, overrides: Partial<ToolContext> = {}): ToolContext => ({
  workspacePath: root,
  allowedPaths: ['src/**'],
  forbiddenPaths: [],
  canWrite: true,
  ...overrides,
})

const answer = (content: string): CompletionResult => ({
  ok: true,
  content,
  reasoning: '',
  toolCalls: [],
  error: null,
})

const callTool = (name: string, args: Record<string, unknown>): CompletionResult => ({
  ok: true,
  content: '',
  reasoning: '',
  toolCalls: [{ id: `c-${name}`, name, args }],
  error: null,
})

/** Replays a fixed sequence of completions, recording what it was sent. */
const scriptedModel = (script: readonly CompletionResult[]) => {
  const seen: readonly LoopMessage[][] = []
  const sent: LoopMessage[][] = seen as LoopMessage[][]
  let index = 0
  return {
    sent,
    complete: (messages: readonly LoopMessage[]) => {
      sent.push([...messages])
      const next = script[index] ?? answer('(script exhausted)')
      index += 1
      return Promise.resolve(next)
    },
  }
}

afterEach(async () => {
  for (const dir of dirs.splice(0)) await removeTempDir(dir)
})

describe('runAgentLoop', () => {
  it('returns immediately when the model answers with no tool calls', async () => {
    const root = makeWorkspace()
    const model = scriptedModel([answer('Hello.')])

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }],
      tools: tools(root),
      complete: model.complete,
    })

    expect(result.ok).toBe(true)
    expect(result.content).toBe('Hello.')
    expect(result.rounds).toBe(1)
    expect(result.toolsUsed).toEqual([])
  })

  it('executes a tool and feeds the real result back to the model', async () => {
    // The heart of it: the second completion must be able to see the file's
    // actual contents, which is what a chat model could never do before.
    const root = makeWorkspace()
    const model = scriptedModel([
      callTool('read_file', { path: 'src/math.ts' }),
      answer('The constant is 40.'),
    ])

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'what is the constant?' }],
      tools: tools(root),
      complete: model.complete,
    })

    expect(result.ok).toBe(true)
    expect(result.toolsUsed).toEqual([{ name: 'read_file', ok: true }])

    const secondPrompt = model.sent[1] ?? []
    const toolMessage = secondPrompt.find((message) => message.role === 'tool')
    expect(toolMessage?.content).toContain('answer = 40')
  })

  it('actually writes a file when the model asks it to', async () => {
    const root = makeWorkspace()
    const model = scriptedModel([
      callTool('write_file', { path: 'src/math.ts', content: 'export const answer = 42\n' }),
      answer('Fixed.'),
    ])

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'fix it' }],
      tools: tools(root),
      complete: model.complete,
    })

    expect(result.ok).toBe(true)
    expect(readFileSync(join(root, 'src', 'math.ts'), 'utf8')).toContain('42')
  })

  it('feeds a refusal back rather than aborting, so the model can change course', async () => {
    // A refusal is information. Ending the turn on one would leave the model no
    // chance to take a path it is permitted.
    const root = makeWorkspace()
    const model = scriptedModel([
      callTool('write_file', { path: 'package.json', content: '{}' }),
      answer('That is out of scope, so I left it alone.'),
    ])

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'edit package.json' }],
      tools: tools(root),
      complete: model.complete,
    })

    expect(result.ok).toBe(true)
    expect(result.toolsUsed).toEqual([{ name: 'write_file', ok: false }])

    const secondPrompt = model.sent[1] ?? []
    const toolMessage = secondPrompt.find((message) => message.role === 'tool')
    expect(toolMessage?.content).toMatch(/outside the task scope/i)
  })

  it('runs several rounds of tools before answering', async () => {
    const root = makeWorkspace()
    const model = scriptedModel([
      callTool('list_dir', { path: '.' }),
      callTool('read_file', { path: 'src/math.ts' }),
      answer('Done.'),
    ])

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'explore' }],
      tools: tools(root),
      complete: model.complete,
    })

    expect(result.rounds).toBe(3)
    expect(result.toolsUsed.map((t) => t.name)).toEqual(['list_dir', 'read_file'])
  })

  it('stops at the round cap and says so instead of returning a partial answer', async () => {
    // A model looping on the same call must be cut off, and the caller must be
    // able to tell that from a real answer (A5).
    const root = makeWorkspace()
    const model = scriptedModel(
      Array.from({ length: 20 }, () => callTool('read_file', { path: 'src/math.ts' })),
    )

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'loop' }],
      tools: tools(root),
      complete: model.complete,
      maxRounds: 3,
    })

    expect(result.ok).toBe(false)
    expect(result.stoppedAtLimit).toBe(true)
    expect(result.rounds).toBe(3)
    expect(result.error).toMatch(/3 tool rounds/)
  })

  it('reports a provider failure without pretending to have an answer', async () => {
    const root = makeWorkspace()
    const model = scriptedModel([
      { ok: false, content: '', reasoning: '', toolCalls: [], error: 'connection refused' },
    ])

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }],
      tools: tools(root),
      complete: model.complete,
    })

    expect(result.ok).toBe(false)
    expect(result.error).toBe('connection refused')
    expect(result.content).toBe('')
  })

  it('accumulates reasoning across rounds', async () => {
    const root = makeWorkspace()
    const model = scriptedModel([
      { ...callTool('read_file', { path: 'src/math.ts' }), reasoning: 'first ' },
      { ...answer('done'), reasoning: 'second' },
    ])

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }],
      tools: tools(root),
      complete: model.complete,
    })

    expect(result.reasoning).toBe('first second')
  })

  it('reports each tool starting and finishing, for a live view', async () => {
    const root = makeWorkspace()
    const model = scriptedModel([callTool('read_file', { path: 'src/math.ts' }), answer('ok')])
    const events: string[] = []

    await runAgentLoop({
      messages: [{ role: 'user', content: 'hi' }],
      tools: tools(root),
      complete: model.complete,
      onEvent: (event) => events.push(event.kind),
    })

    expect(events).toContain('tool-start')
    expect(events).toContain('tool-end')
  })
})
