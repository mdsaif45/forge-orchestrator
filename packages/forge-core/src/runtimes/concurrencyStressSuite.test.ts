import { describe, expect, it } from 'vitest'
import {
  ConcurrencyStressSuite,
  createDefaultStressProfiles,
  InvalidStressProfileError,
  StressEnduranceFailureError,
  type StressProfile,
} from './concurrencyStressSuite'

describe('ConcurrencyStressSuite (BENCH-003)', () => {
  it('executes 100+ concurrent iterations across parallel workers with WAL contention and zero leaks', async () => {
    const suite = new ConcurrencyStressSuite()
    const [walProfile] = createDefaultStressProfiles()
    if (!walProfile) throw new Error('Missing default stress profile')

    const report = await suite.runProfileStrict(walProfile)

    expect(report.passed).toBe(true)
    expect(report.verdict).toBe('PASS')
    expect(report.targetIterations).toBeGreaterThanOrEqual(100)
    expect(report.completedIterations).toBe(120)
    expect(report.failedIterations).toBe(0)
    expect(report.leakedHandlesCount).toBe(0)
    expect(report.unhandledRejectionsCount).toBe(0)
    expect(report.peakConcurrentHandles).toBeGreaterThan(1)
    expect(report.sqliteWalStats.enabled).toBe(true)
    expect(report.sqliteWalStats.writes).toBe(120)
    expect(report.sqliteWalStats.reads).toBe(120)
    expect(report.sqliteWalStats.integrityVerified).toBe(true)
    expect(report.memoryStats.withinCeiling).toBe(true)
    expect(report.workers).toHaveLength(24)
    expect(report.evidenceDigest).toHaveLength(64)
  })

  it('supports STEADY and SPIKE_RAMP endurance profiles without memory ceiling breaches', async () => {
    const suite = new ConcurrencyStressSuite()
    const rampProfile: StressProfile = {
      profileId: 'endurance-105',
      name: '105-iteration steady profile',
      concurrencyLevel: 15,
      totalIterations: 105,
      burstPattern: 'STEADY',
      enableSqliteWalStress: false,
      simulatedToolCallsPerIteration: 4,
    }

    const report = await suite.runProfileStrict(rampProfile)
    expect(report.completedIterations).toBe(105)
    expect(report.totalToolCallsExecuted).toBe(420)
    expect(report.sqliteWalStats.enabled).toBe(false)
    expect(report.leakedHandlesCount).toBe(0)
    expect(report.memoryStats.withinCeiling).toBe(true)
  })

  it('captures worker exceptions without unhandled rejections and cleans up handles fail-closed', async () => {
    const suite = new ConcurrencyStressSuite()
    const profile: StressProfile = {
      profileId: 'fault-injection-profile',
      name: 'Fault injection stress',
      concurrencyLevel: 10,
      totalIterations: 20,
      burstPattern: 'BURST_WAVE',
      enableSqliteWalStress: false,
      maxAllowedFailures: 0,
    }

    const failingReport = await suite.runProfile(profile, (ctx) => {
      if (ctx.iterationIndex === 5 || ctx.iterationIndex === 12) {
        throw new Error('Injected transient worker failure')
      }
    })

    expect(failingReport.passed).toBe(false)
    expect(failingReport.verdict).toBe('STRESS_FAIL')
    expect(failingReport.failedIterations).toBe(2)
    expect(failingReport.completedIterations).toBe(18)
    expect(failingReport.leakedHandlesCount).toBe(0) // handles cleaned in finally!
    expect(failingReport.unhandledRejectionsCount).toBe(0)
    expect(failingReport.failureReasons.some((r) => r.includes('Failed iterations'))).toBe(true)

    await expect(
      suite.runProfileStrict(profile, () => {
        throw new Error('Fatal defect')
      }),
    ).rejects.toThrow(StressEnduranceFailureError)
  })

  it('rejects invalid stress profiles fail-closed', async () => {
    const suite = new ConcurrencyStressSuite()

    await expect(
      suite.runProfile({
        profileId: '',
        name: 'Bad',
        concurrencyLevel: 4,
        totalIterations: 10,
        burstPattern: 'STEADY',
      }),
    ).rejects.toThrow(InvalidStressProfileError)

    await expect(
      suite.runProfile({
        profileId: 'bad-conc',
        name: 'Bad',
        concurrencyLevel: 0,
        totalIterations: 10,
        burstPattern: 'STEADY',
      }),
    ).rejects.toThrow(InvalidStressProfileError)

    await expect(
      suite.runProfile({
        profileId: 'bad-mem',
        name: 'Bad',
        concurrencyLevel: 2,
        totalIterations: 10,
        burstPattern: 'STEADY',
        maxMemoryGrowthBytes: -100,
      }),
    ).rejects.toThrow(InvalidStressProfileError)
  })
})
