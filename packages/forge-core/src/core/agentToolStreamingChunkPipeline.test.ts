import { describe, expect, it } from 'vitest'
import {
  AgentToolStreamingChunkPipeline,
  type ChunkEvent,
  type StreamingChunk,
} from './agentToolStreamingChunkPipeline'

describe('AgentToolStreamingChunkPipeline (AGENT-032)', () => {
  it('streams chunks sequentially with monotonic sequence numbers and channel metrics', () => {
    const pipeline = new AgentToolStreamingChunkPipeline({
      highWatermarkBytes: 4096,
      lowWatermarkBytes: 1024,
      maxRingBufferBytes: 8192,
      maxChunkSizeBytes: 2048,
    })

    const received: StreamingChunk[] = []
    const unsubscribe = pipeline.subscribe((event) => {
      if (event.type === 'chunk') {
        received.push(event.chunk)
      }
    })

    expect(pipeline.push('Starting build process...\n', 'stdout')).toBe(true)
    expect(pipeline.push('Warning: unused variable in parser.ts:42\n', 'stderr')).toBe(true)
    expect(pipeline.push('[system] process exited with code 0\n', 'system')).toBe(true)

    expect(received).toHaveLength(3)
    expect(received[0]!.sequenceNumber).toBe(1)
    expect(received[0]!.channel).toBe('stdout')
    expect(received[0]!.data).toBe('Starting build process...\n')

    expect(received[1]!.sequenceNumber).toBe(2)
    expect(received[1]!.channel).toBe('stderr')

    expect(received[2]!.sequenceNumber).toBe(3)
    expect(received[2]!.channel).toBe('system')

    const metrics = pipeline.getMetrics()
    expect(metrics.totalChunks).toBe(3)
    expect(metrics.totalBytes).toBeGreaterThan(0)
    expect(metrics.stdoutBytes).toBe(received[0]!.byteLength)
    expect(metrics.stderrBytes).toBe(received[1]!.byteLength)
    expect(metrics.systemBytes).toBe(received[2]!.byteLength)
    expect(metrics.activeObservers).toBe(1)

    unsubscribe()
    expect(pipeline.getMetrics().activeObservers).toBe(0)
  })

  it('segments oversized payload exceeding maxChunkSizeBytes into consecutive chunks', () => {
    const maxChunkSizeBytes = 1024
    const pipeline = new AgentToolStreamingChunkPipeline({
      maxChunkSizeBytes,
      highWatermarkBytes: 65536,
    })

    const chunks: StreamingChunk[] = []
    pipeline.subscribe((event) => {
      if (event.type === 'chunk') {
        chunks.push(event.chunk)
      }
    })

    const largeData = 'A'.repeat(2500)
    const canAcceptMore = pipeline.push(largeData, 'stdout')
    expect(canAcceptMore).toBe(true)

    expect(chunks.length).toBe(3)
    expect(chunks[0]!.byteLength).toBe(1024)
    expect(chunks[1]!.byteLength).toBe(1024)
    expect(chunks[2]!.byteLength).toBe(452)
    expect(chunks[0]!.sequenceNumber).toBe(1)
    expect(chunks[1]!.sequenceNumber).toBe(2)
    expect(chunks[2]!.sequenceNumber).toBe(3)
    expect(chunks.map((c) => c.data).join('')).toBe(largeData)
  })

  it('bounds the ring buffer to maxRingBufferBytes and evicts oldest chunks', () => {
    const pipeline = new AgentToolStreamingChunkPipeline({
      maxRingBufferBytes: 1024,
      maxChunkSizeBytes: 512,
      highWatermarkBytes: 4096,
    })

    pipeline.push('Chunk 1: ' + 'x'.repeat(400) + '\n')
    pipeline.push('Chunk 2: ' + 'y'.repeat(400) + '\n')
    pipeline.push('Chunk 3: ' + 'z'.repeat(400) + '\n')

    const ringOutput = pipeline.getRingBuffer()
    expect(Buffer.byteLength(ringOutput, 'utf-8')).toBeLessThanOrEqual(1024)
    expect(ringOutput).toContain('Chunk 3')
    expect(ringOutput).not.toContain('Chunk 1')
  })

  it('triggers backpressure at high-watermark and resumes upon consumer ack below low-watermark', async () => {
    const highWatermarkBytes = 2048
    const lowWatermarkBytes = 512
    const pipeline = new AgentToolStreamingChunkPipeline({
      highWatermarkBytes,
      lowWatermarkBytes,
      maxRingBufferBytes: 4096,
    })

    const events: ChunkEvent[] = []
    pipeline.subscribe((e) => events.push(e))

    // Push 1800 bytes -> under high-watermark (2048)
    expect(pipeline.push('x'.repeat(1800))).toBe(true)
    expect(pipeline.getMetrics().isFlowing).toBe(true)

    // Push 500 more bytes -> total 2300 bytes >= 2048 -> triggers backpressure
    expect(pipeline.push('y'.repeat(500))).toBe(false)
    expect(pipeline.getMetrics().isFlowing).toBe(false)
    expect(pipeline.getMetrics().backpressurePauseCount).toBe(1)

    // Verify backpressure event broadcasted
    const backpressureEvents = events.filter(
      (e): e is Extract<ChunkEvent, { type: 'backpressure' }> => e.type === 'backpressure',
    )
    expect(backpressureEvents).toHaveLength(1)
    expect(backpressureEvents[0]!.state).toBe('PAUSED_BACKPRESSURE')

    // Await drain asynchronously while simulating downstream processing
    let drained = false
    const drainPromise = pipeline.drain().then(() => {
      drained = true
    })

    // Consume 1000 bytes -> remaining 1300 bytes > lowWatermarkBytes (512) -> still paused
    pipeline.ack(1000)
    expect(drained).toBe(false)

    // Consume 900 more bytes -> remaining 400 bytes <= 512 -> resumes!
    pipeline.ack(900)
    await drainPromise
    expect(drained).toBe(true)
    expect(pipeline.getMetrics().isFlowing).toBe(true)

    const finalEvents = events.filter(
      (e): e is Extract<ChunkEvent, { type: 'backpressure' }> => e.type === 'backpressure',
    )
    expect(finalEvents).toHaveLength(2)
    expect(finalEvents[1]!.state).toBe('DRAINED')
  })

  it('handles observer errors gracefully without terminating pipeline broadcasting', () => {
    const pipeline = new AgentToolStreamingChunkPipeline()

    const receivedBySecondObserver: StreamingChunk[] = []

    // Faulty observer that throws
    pipeline.subscribe(() => {
      throw new Error('Faulty observer crashed')
    })

    // Healthy observer
    pipeline.subscribe((event) => {
      if (event.type === 'chunk') {
        receivedBySecondObserver.push(event.chunk)
      }
    })

    expect(() => {
      pipeline.push('Testing error isolation\n')
    }).not.toThrow()

    expect(receivedBySecondObserver).toHaveLength(1)
    expect(receivedBySecondObserver[0]!.data).toBe('Testing error isolation\n')
  })

  it('notifies completion and releases pending drain promises', async () => {
    const pipeline = new AgentToolStreamingChunkPipeline({ highWatermarkBytes: 1024 })
    pipeline.push('x'.repeat(1500)) // triggers backpressure

    let drainResolved = false
    const drainPromise = pipeline.drain().then(() => {
      drainResolved = true
    })

    let completedEventReceived = false
    pipeline.subscribe((event) => {
      if (event.type === 'complete') {
        completedEventReceived = true
        expect(event.totalBytes).toBe(1500)
      }
    })

    pipeline.complete()
    await drainPromise
    expect(drainResolved).toBe(true)
    expect(completedEventReceived).toBe(true)

    // Subsequent pushes return false
    expect(pipeline.push('after complete')).toBe(false)
  })

  it('notifies error failure and resets pipeline state cleanly', () => {
    const pipeline = new AgentToolStreamingChunkPipeline()
    let errorCaught: Error | undefined

    pipeline.subscribe((event) => {
      if (event.type === 'error') {
        errorCaught = event.error
      }
    })

    pipeline.push('some initial chunk')
    pipeline.fail(new Error('Process terminated unexpectedly'))

    expect(errorCaught).toBeDefined()
    expect(errorCaught?.message).toBe('Process terminated unexpectedly')

    // Reset pipeline
    pipeline.reset()
    const metrics = pipeline.getMetrics()
    expect(metrics.totalChunks).toBe(0)
    expect(metrics.totalBytes).toBe(0)
    expect(metrics.currentBufferBytes).toBe(0)
    expect(metrics.isFlowing).toBe(true)
    expect(pipeline.getRingBuffer()).toBe('')
  })
})
