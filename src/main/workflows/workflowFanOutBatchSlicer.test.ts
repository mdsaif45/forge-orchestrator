import { describe, expect, it } from 'vitest'
import { partitionFanOutBatches } from './workflowFanOutBatchSlicer'

describe('partitionFanOutBatches', () => {
  it('partitions empty items cleanly into zero batches and waves', () => {
    const plan = partitionFanOutBatches([])
    expect(plan.totalItems).toBe(0)
    expect(plan.batchCount).toBe(0)
    expect(plan.waveCount).toBe(0)
    expect(plan.batches).toHaveLength(0)
    expect(plan.waves).toHaveLength(0)
    expect(plan.summary).toContain('0 items')
  })

  it('slices single batch when items count is less than batchSize', () => {
    const items = ['a', 'b', 'c']
    const plan = partitionFanOutBatches(items, { batchSize: 5 })
    expect(plan.totalItems).toBe(3)
    expect(plan.batchCount).toBe(1)
    expect(plan.waveCount).toBe(1)
    expect(plan.batches[0]?.items).toEqual(['a', 'b', 'c'])
    expect(plan.batches[0]?.waveIndex).toBe(0)
  })

  it('partitions items into multiple batches and waves adhering to maxConcurrency', () => {
    const items = Array.from({ length: 25 }, (_, i) => `item-${String(i + 1)}`)
    // batchSize 5 -> 5 batches (0, 1, 2, 3, 4)
    // maxConcurrency 2 -> wave 0 has batches 0, 1; wave 1 has batches 2, 3; wave 2 has batch 4
    const plan = partitionFanOutBatches(items, { batchSize: 5, maxConcurrency: 2 })
    expect(plan.totalItems).toBe(25)
    expect(plan.batchCount).toBe(5)
    expect(plan.waveCount).toBe(3)

    expect(plan.waves[0]?.batchIndices).toEqual([0, 1])
    expect(plan.waves[1]?.batchIndices).toEqual([2, 3])
    expect(plan.waves[2]?.batchIndices).toEqual([4])
  })

  it('preserves all items without dropping or duplicating elements', () => {
    const items = Array.from({ length: 17 }, (_, i) => `file-${String(i)}.ts`)
    const plan = partitionFanOutBatches(items, { batchSize: 4, maxConcurrency: 3 })
    const allCollected = plan.batches.flatMap((b) => b.items)
    expect(allCollected).toEqual(items)
  })

  it('throws error for invalid batchSize or maxConcurrency', () => {
    expect(() => partitionFanOutBatches([1, 2], { batchSize: 0 })).toThrow(
      'batchSize must be greater than 0',
    )
    expect(() => partitionFanOutBatches([1, 2], { maxConcurrency: -1 })).toThrow(
      'maxConcurrency must be greater than 0',
    )
  })
})
