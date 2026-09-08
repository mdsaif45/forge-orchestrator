import { runTool, TOOL_DEFINITIONS, type ToolContext } from './tools'

/**
 * The loop that turns a chat model into an agent.
 *
 * A CLI agent runs its own loop and Forge hosts it. A raw model returns one
 * message and stops, so the loop has to live here: ask the model, execute the
 * tools it asked for, feed the results back, ask again, until it answers with
 * no further tool calls.
 *
 * ```
 * prompt ─> model ─┬─> tool_calls ─> execute ─> results ─┐
 *                  │                                     │
 *                  └─> content, no calls ─> done         └─> back to the model
 * ```
 *
 * Bounded on both axes (A5). An unbounded loop with a model deciding when to
 * stop is exactly the runaway this project has guards for elsewhere, and a local
 * model that mis-reads a tool result will otherwise retry it forever.
 */

export interface LoopMessage {
  readonly role: 'system' | 'user' | 'assistant' | 'tool'
  readonly content: string
  /** Present on an assistant turn that asked for tools. */
  readonly toolCalls?: readonly ToolCall[] | undefined
  /** Present on a tool result, tying it back to the call it answers. */
  readonly toolCallId?: string | undefined
}

export interface ToolCall {
  readonly id: string
  readonly name: string
  readonly args: Readonly<Record<string, unknown>>
}

/** One completion, as the loop needs it. */
export interface CompletionResult {
  readonly ok: boolean
  readonly content: string
  readonly reasoning: string
  readonly toolCalls: readonly ToolCall[]
  readonly error: string | null
}

export interface AgentLoopOptions {
  readonly messages: readonly LoopMessage[]
  readonly tools: ToolContext
  /** Asks the model for one completion, given the conversation so far. */
  readonly complete: (
    messages: readonly LoopMessage[],
    // A readonly list rather than the literal tuple type: a caller may send
    // none, which is how a model without tool support degrades to plain chat.
    tools: readonly (typeof TOOL_DEFINITIONS)[number][],
  ) => Promise<CompletionResult>
  /** Reports progress: a tool about to run, and what it returned. */
  readonly onEvent?: ((event: AgentLoopEvent) => void) | undefined
  /**
   * Tool-executing rounds allowed before the loop stops.
   *
   * Ten is enough for a real task — read a few files, run the tests, write a
   * change — and small enough that a model stuck in a read-the-same-file cycle
   * is cut off rather than running until a timeout.
   */
  readonly maxRounds?: number | undefined
}

export type AgentLoopEvent =
  /**
   * One round's reasoning, emitted as the round completes.
   *
   * Reported per round rather than only summed at the end: the reasoning
   * explains the tool calls that follow it, and delivering it all at once made
   * the transcript show tools streaming while the thinking appeared afterwards
   * in a single block, out of sequence with the work it described.
   */
  | { readonly kind: 'reasoning'; readonly text: string }
  | { readonly kind: 'tool-start'; readonly name: string; readonly args: string }
  | {
      readonly kind: 'tool-end'
      readonly name: string
      readonly ok: boolean
      readonly summary: string
    }
  | { readonly kind: 'text'; readonly text: string }

export interface AgentLoopResult {
  readonly ok: boolean
  readonly content: string
  readonly reasoning: string
  /** Every tool the model actually ran, in order — the audit trail for the turn. */
  readonly toolsUsed: readonly { readonly name: string; readonly ok: boolean }[]
  readonly rounds: number
  readonly error: string | null
  /** True when the round cap ended the turn rather than the model finishing. */
  readonly stoppedAtLimit: boolean
}

const DEFAULT_MAX_ROUNDS = 10

/** A one-line summary of a tool result, for the progress stream. */
function summarise(content: string): string {
  const firstLine = content.split('\n')[0] ?? ''
  return firstLine.length > 120 ? `${firstLine.slice(0, 120)}…` : firstLine
}

export async function runAgentLoop(options: AgentLoopOptions): Promise<AgentLoopResult> {
  const maxRounds = options.maxRounds ?? DEFAULT_MAX_ROUNDS
  const conversation: LoopMessage[] = [...options.messages]
  const toolsUsed: { name: string; ok: boolean }[] = []

  let reasoning = ''

  for (let round = 0; round < maxRounds; round += 1) {
    const completion = await options.complete(conversation, TOOL_DEFINITIONS)

    if (completion.reasoning !== '') {
      reasoning += completion.reasoning
      options.onEvent?.({ kind: 'reasoning', text: completion.reasoning })
    }

    if (!completion.ok) {
      return {
        ok: false,
        content: completion.content,
        reasoning,
        toolsUsed,
        rounds: round,
        error: completion.error,
        stoppedAtLimit: false,
      }
    }

    // No tool calls means the model has answered.
    if (completion.toolCalls.length === 0) {
      if (completion.content !== '') options.onEvent?.({ kind: 'text', text: completion.content })
      return {
        ok: true,
        content: completion.content,
        reasoning,
        toolsUsed,
        rounds: round + 1,
        error: null,
        stoppedAtLimit: false,
      }
    }

    conversation.push({
      role: 'assistant',
      content: completion.content,
      toolCalls: completion.toolCalls,
    })

    for (const call of completion.toolCalls) {
      options.onEvent?.({
        kind: 'tool-start',
        name: call.name,
        args: JSON.stringify(call.args).slice(0, 200),
      })

      const result = await runTool(call.name, call.args, options.tools)
      toolsUsed.push({ name: call.name, ok: result.ok })

      options.onEvent?.({
        kind: 'tool-end',
        name: call.name,
        ok: result.ok,
        summary: summarise(result.content),
      })

      // A refusal is fed back as a tool result rather than aborting the turn: the
      // model can then choose a path it is allowed to take, which is the whole
      // point of explaining why it was refused.
      conversation.push({
        role: 'tool',
        content: result.content,
        toolCallId: call.id,
      })
    }
  }

  // The cap was reached. Reported rather than presented as an answer, because a
  // truncated turn that reads as complete is the failure this is guarding.
  return {
    ok: false,
    content: '',
    reasoning,
    toolsUsed,
    rounds: maxRounds,
    error: `Stopped after ${String(maxRounds)} tool rounds without a final answer.`,
    stoppedAtLimit: true,
  }
}
