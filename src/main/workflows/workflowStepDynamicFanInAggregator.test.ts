import { describe, expect, it } from 'vitest'
import { WorkflowStepDynamicFanInAggregator } from './workflowStepDynamicFanInAggregator'

describe('WorkflowStepDynamicFanInAggregator', () => {
  it('throws error when creating barrier with empty stepId or branch list', () => {
    const aggregator = new WorkflowStepDynamicFanInAggregator()
    expect(() => aggregator.createBarrier('', ['b1'])).toThrow('stepId cannot be empty')
    expect(() => aggregator.createBarrier('step-1', [])).toThrow(
      'expectedBranchIds cannot be empty',
    )
  })

  it('satisfies ALL policy when 100% of branches succeed and merges payloads', () => {
    const aggregator = new WorkflowStepDynamicFanInAggregator()
    const report = aggregator.createBarrier('step-fanin', ['b1', 'b2'], 'ALL')

    expect(report.status).toBe('PENDING')

    aggregator.registerBranchResult(report.barrierId, {
      branchId: 'b1',
      status: 'SUCCESS',
      outputPayload: { processedCount: 10 },
      durationMs: 120,
    })

    const intermediate = aggregator.getBarrier(report.barrierId)
    expect(intermediate?.status).toBe('PENDING')

    const finalReport = aggregator.registerBranchResult(report.barrierId, {
      branchId: 'b2',
      status: 'SUCCESS',
      outputPayload: { processedCount: 20 },
      durationMs: 140,
    })

    expect(finalReport.status).toBe('SATISFIED')
    expect(finalReport.successfulCount).toBe(2)
    expect(finalReport.aggregatedPayload).toEqual({
      b1: { processedCount: 10 },
      b2: { processedCount: 20 },
    })
  })

  it('aborts FAIL_FAST barrier immediately on first branch failure', () => {
    const aggregator = new WorkflowStepDynamicFanInAggregator()
    const report = aggregator.createBarrier('step-fast', ['b1', 'b2', 'b3'], 'FAIL_FAST')

    const aborted = aggregator.registerBranchResult(report.barrierId, {
      branchId: 'b2',
      status: 'FAILED',
      error: 'Disk I/O error',
      durationMs: 40,
    })

    expect(aborted.status).toBe('ABORTED')
    expect(aborted.decisionReason).toContain('Fail-fast triggered')
    expect(aborted.errors).toHaveLength(1)
  })

  it('satisfies FIRST_SUCCESS as soon as any single branch succeeds', () => {
    const aggregator = new WorkflowStepDynamicFanInAggregator()
    const report = aggregator.createBarrier('step-first', ['b1', 'b2', 'b3'], 'FIRST_SUCCESS')

    const firstResult = aggregator.registerBranchResult(report.barrierId, {
      branchId: 'b3',
      status: 'SUCCESS',
      outputPayload: 'fastest-mirror',
      durationMs: 15,
    })

    expect(firstResult.status).toBe('SATISFIED')
    expect(firstResult.decisionReason).toContain('First success')
  })

  it('evaluates QUORUM policy correctly based on quorumRatio', () => {
    const aggregator = new WorkflowStepDynamicFanInAggregator({ quorumRatio: 0.6 })
    // 3 branches, 0.6 * 3 = 1.8 -> ceil = 2 required
    const report = aggregator.createBarrier('step-quorum', ['b1', 'b2', 'b3'], 'QUORUM')

    aggregator.registerBranchResult(report.barrierId, {
      branchId: 'b1',
      status: 'SUCCESS',
      durationMs: 50,
    })

    expect(aggregator.getBarrier(report.barrierId)?.status).toBe('PENDING')

    const satisfied = aggregator.registerBranchResult(report.barrierId, {
      branchId: 'b2',
      status: 'SUCCESS',
      durationMs: 60,
    })

    expect(satisfied.status).toBe('SATISFIED')
    expect(satisfied.decisionReason).toContain('Quorum met')
  })

  it('times out when evaluated after expiration time', async () => {
    const aggregator = new WorkflowStepDynamicFanInAggregator({ defaultTimeoutMs: 50 })
    const report = aggregator.createBarrier('step-timeout', ['b1'], 'ALL', 50)

    await new Promise((resolve) => setTimeout(resolve, 80))

    const timedOut = aggregator.evaluateBarrier(report.barrierId)
    expect(timedOut.status).toBe('TIMED_OUT')
    expect(timedOut.decisionReason).toContain('Barrier expired')
  })

  it('rejects unregistered branches and forbids aborting satisfied barriers', () => {
    const aggregator = new WorkflowStepDynamicFanInAggregator()
    const report = aggregator.createBarrier('step-guards', ['b1'], 'ALL')

    expect(() =>
      aggregator.registerBranchResult(report.barrierId, {
        branchId: 'b-unknown',
        status: 'SUCCESS',
        durationMs: 10,
      }),
    ).toThrow("Branch 'b-unknown' is not registered")

    aggregator.registerBranchResult(report.barrierId, {
      branchId: 'b1',
      status: 'SUCCESS',
      durationMs: 10,
    })

    expect(() => aggregator.abortBarrier(report.barrierId, 'Late abort')).toThrow(
      'Cannot abort already SATISFIED barrier',
    )
  })
})
