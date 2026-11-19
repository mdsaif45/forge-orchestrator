import { createHash, randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { runIdSchema } from '@shared/domain'

export const workflowSnapshotDataSchema = z.strictObject({
  runId: runIdSchema,
  nodeId: z.string().min(1),
  iteration: z.number().int().min(1),
  status: z.string().min(1),
  nodeOutputs: z.record(z.string(), z.unknown()),
  traversedEdges: z.array(z.string()),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type WorkflowSnapshotData = z.infer<typeof workflowSnapshotDataSchema>

export interface WorkflowSnapshot extends WorkflowSnapshotData {
  readonly snapshotId: string
  readonly timestamp: string
  readonly sha256: string
}

export interface WorkflowSnapshotSummary {
  readonly snapshotId: string
  readonly runId: string
  readonly nodeId: string
  readonly iteration: number
  readonly timestamp: string
  readonly status: string
  readonly sha256: string
}

export interface WorkflowSnapshotRestoreResult {
  readonly valid: boolean
  readonly snapshot: WorkflowSnapshot | null
  readonly formattedSummary: string
  readonly error?: string | undefined
}

/**
 * Calculates SHA-256 hash of a serialized string.
 */
function computeSha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * Creates and persists a point-in-time workflow execution checkpoint snapshot (Axioms A1, A3).
 */
export async function createWorkflowSnapshot(
  dataDir: string,
  input: WorkflowSnapshotData,
): Promise<WorkflowSnapshot> {
  const snapshotId = randomUUID()
  const timestamp = new Date().toISOString()

  // Canonical serialization payload without sha256
  const payloadToHash = JSON.stringify({
    snapshotId,
    timestamp,
    ...input,
  })
  const sha256 = computeSha256(payloadToHash)

  const snapshot: WorkflowSnapshot = {
    snapshotId,
    timestamp,
    ...input,
    sha256,
  }

  const snapshotDir = join(dataDir, 'snapshots', input.runId)
  await mkdir(snapshotDir, { recursive: true })
  const filePath = join(snapshotDir, `${snapshotId}.json`)
  await writeFile(filePath, JSON.stringify(snapshot, null, 2), 'utf8')

  return snapshot
}

/**
 * Lists all available checkpoint snapshots for a given workflow run.
 */
export async function listWorkflowSnapshots(
  dataDir: string,
  runId: string,
): Promise<{
  readonly valid: boolean
  readonly runId: string
  readonly totalSnapshots: number
  readonly snapshots: readonly WorkflowSnapshotSummary[]
  readonly formattedSummary: string
}> {
  const snapshotDir = join(dataDir, 'snapshots', runId)
  if (!existsSync(snapshotDir)) {
    return {
      valid: true,
      runId,
      totalSnapshots: 0,
      snapshots: [],
      formattedSummary: `No snapshots found for run ${runId}`,
    }
  }

  const files = await readdir(snapshotDir)
  const jsonFiles = files.filter((f) => f.endsWith('.json'))
  const summaries: WorkflowSnapshotSummary[] = []

  for (const f of jsonFiles) {
    try {
      const raw = await readFile(join(snapshotDir, f), 'utf8')
      const parsed = JSON.parse(raw) as Record<string, unknown>
      if (
        typeof parsed.snapshotId === 'string' &&
        typeof parsed.runId === 'string' &&
        typeof parsed.nodeId === 'string' &&
        typeof parsed.iteration === 'number' &&
        typeof parsed.timestamp === 'string' &&
        typeof parsed.status === 'string' &&
        typeof parsed.sha256 === 'string'
      ) {
        summaries.push({
          snapshotId: parsed.snapshotId,
          runId: parsed.runId,
          nodeId: parsed.nodeId,
          iteration: parsed.iteration,
          timestamp: parsed.timestamp,
          status: parsed.status,
          sha256: parsed.sha256,
        })
      }
    } catch {
      // Ignore corrupt files during listing
    }
  }

  summaries.sort((a, b) => a.timestamp.localeCompare(b.timestamp))

  const lines: string[] = []
  lines.push('================================================================================')
  lines.push(`Workflow Snapshots: Run ${runId}`)
  lines.push(`Total Checkpoints: ${String(summaries.length)}`)
  lines.push('================================================================================')
  if (summaries.length === 0) {
    lines.push('  (No snapshots recorded for this run)')
  } else {
    for (const s of summaries) {
      lines.push(`• [${s.timestamp}] ID: ${s.snapshotId}`)
      lines.push(`  Node: ${s.nodeId} (Iteration ${String(s.iteration)}) | Status: ${s.status}`)
      lines.push(`  SHA-256: ${s.sha256.slice(0, 16)}...`)
    }
  }

  return {
    valid: true,
    runId,
    totalSnapshots: summaries.length,
    snapshots: summaries,
    formattedSummary: lines.join('\n'),
  }
}

/**
 * Loads and verifies a workflow execution snapshot, verifying cryptographic integrity (Axiom A2, A3).
 */
export async function restoreWorkflowSnapshot(
  dataDir: string,
  runId: string,
  snapshotId: string,
): Promise<WorkflowSnapshotRestoreResult> {
  const filePath = join(dataDir, 'snapshots', runId, `${snapshotId}.json`)
  if (!existsSync(filePath)) {
    return {
      valid: false,
      snapshot: null,
      error: `Snapshot "${snapshotId}" not found for run ${runId}`,
      formattedSummary: `Snapshot "${snapshotId}" not found for run ${runId}`,
    }
  }

  try {
    const raw = await readFile(filePath, 'utf8')
    const parsed = JSON.parse(raw) as WorkflowSnapshot

    // Verify SHA-256 integrity
    const { sha256, ...dataToHash } = parsed
    const recalculated = computeSha256(JSON.stringify(dataToHash))
    if (sha256 !== recalculated) {
      const err = `Cryptographic integrity failure: Snapshot ${snapshotId} has been tampered with.`
      return {
        valid: false,
        snapshot: null,
        error: err,
        formattedSummary: `✗ ${err}`,
      }
    }

    const lines: string[] = []
    lines.push('================================================================================')
    lines.push(`Workflow Snapshot Restored: ${snapshotId}`)
    lines.push('================================================================================')
    lines.push(`  Run ID:    ${parsed.runId}`)
    lines.push(`  Node ID:   ${parsed.nodeId}`)
    lines.push(`  Iteration: ${String(parsed.iteration)}`)
    lines.push(`  Status:    ${parsed.status}`)
    lines.push(`  Integrity: Verified SHA-256 (${sha256.slice(0, 16)}...)`)

    return {
      valid: true,
      snapshot: parsed,
      formattedSummary: lines.join('\n'),
    }
  } catch (e) {
    const err = `Failed to restore snapshot: ${e instanceof Error ? e.message : String(e)}`
    return {
      valid: false,
      snapshot: null,
      error: err,
      formattedSummary: `✗ ${err}`,
    }
  }
}
