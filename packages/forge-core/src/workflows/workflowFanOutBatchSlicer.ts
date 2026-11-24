export interface FanOutOptions {
  batchSize?: number | undefined
  maxConcurrency?: number | undefined
  sliceTimeoutMs?: number | undefined
  failFast?: boolean | undefined
}

export interface FanOutBatch<T> {
  batchIndex: number
  items: T[]
  itemCount: number
  waveIndex: number
}

export interface FanOutWave {
  waveIndex: number
  batchIndices: number[]
  totalItemsInWave: number
}

export interface FanOutExecutionPlan<T> {
  totalItems: number
  batchSize: number
  maxConcurrency: number
  batchCount: number
  waveCount: number
  batches: FanOutBatch<T>[]
  waves: FanOutWave[]
  summary: string
}

const DEFAULT_BATCH_SIZE = 5
const DEFAULT_MAX_CONCURRENCY = 4

export function partitionFanOutBatches<T>(
  items: T[],
  options: FanOutOptions = {},
): FanOutExecutionPlan<T> {
  const batchSize = options.batchSize ?? DEFAULT_BATCH_SIZE
  const maxConcurrency = options.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY

  if (batchSize <= 0) {
    throw new Error('batchSize must be greater than 0')
  }
  if (maxConcurrency <= 0) {
    throw new Error('maxConcurrency must be greater than 0')
  }

  const batches: FanOutBatch<T>[] = []
  const waves: FanOutWave[] = []

  if (items.length === 0) {
    return {
      totalItems: 0,
      batchSize,
      maxConcurrency,
      batchCount: 0,
      waveCount: 0,
      batches: [],
      waves: [],
      summary: 'Fan-out execution plan: 0 items (0 batches, 0 waves)',
    }
  }

  let currentBatchIndex = 0
  for (let i = 0; i < items.length; i += batchSize) {
    const chunk = items.slice(i, i + batchSize)
    const waveIndex = Math.floor(currentBatchIndex / maxConcurrency)

    batches.push({
      batchIndex: currentBatchIndex,
      items: chunk,
      itemCount: chunk.length,
      waveIndex,
    })

    currentBatchIndex += 1
  }

  const waveMap = new Map<number, FanOutBatch<T>[]>()
  for (const b of batches) {
    const existing = waveMap.get(b.waveIndex) ?? []
    existing.push(b)
    waveMap.set(b.waveIndex, existing)
  }

  for (const [wIdx, waveBatches] of waveMap.entries()) {
    const totalItemsInWave = waveBatches.reduce((acc, b) => acc + b.itemCount, 0)
    waves.push({
      waveIndex: wIdx,
      batchIndices: waveBatches.map((b) => b.batchIndex),
      totalItemsInWave,
    })
  }

  const summary = [
    `=== Workflow Fan-Out Execution Plan ===`,
    `Total Items: ${String(items.length)} | Batch Size: ${String(batchSize)} | Max Concurrency: ${String(maxConcurrency)}`,
    `Batches: ${String(batches.length)} across ${String(waves.length)} execution waves`,
  ].join('\n')

  return {
    totalItems: items.length,
    batchSize,
    maxConcurrency,
    batchCount: batches.length,
    waveCount: waves.length,
    batches,
    waves,
    summary,
  }
}
