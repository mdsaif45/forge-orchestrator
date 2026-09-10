/**
 * Real Model Call Tracker for Development Mode.
 *
 * Captures authentic network requests sent to model endpoints (Ollama, OpenAI,
 * OpenRouter, LM Studio, etc.), exact wire payloads, response status codes,
 * raw model outputs, reasoning tokens, and tool execution results.
 *
 * No mock or synthetic data: every entry records actual runtime events.
 */

export interface DevModelCallRecord {
  readonly id: string
  readonly timestamp: number
  readonly timeFormatted: string
  readonly type: 'tool_completion' | 'chat_stream' | 'direct_chat'
  readonly providerId: string
  readonly model: string
  readonly endpointUrl: string
  readonly round?: number | undefined
  readonly request: {
    readonly method: string
    readonly headers: Record<string, string>
    readonly body: unknown
  }
  response?:
    | {
        readonly status: number
        readonly statusText: string
        readonly durationMs: number
        readonly rawBody?: unknown
        readonly reasoning?: string | undefined
        readonly content?: string | undefined
        readonly toolCalls?:
          | readonly {
              readonly id: string
              readonly name: string
              readonly args: unknown
            }[]
          | undefined
        readonly error?: string | null | undefined
      }
    | undefined
  toolExecutions?:
    | {
        readonly name: string
        readonly args: unknown
        readonly ok: boolean
        readonly output: string
        readonly durationMs: number
      }[]
    | undefined
}

type ModelCallListener = (record: DevModelCallRecord) => void

class DevModelTrackerService {
  private readonly history: DevModelCallRecord[] = []
  private readonly maxEntries = 100
  private readonly listeners = new Set<ModelCallListener>()

  /** Sanitizes headers so auth tokens are not exposed in plaintext. */
  sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
    const sanitized: Record<string, string> = {}
    for (const [key, value] of Object.entries(headers)) {
      if (key.toLowerCase() === 'authorization') {
        sanitized[key] = value.length > 15 ? `${value.slice(0, 11)}...***` : '***'
      } else {
        sanitized[key] = value
      }
    }
    return sanitized
  }

  /** Starts recording a new model API call before the HTTP request is dispatched. */
  startCall(params: {
    readonly type: 'tool_completion' | 'chat_stream' | 'direct_chat'
    readonly providerId: string
    readonly model: string
    readonly endpointUrl: string
    readonly round?: number | undefined
    readonly method?: string | undefined
    readonly headers: Record<string, string>
    readonly body: unknown
  }): DevModelCallRecord {
    const now = new Date()
    const record: DevModelCallRecord = {
      id: `call-${String(now.getTime())}-${Math.random().toString(36).slice(2, 7)}`,
      timestamp: now.getTime(),
      timeFormatted: now.toLocaleTimeString(),
      type: params.type,
      providerId: params.providerId,
      model: params.model,
      endpointUrl: params.endpointUrl,
      round: params.round,
      request: {
        method: params.method ?? 'POST',
        headers: this.sanitizeHeaders(params.headers),
        body: params.body,
      },
    }

    this.history.push(record)
    if (this.history.length > this.maxEntries) {
      this.history.shift()
    }

    if (process.env.NODE_ENV !== 'production') {
      console.warn(
        `[DevModelTracker] START ${record.type} -> ${record.model} (${record.endpointUrl}) [${record.id}]`,
      )
    }

    this.notify(record)
    return record
  }

  /** Completes an existing model call with the response received from the endpoint. */
  finishCall(
    callId: string,
    response: {
      readonly status: number
      readonly statusText: string
      readonly durationMs: number
      readonly rawBody?: unknown
      readonly reasoning?: string | undefined
      readonly content?: string | undefined
      readonly toolCalls?:
        | readonly {
            readonly id: string
            readonly name: string
            readonly args: unknown
          }[]
        | undefined
      readonly error?: string | null | undefined
    },
  ): void {
    const record = this.history.find((r) => r.id === callId)
    if (record) {
      record.response = response
      if (process.env.NODE_ENV !== 'production') {
        console.warn(
          `[DevModelTracker] FINISH [${callId}] status=${String(response.status)} duration=${String(response.durationMs)}ms tools=${String(response.toolCalls?.length ?? 0)}`,
        )
      }
      this.notify(record)
    }
  }

  /** Attaches a tool execution that resulted from this model turn. */
  recordToolExecution(
    callId: string,
    toolExecution: {
      readonly name: string
      readonly args: unknown
      readonly ok: boolean
      readonly output: string
      readonly durationMs: number
    },
  ): void {
    const record = this.history.find((r) => r.id === callId)
    if (record) {
      record.toolExecutions = record.toolExecutions ?? []
      record.toolExecutions.push(toolExecution)
      this.notify(record)
    }
  }

  /** Returns all tracked model calls currently in the ring buffer. */
  getHistory(): readonly DevModelCallRecord[] {
    return [...this.history]
  }

  /** Clears the call history. */
  clear(): void {
    this.history.length = 0
  }

  /** Registers a listener for real-time model call events. */
  subscribe(listener: ModelCallListener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private notify(record: DevModelCallRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(record)
      } catch {
        // Safe listener execution
      }
    }
  }
}

export const devModelTracker = new DevModelTrackerService()
