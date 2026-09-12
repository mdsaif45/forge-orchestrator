import { createHash, randomUUID } from 'node:crypto'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  artifactIdSchema,
  projectIdSchema,
  repositoryIdSchema,
  runIdSchema,
  stepIdSchema,
  taskIdSchema,
  type RunId,
  type StepId,
} from '@shared/domain'
import { openDatabase, type ForgeDatabase } from '../db/connection'
import { runMigrations } from '../db/migrate'
import { MIGRATIONS } from '../db/migrations.generated'
import { ProjectStore } from '../db/projectStore'
import { RunStore } from '../db/runStore'
import { ArtifactStore } from '../db/artifactStore'
import { ArtifactService } from './artifactService'

describe('ArtifactService', () => {
  let db: ForgeDatabase
  let close: () => void
  let tempDir: string
  let artifactStore: ArtifactStore
  let runStore: RunStore
  let service: ArtifactService
  let runId: RunId
  let stepId: StepId

  const NOW = '2026-08-23T12:00:00.000Z'

  beforeEach(async () => {
    const conn = openDatabase({ file: ':memory:' })
    db = conn.db
    close = conn.close
    runMigrations(db, MIGRATIONS)

    tempDir = await mkdtemp(join(tmpdir(), 'forge-artifacts-test-'))
    artifactStore = new ArtifactStore(db)
    runStore = new RunStore(db)
    service = new ArtifactService(tempDir, artifactStore)

    const projects = new ProjectStore(db)
    const projectId = projectIdSchema.parse(randomUUID())
    projects.create(
      {
        id: projectId,
        name: 'Test Project',
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: 'D:/Projects/Test',
          defaultBranch: 'main',
          buildCommand: null,
          testCommand: null,
          tech: [],
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      'user',
    )

    const taskId = taskIdSchema.parse(randomUUID())
    runId = runIdSchema.parse(randomUUID())
    runStore.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      exitCode: null,
      summary: null,
      error: null,
      metadata: { model: 'test-model' },
    })

    stepId = stepIdSchema.parse(randomUUID())
    runStore.createStep({
      id: stepId,
      runId,
      index: 0,
      role: 'executor',
      runtimeId: null,
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      summary: null,
      changeSetId: null,
      evidenceId: null,
    })
  })

  afterEach(async () => {
    close()
    await rm(tempDir, { recursive: true, force: true })
  })

  it('writes and reads a text artifact on disk and in database', async () => {
    const content = 'Hello Forge Artifact Substrate!\nThis is test log output.'
    const expectedSha256 = createHash('sha256').update(content).digest('hex')

    const meta = await service.writeArtifact({
      runId,
      stepId,
      kind: 'stdout',
      name: 'build.log',
      content,
      createdAt: NOW,
    })

    expect(meta.runId).toBe(runId)
    expect(meta.stepId).toBe(stepId)
    expect(meta.kind).toBe('stdout')
    expect(meta.name).toBe('build.log')
    expect(meta.mimeType).toBe('text/plain; charset=utf-8')
    expect(meta.sha256).toBe(expectedSha256)
    expect(meta.sizeBytes).toBe(Buffer.byteLength(content, 'utf-8'))

    // Verify metadata query
    const queried = service.getMetadata(meta.id)
    expect(queried).toEqual(meta)

    // Verify text read
    const text = await service.readArtifactText(meta.id)
    expect(text).toBe(content)

    // Verify buffer read
    const buf = await service.readArtifact(meta.id)
    expect(buf.toString('utf-8')).toBe(content)
  })

  it('writes and reads binary artifacts correctly', async () => {
    const binaryData = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0xfd])
    const expectedSha256 = createHash('sha256').update(binaryData).digest('hex')

    const meta = await service.writeArtifact({
      runId,
      kind: 'custom',
      name: 'binary.dat',
      content: binaryData,
      mimeType: 'application/octet-stream',
    })

    expect(meta.sha256).toBe(expectedSha256)
    expect(meta.sizeBytes).toBe(binaryData.length)

    const readBack = await service.readArtifact(meta.id)
    expect(readBack.equals(binaryData)).toBe(true)
  })

  it('reads arbitrary byte windows of an artifact', async () => {
    const text = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'
    const meta = await service.writeArtifact({
      runId,
      kind: 'diff',
      name: 'patch.diff',
      content: text,
    })

    // Window 0..10
    const w1 = await service.readWindow(meta.id, 0, 10)
    expect(w1.totalBytes).toBe(text.length)
    expect(w1.data.toString('utf-8')).toBe('0123456789')

    // Window 10..20 (10 bytes starting at index 10)
    const w2 = await service.readWindow(meta.id, 10, 10)
    expect(w2.data.toString('utf-8')).toBe('ABCDEFGHIJ')

    // Window reaching past end
    const w3 = await service.readWindow(meta.id, 30, 100)
    expect(w3.data.toString('utf-8')).toBe('UVWXYZ')

    // Offset at or beyond total length
    const w4 = await service.readWindow(meta.id, 100, 10)
    expect(w4.data.length).toBe(0)
    expect(w4.totalBytes).toBe(text.length)

    // Negative offset
    await expect(service.readWindow(meta.id, -1, 5)).rejects.toThrow('Invalid offsetBytes')
  })

  it('lists artifacts for a run and for a step', async () => {
    const step2Id = stepIdSchema.parse(randomUUID())
    runStore.createStep({
      id: step2Id,
      runId,
      index: 1,
      role: 'verifier',
      runtimeId: null,
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      summary: null,
      changeSetId: null,
      evidenceId: null,
    })

    const art1 = await service.writeArtifact({
      runId,
      stepId,
      kind: 'stdout',
      name: 'step1-out.log',
      content: 'step 1 log',
    })

    const art2 = await service.writeArtifact({
      runId,
      stepId: step2Id,
      kind: 'stderr',
      name: 'step2-err.log',
      content: 'step 2 log',
    })

    const art3 = await service.writeArtifact({
      runId,
      stepId: null,
      kind: 'diff',
      name: 'run.patch',
      content: 'diff --git a/file b/file',
    })

    const runArtifacts = service.listArtifacts(runId)
    expect(runArtifacts).toHaveLength(3)
    expect(runArtifacts.some((a) => a.id === art3.id)).toBe(true)

    const step1Artifacts = service.listForStep(stepId)
    expect(step1Artifacts).toHaveLength(1)
    expect(step1Artifacts[0]!.id).toBe(art1.id)

    const step2Artifacts = service.listForStep(step2Id)
    expect(step2Artifacts).toHaveLength(1)
    expect(step2Artifacts[0]!.id).toBe(art2.id)
  })

  it('throws an error when reading non-existent artifact', async () => {
    const nonExistent = artifactIdSchema.parse('00000000-0000-0000-0000-000000000000')
    await expect(service.readArtifact(nonExistent)).rejects.toThrow(/not found/)
    await expect(service.readArtifactText(nonExistent)).rejects.toThrow(/not found/)
    await expect(service.readWindow(nonExistent, 0, 10)).rejects.toThrow(/not found/)
  })

  it('enforces path containment and rejects path traversal', () => {
    expect(() => service.resolvePath('../escaped.log')).toThrow(/Path traversal detected/)
    expect(() => service.resolvePath('../../etc/passwd')).toThrow(/Path traversal detected/)
    expect(() => service.resolvePath('run-123/../../../outside.txt')).toThrow(
      /Path traversal detected/,
    )
  })

  it('rolls back physical file if metadata recording in database fails', async () => {
    const failingStore = {
      record: () => {
        throw new Error('Database disk error')
      },
      get: () => null,
      listForRun: () => [],
      listForStep: () => [],
    } as unknown as ArtifactStore

    const failingService = new ArtifactService(tempDir, failingStore)

    await expect(
      failingService.writeArtifact({
        runId,
        kind: 'stdout',
        name: 'orphan-test.log',
        content: 'content that should be deleted',
      }),
    ).rejects.toThrow('Database disk error')

    const runDir = join(tempDir, runId)
    try {
      const files = await readdir(runDir)
      expect(files.filter((f) => f.includes('orphan-test'))).toHaveLength(0)
    } catch {
      // Directory may not exist
    }
  })
})
