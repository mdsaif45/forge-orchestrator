import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runIdSchema } from '@shared/domain'
import {
  createWorkflowSnapshot,
  listWorkflowSnapshots,
  restoreWorkflowSnapshot,
} from './graphSnapshotter'

describe('Workflow Graph Snapshotter & Time-Travel (WORK-014)', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'graph-snapshot-test-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('creates and persists a valid workflow snapshot with cryptographic hash', async () => {
    const runId = runIdSchema.parse(randomUUID())
    const snapshot = await createWorkflowSnapshot(tempDir, {
      runId,
      nodeId: 'implement',
      iteration: 1,
      status: 'completed',
      nodeOutputs: { codeChanges: 4 },
      traversedEdges: ['start->plan', 'plan->implement'],
    })

    expect(snapshot.snapshotId).toBeDefined()
    expect(snapshot.runId).toBe(runId)
    expect(snapshot.nodeId).toBe('implement')
    expect(snapshot.sha256).toBeDefined()
  })

  it('lists snapshots ordered by timestamp', async () => {
    const runId = runIdSchema.parse(randomUUID())
    await createWorkflowSnapshot(tempDir, {
      runId,
      nodeId: 'plan',
      iteration: 1,
      status: 'completed',
      nodeOutputs: {},
      traversedEdges: ['start->plan'],
    })
    await createWorkflowSnapshot(tempDir, {
      runId,
      nodeId: 'implement',
      iteration: 1,
      status: 'completed',
      nodeOutputs: {},
      traversedEdges: ['plan->implement'],
    })

    const result = await listWorkflowSnapshots(tempDir, runId)
    expect(result.valid).toBe(true)
    expect(result.totalSnapshots).toBe(2)
    expect(result.snapshots[0]?.nodeId).toBe('plan')
    expect(result.snapshots[1]?.nodeId).toBe('implement')
  })

  it('restores snapshot and verifies SHA-256 integrity', async () => {
    const runId = runIdSchema.parse(randomUUID())
    const created = await createWorkflowSnapshot(tempDir, {
      runId,
      nodeId: 'verify',
      iteration: 1,
      status: 'completed',
      nodeOutputs: { testsPassed: true },
      traversedEdges: ['implement->verify'],
    })

    const restored = await restoreWorkflowSnapshot(tempDir, runId, created.snapshotId)
    expect(restored.valid).toBe(true)
    expect(restored.snapshot?.nodeId).toBe('verify')
    expect(restored.formattedSummary).toContain('Workflow Snapshot Restored')
  })

  it('fails closed when snapshot is tampered with', async () => {
    const runId = runIdSchema.parse(randomUUID())
    const created = await createWorkflowSnapshot(tempDir, {
      runId,
      nodeId: 'verify',
      iteration: 1,
      status: 'completed',
      nodeOutputs: {},
      traversedEdges: [],
    })

    // Tamper with the snapshot file on disk
    const snapshotPath = join(tempDir, 'snapshots', runId, `${created.snapshotId}.json`)
    writeFileSync(
      snapshotPath,
      JSON.stringify({ ...created, status: 'maliciously-altered' }),
      'utf8',
    )

    const restored = await restoreWorkflowSnapshot(tempDir, runId, created.snapshotId)
    expect(restored.valid).toBe(false)
    expect(restored.error).toContain('integrity failure')
  })
})
