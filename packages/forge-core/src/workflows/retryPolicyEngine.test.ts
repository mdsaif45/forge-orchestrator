import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runIdSchema } from '@shared/domain'
import {
  computeBackoffDelay,
  DEFAULT_RETRY_POLICY,
  enqueueToDeadLetterQueue,
  isRetryableNodeError,
  listDeadLetterQueue,
  purgeDeadLetterQueue,
  type RetryPolicy,
} from './retryPolicyEngine'

describe('Workflow DLQ and Retry Policy Engine (WORK-015)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'dlq-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('computes exponential backoff delays with bounded maximum', () => {
    const policy: RetryPolicy = {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 5000,
      backoffFactor: 2,
      jitter: false,
      retryableErrors: [],
    }

    expect(computeBackoffDelay(policy, 0)).toBe(0)
    expect(computeBackoffDelay(policy, 1)).toBe(1000)
    expect(computeBackoffDelay(policy, 2)).toBe(2000)
    expect(computeBackoffDelay(policy, 3)).toBe(4000)
    expect(computeBackoffDelay(policy, 4)).toBe(5000) // capped at maxDelayMs
  })

  it('applies jitter within expected delay bounds', () => {
    const policy: RetryPolicy = {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 10000,
      backoffFactor: 2,
      jitter: true,
      retryableErrors: [],
    }

    // Min fraction (0) => 50% of 1000 = 500
    const delayLow = computeBackoffDelay(policy, 1, 0)
    expect(delayLow).toBe(500)

    // Max fraction (1) => 100% of 1000 = 1000
    const delayHigh = computeBackoffDelay(policy, 1, 1)
    expect(delayHigh).toBe(1000)
  })

  it('identifies retryable error messages against policy', () => {
    expect(
      isRetryableNodeError(DEFAULT_RETRY_POLICY, new Error('Connection reset: ECONNRESET')),
    ).toBe(true)
    expect(
      isRetryableNodeError(DEFAULT_RETRY_POLICY, new Error('HTTP 429 Too Many Requests')),
    ).toBe(true)
    expect(
      isRetryableNodeError(DEFAULT_RETRY_POLICY, new Error('SyntaxError: unexpected token')),
    ).toBe(false)
  })

  it('enqueues, lists, and purges Dead-Letter Queue records', async () => {
    const runId1 = runIdSchema.parse(randomUUID())
    const runId2 = runIdSchema.parse(randomUUID())

    const record1 = await enqueueToDeadLetterQueue(tempDir, {
      runId: runId1,
      nodeId: 'build',
      attempt: 3,
      error: 'Build timeout after 300000ms',
    })

    const record2 = await enqueueToDeadLetterQueue(tempDir, {
      runId: runId2,
      nodeId: 'test',
      attempt: 3,
      error: 'Test suite failure',
    })

    expect(record1.dlqId).toMatch(/^dlq-/)
    expect(record2.dlqId).toMatch(/^dlq-/)

    // List all
    const all = await listDeadLetterQueue(tempDir)
    expect(all.valid).toBe(true)
    expect(all.totalRecords).toBe(2)
    expect(all.formattedSummary).toContain('DEAD-LETTER QUEUE RECORDS (2)')

    // Filter by runId
    const filtered = await listDeadLetterQueue(tempDir, { runId: runId1 })
    expect(filtered.totalRecords).toBe(1)
    expect(filtered.records[0]?.nodeId).toBe('build')

    // Purge record 1
    const purgeOne = await purgeDeadLetterQueue(tempDir, record1.dlqId)
    expect(purgeOne.purgedCount).toBe(1)

    // Purge remaining
    const purgeAll = await purgeDeadLetterQueue(tempDir)
    expect(purgeAll.purgedCount).toBe(1)

    const empty = await listDeadLetterQueue(tempDir)
    expect(empty.totalRecords).toBe(0)
  })
})
