import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  accountIdSchema,
  decisionIdSchema,
  projectIdSchema,
  workflowIdSchema,
  type Account,
  type Decision,
} from '@shared/domain'
import { AccountStore } from '../db/accountStore'
import { EventStore } from '../db/eventStore'
import { initialiseDatabase, type ForgeDatabase } from '../db'
import { ProjectService } from '../projects/projectService'
import { MockAgentRuntime } from './mockRuntime'
import { RuntimeRegistry } from './registry'
import { SCENARIOS } from './scenario'
import { WorkflowService } from '../workflows/workflowService'

function initGitRepository(directory: string): void {
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', '.'], { cwd: directory })
  execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: directory })
  execFileSync('git', ['config', 'user.name', 'Forge Test Runner'], { cwd: directory })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: directory })
  writeFileSync(
    join(directory, 'package.json'),
    JSON.stringify({ name: 'hot-swap-repo', version: '1.0.0' }, null, 2),
  )
  execFileSync('git', ['add', '-A'], { cwd: directory })
  execFileSync('git', ['commit', '--quiet', '-m', 'initial commit'], { cwd: directory })
}

describe('Account Hot-Swapping without Domain State Loss (#44)', () => {
  let tempDir: string
  let repoDir: string
  let packetDir: string
  let dbHandle: { readonly db: ForgeDatabase; readonly close: () => void }
  let events: EventStore
  let accounts: AccountStore
  let projects: ProjectService
  let workflows: WorkflowService
  let registry: RuntimeRegistry

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'forge-account-switch-'))
    repoDir = join(tempDir, 'repo')
    packetDir = join(tempDir, 'packets')
    mkdirSync(repoDir, { recursive: true })
    mkdirSync(packetDir, { recursive: true })
    initGitRepository(repoDir)

    const dbFile = join(tempDir, 'forge.db')
    dbHandle = initialiseDatabase(dbFile)
    events = new EventStore(dbHandle.db)
    accounts = new AccountStore(dbHandle.db, events)
    projects = new ProjectService(dbHandle.db)
    registry = new RuntimeRegistry()

    // Account A runtime (Work Pro)
    registry.register(
      new MockAgentRuntime({
        scenario: SCENARIOS.fullRun,
        id: 'claude:account-a',
      }),
    )

    // Account B runtime (Backup Org)
    registry.register(
      new MockAgentRuntime({
        scenario: SCENARIOS.fullRun,
        id: 'claude:account-b',
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
      // Ignore transient Windows file locks during cleanup
    }
  })

  it('completes workflow spanning an account switch with unbroken audit history and uncorrupted state', async () => {
    // 1. Register accounts in store
    const accAId = accountIdSchema.parse(randomUUID())
    const accountA: Account = {
      id: accAId,
      provider: 'claude',
      label: 'Work Pro (Primary)',
      status: 'connected',
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
    }
    accounts.register(accountA, 'user', new Date().toISOString())

    const accBId = accountIdSchema.parse(randomUUID())
    const accountB: Account = {
      id: accBId,
      provider: 'claude',
      label: 'Backup Team (Secondary)',
      status: 'connected',
      lastUsedAt: null,
      createdAt: new Date().toISOString(),
    }
    accounts.register(accountB, 'user', new Date().toISOString())

    // 2. Create project
    const project = await projects.create({
      name: 'Account Switch Test Project',
      repositoryPath: repoDir,
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: ['ts'],
      rules: [],
    })

    // 3. Start workflow using Account A for planning
    const started = await workflows.start({
      projectId: project.id,
      objective: 'Build feature across accounts',
      autoRun: false,
    })

    const wId = workflowIdSchema.parse(started.id)
    const pId = projectIdSchema.parse(project.id)
    const now = new Date().toISOString()

    // Planner executes step 1 with Account A
    workflows.getWorkflowStore().apply(wId, 'start', 'system', now)
    workflows.getWorkflowStore().apply(wId, 'planProduced', 'agent:planner', now)

    // Lock decision
    const decId = decisionIdSchema.parse(randomUUID())
    const decision: Decision = {
      id: decId,
      statement: 'Use modular arithmetic package',
      rationale: 'Performance',
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

    // 4. Hot swap: Update account status (e.g. Account A hit rate limit, switch to Account B)
    accounts.updateStatus(accAId, 'rate_limited', 'system', now, now)
    accounts.updateStatus(accBId, 'connected', 'system', now, now)

    // 5. Enter implementation and continue with Account B
    const implementing = workflows.approveAndStartImplementation(started.id)
    expect(implementing.state).toBe('DECISIONS_LOCKED')

    workflows.getWorkflowStore().apply(wId, 'implementationStarted', 'agent:implementer', now)
    workflows.getWorkflowStore().apply(wId, 'implemented', 'agent:implementer', now)
    workflows.getWorkflowStore().apply(wId, 'verified', 'system', now)
    workflows.getWorkflowStore().apply(wId, 'reviewPassed', 'agent:reviewer', now)

    // 6. Assert workflow state is DONE and decisions/tasks remained 100% intact
    const completed = workflows.get(started.id)
    expect(completed?.state).toBe('DONE')
    expect(completed?.finishedAt).not.toBeNull()

    const lockedDecisions = workflows.getDecisionStore().listLocked(pId)
    expect(lockedDecisions).toHaveLength(1)
    expect(lockedDecisions[0]?.statement).toBe('Use modular arithmetic package')

    // 7. Verify event sequence is contiguous and unbroken
    const projectEvents = events.read(pId)
    expect(projectEvents.length).toBeGreaterThan(0)
    for (let i = 0; i < projectEvents.length; i += 1) {
      expect(projectEvents[i]?.seq).toBe(i + 1)
    }
  })
})
