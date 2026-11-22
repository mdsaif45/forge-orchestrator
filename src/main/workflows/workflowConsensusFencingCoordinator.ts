import { randomUUID } from 'node:crypto'

/**
 * Distributed consensus barrier and split-brain fencing coordinator for workflow steps.
 *
 * Guarantees monotonic epoch fencing, prevents split-brain zombie execution,
 * and verifies quorum consensus before state commits (A1, A4).
 */

export interface ConsensusCoordinatorConfig {
  /** Quorum size override. Defaults to majority (floor(totalClusterSize / 2) + 1). */
  readonly requiredQuorum?: number | undefined
  /** Default worker lease TTL in milliseconds. Defaults to 30,000ms. */
  readonly defaultLeaseTtlMs?: number | undefined
  /** Initial generation epoch number. Defaults to 1. */
  readonly initialEpoch?: number | undefined
  /** Maximum history of proposals retained. Defaults to 200. */
  readonly maxProposalsHistory?: number | undefined
}

export interface WorkerLease {
  readonly workerId: string
  readonly leaseId: string
  readonly epochNumber: number
  readonly grantedAt: number
  readonly expiresAt: number
  readonly active: boolean
  readonly fencingReason?: string | undefined
}

export interface VotePayload {
  readonly workerId: string
  readonly stepId: string
  readonly stateCommitHash: string
  readonly epochNumber: number
  readonly timestamp: number
  readonly approved: boolean
}

export interface ConsensusProposal {
  readonly proposalId: string
  readonly stepId: string
  readonly stateCommitHash: string
  readonly epochNumber: number
  readonly targetQuorum: number
  readonly createdAt: number
  readonly votes: Map<string, VotePayload>
  status: 'pending' | 'admitted' | 'rejected' | 'fenced'
  decisionReason?: string | undefined
}

export interface FencingDecision {
  readonly workerId: string
  readonly allowed: boolean
  readonly currentEpoch: number
  readonly claimedEpoch: number
  readonly isFenced: boolean
  readonly reason: string
}

export interface ConsensusReport {
  readonly proposalId: string
  readonly stepId: string
  readonly status: 'pending' | 'admitted' | 'rejected' | 'fenced'
  readonly epochNumber: number
  readonly votesCount: number
  readonly approvedCount: number
  readonly requiredQuorum: number
  readonly quorumAchieved: boolean
  readonly decisionReason: string
}

export class WorkflowConsensusFencingCoordinator {
  private currentEpochNumber: number
  private leaderId: string | null = null
  private readonly defaultLeaseTtlMs: number
  private readonly requiredQuorumOverride?: number | undefined
  private readonly maxProposalsHistory: number

  private readonly leases = new Map<string, WorkerLease>()
  private readonly proposals = new Map<string, ConsensusProposal>()
  private readonly fencedWorkers = new Set<string>()

  constructor(config: ConsensusCoordinatorConfig = {}) {
    this.currentEpochNumber = Math.max(1, config.initialEpoch ?? 1)
    this.defaultLeaseTtlMs = Math.max(1000, config.defaultLeaseTtlMs ?? 30_000)
    this.requiredQuorumOverride = config.requiredQuorum
    this.maxProposalsHistory = Math.max(10, config.maxProposalsHistory ?? 200)
  }

  /**
   * Advances the generation epoch, establishing a new fencing term and invalidating
   * all leases granted in older epochs (mitigates split-brain zombie workers).
   */
  advanceEpoch(newLeaderId: string, reason = 'leadership_transition'): number {
    this.currentEpochNumber += 1
    this.leaderId = newLeaderId

    // Fence all active leases from prior epochs
    for (const [workerId, lease] of this.leases.entries()) {
      if (lease.epochNumber < this.currentEpochNumber) {
        this.leases.set(workerId, {
          ...lease,
          active: false,
          fencingReason: `Epoch advanced to ${String(this.currentEpochNumber)} (${reason})`,
        })
      }
    }

    return this.currentEpochNumber
  }

  /**
   * Grants or renews a timed worker lease bound to the current generation epoch.
   */
  grantLease(workerId: string, ttlMs?: number, now: number = Date.now()): WorkerLease {
    if (this.fencedWorkers.has(workerId)) {
      throw new Error(`Cannot grant lease: worker ${workerId} is explicitly fenced`)
    }

    const duration = Math.max(1000, ttlMs ?? this.defaultLeaseTtlMs)
    const lease: WorkerLease = {
      workerId,
      leaseId: randomUUID(),
      epochNumber: this.currentEpochNumber,
      grantedAt: now,
      expiresAt: now + duration,
      active: true,
    }

    this.leases.set(workerId, lease)
    return lease
  }

  /**
   * Explicitly fences a worker, revoking lease and rejecting any subsequent votes.
   */
  fenceWorker(workerId: string, reason: string): void {
    this.fencedWorkers.add(workerId)
    const existing = this.leases.get(workerId)
    if (existing) {
      this.leases.set(workerId, {
        ...existing,
        active: false,
        fencingReason: reason,
      })
    }
  }

  /**
   * Evaluates worker access against current epoch and active leases.
   */
  evaluateWorkerAccess(
    workerId: string,
    claimedEpoch: number,
    now: number = Date.now(),
  ): FencingDecision {
    if (this.fencedWorkers.has(workerId)) {
      return {
        workerId,
        allowed: false,
        currentEpoch: this.currentEpochNumber,
        claimedEpoch,
        isFenced: true,
        reason: 'Worker is permanently fenced in coordinator registry',
      }
    }

    if (claimedEpoch < this.currentEpochNumber) {
      return {
        workerId,
        allowed: false,
        currentEpoch: this.currentEpochNumber,
        claimedEpoch,
        isFenced: true,
        reason: `Claimed epoch ${String(claimedEpoch)} is stale; current epoch is ${String(this.currentEpochNumber)}`,
      }
    }

    const lease = this.leases.get(workerId)
    if (!lease?.active) {
      return {
        workerId,
        allowed: false,
        currentEpoch: this.currentEpochNumber,
        claimedEpoch,
        isFenced: false,
        reason: 'No active lease found for worker',
      }
    }

    if (now >= lease.expiresAt) {
      return {
        workerId,
        allowed: false,
        currentEpoch: this.currentEpochNumber,
        claimedEpoch,
        isFenced: false,
        reason: 'Worker lease has expired',
      }
    }

    return {
      workerId,
      allowed: true,
      currentEpoch: this.currentEpochNumber,
      claimedEpoch,
      isFenced: false,
      reason: 'Valid active lease in current epoch',
    }
  }

  /**
   * Creates a new consensus proposal for a step terminal state commit.
   */
  createProposal(
    stepId: string,
    stateCommitHash: string,
    clusterSize: number,
    now: number = Date.now(),
  ): ConsensusProposal {
    this.pruneProposals()

    const targetQuorum = this.requiredQuorumOverride ?? Math.floor(clusterSize / 2) + 1
    const proposalId = randomUUID()

    const proposal: ConsensusProposal = {
      proposalId,
      stepId,
      stateCommitHash,
      epochNumber: this.currentEpochNumber,
      targetQuorum: Math.max(1, targetQuorum),
      createdAt: now,
      votes: new Map<string, VotePayload>(),
      status: 'pending',
    }

    this.proposals.set(proposalId, proposal)
    return proposal
  }

  /**
   * Submits a vote from a worker. Verifies worker lease and epoch fencing invariants.
   */
  submitVote(
    proposalId: string,
    vote: VotePayload,
    now: number = Date.now(),
  ): { accepted: boolean; reason: string } {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) {
      return { accepted: false, reason: `Proposal ${proposalId} not found` }
    }

    if (proposal.status !== 'pending') {
      return { accepted: false, reason: `Proposal is already finalized as ${proposal.status}` }
    }

    // Verify worker access and epoch validity
    const decision = this.evaluateWorkerAccess(vote.workerId, vote.epochNumber, now)
    if (!decision.allowed) {
      return { accepted: false, reason: `Vote rejected: ${decision.reason}` }
    }

    // Verify proposal epoch match
    if (vote.epochNumber !== proposal.epochNumber) {
      return {
        accepted: false,
        reason: `Vote epoch ${String(vote.epochNumber)} does not match proposal epoch ${String(proposal.epochNumber)}`,
      }
    }

    // Verify step and commit hash integrity
    if (vote.stepId !== proposal.stepId || vote.stateCommitHash !== proposal.stateCommitHash) {
      return {
        accepted: false,
        reason: `Vote step or stateCommitHash does not match proposal payload`,
      }
    }

    proposal.votes.set(vote.workerId, vote)

    // Check if quorum reached
    this.evaluateConsensus(proposalId)

    return { accepted: true, reason: 'Vote accepted' }
  }

  /**
   * Evaluates consensus quorum for a proposal and transitions status.
   */
  evaluateConsensus(proposalId: string): ConsensusReport {
    const proposal = this.proposals.get(proposalId)
    if (!proposal) {
      throw new Error(`Proposal ${proposalId} not found`)
    }

    let approved = 0
    let rejected = 0

    for (const vote of proposal.votes.values()) {
      if (vote.approved) approved += 1
      else rejected += 1
    }

    if (proposal.status === 'pending') {
      if (approved >= proposal.targetQuorum) {
        proposal.status = 'admitted'
        proposal.decisionReason = `Quorum reached: ${String(approved)}/${String(proposal.targetQuorum)} approvals`
      } else if (proposal.votes.size >= proposal.targetQuorum && rejected > 0) {
        proposal.status = 'rejected'
        proposal.decisionReason = `Quorum rejected: ${String(rejected)} negative votes`
      }
    }

    return {
      proposalId,
      stepId: proposal.stepId,
      status: proposal.status,
      epochNumber: proposal.epochNumber,
      votesCount: proposal.votes.size,
      approvedCount: approved,
      requiredQuorum: proposal.targetQuorum,
      quorumAchieved: approved >= proposal.targetQuorum,
      decisionReason: proposal.decisionReason ?? 'Awaiting quorum votes',
    }
  }

  getEpoch(): number {
    return this.currentEpochNumber
  }

  getLeader(): string | null {
    return this.leaderId
  }

  getProposal(proposalId: string): ConsensusProposal | null {
    return this.proposals.get(proposalId) ?? null
  }

  private pruneProposals(): void {
    while (this.proposals.size >= this.maxProposalsHistory) {
      const oldestKey = this.proposals.keys().next().value
      if (!oldestKey) break
      this.proposals.delete(oldestKey)
    }
  }
}
