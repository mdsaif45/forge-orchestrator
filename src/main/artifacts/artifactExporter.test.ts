import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type {
  ArtifactId,
  ArtifactMetadata,
  ProjectId,
  RunId,
  RunRecord,
  TaskId,
} from '@shared/domain'
import type { ArtifactService } from './artifactService'
import type { ArtifactStore } from '../db/artifactStore'
import type { RunStore } from '../db/runStore'
import { exportRunArtifactArchive } from './artifactExporter'

describe('exportRunArtifactArchive', () => {
  let tempDir: string

  const runId = randomUUID() as RunId
  const taskId = randomUUID() as TaskId
  const projectId = randomUUID() as ProjectId

  const mockRun: RunRecord = {
    id: runId,
    taskId,
    projectId,
    type: 'workflow',
    status: 'completed',
    startedAt: '2026-11-18T10:00:00.000Z',
    finishedAt: '2026-11-18T10:05:00.000Z',
    exitCode: 0,
    summary: 'Export test run',
    error: null,
    metadata: {},
  }

  const artContent = 'Physical artifact content bytes 12345'
  const artSha256 = createHash('sha256').update(artContent).digest('hex')
  const artId = randomUUID() as ArtifactId

  const mockArtifact: ArtifactMetadata = {
    id: artId,
    runId,
    stepId: null,
    relativePath: 'test.txt',
    kind: 'diff',
    name: 'test.txt',
    mimeType: 'text/plain',
    sizeBytes: Buffer.byteLength(artContent),
    sha256: artSha256,
    createdAt: new Date().toISOString(),
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'forge-export-test-'))
  })

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('exports self-contained JSON bundle with verified manifest', async () => {
    const artifactService = {
      readArtifact: vi.fn().mockResolvedValue(Buffer.from(artContent)),
    } as unknown as ArtifactService

    const artifactStore = {
      listForRun: vi.fn().mockReturnValue([mockArtifact]),
    } as unknown as ArtifactStore

    const runStore = {
      getRun: vi.fn().mockReturnValue(mockRun),
      listEventsForRun: vi.fn().mockReturnValue([
        {
          id: randomUUID(),
          runId,
          seq: 1,
          stream: 'lifecycle',
          payload: { type: 'run.started' },
          timestamp: '2026-11-18T10:00:00.000Z',
        },
      ]),
    } as unknown as RunStore

    const outJsonPath = join(tempDir, 'export.json')
    const result = await exportRunArtifactArchive(
      artifactService,
      artifactStore,
      runStore,
      runId,
      outJsonPath,
    )

    expect(result.valid).toBe(true)
    expect(result.totalArtifacts).toBe(1)
    expect(result.totalEvents).toBe(1)
    expect(result.manifestSha256).toBeDefined()

    const rawExport = await readFile(outJsonPath, 'utf8')
    const parsed = JSON.parse(rawExport) as {
      manifest: { runId: string; artifacts: { sha256: string }[] }
      artifacts: { contentBase64: string }[]
    }
    expect(parsed.manifest.runId).toBe(runId)
    expect(parsed.manifest.artifacts[0]?.sha256).toBe(artSha256)
    expect(parsed.artifacts[0]?.contentBase64).toBe(Buffer.from(artContent).toString('base64'))
  })

  it('detects cryptographic tampering and fails closed (A2/A3)', async () => {
    const artifactService = {
      readArtifact: vi.fn().mockResolvedValue(Buffer.from('tampered malicious bytes')),
    } as unknown as ArtifactService

    const artifactStore = {
      listForRun: vi.fn().mockReturnValue([mockArtifact]),
    } as unknown as ArtifactStore

    const runStore = {
      getRun: vi.fn().mockReturnValue(mockRun),
      listEventsForRun: vi.fn().mockReturnValue([]),
    } as unknown as RunStore

    const outJsonPath = join(tempDir, 'tampered.json')
    const result = await exportRunArtifactArchive(
      artifactService,
      artifactStore,
      runStore,
      runId,
      outJsonPath,
    )

    expect(result.valid).toBe(false)
    expect(result.error).toContain('Cryptographic tamper detected')
  })

  it('fails closed when run is not found', async () => {
    const runStore = {
      getRun: vi.fn().mockReturnValue(null),
    } as unknown as RunStore

    const result = await exportRunArtifactArchive(
      {} as ArtifactService,
      {} as ArtifactStore,
      runStore,
      runId,
      join(tempDir, 'missing.json'),
    )

    expect(result.valid).toBe(false)
    expect(result.error).toContain('Run not found')
  })
})
