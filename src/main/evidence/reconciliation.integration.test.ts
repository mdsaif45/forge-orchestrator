import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  compileContext,
  FEATURE_IMPLEMENTATION,
  projectIdSchema,
  reconcile,
  repositoryIdSchema,
  stepIdSchema,
  summariseDiscrepancies,
  taskIdSchema,
  workflowIdSchema,
  workflowLimitsSchema,
  type ProjectId,
  type ScopePolicy,
  type TaskId,
  type WorkflowId,
} from '@shared/domain'
import { initialiseDatabase, type ForgeDatabase } from '../db'
import { EventStore } from '../db/eventStore'
import { ProjectStore } from '../db/projectStore'
import { applyEvent } from '../db/projections'
import { WorkflowStore } from '../db/workflowStore'
import { PacketStore } from '../context/packetStore'
import { GitService } from '../git'
import { bindRole, BindingSet } from '../runtimes/bindings'
import { MockAgentRuntime } from '../runtimes/mockRuntime'
import { Orchestrator } from '../runtimes/orchestrator'
import { RuntimeRegistry } from '../runtimes/registry'
import { SCENARIOS } from '../runtimes/scenario'
import { buildChangeSet, diffStatOf } from './changeSetBuilder'

/**
 * Reconciliation against a real repository and a real workflow.
 *
 * The unit tests in `shared/domain/reconcile.test.ts` cover the comparison. These cover the
 * claim the issue makes: that an agent editing outside its scope is *stopped*, and that a
 * mismatch between claim and reality is recorded rather than passed over. Both need a real
 * diff, because the whole point is that the repository is the authority.
 */

let dbFile: string
let db: ForgeDatabase
let closeDb: () => void
let repoPath: string
let packetDir: string

const NOW = '2026-08-19T10:00:00.000Z'
let projectId: ProjectId
let taskId: TaskId
let workflowId: WorkflowId

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })
}

const SCOPE: ScopePolicy = { allowedPaths: ['src/**'], forbiddenPaths: [] }

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'forge-recon-repo-'))
  git('init', '--quiet', '--initial-branch=main', '.')
  git('config', 'user.email', 'test@forge.local')
  git('config', 'user.name', 'Forge Test')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(repoPath, 'src'))
  writeFileSync(join(repoPath, 'src', 'math.ts'), 'export const answer = 40\n')
  writeFileSync(join(repoPath, 'package.json'), '{ "name": "subject" }\n')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'base')

  packetDir = mkdtempSync(join(tmpdir(), 'forge-recon-packets-'))
  dbFile = join(mkdtempSync(join(tmpdir(), 'forge-recon-db-')), 'forge.db')
  const opened = initialiseDatabase(dbFile)
  db = opened.db
  closeDb = opened.close

  projectId = projectIdSchema.parse(randomUUID())
  taskId = taskIdSchema.parse(randomUUID())
  workflowId = workflowIdSchema.parse(randomUUID())

  new ProjectStore(db).create(
    {
      id: projectId,
      name: 'Subject',
      repository: {
        id: repositoryIdSchema.parse(randomUUID()),
        absolutePath: repoPath.split('\\').join('/'),
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

  applyEvent(
    db,
    new EventStore(db).append(
      {
        type: 'task.created',
        payload: {
          task: {
            id: taskId,
            objective: 'Correct the constant in src/math.ts',
            constraints: [],
            completionCriteria: [{ kind: 'tests', description: 'the tests pass', params: {} }],
            scope: SCOPE,
            lockedDecisionIds: [],
            correctsTaskId: null,
            createdAt: NOW,
          },
        },
      },
      { projectId, actor: 'user', occurredAt: NOW },
    ),
  )

  new WorkflowStore(db).start(
    { workflowId, projectId, taskId, templateId: 'feature', startedAt: NOW },
    'user',
  )
})

afterEach(() => {
  closeDb()
  rmSync(dbFile, { recursive: true, force: true })
  rmSync(repoPath, { recursive: true, force: true })
  rmSync(packetDir, { recursive: true, force: true })
})

/** An orchestrator with reconciliation wired to the real repository. */
function orchestrator(registry: RuntimeRegistry): Orchestrator {
  const service = new GitService({ repositoryPath: repoPath })
  const baseSha = git('rev-parse', 'HEAD').trim()

  return new Orchestrator({
    registry,
    workflows: new WorkflowStore(db),
    packets: new PacketStore({ directory: packetDir }),
    compilePacket: (context) =>
      Promise.resolve(
        compileContext({
          role: context.role,
          task: {
            id: taskId,
            objective: 'Correct the constant in src/math.ts',
            constraints: [],
            completionCriteria: [{ kind: 'tests', description: 'the tests pass', params: {} }],
            scope: SCOPE,
            lockedDecisionIds: [],
            correctsTaskId: null,
            createdAt: NOW,
          },
          rules: [],
          lockedDecisions: [],
          files: [{ path: 'src/math.ts', mentionedInTask: true, inScope: true }],
          previousAttempt: context.previousAttempt,
          reviewFindings: context.reviewFindings,
          answeredQuestions: [],
        }).packet,
      ),
    measureChange: async () => {
      const diff = await service.diffWorktree('HEAD')
      return { files: [...diff.files], patch: diff.patch }
    },
    // The real thing: a changeset built from the worktree, reconciled against the claim.
    reconcileStep: async (report) => {
      const built = await buildChangeSet(service, {
        baseSha,
        report,
        scope: SCOPE,
        authorActor: 'agent:mock:all',
        stepId: stepIdSchema.parse(randomUUID()),
        taskId,
        capturedAt: NOW,
      })

      return built.reconciliation
    },
  })
}

function registryFor(scenario: (typeof SCENARIOS)[keyof typeof SCENARIOS]): {
  registry: RuntimeRegistry
  bindings: BindingSet
} {
  const registry = new RuntimeRegistry()
  registry.register(new MockAgentRuntime({ scenario, id: 'mock:all' }))

  return {
    registry,
    bindings: new BindingSet([
      bindRole(registry, { role: 'planner', runtimeId: 'mock:all' }),
      bindRole(registry, { role: 'implementer', runtimeId: 'mock:all' }),
      bindRole(registry, { role: 'reviewer', runtimeId: 'mock:all' }),
    ]),
  }
}

function runOptions(bindings: BindingSet) {
  return {
    workflowId,
    template: FEATURE_IMPLEMENTATION,
    bindings,
    repositoryPath: repoPath,
    limits: workflowLimitsSchema.parse({ maxIterations: 2 }),
    approve: () => Promise.resolve(true),
    verify: () => Promise.resolve({ passed: true, detail: 'build and tests passed' }),
  }
}

describe('building a changeset from the repository', () => {
  it('records what git shows, not what the agent claimed', async () => {
    const service = new GitService({ repositoryPath: repoPath })
    const baseSha = git('rev-parse', 'HEAD').trim()

    writeFileSync(join(repoPath, 'src', 'math.ts'), 'export const answer = 42\n')

    const built = await buildChangeSet(service, {
      baseSha,
      report: {
        status: 'completed',
        summary: 'Fixed it',
        // Claims a second file that was never touched.
        filesChanged: ['src/math.ts', 'src/imaginary.ts'],
        commandsRun: [],
        testsRun: false,
        openQuestions: [],
        assumptions: [],
      },
      scope: SCOPE,
      authorActor: 'agent:mock:all',
      stepId: stepIdSchema.parse(randomUUID()),
      taskId,
      capturedAt: NOW,
    })

    // The files come from the diff; the claim does not add one.
    expect(built.changeSet.files.map((file) => file.path)).toEqual(['src/math.ts'])
    expect(built.changeSet.patch).toContain('+export const answer = 42')

    // And the overstatement is recorded rather than dropped.
    expect(built.reconciliation.discrepancies).toHaveLength(1)
    expect(built.reconciliation.discrepancies.at(0)?.kind).toBe('claimed-but-unchanged')
  })

  it('records change ownership', async () => {
    // What makes a correction loop auditable months later rather than a sequence of anonymous
    // diffs.
    const service = new GitService({ repositoryPath: repoPath })
    const stepId = stepIdSchema.parse(randomUUID())
    writeFileSync(join(repoPath, 'src', 'math.ts'), 'export const answer = 42\n')

    const built = await buildChangeSet(service, {
      baseSha: git('rev-parse', 'HEAD').trim(),
      report: {
        status: 'completed',
        summary: 'Fixed it',
        filesChanged: ['src/math.ts'],
        commandsRun: [],
        testsRun: false,
        openQuestions: [],
        assumptions: [],
      },
      scope: SCOPE,
      authorActor: 'agent:mock:all',
      stepId,
      taskId,
      capturedAt: NOW,
    })

    expect(built.changeSet.authorActor).toBe('agent:mock:all')
    expect(built.changeSet.stepId).toBe(stepId)
    expect(built.changeSet.taskId).toBe(taskId)
    // Null for a first attempt; set when this changeset fixes an earlier one.
    expect(built.changeSet.correctsChangeSetId).toBeNull()
    // Not reviewed here: capturing a diff is not reviewing it (#36).
    expect(built.changeSet.reviewVerdict).toBeNull()
  })

  it('summarises the diff from Forge’s own measurement', async () => {
    const service = new GitService({ repositoryPath: repoPath })
    writeFileSync(join(repoPath, 'src', 'math.ts'), 'export const answer = 42\n')

    const built = await buildChangeSet(service, {
      baseSha: git('rev-parse', 'HEAD').trim(),
      report: {
        status: 'completed',
        summary: 'Fixed it',
        filesChanged: ['src/math.ts'],
        commandsRun: [],
        testsRun: false,
        openQuestions: [],
        assumptions: [],
      },
      scope: SCOPE,
      authorActor: 'agent:mock:all',
      stepId: stepIdSchema.parse(randomUUID()),
      taskId,
      capturedAt: NOW,
    })

    // The next attempt is told what actually happened, not what the last one said happened.
    expect(diffStatOf(built.changeSet)).toBe('1 file(s), +1 -1')
  })

  it('reports an empty changeset honestly', async () => {
    const service = new GitService({ repositoryPath: repoPath })

    const built = await buildChangeSet(service, {
      baseSha: git('rev-parse', 'HEAD').trim(),
      report: {
        status: 'completed',
        summary: 'Nothing needed doing',
        filesChanged: [],
        commandsRun: [],
        testsRun: false,
        openQuestions: [],
        assumptions: [],
      },
      scope: SCOPE,
      authorActor: 'agent:mock:all',
      stepId: stepIdSchema.parse(randomUUID()),
      taskId,
      capturedAt: NOW,
    })

    expect(built.changeSet.files).toEqual([])
    expect(built.reconciliation.claimAccurate).toBe(true)
    expect(diffStatOf(built.changeSet)).toBe('nothing changed')
  })
})

describe('the scope-creep scenario', () => {
  it('halts with HALTED_POLICY and names the offending file', async () => {
    // The definition of done. The scenario edits src/math.ts (allowed) and package.json
    // (outside `src/**`), and reports both honestly — so the halt is about the *edit*, not
    // about the report.
    const { registry, bindings } = registryFor(SCENARIOS.scopeCreep)

    const outcome = await orchestrator(registry).run(runOptions(bindings))

    expect(outcome.state).toBe('HALTED_POLICY')
    expect(outcome.haltCode).toBe('unexpected-file-modification')
    // Named, so the user knows which file rather than that "something" was out of scope.
    expect(outcome.haltReason).toContain('package.json')
  })

  it('records the halt reason in the workflow, not only in the return value', async () => {
    const { registry, bindings } = registryFor(SCENARIOS.scopeCreep)
    await orchestrator(registry).run(runOptions(bindings))

    const workflow = new WorkflowStore(db).find(workflowId)

    expect(workflow?.state).toBe('HALTED_POLICY')
    expect(workflow?.haltReason).toContain('outside the task scope')
  })

  it('stops at the step that made the edit, not after advancing', async () => {
    // An out-of-scope edit must halt where it happened. Advancing first and halting later would
    // build the next step on a change the user never sanctioned.
    const { registry, bindings } = registryFor(SCENARIOS.scopeCreep)
    const outcome = await orchestrator(registry).run(runOptions(bindings))

    // planner, user, implementer — and nothing after.
    expect(outcome.steps.map((step) => step.role)).toEqual(['planner', 'user', 'implementer'])
  })
})

describe('the liar scenario', () => {
  it('records a discrepancy rather than passing', async () => {
    // The other half of the definition of done: a claim/reality mismatch is visible as a
    // discrepancy, not a pass. The `liar` scenario claims src/math.ts changed and touches
    // nothing.
    const service = new GitService({ repositoryPath: repoPath })
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.liar, id: 'mock:all' }))

    const session = await registry
      .resolve('mock:all')
      .start({ repositoryPath: repoPath, role: 'implementer' })

    const runtime = registry.resolve('mock:all')
    const events = runtime.events(session)[Symbol.asyncIterator]()

    await runtime.send(session, {
      role: 'implementer',
      objective: 'Correct the constant',
      constraints: [],
      rules: [],
      lockedDecisions: [],
      allowedPaths: ['src/**'],
      forbiddenPaths: [],
      relevantFiles: [],
      reviewFindings: [],
      previousAttempt: null,
      completionCriteria: [],
      answeredQuestions: [],
    })

    // Drain to the report.
    let report = null
    for (let index = 0; index < 10; index += 1) {
      const next = await events.next()
      if (next.done === true) break
      if (next.value.type === 'result') {
        report = next.value.report
        break
      }
    }

    expect(report).not.toBeNull()
    if (report === null) return

    const built = await buildChangeSet(service, {
      baseSha: git('rev-parse', 'HEAD').trim(),
      report,
      scope: SCOPE,
      authorActor: 'agent:mock:all',
      stepId: stepIdSchema.parse(randomUUID()),
      taskId,
      capturedAt: NOW,
    })

    await runtime.dispose(session)

    // The report claims a change; git shows none.
    expect(report.filesChanged).toEqual(['src/math.ts'])
    expect(built.changeSet.files).toEqual([])
    expect(built.reconciliation.claimAccurate).toBe(false)
    expect(built.changeSet.discrepancies.at(0)?.kind).toBe('claimed-but-unchanged')

    // And the summary a user sees says so plainly.
    expect(summariseDiscrepancies(built.reconciliation)).toContain('1 reported but unchanged')
  })

  it('does not halt the workflow — a lie is a correction', async () => {
    // The distinction the whole design rests on: dishonesty loops back as a finding, a scope
    // breach halts. The liar's diff is empty, so the no-progress guard stops the run rather
    // than a policy halt.
    const { registry, bindings } = registryFor(SCENARIOS.liar)
    const outcome = await orchestrator(registry).run(runOptions(bindings))

    expect(outcome.state).not.toBe('HALTED_POLICY')
  })
})

describe('an honest in-scope run', () => {
  it('reaches DONE with no discrepancies', async () => {
    // The control case: reconciliation must not halt a run that did exactly what it said.
    const { registry, bindings } = registryFor(SCENARIOS.fullRun)

    const outcome = await orchestrator(registry).run(runOptions(bindings))

    expect(outcome.state).toBe('DONE')
    expect(outcome.haltCode).toBeNull()
  })
})

describe('reconciliation is pure', () => {
  it('needs no repository to compare a claim', () => {
    // Stated as a test because it is what keeps the interesting cases cheap to cover: the
    // comparison is a function of three inputs and nothing else.
    const result = reconcile({
      claimed: ['src/a.ts'],
      actual: [
        {
          path: 'src/b.ts',
          changeType: 'modified',
          previousPath: null,
          insertions: 1,
          deletions: 0,
        },
      ],
      scope: SCOPE,
    })

    expect(result.discrepancies.map((entry) => entry.kind)).toEqual([
      'changed-but-unclaimed',
      'claimed-but-unchanged',
    ])
  })
})
