import { describe, expect, it } from 'vitest'
import { WorkflowConsensusFencingCoordinator } from './workflowConsensusFencingCoordinator'

describe('WorkflowConsensusFencingCoordinator (WORK-036)', () => {
  it('grants timed leases in the current epoch and allows valid worker access', () => {
    const coordinator = new WorkflowConsensusFencingCoordinator({
      initialEpoch: 1,
      defaultLeaseTtlMs: 5000,
    })
    const now = 1_000_000

    const lease = coordinator.grantLease('worker-1', 5000, now)
    expect(lease.workerId).toBe('worker-1')
    expect(lease.epochNumber).toBe(1)
    expect(lease.active).toBe(true)

    const access = coordinator.evaluateWorkerAccess('worker-1', 1, now + 1000)
    expect(access.allowed).toBe(true)
    expect(access.isFenced).toBe(false)
  })

  it('rejects stale epoch workers when generation epoch advances (split-brain fencing)', () => {
    const coordinator = new WorkflowConsensusFencingCoordinator({ initialEpoch: 1 })
    const now = 1_000_000

    coordinator.grantLease('zombie-worker', 10_000, now)

    // Leader changes / epoch advances
    const newEpoch = coordinator.advanceEpoch('leader-node-2', 'partition_resolved')
    expect(newEpoch).toBe(2)

    // Old worker claiming epoch 1 must be fenced
    const access = coordinator.evaluateWorkerAccess('zombie-worker', 1, now + 1000)
    expect(access.allowed).toBe(false)
    expect(access.isFenced).toBe(true)
    expect(access.reason).toContain('Claimed epoch 1 is stale')
  })

  it('admits state commits when quorum approvals are satisfied', () => {
    const coordinator = new WorkflowConsensusFencingCoordinator({ initialEpoch: 3 })
    const now = 1_000_000

    // Cluster size 3 -> Quorum = 2
    const proposal = coordinator.createProposal('step-101', 'commit-sha-abc', 3, now)
    expect(proposal.targetQuorum).toBe(2)
    expect(proposal.status).toBe('pending')

    coordinator.grantLease('w1', 5000, now)
    coordinator.grantLease('w2', 5000, now)

    // Submit first vote
    const res1 = coordinator.submitVote(
      proposal.proposalId,
      {
        workerId: 'w1',
        stepId: 'step-101',
        stateCommitHash: 'commit-sha-abc',
        epochNumber: 3,
        timestamp: now,
        approved: true,
      },
      now,
    )
    expect(res1.accepted).toBe(true)

    let report = coordinator.evaluateConsensus(proposal.proposalId)
    expect(report.status).toBe('pending')
    expect(report.quorumAchieved).toBe(false)

    // Submit second vote (reaching quorum)
    const res2 = coordinator.submitVote(
      proposal.proposalId,
      {
        workerId: 'w2',
        stepId: 'step-101',
        stateCommitHash: 'commit-sha-abc',
        epochNumber: 3,
        timestamp: now,
        approved: true,
      },
      now,
    )
    expect(res2.accepted).toBe(true)

    report = coordinator.evaluateConsensus(proposal.proposalId)
    expect(report.status).toBe('admitted')
    expect(report.quorumAchieved).toBe(true)
    expect(report.approvedCount).toBe(2)
  })

  it('rejects votes from expired or explicitly fenced workers', () => {
    const coordinator = new WorkflowConsensusFencingCoordinator({ initialEpoch: 1 })
    const now = 1_000_000

    coordinator.grantLease('worker-bad', 2000, now)
    const proposal = coordinator.createProposal('step-99', 'sha-xyz', 3, now)

    // Explicitly fence worker
    coordinator.fenceWorker('worker-bad', 'Byzantine behavior detected')

    const res = coordinator.submitVote(
      proposal.proposalId,
      {
        workerId: 'worker-bad',
        stepId: 'step-99',
        stateCommitHash: 'sha-xyz',
        epochNumber: 1,
        timestamp: now,
        approved: true,
      },
      now,
    )

    expect(res.accepted).toBe(false)
    expect(res.reason).toContain('Worker is permanently fenced')
  })

  it('rejects votes with mismatched commit hash or step ID', () => {
    const coordinator = new WorkflowConsensusFencingCoordinator({ initialEpoch: 1 })
    const now = 1_000_000

    coordinator.grantLease('w1', 5000, now)
    const proposal = coordinator.createProposal('step-valid', 'sha-valid', 3, now)

    const res = coordinator.submitVote(
      proposal.proposalId,
      {
        workerId: 'w1',
        stepId: 'step-invalid',
        stateCommitHash: 'sha-valid',
        epochNumber: 1,
        timestamp: now,
        approved: true,
      },
      now,
    )

    expect(res.accepted).toBe(false)
    expect(res.reason).toContain('does not match proposal payload')
  })
})
