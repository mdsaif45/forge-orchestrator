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

describe('requireOneOf', () => {
  it('asks once more when the turn answered without changing anything', async () => {
    // The reported failure: asked to update a file, the model read it and
    // replied with a plan. Measured on a local 4B model, that happened on every
    // attempt of three; a stronger prompt raised it to two in three, which is
    // why the loop checks rather than trusting the instruction to land.
    const root = makeWorkspace()
    const model = scriptedModel([
      callTool('read_file', { path: 'src/math.ts' }),
      answer('Here is what I would change: ...'),
      callTool('write_file', { path: 'src/math.ts', content: 'export const answer = 42\n' }),
      answer('Changed it to 42.'),
    ])

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'change the constant' }],
      tools: tools(root),
      complete: model.complete,
      requireOneOf: ['write_file'],
    })

    expect(result.ok).toBe(true)
    expect(result.toolsUsed.some((tool) => tool.name === 'write_file')).toBe(true)
    expect(readFileSync(join(root, 'src', 'math.ts'), 'utf8')).toContain('42')

    // The nudge is a real message the model can act on, not a silent retry.
    const afterNudge = model.sent[2] ?? []
    expect(afterNudge.at(-1)?.content).toMatch(/have not changed anything yet/i)
  })

  it('uses the round reasoning when the model finishes work but says nothing', async () => {
    // Measured against a real model: given the report instructions it edited
    // the file correctly and returned an empty final message, so the caller
    // had a finished step with nothing to parse. The model did say what it
    // did — in the reasoning channel the loop was discarding.
    const root = makeWorkspace()
    const model = scriptedModel([
      callTool('write_file', { path: 'src/math.ts', content: 'export const answer = 42\n' }),
      {
        ok: true,
        content: '',
        reasoning: 'I set the constant to 42.',
        toolCalls: [],
        error: null,
      },
    ])

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'fix it' }],
      tools: tools(root),
      complete: model.complete,
    })

    expect(result.ok).toBe(true)
    expect(result.content).toBe('I set the constant to 42.')
  })

  it('keeps an empty answer empty when no tool ran, rather than inventing one', async () => {
    // Only a turn that did work gets the fallback. A model that neither acted
    // nor answered has produced nothing, and reasoning is not an answer.
    const root = makeWorkspace()
    const model = scriptedModel([
      { ok: true, content: '', reasoning: 'thinking out loud', toolCalls: [], error: null },
    ])

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'hello' }],
      tools: tools(root),
      complete: model.complete,
    })

    expect(result.content).toBe('')
  })

  it('offers the configured tool list rather than every definition it knows', async () => {
    // The loop used to pass the module's whole TOOL_DEFINITIONS on every round
    // and ignore what it was configured with. That worked only because the one
    // caller filtered them again afterwards; a narrower list would have been
    // silently discarded.
    const root = makeWorkspace()
    const offered: number[] = []
    const model = {
      complete: (
        _messages: readonly LoopMessage[],
        tools: readonly { readonly function: { readonly name: string } }[],
      ) => {
        offered.push(tools.length)
        return Promise.resolve(answer('done'))
      },
    }

    await runAgentLoop({
      messages: [{ role: 'user', content: 'hello' }],
      tools: tools(root),
      toolDefinitions: [],
      complete: model.complete,
    })

    expect(offered).toEqual([0])
  })

  it('accepts the answer when the required tool was already used', async () => {
    const root = makeWorkspace()
    const model = scriptedModel([
      callTool('write_file', { path: 'src/math.ts', content: 'x\n' }),
      answer('Done.'),
    ])

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'change it' }],
      tools: tools(root),
      complete: model.complete,
      requireOneOf: ['write_file'],
    })

    expect(result.content).toBe('Done.')
    // Two completions, not three: nothing was owed, so nothing was asked again.
    expect(model.sent).toHaveLength(2)
  })

  it('asks only once, so a model that declines twice does not loop', async () => {
    // Arguing with it would spend the whole round budget for nothing.
    const root = makeWorkspace()
    const model = scriptedModel([answer('I would change it like this...'), answer('Still a plan.')])

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'change it' }],
      tools: tools(root),
      complete: model.complete,
      requireOneOf: ['write_file'],
      maxRounds: 6,
    })

    expect(result.ok).toBe(true)
    expect(result.content).toBe('Still a plan.')
    expect(model.sent).toHaveLength(2)
  })

  it('does not require a change when the request needed none', async () => {
    const root = makeWorkspace()
    const model = scriptedModel([answer('The constant is 40.')])

    const result = await runAgentLoop({
      messages: [{ role: 'user', content: 'what is it?' }],
      tools: tools(root),
      complete: model.complete,
      // Empty means nothing is owed, which is how a read-only turn behaves.
      requireOneOf: [],
    })

    expect(result.content).toBe('The constant is 40.')
    expect(model.sent).toHaveLength(1)
  })
})
