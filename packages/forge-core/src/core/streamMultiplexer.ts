/**
 * AGENT-014: Agent streaming turn event dispatcher and structured tool output consumer.
 * Coordinates real-time token streams, partial tool call accumulations, and backpressure signals without event loss (Axioms A1, A5).
 */

export interface StreamTokenDelta {
  readonly token: string
  readonly accumulatedText: string
  readonly tokenCount: number
  readonly timestamp: string
}

export interface StreamToolDelta {
  readonly index: number
  readonly nameChunk?: string | undefined
  readonly argChunk?: string | undefined
  readonly accumulatedName: string
  readonly accumulatedArgs: string
  readonly timestamp: string
}

export interface FinalizedToolCall {
  readonly index: number
  readonly name: string
  readonly rawArgs: string
  readonly parsedArgs: Record<string, unknown> | null
  readonly validJson: boolean
}

export interface StreamTurnSummary {
  readonly valid: boolean
  readonly totalTokens: number
  readonly elapsedMs: number
  readonly completedText: string
  readonly toolCalls: readonly FinalizedToolCall[]
  readonly finishReason: string
  readonly formattedSummary: string
  readonly error?: string | undefined
}

export interface MultiplexerOptions {
  readonly maxTokenBudget?: number | undefined
  readonly maxBufferBytes?: number | undefined
  readonly onToken?: ((delta: StreamTokenDelta) => void) | undefined
  readonly onTool?: ((delta: StreamToolDelta) => void) | undefined
}

interface MutableToolState {
  index: number
  name: string
  args: string
}

const DEFAULT_MAX_TOKEN_BUDGET = 32_000
const DEFAULT_MAX_BUFFER_BYTES = 1_048_576 // 1MB

/**
 * Event-driven multiplexer for streaming LLM turn chunks and tool invocations (Axioms A1, A5).
 */
export class AgentStreamMultiplexer {
  private readonly maxTokens: number
  private readonly maxBytes: number
  private readonly onToken?: ((delta: StreamTokenDelta) => void) | undefined
  private readonly onTool?: ((delta: StreamToolDelta) => void) | undefined

  private accumulatedText = ''
  private tokenCount = 0
  private readonly startTimeMs: number
  private readonly tools = new Map<number, MutableToolState>()
  private finalized = false

  constructor(options: MultiplexerOptions = {}) {
    this.maxTokens = options.maxTokenBudget ?? DEFAULT_MAX_TOKEN_BUDGET
    this.maxBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES
    this.onToken = options.onToken
    this.onTool = options.onTool
    this.startTimeMs = Date.now()
  }

  /**
   * Pushes a streaming token chunk to the buffer.
   */
  public pushToken(token: string): StreamTokenDelta {
    if (this.finalized) {
      throw new Error('Cannot push token to a finalized stream multiplexer')
    }

    if (this.accumulatedText.length + token.length > this.maxBytes) {
      throw new Error(
        `Stream buffer exceeded maximum byte capacity of ${String(this.maxBytes)} bytes`,
      )
    }

    this.accumulatedText += token
    this.tokenCount++

    if (this.tokenCount > this.maxTokens) {
      throw new Error(`Token stream exceeded max token budget limit of ${String(this.maxTokens)}`)
    }

    const delta: StreamTokenDelta = {
      token,
      accumulatedText: this.accumulatedText,
      tokenCount: this.tokenCount,
      timestamp: new Date().toISOString(),
    }

    if (this.onToken) {
      this.onToken(delta)
    }

    return delta
  }

  /**
   * Pushes a streaming tool call fragment, accumulating partial names and JSON argument chunks.
   */
  public pushToolDelta(index: number, nameChunk?: string, argChunk?: string): StreamToolDelta {
    if (this.finalized) {
      throw new Error('Cannot push tool delta to a finalized stream multiplexer')
    }

    let state = this.tools.get(index)
    if (!state) {
      state = { index, name: '', args: '' }
      this.tools.set(index, state)
    }

    if (nameChunk) {
      state.name += nameChunk
    }
    if (argChunk) {
      state.args += argChunk
    }

    if (state.args.length > this.maxBytes) {
      throw new Error(
        `Tool arguments for tool index ${String(index)} exceeded buffer ceiling of ${String(this.maxBytes)} bytes`,
      )
    }

    const delta: StreamToolDelta = {
      index,
      nameChunk,
      argChunk,
      accumulatedName: state.name,
      accumulatedArgs: state.args,
      timestamp: new Date().toISOString(),
    }

    if (this.onTool) {
      this.onTool(delta)
    }

    return delta
  }

  /**
   * Finalizes the turn stream and returns a structured summary with parsed tool parameters.
   */
  public finalize(finishReason = 'stop'): StreamTurnSummary {
    if (this.finalized) {
      throw new Error('Stream multiplexer has already been finalized')
    }
    this.finalized = true
    const elapsedMs = Math.max(0, Date.now() - this.startTimeMs)

    const finalizedTools: FinalizedToolCall[] = []
    const sortedEntries = Array.from(this.tools.values()).sort((a, b) => a.index - b.index)

    for (const tool of sortedEntries) {
      let parsed: Record<string, unknown> | null = null
      let validJson = false

      if (tool.args.trim() !== '') {
        try {
          const res = JSON.parse(tool.args) as unknown
          if (typeof res === 'object' && res !== null && !Array.isArray(res)) {
            parsed = res as Record<string, unknown>
            validJson = true
          }
        } catch {
          validJson = false
        }
      } else {
        parsed = {}
        validJson = true
      }

      finalizedTools.push({
        index: tool.index,
        name: tool.name.trim(),
        rawArgs: tool.args,
        parsedArgs: parsed,
        validJson,
      })
    }

    const lines: string[] = [
      'STREAM TURN SUMMARY (AGENT-014):',
      `  Total Tokens:   ${String(this.tokenCount)}`,
      `  Elapsed:        ${String(elapsedMs)}ms`,
      `  Finish Reason:  ${finishReason}`,
      `  Tool Calls:     ${String(finalizedTools.length)}`,
    ]

    for (const tc of finalizedTools) {
      lines.push(
        `  • [Tool #${String(tc.index)}] ${tc.name || '(unnamed)'} (valid JSON: ${tc.validJson ? 'YES' : 'NO'})`,
      )
    }

    return {
      valid: true,
      totalTokens: this.tokenCount,
      elapsedMs,
      completedText: this.accumulatedText,
      toolCalls: finalizedTools,
      finishReason,
      formattedSummary: lines.join('\n'),
    }
  }

  public getAccumulatedText(): string {
    return this.accumulatedText
  }

  public getTokenCount(): number {
    return this.tokenCount
  }
}
