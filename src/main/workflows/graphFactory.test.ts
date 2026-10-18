import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  projectIdSchema,
  repositoryIdSchema,
  runIdSchema,
  stepIdSchema,
  taskIdSchema,
  workflowIdSchema,
  type WorkflowTemplateV2,
} from '@shared/domain'
import { ArtifactService } from '../artifacts/artifactService'
import { initialiseDatabase, type ForgeDatabase } from '../db'
import { ArtifactStore } from '../db/artifactStore'
import { EventStore } from '../db/eventStore'
import { ProjectStore } from '../db/projectStore'
import { applyEvent } from '../db/projections'
import { RunStore } from '../db/runStore'
import { WorkflowStore } from '../db/workflowStore'
import { MockAgentRuntime } from '../runtimes/mockRuntime'
import { RuntimeRegistry } from '../runtimes/registry'
import {
  createGraphExecutorWithLeafRunner,
  GraphCompositionError,
  type ProductionGraphCompositionOptions,
} from './graphFactory'

describe('Graph Composition Factory (Slice 5B-1A)', () => {
  let tempDirs: string[] = []
  let dbFile: string
  let db: ForgeDatabase
  let closeDb: () => void
  let eventStore: EventStore
  let artifactStore: ArtifactStore
  let artifactService: ArtifactService
  let registry: RuntimeRegistry
  let repoDir: string
  let worktreeRoot: string
  let artifactDir: string

  function git(cwd: string, ...args: string[]): string {
    return execFileSync('git', args, { cwd, encoding: 'utf8' })
  }

  beforeEach(() => {
    tempDirs = []
    const dbDir = mkdtempSync(join(tmpdir(), 'forge-gf-db-'))
    tempDirs.push(dbDir)
    dbFile = join(dbDir, 'forge.db')
    const opened = initialiseDatabase(dbFile)
    db = opened.db
    closeDb = opened.close

    eventStore = new EventStore(db)
    artifactStore = new ArtifactStore(db)

    artifactDir = mkdtempSync(join(tmpdir(), 'forge-gf-arts-'))
    tempDirs.push(artifactDir)
    artifactService = new ArtifactService(artifactDir, artifactStore)

    registry = new RuntimeRegistry()

    repoDir = mkdtempSync(join(tmpdir(), 'forge-gf-repo-'))
    tempDirs.push(repoDir)
    git(repoDir, 'init', '--quiet', '--initial-branch=main')
    git(repoDir, 'config', 'user.email', 'forge-test@local')
    git(repoDir, 'config', 'user.name', 'Forge Test')
    git(repoDir, 'config', 'commit.gpgsign', 'false')

    mkdirSync(join(repoDir, 'src'), { recursive: true })
    writeFileSync(join(repoDir, 'src', 'main.ts'), 'export const answer = 41;\n')
    git(repoDir, 'add', '.')
    git(repoDir, 'commit', '-m', 'Initial commit')

    worktreeRoot = mkdtempSync(join(tmpdir(), 'forge-gf-wt-'))
    tempDirs.push(worktreeRoot)
  })

  afterEach(() => {
    closeDb()
    for (const d of tempDirs) {
      try {
        rmSync(d, { recursive: true, force: true })
      } catch {
        // ignore cleanup errors
      }
    }
  })

  // ===========================================================================
  // A. Construction and dependency validation
  // ===========================================================================
  describe('A. Construction and dependency validation', () => {
    it('constructs valid executor, leafRunner, worktreeService, and stores when given genuine infrastructure', () => {
      const composition = createGraphExecutorWithLeafRunner({
        db,
        eventStore,
        worktreeRoot,
        repositoryPath: repoDir,
        artifactService,
        registry,
      })

      expect(composition).toBeDefined()
      expect(composition.executor).toBeDefined()
      expect(composition.leafRunner).toBeDefined()
      expect(composition.worktreeService).toBeDefined()
      expect(composition.gitServiceFactory).toBeDefined()
      expect(composition.stores.workflowStore).toBeDefined()
      expect(composition.stores.projectStore).toBeDefined()
      expect(composition.stores.decisionStore).toBeDefined()
      expect(composition.stores.changeSetStore).toBeDefined()
    })

    it('fails closed when options are missing or null', () => {
      expect(() =>
        createGraphExecutorWithLeafRunner(null as unknown as ProductionGraphCompositionOptions),
      ).toThrow(GraphCompositionError)
      expect(() =>
        createGraphExecutorWithLeafRunner(
          undefined as unknown as ProductionGraphCompositionOptions,
        ),
      ).toThrow(/Options object is required/)
    })

    it('fails closed when db is missing or invalid', () => {
      expect(() =>
        createGraphExecutorWithLeafRunner({
          db: null as unknown as ForgeDatabase,
          eventStore,
          worktreeRoot,
          repositoryPath: repoDir,
          artifactService,
          registry,
        }),
      ).toThrow(/Valid ForgeDatabase instance is required/)
    })

    it('fails closed when eventStore is missing or invalid', () => {
      expect(() =>
        createGraphExecutorWithLeafRunner({
          db,
          eventStore: null as unknown as EventStore,
          worktreeRoot,
          repositoryPath: repoDir,
          artifactService,
          registry,
        }),
      ).toThrow(/Valid EventStore instance is required/)
    })

    it('fails closed when artifactService is missing', () => {
      expect(() =>
        createGraphExecutorWithLeafRunner({
          db,
          eventStore,
          worktreeRoot,
          repositoryPath: repoDir,
          artifactService: null as unknown as ArtifactService,
          registry,
        }),
      ).toThrow(/Valid ArtifactService instance is required/)
    })

    it('fails closed when registry is missing', () => {
      expect(() =>
        createGraphExecutorWithLeafRunner({
          db,
          eventStore,
          worktreeRoot,
          repositoryPath: repoDir,
          artifactService,
          registry: null as unknown as RuntimeRegistry,
        }),
      ).toThrow(/Valid RuntimeRegistry instance is required/)
    })

    it('fails closed when worktreeRoot or repositoryPath are invalid or empty', () => {
      expect(() =>
        createGraphExecutorWithLeafRunner({
          db,
          eventStore,
          worktreeRoot: '',
          repositoryPath: repoDir,
          artifactService,
          registry,
        }),
      ).toThrow(/worktreeRoot must be a non-empty string path/)

      expect(() =>
        createGraphExecutorWithLeafRunner({
          db,
          eventStore,
          worktreeRoot,
          repositoryPath: '   ',
          artifactService,
          registry,
        }),
      ).toThrow(/repositoryPath must be a non-empty string path/)
    })

    it('fails closed when worktreeRoot or repositoryPath are relative paths', () => {
      expect(() =>
        createGraphExecutorWithLeafRunner({
          db,
          eventStore,
          worktreeRoot: './relative-wt',
          repositoryPath: repoDir,
          artifactService,
          registry,
        }),
      ).toThrow(/worktreeRoot must be an absolute path/)

      expect(() =>
        createGraphExecutorWithLeafRunner({
          db,
          eventStore,
          worktreeRoot,
          repositoryPath: 'relative/repo',
          artifactService,
          registry,
        }),
      ).toThrow(/repositoryPath must be an absolute path/)
    })

    it('fails closed when worktreeRoot is identical to repositoryPath', () => {
      expect(() =>
        createGraphExecutorWithLeafRunner({
          db,
          eventStore,
          worktreeRoot: repoDir,
          repositoryPath: repoDir,
          artifactService,
          registry,
        }),
      ).toThrow(/worktreeRoot cannot be identical to repositoryPath/)
    })

    it('does not execute any workflow or create runs merely because the factory is constructed', () => {
      const composition = createGraphExecutorWithLeafRunner({
        db,
        eventStore,
        worktreeRoot,
        repositoryPath: repoDir,
        artifactService,
        registry,
      })

      // No graph runs exist in database
      const run = composition.stores.workflowStore.getGraphRun('non-existent-wf')
      expect(run).toBeNull()
    })

    it('allows repeated construction without duplicating or corrupting shared persistence ownership', () => {
      const c1 = createGraphExecutorWithLeafRunner({
        db,
        eventStore,
        worktreeRoot,
        repositoryPath: repoDir,
        artifactService,
        registry,
      })

      const c2 = createGraphExecutorWithLeafRunner({
        db,
        eventStore,
        worktreeRoot,
        repositoryPath: repoDir,
        artifactService,
        registry,
      })

      expect(c1.executor).not.toBe(c2.executor)
      expect(c1.worktreeService).not.toBe(c2.worktreeService)
      expect(c1.stores.workflowStore).not.toBe(c2.stores.workflowStore)
    })
  })

  // ===========================================================================
  // B. Real-infrastructure integration
  // ===========================================================================
  describe('B. Real-infrastructure integration', () => {
    it('executes a real multi-node DAG through factory-created GraphExecutor with real SQLite, worktrees, and artifacts (composition test with mocked runtime)', async () => {
      const projectId = projectIdSchema.parse(randomUUID())
      const taskId = taskIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const graphRunId = randomUUID()
      const now = new Date().toISOString()
      const forkSha = git(repoDir, 'rev-parse', 'HEAD').trim()

      // 1. Setup real project in ProjectStore
      const projectStore = new ProjectStore(db)
      projectStore.create(
        {
          id: projectId,
          name: 'Integration Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: repoDir,
            defaultBranch: 'main',
            buildCommand: 'node -e "process.exit(0)"',
            testCommand: 'node -e "process.exit(0)"',
            tech: ['typescript'],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      // 2. Setup real task in EventStore and project it
      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Update answer constant to 42',
              constraints: [],
              completionCriteria: [{ kind: 'tests', description: 'tests pass', params: {} }],
              scope: { allowedPaths: ['src/main.ts'], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)

      // 3. Setup workflow in WorkflowStore and RunStore
      const workflowStore = new WorkflowStore(db)
      workflowStore.start(
        {
          workflowId,
          projectId,
          taskId,
          templateId: 'test-v2-template',
          startedAt: now,
        },
        'user',
      )

      new RunStore(db).createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: now,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      // 4. Register mock runtime for testing composition mechanics
      const mockRuntime = new MockAgentRuntime({
        id: 'test:agent',
        scenario: {
          name: 'updateAnswer',
          description: 'updates answer to 42',
          capabilities: ['repo-read', 'file-write', 'terminal', 'plan', 'review', 'test'],
          steps: [
            {
              narration: ['Editing src/main.ts'],
              tools: [],
              edits: [{ path: 'src/main.ts', contents: 'export const answer = 42;\n' }],
              report: {
                status: 'completed',
                summary: 'Updated answer to 42',
                filesChanged: ['src/main.ts'],
                commandsRun: [],
                testsRun: true,
                openQuestions: [],
                assumptions: [],
              },
              ending: 'report',
              replyText: null,
            },
          ],
        },
      })
      registry.register(mockRuntime)

      // 5. Define V2 DAG with schema-valid StepIds: implementer (agent) -> verifier (verification)
      const implementNodeId = stepIdSchema.parse(randomUUID())
      const verifyNodeId = stepIdSchema.parse(randomUUID())

      const template: WorkflowTemplateV2 = {
        id: taskId,
        name: 'Factory Integration Template',
        description: 'Two-stage DAG testing factory composition',
        version: 1,
        status: 'published',
        category: 'Test',
        nodes: [
          {
            id: implementNodeId,
            title: 'Implement Changes',
            type: 'agent',
            runtimeType: 'cli-agent',
            config: {
              skills: [],
              permissionMode: 'developer',
              role: 'implementer',
              providerId: 'test:agent',
            },
            inputs: [],
            outputs: [
              {
                name: 'code_diff',
                kind: 'diff',
                format: 'text',
                required: true,
                requiredSections: [],
              },
            ],
          },
          {
            id: verifyNodeId,
            title: 'Verify Implementation',
            type: 'verification',
            runtimeType: 'forge-engine',
            config: {
              skills: [],
              permissionMode: 'developer',
            },
            inputs: [
              {
                name: 'code_diff',
                kind: 'diff',
                required: true,
              },
            ],
            outputs: [
              {
                name: 'verdict',
                kind: 'stage-output',
                format: 'json',
                required: true,
                requiredSections: [],
              },
            ],
          },
        ],
        edges: [
          {
            id: 'edge-impl-verify',
            source: implementNodeId,
            target: verifyNodeId,
            sourceHandle: 'code_diff',
            targetHandle: 'code_diff',
          },
        ],
        createdAt: now,
        updatedAt: now,
      }

      // 6. Compose via the factory
      const composition = createGraphExecutorWithLeafRunner({
        db,
        eventStore,
        worktreeRoot,
        repositoryPath: repoDir,
        artifactService,
        registry,
        verifyFn: () =>
          Promise.resolve({
            passed: true,
            verdict: 'pass',
            findings: [],
            falseClaims: [],
            detail: 'build and tests pass cleanly',
            criteria: [],
            artifacts: [],
          }),
      })

      // 7. Execute through factory-created executor
      const result = await composition.executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      // 8. Assertions on observable execution outcomes
      expect(result.status).toBe('completed')
      expect(result.completedNodeIds).toContain(implementNodeId)
      expect(result.completedNodeIds).toContain(verifyNodeId)

      // Verify SQLite durability for node attempts
      const implementAttempts = composition.stores.workflowStore.getNodeAttempts(
        graphRunId,
        implementNodeId,
      )
      expect(implementAttempts).toHaveLength(1)
      expect(implementAttempts[0]?.status).toBe('completed')
      expect(implementAttempts[0]?.changeSetId).toBeDefined()
      const changeSet = composition.stores.changeSetStore.find(implementAttempts[0]!.changeSetId!)
      expect(changeSet).toBeDefined()
      expect(changeSet?.patch).toContain('+export const answer = 42;')

      const verifyAttempts = composition.stores.workflowStore.getNodeAttempts(
        graphRunId,
        verifyNodeId,
      )
      expect(verifyAttempts).toHaveLength(1)
      expect(verifyAttempts[0]?.status).toBe('completed')

      // Verify artifacts persisted via ArtifactService
      const runArtifacts = artifactService.listArtifacts(runIdSchema.parse(graphRunId))
      expect(runArtifacts.length).toBeGreaterThanOrEqual(2)

      interface PersistedDiffEnvelope {
        readonly content: string
        readonly metadata: { readonly filesChanged: readonly string[] }
      }
      interface PersistedVerdictEnvelope {
        readonly metadata: { readonly verdict: string; readonly passed: boolean }
      }

      const diffMeta = runArtifacts.find((a) => a.kind === 'diff')
      expect(diffMeta).toBeDefined()
      const diffEnvelope = JSON.parse(
        await artifactService.readArtifactText(diffMeta!.id),
      ) as PersistedDiffEnvelope
      expect(diffEnvelope.content).toBe('Updated answer to 42')
      expect(diffEnvelope.metadata.filesChanged).toContain('src/main.ts')

      const verdictMeta = runArtifacts.find((a) => a.kind === 'stage-output')
      expect(verdictMeta).toBeDefined()
      const verdictEnvelope = JSON.parse(
        await artifactService.readArtifactText(verdictMeta!.id),
      ) as PersistedVerdictEnvelope
      expect(verdictEnvelope.metadata.verdict).toBe('pass')
      expect(verdictEnvelope.metadata.passed).toBe(true)
    }, 30_000)

    it('fails closed when a writable agent attempts modifications outside authoritative task scope', async () => {
      const projectId = projectIdSchema.parse(randomUUID())
      const taskId = taskIdSchema.parse(randomUUID())
      const workflowId = workflowIdSchema.parse(randomUUID())
      const graphRunId = randomUUID()
      const now = new Date().toISOString()
      const forkSha = git(repoDir, 'rev-parse', 'HEAD').trim()

      const projectStore = new ProjectStore(db)
      projectStore.create(
        {
          id: projectId,
          name: 'Scope Enforced Project',
          repository: {
            id: repositoryIdSchema.parse(randomUUID()),
            absolutePath: repoDir,
            defaultBranch: 'main',
            buildCommand: null,
            testCommand: null,
            tech: [],
          },
          createdAt: now,
          updatedAt: now,
        },
        'user',
      )

      // Task strictly allows only 'src/main.ts'
      const taskEvent = eventStore.append(
        {
          type: 'task.created',
          payload: {
            task: {
              id: taskId,
              objective: 'Scoped edit',
              constraints: [],
              completionCriteria: [{ kind: 'tests', description: 'tests pass', params: {} }],
              scope: { allowedPaths: ['src/main.ts'], forbiddenPaths: [] },
              lockedDecisionIds: [],
              correctsTaskId: null,
              createdAt: now,
            },
          },
        },
        { projectId, actor: 'user', occurredAt: now },
      )
      applyEvent(db, taskEvent)

      const workflowStore = new WorkflowStore(db)
      workflowStore.start(
        {
          workflowId,
          projectId,
          taskId,
          templateId: taskId,
          startedAt: now,
        },
        'user',
      )

      new RunStore(db).createRun({
        id: runIdSchema.parse(graphRunId),
        projectId,
        taskId,
        type: 'workflow',
        status: 'running',
        startedAt: now,
        finishedAt: null,
        exitCode: null,
        summary: null,
        error: null,
        metadata: {},
      })

      // Mock runtime edits outside scope ('package.json')
      const outOfScopeRuntime = new MockAgentRuntime({
        id: 'out-of-scope-agent',
        scenario: {
          name: 'outOfScope',
          description: 'modifies package.json outside allowed scope',
          capabilities: ['repo-read', 'file-write', 'terminal', 'plan', 'review', 'test'],
          steps: [
            {
              narration: ['Sneaking edit into package.json'],
              tools: [],
              edits: [{ path: 'package.json', contents: '{"name":"tampered"}\n' }],
              report: {
                status: 'completed',
                summary: 'Modified package.json',
                filesChanged: ['package.json'],
                commandsRun: [],
                testsRun: false,
                openQuestions: [],
                assumptions: [],
              },
              ending: 'report',
              replyText: null,
            },
          ],
        },
      })
      registry.register(outOfScopeRuntime)

      const template: WorkflowTemplateV2 = {
        id: taskId,
        name: 'Scope Enforcement Template',
        description: 'Single agent node DAG',
        version: 1,
        status: 'published',
        category: 'Test',
        nodes: [
          {
            id: 'node-rogue',
            title: 'Rogue Implementer',
            type: 'agent',
            runtimeType: 'cli-agent',
            config: {
              skills: [],
              permissionMode: 'developer',
              role: 'implementer',
              providerId: 'out-of-scope-agent',
            },
            inputs: [],
            outputs: [],
          },
        ],
        edges: [],
        createdAt: now,
        updatedAt: now,
      }

      const composition = createGraphExecutorWithLeafRunner({
        db,
        eventStore,
        worktreeRoot,
        repositoryPath: repoDir,
        artifactService,
        registry,
      })

      const result = await composition.executor.run({
        graphRunId,
        workflowId,
        projectId,
        template,
        forkSha,
      })

      // Node and run fail closed on policy violation
      expect(result.status).toBe('failed')
      expect(result.error).toMatch(/Policy violation: 1 file\(s\) modified outside scope/i)

      const attempts = composition.stores.workflowStore.getNodeAttempts(graphRunId, 'node-rogue')
      expect(attempts).toHaveLength(1)
      expect(attempts[0]?.status).toBe('failed')
      expect(attempts[0]?.error).toMatch(/Policy violation/i)
    })
  })

  // ===========================================================================
  // C. Legacy-path preservation
  // ===========================================================================
  describe('C. Legacy-path preservation', () => {
    it('verifies createForgeCore still uses the existing Orchestrator production path', () => {
      const forgeCoreSource = readFileSync(join(__dirname, '../core/forgeCore.ts'), 'utf8')

      // createForgeCore constructs WorkflowService, not GraphExecutor
      expect(forgeCoreSource).toContain('new WorkflowService({')
      expect(forgeCoreSource).not.toContain('createGraphExecutorWithLeafRunner')
      expect(forgeCoreSource).not.toContain('new GraphExecutor(')
    })

    it('verifies WorkflowService still routes production execution through Orchestrator', () => {
      const workflowServiceSource = readFileSync(join(__dirname, 'workflowService.ts'), 'utf8')

      // executeWorkflow instantiates Orchestrator
      expect(workflowServiceSource).toContain('new Orchestrator({')
      expect(workflowServiceSource).toContain('await orchestrator.run({')
      expect(workflowServiceSource).not.toContain('createGraphExecutorWithLeafRunner')
    })

    it('verifies no IPC handler exposes GraphExecutor directly', () => {
      const handlersSource = readFileSync(join(__dirname, '../ipc/handlers.ts'), 'utf8')

      // IPC handlers invoke WorkflowService methods, never GraphExecutor directly
      expect(handlersSource).toContain('workflows.start(')
      expect(handlersSource).toContain('workflows.approveAndStartImplementation(')
      expect(handlersSource).not.toContain('GraphExecutor')
      expect(handlersSource).not.toContain('createGraphExecutorWithLeafRunner')
    })
  })
})
