import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { runIdSchema, type RunId } from '@shared/domain'

export const retryPolicySchema = z.strictObject({
  maxRetries: z.number().int().min(0).default(3),
  baseDelayMs: z.number().int().positive().default(1000),
  maxDelayMs: z.number().int().positive().default(30000),
  backoffFactor: z.number().positive().default(2),
  jitter: z.boolean().default(true),
  retryableErrors: z.array(z.string()).default([]),
})

export type RetryPolicy = z.infer<typeof retryPolicySchema>

export const deadLetterQueueRecordSchema = z.strictObject({
  dlqId: z.string().min(1),
  runId: runIdSchema,
  nodeId: z.string().min(1),
  attempt: z.number().int().positive(),
  error: z.string().min(1),
  timestamp: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type DeadLetterQueueRecord = z.infer<typeof deadLetterQueueRecordSchema>

export interface DlqInspectionReport {
  readonly valid: boolean
  readonly totalRecords: number
  readonly records: readonly DeadLetterQueueRecord[]
  readonly formattedSummary: string
}

export const DEFAULT_RETRY_POLICY: RetryPolicy = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  backoffFactor: 2,
  jitter: true,
  retryableErrors: [
    'ETIMEDOUT',
    'ECONNRESET',
    'ENOTFOUND',
    'rate_limit',
    '503',
    '429',
    'temporary_failure',
  ],
}

/**
 * Calculates exponential backoff delay with bounded ceilings and optional jitter (Axiom A5).
 */
export function computeBackoffDelay(
  policy: RetryPolicy,
  attempt: number,
  randomFraction = Math.random(),
): number {
  if (attempt <= 0) return 0
  const exponential = policy.baseDelayMs * Math.pow(policy.backoffFactor, attempt - 1)
  const capped = Math.min(policy.maxDelayMs, exponential)

  if (!policy.jitter) {
    return Math.round(capped)
  }

  // Full jitter: uniformly distributed between 0 and capped delay
  const jittered = capped * 0.5 + capped * 0.5 * randomFraction
  return Math.round(jittered)
}

/**
 * Evaluates whether an error is eligible for retry under the specified retry policy (Axiom A2).
 */
export function isRetryableNodeError(policy: RetryPolicy, error: unknown): boolean {
  if (!error) return false
  const msg =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : JSON.stringify(error)
  const lowerMsg = msg.toLowerCase()

  if (policy.retryableErrors.length === 0) {
    // Default transient markers
    return (
      lowerMsg.includes('timeout') ||
      lowerMsg.includes('econnreset') ||
      lowerMsg.includes('rate limit') ||
      lowerMsg.includes('503') ||
      lowerMsg.includes('429')
    )
  }

  return policy.retryableErrors.some((pattern) => lowerMsg.includes(pattern.toLowerCase()))
}

function resolveDlqDir(dataDir: string): string {
  return join(dataDir, 'dlq')
}

/**
 * Persists an unrecoverable DAG stage failure record to the Dead-Letter Queue (Axiom A1, A3).
 */
export async function enqueueToDeadLetterQueue(
  dataDir: string,
  recordData: Omit<DeadLetterQueueRecord, 'dlqId' | 'timestamp'>,
): Promise<DeadLetterQueueRecord> {
  const dlqDir = resolveDlqDir(dataDir)
  await mkdir(dlqDir, { recursive: true })

  const dlqId = `dlq-${randomUUID().slice(0, 8)}`
  const record: DeadLetterQueueRecord = {
    ...recordData,
    dlqId,
    timestamp: new Date().toISOString(),
  }

  const filePath = join(dlqDir, `${dlqId}.json`)
  await writeFile(filePath, JSON.stringify(record, null, 2), 'utf8')
  return record
}

/**
 * Lists DLQ records with optional filtering by runId or nodeId (Axiom A1).
 */
export async function listDeadLetterQueue(
  dataDir: string,
  filter?: { runId?: RunId; nodeId?: string },
): Promise<DlqInspectionReport> {
  const dlqDir = resolveDlqDir(dataDir)
  if (!existsSync(dlqDir)) {
    return {
      valid: true,
      totalRecords: 0,
      records: [],
      formattedSummary: 'Dead-Letter Queue is empty (0 records).',
    }
  }

  const files = await readdir(dlqDir)
  const records: DeadLetterQueueRecord[] = []

  for (const f of files) {
    if (!f.endsWith('.json')) continue
    try {
      const text = await readFile(join(dlqDir, f), 'utf8')
      const parsed = deadLetterQueueRecordSchema.parse(JSON.parse(text))

      if (filter?.runId && parsed.runId !== filter.runId) continue
      if (filter?.nodeId && parsed.nodeId !== filter.nodeId) continue

      records.push(parsed)
    } catch {
      // Ignore corrupt files
    }
  }

  records.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

  const lines = [
    `DEAD-LETTER QUEUE RECORDS (${String(records.length)})`,
    ...records.map(
      (r) =>
        `  • [${r.dlqId}] ${r.timestamp} | Run ${r.runId.slice(0, 8)} | Node: "${r.nodeId}" (Attempt ${String(r.attempt)}) - Error: ${r.error}`,
    ),
  ]

  return {
    valid: true,
    totalRecords: records.length,
    records,
    formattedSummary: lines.join('\n'),
  }
}

/**
 * Purges dead-letter queue records either entirely or by individual ID (Axiom A5).
 */
export async function purgeDeadLetterQueue(
  dataDir: string,
  dlqId?: string,
): Promise<{ purgedCount: number; formattedSummary: string }> {
  const dlqDir = resolveDlqDir(dataDir)
  if (!existsSync(dlqDir)) {
    return {
      purgedCount: 0,
      formattedSummary: 'Dead-Letter Queue directory does not exist (0 purged).',
    }
  }

  if (dlqId) {
    const targetFile = join(dlqDir, `${dlqId}.json`)
    if (existsSync(targetFile)) {
      await rm(targetFile, { force: true })
      return { purgedCount: 1, formattedSummary: `✓ DLQ record ${dlqId} purged.` }
    }
    return { purgedCount: 0, formattedSummary: `DLQ record ${dlqId} not found.` }
  }

  const files = await readdir(dlqDir)
  let count = 0
  for (const f of files) {
    if (f.endsWith('.json')) {
      await rm(join(dlqDir, f), { force: true })
      count++
    }
  }

  return {
    purgedCount: count,
    formattedSummary: `✓ Purged ${String(count)} Dead-Letter Queue record(s).`,
  }
}
