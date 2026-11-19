import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { projectIdSchema, runIdSchema, taskIdSchema } from '@shared/domain'
import { createForgeCore, type ForgeCore } from './forgeCore'
import { getMemoryStats, indexRunMemory, queryAgentMemory } from './agentMemory'

describe('Agent Semantic Memory & Solution Indexer (AGENT-007)', () => {
  let tempDir: string
  let dataDir: string
  let core: ForgeCore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'agent-memory-test-'))
    execFileSync('git', ['init', tempDir], { encoding: 'utf8' })
    dataDir = join(tempDir, 'data')
    core = createForgeCore({ dataDir })
  })

  afterEach(async () => {
    await core.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore
    }
  })

  it('indexes a completed run with exitCode 0 and physical artifacts', async () => {
    const project = await core.projects.create({
      name: 'Memory Test Project',
      repositoryPath: tempDir,
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: ['ts'],
      rules: [],
    })
    const runId = runIdSchema.parse(randomUUID())
    const projectId = projectIdSchema.parse(project.id)
    const taskId = taskIdSchema.parse(randomUUID())

    core.runs.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'completed',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: 'Added JWT validation filter',
      error: null,
      metadata: { task: 'Implement JWT authentication filter' },
    })

    await core.artifacts.writeArtifact({
      runId,
      kind: 'changeset',
      name: 'jwtFilter.ts',
      content: '// JWT filter code',
    })

    const memory = await indexRunMemory(core.runs, core.artifactStore, runId)
    expect(memory).not.toBeNull()
    expect(memory?.runId).toBe(runId)
    expect(memory?.task).toContain('JWT authentication')
    expect(memory?.touchedFiles).toContain('jwtFilter.ts')
  })

  it('returns null for failed or non-completed runs', async () => {
    const project = await core.projects.create({
      name: 'Failed Project',
      repositoryPath: tempDir,
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: ['ts'],
      rules: [],
    })
    const runId = runIdSchema.parse(randomUUID())
    const projectId = projectIdSchema.parse(project.id)
    const taskId = taskIdSchema.parse(randomUUID())

    core.runs.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'failed',
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 1,
      summary: 'Build failed',
      error: 'Type error',
      metadata: { task: 'Failing task' },
    })

    const memory = await indexRunMemory(core.runs, core.artifactStore, runId)
    expect(memory).toBeNull()
  })

  it('queries relevant past memories by semantic keyword and touched files', async () => {
    const project = await core.projects.create({
      name: 'Query Project',
      repositoryPath: tempDir,
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: ['ts'],
      rules: [],
    })
    const runId1 = runIdSchema.parse(randomUUID())
    const runId2 = runIdSchema.parse(randomUUID())
    const projectId = projectIdSchema.parse(project.id)
    const taskId = taskIdSchema.parse(randomUUID())

    // Run 1: Auth task
    core.runs.createRun({
      id: runId1,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'completed',
      startedAt: new Date(Date.now() - 8000).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: 'Auth module implemented',
      error: null,
      metadata: { task: 'Fix password hash salt generation in auth.ts' },
    })
    await core.artifacts.writeArtifact({
      runId: runId1,
      kind: 'changeset',
      name: 'auth.ts',
      content: '// auth patch',
    })

    // Run 2: Database migration task
    core.runs.createRun({
      id: runId2,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'completed',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: 'Database migration complete',
      error: null,
      metadata: { task: 'Add user_sessions table migration' },
    })
    await core.artifacts.writeArtifact({
      runId: runId2,
      kind: 'changeset',
      name: 'migration.sql',
      content: '-- migration',
    })

    // Query for auth task
    const result = await queryAgentMemory(core.runs, core.artifactStore, {
      query: 'password hash authentication',
      touchedFiles: ['src/auth.ts'],
    })

    expect(result.valid).toBe(true)
    expect(result.totalMatches).toBeGreaterThan(0)
    expect(result.entries[0]?.runId).toBe(runId1)
    expect(result.contextSnippet).toContain('PREVIOUS VERIFIED SOLUTIONS')
    expect(result.contextSnippet).toContain('password hash salt')
  })

  it('reports memory statistics across completed runs', async () => {
    const stats = await getMemoryStats(core.runs)
    expect(stats.totalRuns).toBeDefined()
    expect(stats.formattedSummary).toContain('AGENT MEMORY STATISTICS')
  })
})
