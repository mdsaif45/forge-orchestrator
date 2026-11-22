/**
 * Distributed two-phase commit (2PC) arbiter for workflow step executions.
 *
 * Coordinates atomic state changes across multiple concurrent step participants,
 * enforcing unanimous agreement (Prepare -> Commit) with strict timeout fencing
 * and fail-closed rollbacks (A1, A4).
 */

export type TransactionPhase = 'IDLE' | 'PREPARING' | 'PREPARED' | 'COMMITTED' | 'ABORTED'

export interface ParticipantVote {
  readonly participantId: string
  readonly vote: 'READY' | 'ABORT'
  readonly timestamp: number
  readonly error?: string | undefined
}

export interface TwoPhaseTransaction {
  readonly txId: string
  readonly stepId: string
  phase: TransactionPhase
  readonly participants: readonly string[]
  readonly votes: ParticipantVote[]
  readonly createdAt: number
  readonly leaseExpiresAt: number
  abortReason?: string | undefined
  committedAt?: number | undefined
  abortedAt?: number | undefined
}

export interface TwoPhaseArbiterConfig {
  /** Default duration in ms before a prepare lease expires. Defaults to 5000ms. */
  readonly defaultLeaseMs?: number | undefined
  /** Maximum allowed lease duration in ms. Defaults to 60000ms. */
  readonly maxLeaseMs?: number | undefined
}

export class WorkflowStepTwoPhaseCommitArbiter {
  private readonly defaultLeaseMs: number
  private readonly maxLeaseMs: number
  private readonly transactions = new Map<string, TwoPhaseTransaction>()
  private txCounter = 0

  constructor(config: TwoPhaseArbiterConfig = {}) {
    this.defaultLeaseMs = Math.max(100, config.defaultLeaseMs ?? 5000)
    this.maxLeaseMs = Math.max(this.defaultLeaseMs, config.maxLeaseMs ?? 60000)
  }

  /**
   * Initiates a new two-phase commit transaction for a workflow step and participants.
   */
  beginTransaction(
    stepId: string,
    participants: readonly string[],
    options: { leaseMs?: number | undefined } = {},
  ): TwoPhaseTransaction {
    if (!stepId || stepId.trim().length === 0) {
      throw new Error('stepId cannot be empty')
    }
    if (participants.length === 0) {
      throw new Error('participants list cannot be empty')
    }

    const uniqueParticipants = Array.from(new Set(participants))
    this.txCounter += 1
    const txId = `tx-2pc-${stepId}-${String(Date.now())}-${String(this.txCounter)}`

    const requestedLease = options.leaseMs ?? this.defaultLeaseMs
    const effectiveLease = Math.min(Math.max(50, requestedLease), this.maxLeaseMs)
    const createdAt = Date.now()
    const leaseExpiresAt = createdAt + effectiveLease

    const tx: TwoPhaseTransaction = {
      txId,
      stepId,
      phase: 'PREPARING',
      participants: uniqueParticipants,
      votes: [],
      createdAt,
      leaseExpiresAt,
    }

    this.transactions.set(txId, tx)
    return tx
  }

  /**
   * Retrieves a transaction by ID, evaluating lease expiration if in-flight.
   */
  getTransaction(txId: string): TwoPhaseTransaction | undefined {
    const tx = this.transactions.get(txId)
    if (!tx) return undefined

    this.checkLeaseExpiration(tx)
    return tx
  }

  /**
   * Lists all tracked transactions.
   */
  listTransactions(): readonly TwoPhaseTransaction[] {
    const list: TwoPhaseTransaction[] = []
    for (const tx of this.transactions.values()) {
      this.checkLeaseExpiration(tx)
      list.push(tx)
    }
    return list
  }

  /**
   * Registers a participant vote during the PREPARING phase.
   */
  registerVote(
    txId: string,
    participantId: string,
    vote: 'READY' | 'ABORT',
    error?: string,
  ): TwoPhaseTransaction {
    const tx = this.transactions.get(txId)
    if (!tx) {
      throw new Error(`Transaction not found: ${txId}`)
    }

    this.checkLeaseExpiration(tx)

    if (tx.phase !== 'PREPARING') {
      throw new Error(
        `Cannot record vote for transaction in '${tx.phase}' phase. Only PREPARING accepts votes.`,
      )
    }

    if (!tx.participants.includes(participantId)) {
      throw new Error(`Participant '${participantId}' is not registered in transaction '${txId}'.`)
    }

    const existingVoteIndex = tx.votes.findIndex((v) => v.participantId === participantId)
    const voteRecord: ParticipantVote = {
      participantId,
      vote,
      timestamp: Date.now(),
      error,
    }

    if (existingVoteIndex >= 0) {
      tx.votes[existingVoteIndex] = voteRecord
    } else {
      tx.votes.push(voteRecord)
    }

    // Fail-closed rule: Any ABORT vote aborts immediately
    if (vote === 'ABORT') {
      tx.phase = 'ABORTED'
      tx.abortedAt = Date.now()
      tx.abortReason = error ?? `Participant '${participantId}' voted ABORT during prepare phase.`
      return tx
    }

    // Check if all participants voted READY
    const readyVotes = tx.votes.filter((v) => v.vote === 'READY')
    if (readyVotes.length === tx.participants.length) {
      tx.phase = 'PREPARED'
    }

    return tx
  }

  /**
   * Commits a PREPARED transaction.
   */
  commitTransaction(txId: string): TwoPhaseTransaction {
    const tx = this.transactions.get(txId)
    if (!tx) {
      throw new Error(`Transaction not found: ${txId}`)
    }

    this.checkLeaseExpiration(tx)

    if (tx.phase !== 'PREPARED') {
      throw new Error(
        `Cannot commit transaction in '${tx.phase}' phase. Only PREPARED transactions can be committed.`,
      )
    }

    tx.phase = 'COMMITTED'
    tx.committedAt = Date.now()
    return tx
  }

  /**
   * Aborts an active transaction with a specified reason.
   */
  abortTransaction(txId: string, reason: string): TwoPhaseTransaction {
    const tx = this.transactions.get(txId)
    if (!tx) {
      throw new Error(`Transaction not found: ${txId}`)
    }

    if (tx.phase === 'COMMITTED') {
      throw new Error(`Cannot abort already COMMITTED transaction '${txId}'.`)
    }

    tx.phase = 'ABORTED'
    tx.abortedAt = Date.now()
    tx.abortReason = reason
    return tx
  }

  /**
   * Fully coordinates the 2PC protocol by soliciting votes from all participants.
   */
  async coordinate(
    txId: string,
    queryParticipant: (
      participantId: string,
      txId: string,
    ) => Promise<{ vote: 'READY' | 'ABORT'; error?: string }>,
  ): Promise<TwoPhaseTransaction> {
    const tx = this.transactions.get(txId)
    if (!tx) {
      throw new Error(`Transaction not found: ${txId}`)
    }

    this.checkLeaseExpiration(tx)
    if (tx.phase !== 'PREPARING') {
      return tx
    }

    const votePromises = tx.participants.map(async (participantId) => {
      try {
        const result = await queryParticipant(participantId, txId)
        return { participantId, ...result }
      } catch (err) {
        return {
          participantId,
          vote: 'ABORT' as const,
          error: err instanceof Error ? err.message : String(err),
        }
      }
    })

    const results = await Promise.all(votePromises)

    for (const res of results) {
      if ((tx.phase as TransactionPhase) !== 'PREPARING') break
      this.registerVote(txId, res.participantId, res.vote, res.error)
    }

    if ((tx.phase as TransactionPhase) === 'PREPARED') {
      return this.commitTransaction(txId)
    }

    return tx
  }

  /**
   * Checks whether the transaction lease expired, transitioning to ABORTED if so.
   */
  private checkLeaseExpiration(tx: TwoPhaseTransaction): void {
    if (tx.phase === 'PREPARING' || tx.phase === 'PREPARED') {
      if (Date.now() > tx.leaseExpiresAt) {
        tx.phase = 'ABORTED'
        tx.abortedAt = Date.now()
        tx.abortReason = `Transaction lease expired at ${String(tx.leaseExpiresAt)} ms.`
      }
    }
  }
}
