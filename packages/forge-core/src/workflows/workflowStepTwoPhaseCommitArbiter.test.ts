import { describe, expect, it } from 'vitest'
import { WorkflowStepTwoPhaseCommitArbiter } from './workflowStepTwoPhaseCommitArbiter'

describe('WorkflowStepTwoPhaseCommitArbiter', () => {
  it('throws error when initiating transaction with empty stepId or participants', () => {
    const arbiter = new WorkflowStepTwoPhaseCommitArbiter()
    expect(() => arbiter.beginTransaction('', ['worker-1'])).toThrow('stepId cannot be empty')
    expect(() => arbiter.beginTransaction('step-1', [])).toThrow(
      'participants list cannot be empty',
    )
  })

  it('initializes transaction in PREPARING phase with calculated lease duration', () => {
    const arbiter = new WorkflowStepTwoPhaseCommitArbiter({ defaultLeaseMs: 2000 })
    const tx = arbiter.beginTransaction('step-prepare', ['worker-1', 'worker-2'])

    expect(tx.stepId).toBe('step-prepare')
    expect(tx.phase).toBe('PREPARING')
    expect(tx.participants).toEqual(['worker-1', 'worker-2'])
    expect(tx.votes).toHaveLength(0)
    expect(tx.leaseExpiresAt).toBeGreaterThan(tx.createdAt)
  })

  it('advances to PREPARED when all participants vote READY', () => {
    const arbiter = new WorkflowStepTwoPhaseCommitArbiter()
    const tx = arbiter.beginTransaction('step-unanimous', ['p1', 'p2'])

    arbiter.registerVote(tx.txId, 'p1', 'READY')
    expect(tx.phase).toBe('PREPARING')

    arbiter.registerVote(tx.txId, 'p2', 'READY')
    expect(tx.phase).toBe('PREPARED')

    const committed = arbiter.commitTransaction(tx.txId)
    expect(committed.phase).toBe('COMMITTED')
    expect(committed.committedAt).toBeDefined()
  })

  it('fails closed and aborts immediately if any participant votes ABORT', () => {
    const arbiter = new WorkflowStepTwoPhaseCommitArbiter()
    const tx = arbiter.beginTransaction('step-abort', ['p1', 'p2', 'p3'])

    arbiter.registerVote(tx.txId, 'p1', 'READY')
    arbiter.registerVote(tx.txId, 'p2', 'ABORT', 'Disk full on node 2')

    expect(tx.phase).toBe('ABORTED')
    expect(tx.abortReason).toBe('Disk full on node 2')
    expect(tx.abortedAt).toBeDefined()

    // Cannot commit after abort
    expect(() => arbiter.commitTransaction(tx.txId)).toThrow(
      "Cannot commit transaction in 'ABORTED' phase",
    )
  })

  it('rejects votes from unregistered participants', () => {
    const arbiter = new WorkflowStepTwoPhaseCommitArbiter()
    const tx = arbiter.beginTransaction('step-unreg', ['p1'])

    expect(() => arbiter.registerVote(tx.txId, 'p-unknown', 'READY')).toThrow(
      "Participant 'p-unknown' is not registered",
    )
  })

  it('coordinates end-to-end transaction successfully with query callbacks', async () => {
    const arbiter = new WorkflowStepTwoPhaseCommitArbiter()
    const tx = arbiter.beginTransaction('step-auto', ['agent-a', 'agent-b'])

    const result = await arbiter.coordinate(tx.txId, async (_participantId) => {
      await Promise.resolve()
      return { vote: 'READY' }
    })

    expect(result.phase).toBe('COMMITTED')
    expect(result.votes).toHaveLength(2)
  })

  it('coordinates rollback when a participant query rejects with an error', async () => {
    const arbiter = new WorkflowStepTwoPhaseCommitArbiter()
    const tx = arbiter.beginTransaction('step-auto-fail', ['agent-a', 'agent-b'])

    const result = await arbiter.coordinate(tx.txId, async (participantId) => {
      await Promise.resolve()
      if (participantId === 'agent-b') {
        throw new Error('Connection refused to agent-b')
      }
      return { vote: 'READY' }
    })

    expect(result.phase).toBe('ABORTED')
    expect(result.abortReason).toContain('Connection refused to agent-b')
  })

  it('auto-aborts when lease expires during voting', async () => {
    const arbiter = new WorkflowStepTwoPhaseCommitArbiter({ defaultLeaseMs: 50 })
    const tx = arbiter.beginTransaction('step-timeout', ['p1', 'p2'], { leaseMs: 50 })

    await new Promise((resolve) => setTimeout(resolve, 80))

    const queried = arbiter.getTransaction(tx.txId)
    expect(queried?.phase).toBe('ABORTED')
    expect(queried?.abortReason).toContain('lease expired')
  })

  it('cannot abort an already COMMITTED transaction', () => {
    const arbiter = new WorkflowStepTwoPhaseCommitArbiter()
    const tx = arbiter.beginTransaction('step-commit-first', ['p1'])
    arbiter.registerVote(tx.txId, 'p1', 'READY')
    arbiter.commitTransaction(tx.txId)

    expect(() => arbiter.abortTransaction(tx.txId, 'Late abort')).toThrow(
      'Cannot abort already COMMITTED transaction',
    )
  })
})
