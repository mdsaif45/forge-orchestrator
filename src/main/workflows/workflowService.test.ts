import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decisionIdSchema, projectIdSchema, workflowIdSchema } from '@shared/domain'
import type { ProjectView, WorkflowDetailView } from '@shared/ipc'
import { initialiseDatabase, type ForgeDatabase } from '../db'
import { ProjectService } from '../projects/projectService'
import { MockAgentRuntime } from '../runtimes/mockRuntime'
import { RuntimeRegistry } from '../runtimes/registry'
import { SCENARIOS } from '../runtimes/scenario'
import { WorkflowService } from './workflowService'

function initRepository(directory: string): void {
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', '.'], { cwd: directory })
  execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: directory })
  execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: directory })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: directory })
  writeFileSync(join(directory, 'package.json'), '{}\n')
  execFileSync('git', ['add', '-A'], { cwd: directory })
  execFileSync('git', ['commit', '--quiet', '-m', 'first'], { cwd: directory })
}

describe('WorkflowService', () => {
  let tempDir: string
  let dbHandle: { readonly db: ForgeDatabase; readonly close: () => void }
  let projects: ProjectService
  let workflows: WorkflowService
  let registry: RuntimeRegistry

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'forge-workflow-service-test-'))
    const dbFile = join(tempDir, 'test.db')
    dbHandle = initialiseDatabase(dbFile)
    projects = new ProjectService(dbHandle.db)
    registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.question, id: 'mock:default' }))

    workflows = new WorkflowService({
      db: dbHandle.db,
      projects,
      packetDir: join(tempDir, 'packets'),
      registry,
    })
  })

  afterEach(() => {
    dbHandle.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('lists workflows for a project', async () => {
    const repoPath = join(tempDir, 'repo')
    mkdirSync(repoPath, { recursive: true })
    initRepository(repoPath)

    const project: ProjectView = await projects.create({
      name: 'Test Project',
      repositoryPath: repoPath,
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: ['ts'],
      rules: [],
    })

    const initial = workflows.list(project.id)
    expect(initial).toEqual([])

    const started: WorkflowDetailView = await workflows.start({
      projectId: project.id,
      objective: 'Do math fix',
      autoRun: false,
    })

    expect(started.id).toBeDefined()
    expect(started.state).toBe('DISCOVERY')

    const list = workflows.list(project.id)
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe(started.id)

    const active = workflows.getActive(project.id)
    expect(active?.id).toBe(started.id)

    const detail = workflows.get(started.id)
    expect(detail?.id).toBe(started.id)
  })

  it('cancels an active workflow', async () => {
    const repoPath = join(tempDir, 'repo2')
    mkdirSync(repoPath, { recursive: true })
    initRepository(repoPath)

    const project: ProjectView = await projects.create({
      name: 'Cancel Test Project',
      repositoryPath: repoPath,
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: [],
      rules: [],
    })

    const started: WorkflowDetailView = await workflows.start({
      projectId: project.id,
      autoRun: false,
    })

    const cancelled = workflows.cancel(started.id, 'User stopped')
    expect(cancelled?.state).toBe('CANCELLED')

    const fetched = workflows.get(started.id)
    expect(fetched?.state).toBe('CANCELLED')
  })

  it('handles question pause and resume when answered', async () => {
    const repoPath = join(tempDir, 'repo3')
    mkdirSync(repoPath, { recursive: true })
    initRepository(repoPath)

    const project: ProjectView = await projects.create({
      name: 'Question Test Project',
      repositoryPath: repoPath,
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: [],
      rules: [],
    })

    const started: WorkflowDetailView = await workflows.start({
      projectId: project.id,
      autoRun: true,
    })

    // Wait for the mock question scenario to run and pause the workflow
    let paused: WorkflowDetailView | null = null
    for (let i = 0; i < 20; i += 1) {
      paused = workflows.get(started.id)
      if (paused?.state === 'AWAITING_USER') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(paused?.state).toBe('AWAITING_USER')
    expect(paused?.resumeState).toBe('PLANNING')
    expect(paused?.blockedByQuestionId).toBeTruthy()

    // Answer the question
    const questionId = paused?.blockedByQuestionId ?? ''
    expect(questionId).not.toBe('')
    const answered = workflows.answerQuestion(questionId, 'Use 403 Forbidden')
    expect(answered.answer).toBe('Use 403 Forbidden')

    // Wait for resumed workflow or cancel before teardown
    for (let i = 0; i < 30; i += 1) {
      const current = workflows.get(started.id)
      if (current?.finishedAt !== null) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    workflows.cancel(started.id)
  })

  it('enforces that transitioning to implementation requires at least one locked decision', async () => {
    const repoPath = join(tempDir, 'repo-mode')
    mkdirSync(repoPath, { recursive: true })
    initRepository(repoPath)

    const project: ProjectView = await projects.create({
      name: 'Mode Test Project',
      repositoryPath: repoPath,
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: [],
      rules: [],
    })

    const started: WorkflowDetailView = await workflows.start({
      projectId: project.id,
      autoRun: false,
    })

    // Advance from DISCOVERY to PLANNING, then to AWAITING_APPROVAL
    const now = new Date().toISOString()
    const wId = workflowIdSchema.parse(started.id)
    const pId = projectIdSchema.parse(project.id)
    workflows.getWorkflowStore().apply(wId, 'start', 'system', now)
    workflows.getWorkflowStore().apply(wId, 'planProduced', 'agent:planner', now)

    // Attempt to enter implementation without decisions -> throws
    expect(() => workflows.approveAndStartImplementation(started.id)).toThrow(
      /at least one approved or locked architectural decision is required/,
    )

    // Now lock a decision
    const decId = decisionIdSchema.parse(randomUUID())
    workflows.getDecisionStore().propose(
      {
        id: decId,
        statement: 'Use SQLite WAL mode',
        rationale: 'Concurrency',
        status: 'proposed',
        proposedBy: 'user',
        proposedAt: now,
        lockedAt: null,
        lockedBy: null,
        supersededBy: null,
        originQuestionId: null,
      },
      pId,
      'user',
      now,
    )
    workflows.getDecisionStore().lock(decId, 'user', now)

    // Now transitioning succeeds to DECISIONS_LOCKED
    const implementing = workflows.approveAndStartImplementation(started.id)
    expect(implementing.state).toBe('DECISIONS_LOCKED')
    workflows.cancel(started.id)
  })
})
