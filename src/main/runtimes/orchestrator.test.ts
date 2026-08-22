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
  repositoryIdSchema,
  taskIdSchema,
  validateTemplate,
  workflowIdSchema,
  workflowLimitsSchema,
  type ProjectId,
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
import { bindRole, BindingSet, UnboundRoleError } from './bindings'
import { MockAgentRuntime } from './mockRuntime'
import { Orchestrator, UnrunnableWorkflowError } from './orchestrator'
import { IncapableRuntimeError, RuntimeRegistry } from './registry'
import { SCENARIOS } from './scenario'

/**
 * The orchestrator, running a real template against real runtimes and a real repository.
 *
 * This is the first point where everything built separately becomes a loop, so the tests are
 * about the loop's behaviour rather than any one component: does a workflow reach DONE, does
 * swapping which runtime plans change nothing but data, does a dishonest agent get stopped.
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

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'forge-orch-repo-'))
  git('init', '--quiet', '--initial-branch=main', '.')
  git('config', 'user.email', 'test@forge.local')
  git('config', 'user.name', 'Forge Test')
  git('config', 'commit.gpgsign', 'false')
  mkdirSync(join(repoPath, 'src'))
  writeFileSync(join(repoPath, 'src', 'math.ts'), 'export const answer = 40\n')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'base')

  packetDir = mkdtempSync(join(tmpdir(), 'forge-orch-packets-'))
  dbFile = join(mkdtempSync(join(tmpdir(), 'forge-orch-db-')), 'forge.db')
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
            scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
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

/** Builds an orchestrator wired to real stores and a real repository. */
function orchestrator(registry: RuntimeRegistry): Orchestrator {
  const service = new GitService({ repositoryPath: repoPath })

  return new Orchestrator({
    registry,
    workflows: new WorkflowStore(db),
    packets: new PacketStore({ directory: packetDir }),
    // Promise.resolve rather than : the interface is async because a real compiler
    // reads the filesystem, and this one does not.
    compilePacket: (context) =>
      Promise.resolve(
        compileContext({
          role: context.role,
          task: {
            id: taskId,
            objective: 'Correct the constant in src/math.ts',
            constraints: [],
            completionCriteria: [{ kind: 'tests', description: 'the tests pass', params: {} }],
            scope: { allowedPaths: ['src/**'], forbiddenPaths: [] },
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
  })
}

/** A registry with one runtime per role, all backed by the same scenario. */
function registryFor(scenario = SCENARIOS.fullRun): {
  registry: RuntimeRegistry
  bindings: BindingSet
} {
  const registry = new RuntimeRegistry()
  const runtime = new MockAgentRuntime({ scenario, id: 'mock:all' })
  registry.register(runtime)

  const bindings = new BindingSet([
    bindRole(registry, { role: 'planner', runtimeId: 'mock:all' }),
    bindRole(registry, { role: 'implementer', runtimeId: 'mock:all' }),
    bindRole(registry, { role: 'reviewer', runtimeId: 'mock:all' }),
  ])

  return { registry, bindings }
}

function runOptions(
  registry: RuntimeRegistry,
  bindings: BindingSet,
  overrides: Partial<Parameters<Orchestrator['run']>[0]> = {},
) {
  return {
    workflowId,
    template: FEATURE_IMPLEMENTATION,
    bindings,
    repositoryPath: repoPath,
    limits: workflowLimitsSchema.parse({ maxIterations: 2 }),
    approve: () => Promise.resolve(true),
    verify: () => Promise.resolve({ passed: true, detail: 'build and tests passed' }),
    ...overrides,
  }
}

describe('the template', () => {
  it('is valid against the state machine', () => {
    expect(validateTemplate(FEATURE_IMPLEMENTATION)).toEqual([])
  })

  it('names roles, never runtimes', () => {
    // A6 read off the data: nothing in the template mentions a provider, so which runtime
    // occupies a role is purely a binding.
    const serialised = JSON.stringify(FEATURE_IMPLEMENTATION)

    expect(serialised).not.toMatch(/claude|antigravity|mock/i)
  })
})

describe('a full run', () => {
  it('reaches DONE through plan, approve, implement, verify, review', async () => {
    const { registry, bindings } = registryFor()

    const outcome = await orchestrator(registry).run(runOptions(registry, bindings))

    expect(outcome.state).toBe('DONE')
    // Five steps: planner, user, implementer, system, reviewer.
    expect(outcome.steps).toHaveLength(5)
    expect(outcome.steps.map((step) => step.role)).toEqual([
      'planner',
      'user',
      'implementer',
      'system',
      'reviewer',
    ])
  })

  it('snapshots a packet for every agent step and none for a Forge step', async () => {
    // The audit property: what an agent was told still exists afterwards. A `user` or
    // `system` step involves no agent, so it has nothing to snapshot.
    const { registry, bindings } = registryFor()
    const outcome = await orchestrator(registry).run(runOptions(registry, bindings))

    const agentSteps = outcome.steps.filter((step) => step.runtimeId !== null)
    const forgeSteps = outcome.steps.filter((step) => step.runtimeId === null)

    expect(agentSteps.every((step) => step.contextRef !== null)).toBe(true)
    expect(forgeSteps.every((step) => step.contextRef === null)).toBe(true)
  })

  it('records the run in the event log', async () => {
    const { registry, bindings } = registryFor()
    await orchestrator(registry).run(runOptions(registry, bindings))

    const types = new EventStore(db)
      .read(projectId)
      .map((event) => event.type)
      .filter((type) => type.startsWith('workflow.') || type.startsWith('step.'))

    // Every transition and every step, in the log rather than only in the read model.
    expect(types).toContain('workflow.transitioned')
    expect(types).toContain('workflow.checkpointed')
    expect(types).toContain('step.started')
    expect(types).toContain('step.finished')
    expect(types).toContain('workflow.finished')
  })
})

describe('swapping which runtime holds which role', () => {
  it('changes only configuration data', async () => {
    // The definition of done. Two runtimes, two bindings, swapped — and the same template
    // runs. Nothing in the orchestrator, the template, or the machine names either one.
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.fullRun, id: 'runtime:a' }))
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.fullRun, id: 'runtime:b' }))

    const forward = new BindingSet([
      bindRole(registry, { role: 'planner', runtimeId: 'runtime:a' }),
      bindRole(registry, { role: 'implementer', runtimeId: 'runtime:b' }),
      bindRole(registry, { role: 'reviewer', runtimeId: 'runtime:a' }),
    ])

    const first = await orchestrator(registry).run(runOptions(registry, forward))
    expect(first.state).toBe('DONE')
    expect(forward.require('planner').runtimeId).toBe('runtime:a')
    expect(forward.require('implementer').runtimeId).toBe('runtime:b')

    // A fresh workflow, bindings swapped, identical template.
    workflowId = workflowIdSchema.parse(randomUUID())
    new WorkflowStore(db).start(
      { workflowId, projectId, taskId, templateId: 'feature', startedAt: NOW },
      'user',
    )

    const swappedRegistry = new RuntimeRegistry()
    swappedRegistry.register(new MockAgentRuntime({ scenario: SCENARIOS.fullRun, id: 'runtime:a' }))
    swappedRegistry.register(new MockAgentRuntime({ scenario: SCENARIOS.fullRun, id: 'runtime:b' }))

    const swapped = new BindingSet([
      bindRole(swappedRegistry, { role: 'planner', runtimeId: 'runtime:b' }),
      bindRole(swappedRegistry, { role: 'implementer', runtimeId: 'runtime:a' }),
      bindRole(swappedRegistry, { role: 'reviewer', runtimeId: 'runtime:b' }),
    ])

    const second = await orchestrator(swappedRegistry).run(runOptions(swappedRegistry, swapped))

    expect(second.state).toBe('DONE')
    expect(swapped.require('planner').runtimeId).toBe('runtime:b')
    expect(swapped.require('implementer').runtimeId).toBe('runtime:a')
  })
})

describe('binding refusals', () => {
  it('refuses a runtime that cannot perform the role, naming the capability', () => {
    // The other half of the definition of done. Refused at bind time, not at step time: a
    // read-only runtime bound as the implementer would otherwise fail halfway through a run.
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.readOnly, id: 'mock:ro' }))

    expect(() => bindRole(registry, { role: 'implementer', runtimeId: 'mock:ro' })).toThrow(
      IncapableRuntimeError,
    )
    expect(() => bindRole(registry, { role: 'implementer', runtimeId: 'mock:ro' })).toThrow(
      /file-write/,
    )

    // The same runtime is a perfectly good reviewer.
    expect(bindRole(registry, { role: 'reviewer', runtimeId: 'mock:ro' }).role).toBe('reviewer')
  })

  it('refuses to start when a role the template needs is unbound', () => {
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.happy, id: 'mock:all' }))

    const partial = new BindingSet([bindRole(registry, { role: 'planner', runtimeId: 'mock:all' })])

    // Checked before any work happens: a run that fails at step three has already spent an
    // agent's time and left a half-finished change.
    const problems = orchestrator(registry).precheck(runOptions(registry, partial))

    expect(problems.some((problem) => problem.includes('implementer'))).toBe(true)
    expect(problems.some((problem) => problem.includes('reviewer'))).toBe(true)
  })

  it('throws before doing any work when the configuration is unrunnable', async () => {
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.happy, id: 'mock:all' }))
    const partial = new BindingSet([bindRole(registry, { role: 'planner', runtimeId: 'mock:all' })])

    await expect(orchestrator(registry).run(runOptions(registry, partial))).rejects.toThrow(
      UnrunnableWorkflowError,
    )

    // Still in DISCOVERY: nothing ran.
    expect(new WorkflowStore(db).find(workflowId)?.state).toBe('DISCOVERY')
  })

  it('reports a binding whose runtime is no longer registered', () => {
    // An adapter removed between sessions. Discovered up front rather than at the step that
    // needs it.
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.happy, id: 'mock:all' }))
    const bindings = new BindingSet([
      bindRole(registry, { role: 'planner', runtimeId: 'mock:all' }),
      bindRole(registry, { role: 'implementer', runtimeId: 'mock:all' }),
      bindRole(registry, { role: 'reviewer', runtimeId: 'mock:all' }),
    ])

    const emptyRegistry = new RuntimeRegistry()
    const problems = orchestrator(emptyRegistry).precheck(runOptions(emptyRegistry, bindings))

    expect(problems.some((problem) => problem.includes('not registered'))).toBe(true)
  })

  it('names the bound roles when one is missing', () => {
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.happy, id: 'mock:all' }))
    const bindings = new BindingSet([
      bindRole(registry, { role: 'planner', runtimeId: 'mock:all' }),
    ])

    expect(() => bindings.require('reviewer')).toThrow(UnboundRoleError)
    expect(() => bindings.require('reviewer')).toThrow(/planner/)
  })
})

describe('permissions per role', () => {
  it('gives a planner no write access', () => {
    // A planner that could write would let a plan quietly become an implementation, which is
    // the boundary #42's discussion mode exists to enforce.
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.happy, id: 'mock:all' }))

    const planner = bindRole(registry, { role: 'planner', runtimeId: 'mock:all' })

    expect(planner.permissions.readFiles).toBe(true)
    expect(planner.permissions.writeFiles).toBe(false)
  })

  it('gives a reviewer tests but not writes', () => {
    // A reviewer that could fix what it found would have no reason to report it.
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.happy, id: 'mock:all' }))

    const reviewer = bindRole(registry, { role: 'reviewer', runtimeId: 'mock:all' })

    expect(reviewer.permissions.runTests).toBe(true)
    expect(reviewer.permissions.writeFiles).toBe(false)
  })

  it('lets a project narrow a role but never widen it', () => {
    // A settings screen that could grant an implementer's write access to a reviewer would
    // make the role distinction decorative (A7).
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.happy, id: 'mock:all' }))

    const narrowed = bindRole(registry, {
      role: 'implementer',
      runtimeId: 'mock:all',
      permissions: { runBuild: false },
    })
    expect(narrowed.permissions.runBuild).toBe(false)
    expect(narrowed.permissions.writeFiles).toBe(true)

    const widened = bindRole(registry, {
      role: 'reviewer',
      runtimeId: 'mock:all',
      permissions: { writeFiles: true },
    })
    expect(widened.permissions.writeFiles).toBe(false)
  })

  it('never grants git write, whatever a caller asks', () => {
    // The final commit is the user's call for the MVP.
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.happy, id: 'mock:all' }))

    const binding = bindRole(registry, {
      role: 'implementer',
      runtimeId: 'mock:all',
      permissions: { gitWrite: true },
    })

    expect(binding.permissions.gitWrite).toBe(false)
  })
})

describe('what stops a run', () => {
  it('cancels when the user declines the plan', async () => {
    // Declining is a decision, not a failure: the run is cancelled with no blame attached
    // rather than halted with a policy code.
    const { registry, bindings } = registryFor()

    const outcome = await orchestrator(registry).run(
      runOptions(registry, bindings, { approve: () => Promise.resolve(false) }),
    )

    expect(outcome.state).toBe('CANCELLED')
    expect(outcome.haltCode).toBeNull()
  })

  it('halts on an admitted assumption', async () => {
    // R1 through the whole loop: a structurally valid report that admits a guess stops the
    // run rather than being accepted.
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.assumer, id: 'mock:all' }))
    const bindings = new BindingSet([
      bindRole(registry, { role: 'planner', runtimeId: 'mock:all' }),
      bindRole(registry, { role: 'implementer', runtimeId: 'mock:all' }),
      bindRole(registry, { role: 'reviewer', runtimeId: 'mock:all' }),
    ])

    const outcome = await orchestrator(registry).run(runOptions(registry, bindings))

    expect(outcome.state).toBe('HALTED_POLICY')
    expect(outcome.haltReason).toMatch(/assumption/i)
  })

  it('pauses for the user when an agent raises a question', async () => {
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.question, id: 'mock:all' }))
    const bindings = new BindingSet([
      bindRole(registry, { role: 'planner', runtimeId: 'mock:all' }),
      bindRole(registry, { role: 'implementer', runtimeId: 'mock:all' }),
      bindRole(registry, { role: 'reviewer', runtimeId: 'mock:all' }),
    ])

    const outcome = await orchestrator(registry).run(runOptions(registry, bindings))

    expect(outcome.state).toBe('AWAITING_USER')
    // The resume state is recorded, so answering continues from exactly here (#28).
    expect(new WorkflowStore(db).find(workflowId)?.resumeState).toBe('PLANNING')
  })

  it('stops when the runtime cannot authenticate', async () => {
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.authFailure, id: 'mock:all' }))
    const bindings = new BindingSet([
      bindRole(registry, { role: 'planner', runtimeId: 'mock:all' }),
      bindRole(registry, { role: 'implementer', runtimeId: 'mock:all' }),
      bindRole(registry, { role: 'reviewer', runtimeId: 'mock:all' }),
    ])

    const outcome = await orchestrator(registry).run(runOptions(registry, bindings))

    expect(outcome.state).toBe('HALTED_POLICY')
    expect(outcome.haltReason).toMatch(/authenticate/i)
  })

  it('stops when cancelled mid-run', async () => {
    const { registry, bindings } = registryFor()
    const controller = new AbortController()
    controller.abort()

    const outcome = await orchestrator(registry).run(
      runOptions(registry, bindings, { signal: controller.signal }),
    )

    expect(outcome.state).toBe('CANCELLED')
  })

  it('halts when a system step fails and the correction loop exhausts its cap', async () => {
    // The bounded correction loop, end to end: verification keeps failing, the implementer
    // keeps trying, and the cap stops it rather than the loop running forever.
    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.fullRun, id: 'mock:planner' }))
    registry.register(
      new MockAgentRuntime({ scenario: SCENARIOS.noProgress, id: 'mock:implementer' }),
    )
    const bindings = new BindingSet([
      bindRole(registry, { role: 'planner', runtimeId: 'mock:planner' }),
      bindRole(registry, { role: 'implementer', runtimeId: 'mock:implementer' }),
      bindRole(registry, { role: 'reviewer', runtimeId: 'mock:planner' }),
    ])

    const outcome = await orchestrator(registry).run(
      runOptions(registry, bindings, {
        limits: workflowLimitsSchema.parse({ maxIterations: 2 }),
        verify: () => Promise.resolve({ passed: false, detail: 'the tests still fail' }),
      }),
    )

    expect(outcome.state).toBe('HALTED_LIMIT')
    // Either the cap or the no-progress detector — both are legitimate stops, and which
    // fires first depends on whether the agent changed anything. Asserting the *reason* is
    // recorded matters more than which guard won.
    expect(outcome.haltReason).not.toBeNull()
  })
})

describe('the review step decides nothing on its own (#36)', () => {
  /** A reviewer outcome the test controls, standing in for a parsed review report. */
  function outcomeOf(verdict, overridden, corrections) {
    return {
      verdict,
      overridden,
      reason: overridden ? 'Forge overrode the reviewer' : 'the reviewer decided',
      rejectingFindings: [],
      corrections,
    }
  }

  it('does not close the workflow when a reviewer passes a red build', async () => {
    // The definition of done for #36. The reviewer says PASS; a completion criterion is
    // failing; the workflow must not reach DONE.
    const { registry, bindings } = registryFor()

    const outcome = await orchestrator(registry).run(
      runOptions(registry, bindings, {
        limits: workflowLimitsSchema.parse({ maxIterations: 1 }),
        verify: () =>
          Promise.resolve({
            passed: true,
            detail: 'build ok',
            criteria: [
              {
                kind: 'tests',
                description: 'the test suite passes',
                verdict: 'fail',
                reason: 'npm test exited 1',
                evidenceId: null,
              },
            ],
          }),
        // Forge substitutes FAIL for the reviewer PASS, exactly as assessReview would.
        reviewStep: () =>
          Promise.resolve(outcomeOf('fail', true, ['Failing criterion — the test suite passes'])),
      }),
    )

    expect(outcome.state).not.toBe('DONE')
  })

  it('treats an unusable review as unreviewed rather than as an approval', async () => {
    const { registry, bindings } = registryFor()

    const outcome = await orchestrator(registry).run(
      runOptions(registry, bindings, { reviewStep: () => Promise.resolve(null) }),
    )

    expect(outcome.state).not.toBe('DONE')
    expect(outcome.haltReason).toMatch(/unreviewed|not an approval/i)
  })

  it('reaches DONE when the reviewer passes and the criteria agree', async () => {
    const { registry, bindings } = registryFor()

    const outcome = await orchestrator(registry).run(
      runOptions(registry, bindings, {
        reviewStep: () => Promise.resolve(outcomeOf('pass', false, [])),
      }),
    )

    expect(outcome.state).toBe('DONE')
  })

  it('halts with HALTED_POLICY when a planner binding attempts a write', async () => {
    // Definition of done for #37: A planner attempting a write is blocked and the workflow halts
    const writePlannerScenario = {
      name: 'writePlanner',
      description: 'Planner that attempts to modify files',
      capabilities: ['repo-read', 'plan'] as const,
      steps: [
        {
          narration: ['Planning... and modifying files'],
          tools: [],
          edits: [{ path: 'src/math.ts', contents: 'export const answer = 42\n' }],
          report: {
            status: 'completed' as const,
            summary: 'I planned and wrote the file',
            filesChanged: ['src/math.ts'],
            commandsRun: [],
            testsRun: false,
            openQuestions: [],
            assumptions: [],
          },
          ending: 'report' as const,
          replyText: null,
        },
      ],
    }

    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: writePlannerScenario, id: 'mock:planner' }))
    registry.register(new MockAgentRuntime({ scenario: SCENARIOS.fullRun, id: 'mock:rest' }))

    const bindings = new BindingSet([
      bindRole(registry, { role: 'planner', runtimeId: 'mock:planner' }),
      bindRole(registry, { role: 'implementer', runtimeId: 'mock:rest' }),
      bindRole(registry, { role: 'reviewer', runtimeId: 'mock:rest' }),
    ])

    const outcome = await orchestrator(registry).run(runOptions(registry, bindings))

    expect(outcome.state).toBe('HALTED_POLICY')
    expect(outcome.haltCode).toBe('permission-violation')
    expect(outcome.haltReason).toContain('Role "planner" does not have write permissions')
  })

  it('halts with HALTED_POLICY when an agent attempts a dangerous command', async () => {
    const dangerousScenario = {
      name: 'dangerousCmd',
      description: 'Agent executing a dangerous command',
      capabilities: ['repo-read', 'file-write', 'terminal', 'plan', 'review', 'test'] as const,
      steps: [
        {
          narration: ['Planning'],
          tools: [],
          edits: [],
          report: {
            status: 'completed' as const,
            summary: 'Plan step',
            filesChanged: [],
            commandsRun: ['git reset --hard HEAD~1'],
            testsRun: false,
            openQuestions: [],
            assumptions: [],
          },
          ending: 'report' as const,
          replyText: null,
        },
      ],
    }

    const registry = new RuntimeRegistry()
    registry.register(new MockAgentRuntime({ scenario: dangerousScenario, id: 'mock:dangerous' }))
    const bindings = new BindingSet([
      bindRole(registry, { role: 'planner', runtimeId: 'mock:dangerous' }),
      bindRole(registry, { role: 'implementer', runtimeId: 'mock:dangerous' }),
      bindRole(registry, { role: 'reviewer', runtimeId: 'mock:dangerous' }),
    ])

    const outcome = await orchestrator(registry).run(runOptions(registry, bindings))

    expect(outcome.state).toBe('HALTED_POLICY')
    expect(outcome.haltCode).toBe('permission-violation')
    expect(outcome.haltReason).toContain('Blocked dangerous command')
  })
})
