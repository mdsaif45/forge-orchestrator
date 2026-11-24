/**
 * Agent Tool Call Streaming Chunk Pipeline & Incremental Observer (AGENT-032).
 *
 * Implements real-time chunked streaming of tool stdout/stderr output with
 * high-watermark backpressure throttling, bounded ring buffering, monotonic
 * sequence indexing, and incremental observer state projections (A1, A4, A5).
 */

export type ChunkChannel = 'stdout' | 'stderr' | 'system'

export type FlowControlState = 'FLOWING' | 'PAUSED_BACKPRESSURE' | 'DRAINED' | 'COMPLETED' | 'ERROR'

export interface StreamingChunk {
  readonly sequenceNumber: number
  readonly channel: ChunkChannel
  readonly data: string
  readonly byteLength: number
  readonly timestamp: number
}

export interface PipelineMetrics {
  readonly totalChunks: number
  readonly totalBytes: number
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly systemBytes: number
  readonly peakBufferBytes: number
  readonly currentBufferBytes: number
  readonly backpressurePauseCount: number
  readonly activeObservers: number
  readonly isFlowing: boolean
}

export interface StreamingChunkConfig {
  /** Maximum bytes buffered before flow control triggers backpressure (default: 64KB). */
  readonly highWatermarkBytes?: number | undefined
  /** Low watermark threshold to resume flowing after backpressure (default: 16KB). */
  readonly lowWatermarkBytes?: number | undefined
  /** Maximum bytes retained in ring buffer before oldest chunks are evicted (default: 128KB). */
  readonly maxRingBufferBytes?: number | undefined
  /** Maximum size of an individual chunk emitted (default: 16KB). */
  readonly maxChunkSizeBytes?: number | undefined
}

export type ChunkEvent =
  | { readonly type: 'chunk'; readonly chunk: StreamingChunk }
  | {
      readonly type: 'backpressure'
      readonly state: FlowControlState
      readonly bufferBytes: number
    }
  | { readonly type: 'status'; readonly metrics: PipelineMetrics }
  | { readonly type: 'complete'; readonly totalChunks: number; readonly totalBytes: number }
  | { readonly type: 'error'; readonly error: Error }

export type ChunkObserver = (event: ChunkEvent) => void

export interface StreamEvaluationResult {
  readonly chunksEmitted: number
  readonly totalBytesStreamed: number
  readonly stdoutBytes: number
  readonly stderrBytes: number
  readonly ringBufferSample: string
  readonly backpressurePauses: number
  readonly isHealthy: boolean
}

export class AgentToolStreamingChunkPipeline {
  private readonly highWatermarkBytes: number
  private readonly lowWatermarkBytes: number
  private readonly maxRingBufferBytes: number
  private readonly maxChunkSizeBytes: number

  private sequenceCounter = 0
  private currentBufferBytes = 0
  private peakBufferBytes = 0
  private totalChunks = 0
  private totalBytes = 0
  private stdoutBytes = 0
  private stderrBytes = 0
  private systemBytes = 0
  private backpressurePauseCount = 0

  private state: FlowControlState = 'FLOWING'
  private readonly ringBuffer: StreamingChunk[] = []
  private ringBufferCurrentBytes = 0

  private readonly observers = new Set<ChunkObserver>()
  private readonly drainResolvers: (() => void)[] = []

  constructor(config: StreamingChunkConfig = {}) {
    this.highWatermarkBytes = Math.max(512, config.highWatermarkBytes ?? 65_536)
    this.lowWatermarkBytes = Math.max(
      128,
      Math.min(this.highWatermarkBytes - 128, config.lowWatermarkBytes ?? 16_384),
    )
    this.maxRingBufferBytes = Math.max(512, config.maxRingBufferBytes ?? 131_072)
    this.maxChunkSizeBytes = Math.max(256, config.maxChunkSizeBytes ?? 16_384)
  }

  /**
   * Registers a chunk observer callback. Returns an unregister handle.
   */
  subscribe(observer: ChunkObserver): () => void {
    this.observers.add(observer)
    return () => {
      this.observers.delete(observer)
    }
  }

  /**
   * Pushes raw data into the pipeline. If the data exceeds `maxChunkSizeBytes`,
   * it is segmented into sequential chunks. Returns `false` if backpressure was triggered.
   */
  push(raw: string | Uint8Array, channel: ChunkChannel = 'stdout'): boolean {
    if (this.state === 'COMPLETED' || this.state === 'ERROR') {
      return false
    }

    const text = typeof raw === 'string' ? raw : new TextDecoder('utf-8').decode(raw)
    if (text.length === 0) {
      return this.state !== 'PAUSED_BACKPRESSURE'
    }

    const fullByteLength = Buffer.byteLength(text, 'utf-8')
    let remainingBytes = fullByteLength
    let offset = 0

    while (remainingBytes > 0) {
      const sliceByteTarget = Math.min(this.maxChunkSizeBytes, remainingBytes)
      // Safely slice string roughly by target bytes
      const sliceText = this.sliceStringByBytes(text, offset, sliceByteTarget)
      const chunkBytes = Buffer.byteLength(sliceText, 'utf-8')

      offset += sliceText.length
      remainingBytes -= chunkBytes

      this.emitChunk(sliceText, chunkBytes, channel)
    }

    if (this.currentBufferBytes >= this.highWatermarkBytes) {
      if (this.state !== 'PAUSED_BACKPRESSURE') {
        this.state = 'PAUSED_BACKPRESSURE'
        this.backpressurePauseCount += 1
        this.broadcast({
          type: 'backpressure',
          state: 'PAUSED_BACKPRESSURE',
          bufferBytes: this.currentBufferBytes,
        })
      }
      return false
    }

    return true
  }

  /**
   * Acknowledges that downstream observers/consumers have processed N bytes,
   * draining the internal flow buffer. If the buffer drops below `lowWatermarkBytes`,
   * backpressure is relieved and pending `drain()` promises resolve.
   */
  ack(bytesProcessed: number): void {
    if (bytesProcessed <= 0) return

    this.currentBufferBytes = Math.max(0, this.currentBufferBytes - bytesProcessed)

    if (this.state === 'PAUSED_BACKPRESSURE' && this.currentBufferBytes <= this.lowWatermarkBytes) {
      this.state = 'FLOWING'
      this.broadcast({
        type: 'backpressure',
        state: 'DRAINED',
        bufferBytes: this.currentBufferBytes,
      })

      while (this.drainResolvers.length > 0) {
        const resolve = this.drainResolvers.shift()
        resolve?.()
      }
    }
  }

  /**
   * Returns a promise that resolves once the pipeline drops below low-watermark.
   */
  drain(): Promise<void> {
    if (this.currentBufferBytes < this.highWatermarkBytes && this.state !== 'PAUSED_BACKPRESSURE') {
      return Promise.resolve()
    }

    return new Promise<void>((resolve) => {
      this.drainResolvers.push(resolve)
    })
  }

  /**
   * Marks the stream as completed, notifying all observers.
   */
  complete(): void {
    if (this.state === 'COMPLETED' || this.state === 'ERROR') return

    this.state = 'COMPLETED'
    this.broadcast({
      type: 'complete',
      totalChunks: this.totalChunks,
      totalBytes: this.totalBytes,
    })

    while (this.drainResolvers.length > 0) {
      const resolve = this.drainResolvers.shift()
      resolve?.()
    }
  }

  /**
   * Marks the stream as failed with an error, notifying all observers.
   */
  fail(error: Error): void {
    if (this.state === 'COMPLETED' || this.state === 'ERROR') return

    this.state = 'ERROR'
    this.broadcast({
      type: 'error',
      error,
    })

    while (this.drainResolvers.length > 0) {
      const resolve = this.drainResolvers.shift()
      resolve?.()
    }
  }

  /**
   * Returns the concatenated string content retained in the bounded ring buffer.
   */
  getRingBuffer(): string {
    return this.ringBuffer.map((c) => c.data).join('')
  }

  /**
   * Returns a snapshot of current telemetry metrics.
   */
  getMetrics(): PipelineMetrics {
    return {
      totalChunks: this.totalChunks,
      totalBytes: this.totalBytes,
      stdoutBytes: this.stdoutBytes,
      stderrBytes: this.stderrBytes,
      systemBytes: this.systemBytes,
      peakBufferBytes: this.peakBufferBytes,
      currentBufferBytes: this.currentBufferBytes,
      backpressurePauseCount: this.backpressurePauseCount,
      activeObservers: this.observers.size,
      isFlowing: this.state === 'FLOWING' || this.state === 'DRAINED',
    }
  }

  /**
   * Resets all internal buffers, sequence counters, and flow control state.
   */
  reset(): void {
    this.sequenceCounter = 0
    this.currentBufferBytes = 0
    this.peakBufferBytes = 0
    this.totalChunks = 0
    this.totalBytes = 0
    this.stdoutBytes = 0
    this.stderrBytes = 0
    this.systemBytes = 0
    this.backpressurePauseCount = 0
    this.state = 'FLOWING'
    this.ringBuffer.length = 0
    this.ringBufferCurrentBytes = 0
    this.drainResolvers.length = 0
  }

  private emitChunk(data: string, byteLength: number, channel: ChunkChannel): void {
    this.sequenceCounter += 1
    this.totalChunks += 1
    this.totalBytes += byteLength
    this.currentBufferBytes += byteLength
    if (this.currentBufferBytes > this.peakBufferBytes) {
      this.peakBufferBytes = this.currentBufferBytes
    }

    if (channel === 'stdout') {
      this.stdoutBytes += byteLength
    } else if (channel === 'stderr') {
      this.stderrBytes += byteLength
    } else {
      this.systemBytes += byteLength
    }

    const chunk: StreamingChunk = {
      sequenceNumber: this.sequenceCounter,
      channel,
      data,
      byteLength,
      timestamp: Date.now(),
    }

    // Append to ring buffer and evict oldest if exceeding capacity
    this.ringBuffer.push(chunk)
    this.ringBufferCurrentBytes += byteLength

    while (this.ringBufferCurrentBytes > this.maxRingBufferBytes && this.ringBuffer.length > 1) {
      const evicted = this.ringBuffer.shift()
      if (evicted) {
        this.ringBufferCurrentBytes -= evicted.byteLength
      }
    }

    this.broadcast({ type: 'chunk', chunk })
  }

  private broadcast(event: ChunkEvent): void {
    for (const observer of this.observers) {
      try {
        observer(event)
      } catch {
        // Observers cannot crash pipeline
      }
    }
  }

  private sliceStringByBytes(str: string, charOffset: number, targetBytes: number): string {
    let accumulatedBytes = 0
    let endCharIndex = charOffset

    while (endCharIndex < str.length && accumulatedBytes < targetBytes) {
      const code = str.charCodeAt(endCharIndex)
      const charBytes = code <= 0x7f ? 1 : code <= 0x7ff ? 2 : 3
      if (accumulatedBytes + charBytes > targetBytes && endCharIndex > charOffset) {
        break
      }
      accumulatedBytes += charBytes
      endCharIndex += 1
    }

    return str.slice(charOffset, endCharIndex)
  }
}
