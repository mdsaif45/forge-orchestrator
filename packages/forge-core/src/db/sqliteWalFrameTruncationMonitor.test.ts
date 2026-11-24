import { describe, expect, it } from 'vitest'
import { SqliteWalFrameTruncationMonitor } from './sqliteWalFrameTruncationMonitor'

describe('SqliteWalFrameTruncationMonitor', () => {
  it('updates frame stats and computes uncheckpointed deltas', () => {
    const monitor = new SqliteWalFrameTruncationMonitor({ framePageSizeBytes: 4096 })
    const stats = monitor.updateFrameStats(500, 300)

    expect(stats.totalFrames).toBe(500)
    expect(stats.checkpointedFrames).toBe(300)
    expect(stats.uncheckpointedFrames).toBe(200)
    expect(stats.walSizeBytes).toBe(500 * 4096)
    expect(stats.activeReadersCount).toBe(0)
  })

  it('recommends TRUNCATE when all frames are checkpointed and zero readers active', () => {
    const monitor = new SqliteWalFrameTruncationMonitor()
    monitor.updateFrameStats(100, 100)

    const advisory = monitor.evaluateAdvisory()
    expect(advisory.isTruncationFeasible).toBe(true)
    expect(advisory.recommendedMode).toBe('TRUNCATE')
    expect(advisory.urgency).toBe('LOW')
    expect(advisory.reason).toContain('TRUNCATE checkpoint is feasible')
  })

  it('recommends FULL when uncheckpointed frames exist and zero readers active', () => {
    const monitor = new SqliteWalFrameTruncationMonitor()
    monitor.updateFrameStats(200, 50)

    const advisory = monitor.evaluateAdvisory()
    expect(advisory.isTruncationFeasible).toBe(false)
    expect(advisory.recommendedMode).toBe('FULL')
    expect(advisory.urgency).toBe('MEDIUM')
  })

  it('recommends PASSIVE when active non-starving readers are present', () => {
    const monitor = new SqliteWalFrameTruncationMonitor({ starvationThresholdMs: 5000 })
    monitor.updateFrameStats(300, 100)
    monitor.registerReaderLock('reader-01', 50, Date.now())

    const advisory = monitor.evaluateAdvisory(Date.now() + 1000) // 1s elapsed < 5s threshold
    expect(advisory.isTruncationFeasible).toBe(false)
    expect(advisory.recommendedMode).toBe('PASSIVE')
    expect(advisory.urgency).toBe('LOW')
    expect(advisory.starvingReaders).toHaveLength(0)
  })

  it('detects reader starvation and escalates to RESTART mode', () => {
    const monitor = new SqliteWalFrameTruncationMonitor({ starvationThresholdMs: 2000 })
    monitor.updateFrameStats(800, 200)
    const acquiredTime = 1000
    monitor.registerReaderLock('slow-reader', 10, acquiredTime)

    // Evaluate 5 seconds later (starving > 2s)
    const advisory = monitor.evaluateAdvisory(acquiredTime + 5000)
    expect(advisory.isTruncationFeasible).toBe(false)
    expect(advisory.recommendedMode).toBe('RESTART')
    expect(advisory.urgency).toBe('HIGH')
    expect(advisory.starvingReaders).toHaveLength(1)
    expect(advisory.starvingReaders[0]?.readerId).toBe('slow-reader')
  })

  it('releases reader locks and transitions back to non-blocking advisories', () => {
    const monitor = new SqliteWalFrameTruncationMonitor()
    monitor.updateFrameStats(50, 50)
    monitor.registerReaderLock('temp-reader', 0)

    expect(monitor.evaluateAdvisory().recommendedMode).toBe('PASSIVE')

    const released = monitor.releaseReaderLock('temp-reader')
    expect(released).toBe(true)

    // With zero readers and 0 uncheckpointed, TRUNCATE should be recommended
    expect(monitor.evaluateAdvisory().recommendedMode).toBe('TRUNCATE')
  })

  it('throws error when registering lock with empty readerId', () => {
    const monitor = new SqliteWalFrameTruncationMonitor()
    expect(() => monitor.registerReaderLock('', 0)).toThrow('readerId cannot be empty')
  })
})
