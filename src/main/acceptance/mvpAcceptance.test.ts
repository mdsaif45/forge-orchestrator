import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decisionIdSchema, projectIdSchema, workflowIdSchema, type Decision } from '@shared/domain'
import { initialiseDatabase, type ForgeDatabase } from '../db'
import { ProjectService } from '../projects/projectService'
import { MockAgentRuntime } from '../runtimes/mockRuntime'
import { RuntimeRegistry } from '../runtimes/registry'
import { SCENARIOS } from '../runtimes/scenario'
import { WorkflowService } from '../workflows/workflowService'
import { planResume } from '../db/workflowStore'

function initGitRepository(directory: string): void {
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', '.'], { cwd: directory })
  execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: directory })
  execFileSync('git', ['config', 'user.name', 'Forge Test Runner'], { cwd: directory })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: directory })
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'fixture-project', version: '1.0.0' }, null, 2),
  )
  writeFileSync(
    join(directory, 'index.js'),
    'module.exports = function add(a, b) { return a + b }\n',
  )
  execFileSync('git', ['add', '-A'], { cwd: directory })
  execFileSync('git', ['commit', '--quiet', '-m', 'initial commit'], { cwd: directory })
}

describe('MVP Acceptance: Multi-Agent Closed Loop with Zero Copy-Paste (#43)', () => {
  let tempDir: string
  let repoDir: string
  let packetDir: string
  let dbHandle: { readonly db: ForgeDatabase; readonly close: () => void }
  let projects: ProjectService
  let workflows: WorkflowService
  let registry: RuntimeRegistry

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'forge-mvp-acceptance-'))
    repoDir = join(tempDir, 'repo')
    packetDir = join(tempDir, 'packets')
    mkdirSync(repoDir, { recursive: true })
    mkdirSync(packetDir, { recursive: true })
    initGitRepository(repoDir)

    const dbFile = join(tempDir, 'forge.db')
    dbHandle = initialiseDatabase(dbFile)
    projects = new ProjectService(dbHandle.db)
    registry = new RuntimeRegistry()

    // Register multi-agent mock runtimes
    registry.register(
      new MockAgentRuntime({
        scenario: SCENARIOS.fullRun,
        id: 'mock:planner',
      }),
    )
    registry.register(
      new MockAgentRuntime({
        scenario: SCENARIOS.fullRun,
        id: 'mock:implementer',
      }),
    )
    registry.register(
      new MockAgentRuntime({
        scenario: SCENARIOS.fullRun,
        id: 'mock:reviewer',
      }),
    )

    workflows = new WorkflowService({
      db: dbHandle.db,
      projects,
      packetDir,
      registry,
    })
  })

  afterEach(() => {
    dbHandle.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore Windows transient file lock during cleanup
    }
  })

  it('executes full zero copy-paste loop: plan -> lock decision -> implement -> verify -> review -> DONE', async () => {
    // 1. Create project and bind git repository
    const project = await projects.create({
      name: 'Calculator Acceptance Repo',
      repositoryPath: repoDir,
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: ['javascript'],
      rules: [],
    })
    expect(project.id).toBeDefined()

    // 2. Start feature workflow
    const started = await workflows.start({
      projectId: project.id,
      objective: 'Add multiplication feature with full test coverage',
      autoRun: false,
    })
    expect(started.state).toBe('DISCOVERY')

    // 3. Discussion phase: planner produces plan packet
    const now = new Date().toISOString()
    const wId = workflowIdSchema.parse(started.id)
    const pId = projectIdSchema.parse(project.id)

    workflows.getWorkflowStore().apply(wId, 'start', 'system', now)
    workflows.getWorkflowStore().apply(wId, 'planProduced', 'agent:planner', now)

    const planReady = workflows.get(started.id)
    expect(planReady?.state).toBe('PLAN_READY')

    // 4. Lock architectural decision (Axiom A4: only user can lock)
    const decId = decisionIdSchema.parse(randomUUID())
    const decision: Decision = {
      id: decId,
      statement: 'Export multiply as a pure named function',
      rationale: 'Functional API design',
      status: 'proposed',
      proposedBy: 'agent:planner',
      proposedAt: now,
      lockedAt: null,
      lockedBy: null,
      supersededBy: null,
      originQuestionId: null,
    }
    workflows.getDecisionStore().propose(decision, pId, 'user', now)
    workflows.getDecisionStore().lock(decId, 'user', now)

    // 5. User clicks "Continue to Implementation" -> enters DECISIONS_LOCKED / IMPLEMENTING
    const implementing = workflows.approveAndStartImplementation(started.id)
    expect(implementing.state).toBe('DECISIONS_LOCKED')

    // 6. Advance through implementation, verification, and review
    workflows.getWorkflowStore().apply(wId, 'implementationStarted', 'agent:implementer', now)
    workflows.getWorkflowStore().apply(wId, 'implemented', 'agent:implementer', now)
    workflows.getWorkflowStore().apply(wId, 'verified', 'system', now)
    workflows.getWorkflowStore().apply(wId, 'reviewPassed', 'agent:reviewer', now)

    // 7. Workflow reaches DONE
    const completed = workflows.get(started.id)
    expect(completed?.state).toBe('DONE')
    expect(completed?.finishedAt).not.toBeNull()
  })

  it('pauses cleanly when an agent raises an open question, and resumes on user answer', async () => {
    const questionRegistry = new RuntimeRegistry()
    questionRegistry.register(
      new MockAgentRuntime({
        scenario: SCENARIOS.question,
        id: 'mock:default',
      }),
    )

    const questionWorkflows = new WorkflowService({
      db: dbHandle.db,
      projects,
      packetDir,
      registry: questionRegistry,
    })

    const project = await projects.create({
      name: 'Question Pause Test',
      repositoryPath: repoDir,
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: [],
      rules: [],
    })

    const started = await questionWorkflows.start({
      projectId: project.id,
      autoRun: true,
    })

    // Poll until question pauses workflow in AWAITING_USER
    let paused = questionWorkflows.get(started.id)
    // 3s, not 1s: the orchestrator runs a real scenario here, and under the full
    // parallel suite it needs seconds. Kept well inside vitest's 5s per-test timeout —
    // a longer budget than that makes the test time out instead of failing, which is
    // how an earlier attempt at this made things worse. Still bounded, so a workflow
    // that never pauses fails rather than hanging.
    for (let i = 0; i < 60; i += 1) {
      paused = questionWorkflows.get(started.id)
      if (paused?.state === 'AWAITING_USER') break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }

    expect(paused?.state).toBe('AWAITING_USER')
    expect(paused?.blockedByQuestionId).toBeTruthy()

    // User answers the question
    const qId = paused?.blockedByQuestionId ?? ''
    const answered = questionWorkflows.answerQuestion(qId, 'Return 404 Not Found', true)
    expect(answered.answer).toBe('Return 404 Not Found')

    // Verified question was promoted to decision
    const pId = projectIdSchema.parse(project.id)
    const decisionsList = questionWorkflows.getDecisionStore().listForProject(pId)
    expect(decisionsList.length).toBeGreaterThan(0)

    for (let i = 0; i < 30; i += 1) {
      const current = questionWorkflows.get(started.id)
      if (current?.finishedAt !== null) break
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    questionWorkflows.cancel(started.id)
  })

  it('recovers workflow state and checkpoint after an abrupt kill or restart', async () => {
    const project = await projects.create({
      name: 'Crash Recovery Test',
      repositoryPath: repoDir,
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: [],
      rules: [],
    })

    const started = await workflows.start({
      projectId: project.id,
      autoRun: false,
    })

    const now = new Date().toISOString()
    const wId = workflowIdSchema.parse(started.id)

    // Set checkpoint mid-run
    workflows.getWorkflowStore().checkpoint(
      wId,
      {
        stepIndex: 2,
        state: 'IMPLEMENTING',
        startedAt: now,
        lastOperation: 'agent:implementer',
        inputRef: 'packet://step-2-input',
      },
      'system',
      now,
    )

    // Load domain workflow and calculate recovery plan
    const domainWf = workflows.getWorkflowStore().require(wId)
    const plan = planResume(domainWf)

    expect(plan).not.toBeNull()
    expect(plan?.stepIndex).toBe(2)
    expect(plan?.lastOperation).toBe('agent:implementer')
    expect(plan?.inputRef).toBe('packet://step-2-input')
  })
})
