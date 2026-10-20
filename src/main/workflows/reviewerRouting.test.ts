import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  assessReview,
  authoritativeReviewVerdictSchema,
  changeSetIdSchema,
  compileLinearTemplateToGraph,
  evidenceArtifactSchema,
  projectIdSchema,
  repositoryIdSchema,
  reviewOutcomeSchema,
  reviewReportSchema,
  runIdSchema,
  stepIdSchema,
  taskIdSchema,
  workflowIdSchema,
  BUG_FIX,
  FEATURE_IMPLEMENTATION,
  type AgentReport,
  type ArtifactKind,
  type Capability,
  type CriterionResult,
  type IAgentRuntime,
  type ProjectId,
  type PromptPacket,
  type RuntimeId,
  type Sha,
  type Task,
  type TaskId,
  type WorkflowArtifact,
  type WorkflowId,
  type WorkflowNode,
  type WorkflowTemplateV2,
} from '@shared/domain'
import { ArtifactService } from '../artifacts/artifactService'
import { ArtifactStore } from '../db/artifactStore'
import { initialiseDatabase, type ForgeDatabase } from '../db'
import { DecisionStore } from '../db/decisionStore'
import { EventStore } from '../db/eventStore'
import { ProjectStore } from '../db/projectStore'
import { applyEvent } from '../db/projections'
import { WorkflowStore } from '../db/workflowStore'
import { RunStore } from '../db/runStore'
import { GitService, WorktreeService } from '../git'
import { RuntimeRegistry } from '../runtimes/registry'
import { GraphExecutor, type NodeExecutionContext, type NodeExecutionResult } from './graphExecutor'
import { LeafRunner } from './leafRunner'

describe('Slice 5B-1C Slice B — Reviewer Verdict & Recovery Contract Tests', () => {
  const dirsToCleanup: string[] = []
  let db: ForgeDatabase
  let closeDb: () => void
  let workflowStore: WorkflowStore
  let artifactStore: ArtifactStore
  let artifactService: ArtifactService
  let repoDir: string
  let worktreeRoot: string
  let worktreeService: WorktreeService
  let forkSha: Sha
  let projectId: ProjectId
  let taskId: TaskId
  let workflowId: WorkflowId
  let task: Task

  const NOW = new Date().toISOString()

  function createRunRecord(runId: string) {
    new RunStore(db).createRun({
      id: runIdSchema.parse(runId),
      projectId,
      taskId,
      type: 'workflow',
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      exitCode: null,
      summary: null,
      error: null,
      metadata: {},
    })
  }

  function recordCompletedAttempt(
    graphRunId: string,
    nodeId: string,
    attempt = 1,
    iteration = 1,
  ): string {
    const attemptId = randomUUID()
    workflowStore.recordNodeAttempt(
      {
        id: attemptId,
        projectId,
        graphRunId,
        nodeId,
        attempt,
        iteration,
        status: 'ready',
        startedAt: NOW,
      },
      'system',
    )
    workflowStore.updateNodeAttempt(
      {
        projectId,
        graphRunId,
        nodeId,
        attempt,
        status: 'completed',
        finishedAt: NOW,
        occurredAt: NOW,
      },
      'system',
    )
    return attemptId
  }

  async function persistWorkflowArtifact(
    graphRunId: string,
    attemptId: string,
    art: WorkflowArtifact,
    lineageOrder = 0,
    totalArtifacts = 1,
  ) {
    const expectedName = `${art.title}.workflow-artifact.json`
    const envelope = {
      ...art,
      __lineageOrder: lineageOrder,
      __totalArtifacts: totalArtifacts,
    }
    return artifactService.writeArtifact({
      runId: runIdSchema.parse(graphRunId),
      stepId: stepIdSchema.parse(attemptId),
      kind: art.kind as ArtifactKind,
      name: expectedName,
      content: JSON.stringify(envelope),
      mimeType: 'application/json',
      createdAt: art.createdAt,
    })
  }

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'forge-rev-repo-'))
    dirsToCleanup.push(dir)
    execFileSync('git', ['init', '-b', 'main', dir])
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: dir })
    writeFileSync(join(dir, 'index.ts'), 'export const hello = "world"\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir })
    return dir
  }

  function mockRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
    return {
      id: 'mock-runtime' as RuntimeId,
      capabilities: [
        'repo-read',
        'file-write',
        'terminal',
        'plan',
        'review',
        'test',
      ] as readonly Capability[],
      simulated: true,
      supportsAccountIsolation: true,
      instructionFilenames: [],
      start: vi.fn().mockImplementation((opts) =>
        Promise.resolve({
          sessionId: 'test-session-1',
          repositoryPath: (opts as { repositoryPath?: string }).repositoryPath ?? repoDir,
        }),
      ),
      send: vi.fn().mockResolvedValue(undefined),
      events: vi.fn().mockReturnValue(
        (async function* () {
          await Promise.resolve()
          yield* []
        })(),
      ),
      status: vi.fn().mockResolvedValue({ state: 'idle' }),
      cancel: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    }
  }

  beforeEach(() => {
    const tempDbDir = mkdtempSync(join(tmpdir(), 'forge-rev-db-'))
    dirsToCleanup.push(tempDbDir)
    const dbFile = join(tempDbDir, 'forge.db')
    const opened = initialiseDatabase(dbFile)
    db = opened.db
    closeDb = opened.close

    workflowStore = new WorkflowStore(db)
    const eventStore = new EventStore(db)
    artifactStore = new ArtifactStore(db)

    const artifactsDir = mkdtempSync(join(tmpdir(), 'forge-rev-artifacts-'))
    dirsToCleanup.push(artifactsDir)
    artifactService = new ArtifactService(artifactsDir, artifactStore)

    repoDir = makeRepo()
    worktreeRoot = mkdtempSync(join(tmpdir(), 'forge-rev-wt-'))
    dirsToCleanup.push(worktreeRoot)
    worktreeService = new WorktreeService({ repositoryPath: repoDir, root: worktreeRoot })

    forkSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim()

    projectId = projectIdSchema.parse(randomUUID())
    taskId = taskIdSchema.parse(randomUUID())
    workflowId = workflowIdSchema.parse(randomUUID())

    new ProjectStore(db).create(
      {
        id: projectId,
        name: 'Reviewer Test Project',
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: repoDir,
          defaultBranch: 'main',
          buildCommand: 'npm run build',
          testCommand: 'npm test',
          tech: [],
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      'user',
    )

    task = {
      id: taskId,
      objective: 'Implement feature and verify review',
      constraints: ['no regressions'],
      completionCriteria: [
        { kind: 'tests', description: 'test suite passes', params: {} },
        { kind: 'build', description: 'build succeeds', params: {} },
      ],
      scope: { allowedPaths: ['index.ts'], forbiddenPaths: [] },
      lockedDecisionIds: [],
      correctsTaskId: null,
      createdAt: NOW,
    }

    const taskEvent = eventStore.append(
      {
        type: 'task.created',
        payload: { task },
      },
      { projectId, actor: 'user', occurredAt: NOW },
    )
    applyEvent(db, taskEvent)

    workflowStore.start(
      {
        workflowId,
        projectId,
        taskId,
        templateId: 'test-template',
        startedAt: NOW,
      },
      'user',
    )
  })

  afterEach(() => {
    closeDb()
    for (const dir of dirsToCleanup) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Best effort
      }
    }
  })

  // =========================================================================
  // 1. LeafRunner & assessReview Contract Tests (Requirements 1 - 8)
  // =========================================================================

  it('1. Claimed PASS with zero criteria fails closed with UNKNOWN (never authorizes PASS)', async () => {
    const report: AgentReport = {
      status: 'completed',
      summary: 'Reviewer says looks good without evidence',
      filesChanged: [],
      commandsRun: [],
      testsRun: true,
      openQuestions: [],
      assumptions: [],
      claimedVerdict: 'pass',
      findings: [],
    }

    // Direct domain assessment
    const domainOutcome = assessReview(
      reviewReportSchema.parse({
        changeSetId: changeSetIdSchema.parse(randomUUID()),
        stepId: stepIdSchema.parse(randomUUID()),
        claimedVerdict: 'pass',
        findings: [],
        summary: 'Reviewer passed change',
        reviewedAt: NOW,
      }),
      [], // Zero criteria
    )

    expect(domainOutcome.verdict).toBe('unknown')
    expect(domainOutcome.overridden).toBe(true)
    expect(domainOutcome.reason).toContain('zero completion criteria were verified')

    // LeafRunner precondition test: fails closed when verification evidence has zero criteria
    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report,
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
    })

    const reviewerNode: WorkflowNode = {
      id: 'step-5-reviewer',
      title: 'Reviewer',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
      inputs: [],
      outputs: [
        { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
      ],
    }

    const csId = randomUUID()
    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
      attemptId: randomUUID(),
      iteration: 1,
      forkSha,
      signal: new AbortController().signal,
      inputArtifacts: [
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-3-implementer',
          kind: 'changeset',
          format: 'diff',
          title: 'Implementer changeset',
          content: 'diff --git a/index.ts b/index.ts',
          metadata: { outputName: 'changeset', changeSetId: csId },
          createdAt: NOW,
        },
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verification evidence',
          content: JSON.stringify({
            passed: true,
            verdict: 'unknown',
            criteria: [],
            evidenceId: randomUUID(),
          }),
          metadata: {
            outputName: 'verification_report',
            criteria: [],
            changeSetId: csId,
            iteration: 1,
            evidenceId: randomUUID(),
          },
          createdAt: NOW,
        },
      ],
      incomingSlots: new Map(),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('zero criteria results')
  })

  it('2. Claimed PASS without verification evidence fails closed', async () => {
    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        status: 'completed',
        summary: 'Passed without checking',
        filesChanged: [],
        commandsRun: [],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
        claimedVerdict: 'pass',
        findings: [],
      },
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
    })

    const reviewerNode: WorkflowNode = {
      id: 'step-5-reviewer',
      title: 'Reviewer',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
      inputs: [],
      outputs: [
        { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
      ],
    }

    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
      forkSha,
      signal: new AbortController().signal,
      inputArtifacts: [], // Missing verification and changeset artifacts
      incomingSlots: new Map(),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('requires verification evidence')
  })

  it('3. Claimed PASS with all required criteria passing produces authoritative PASS review artifact', async () => {
    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        status: 'completed',
        summary: 'All checks verified cleanly',
        filesChanged: [],
        commandsRun: [],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
        claimedVerdict: 'pass',
        findings: [],
      },
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
    })

    const reviewerNode: WorkflowNode = {
      id: 'step-5-reviewer',
      title: 'Reviewer',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
      inputs: [],
      outputs: [
        { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
      ],
    }

    const csId = randomUUID()
    const passingCriteria: CriterionResult[] = [
      {
        kind: 'tests',
        description: 'test suite passes',
        verdict: 'pass',
        reason: 'exited 0',
        evidenceId: null,
      },
      {
        kind: 'build',
        description: 'build succeeds',
        verdict: 'pass',
        reason: 'exited 0',
        evidenceId: null,
      },
    ]

    const attemptId = randomUUID()
    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
      attemptId,
      iteration: 1,
      forkSha,
      signal: new AbortController().signal,
      inputArtifacts: [
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-3-implementer',
          kind: 'changeset',
          format: 'diff',
          title: 'Implementer changeset',
          content: 'diff',
          metadata: { outputName: 'changeset', changeSetId: csId },
          createdAt: NOW,
        },
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verification evidence',
          content: JSON.stringify({
            passed: true,
            verdict: 'pass',
            criteria: passingCriteria,
            evidenceId: randomUUID(),
          }),
          metadata: {
            outputName: 'verification_report',
            criteria: passingCriteria,
            changeSetId: csId,
            iteration: 1,
            evidenceId: randomUUID(),
          },
          createdAt: NOW,
        },
      ],
      incomingSlots: new Map(),
    })

    expect(result.status).toBe('completed')
    expect(result.artifacts).toHaveLength(1)
    const reviewArtifact = result.artifacts![0]!
    expect(reviewArtifact.kind).toBe('review_report')
    expect(reviewArtifact.metadata.verdict).toBe('pass')
    expect(reviewArtifact.metadata.overridden).toBe(false)
    expect(reviewArtifact.metadata.changeSetId).toBe(csId)

    const parsed = reviewOutcomeSchema.parse(JSON.parse(reviewArtifact.content))
    expect(parsed.verdict).toBe('pass')
  })

  it('4. Claimed PASS with a failing criterion is overridden to FAIL', async () => {
    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        status: 'completed',
        summary: 'Reviewer claimed PASS despite failing tests',
        filesChanged: [],
        commandsRun: [],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
        claimedVerdict: 'pass',
        findings: [],
      },
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
    })

    const reviewerNode: WorkflowNode = {
      id: 'step-5-reviewer',
      title: 'Reviewer',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
      inputs: [],
      outputs: [
        { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
      ],
    }

    const csId = randomUUID()
    const criteriaWithFailure: CriterionResult[] = [
      {
        kind: 'tests',
        description: 'test suite passes',
        verdict: 'fail',
        reason: 'npm test exited 1',
        evidenceId: null,
      },
      {
        kind: 'build',
        description: 'build succeeds',
        verdict: 'pass',
        reason: 'exited 0',
        evidenceId: null,
      },
    ]

    const attemptId = randomUUID()
    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
      attemptId,
      iteration: 1,
      forkSha,
      signal: new AbortController().signal,
      inputArtifacts: [
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-3-implementer',
          kind: 'changeset',
          format: 'diff',
          title: 'Implementer changeset',
          content: 'diff',
          metadata: { outputName: 'changeset', changeSetId: csId },
          createdAt: NOW,
        },
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verification evidence',
          content: JSON.stringify({
            passed: false,
            verdict: 'fail',
            criteria: criteriaWithFailure,
            evidenceId: randomUUID(),
          }),
          metadata: {
            outputName: 'verification_report',
            criteria: criteriaWithFailure,
            changeSetId: csId,
            iteration: 1,
            evidenceId: randomUUID(),
          },
          createdAt: NOW,
        },
      ],
      incomingSlots: new Map(),
    })

    // Reviewer completed execution, but the outcome verdict is authoritatively FAIL
    expect(result.status).toBe('completed')
    expect(result.artifacts).toHaveLength(1)
    const reviewArtifact = result.artifacts![0]!
    expect(reviewArtifact.metadata.verdict).toBe('fail')
    expect(reviewArtifact.metadata.overridden).toBe(true)

    const parsed = reviewOutcomeSchema.parse(JSON.parse(reviewArtifact.content))
    expect(parsed.verdict).toBe('fail')
    expect(parsed.overridden).toBe(true)
    expect(parsed.corrections.join(' ')).toContain('npm test exited 1')
  })

  it('5. Claimed PASS with an unknown criterion fails closed with UNKNOWN', async () => {
    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        status: 'completed',
        summary: 'Reviewer claimed PASS but tests could not be run',
        filesChanged: [],
        commandsRun: [],
        testsRun: false,
        openQuestions: [],
        assumptions: [],
        claimedVerdict: 'pass',
        findings: [],
      },
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
    })

    const reviewerNode: WorkflowNode = {
      id: 'step-5-reviewer',
      title: 'Reviewer',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
      inputs: [],
      outputs: [
        { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
      ],
    }

    const csId = randomUUID()
    const criteriaWithUnknown: CriterionResult[] = [
      {
        kind: 'tests',
        description: 'test suite passes',
        verdict: 'unknown',
        reason: 'Forge ran no tests command',
        evidenceId: null,
      },
      {
        kind: 'build',
        description: 'build succeeds',
        verdict: 'pass',
        reason: 'exited 0',
        evidenceId: null,
      },
    ]

    const attemptId = randomUUID()
    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
      attemptId,
      iteration: 1,
      forkSha,
      signal: new AbortController().signal,
      inputArtifacts: [
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-3-implementer',
          kind: 'changeset',
          format: 'diff',
          title: 'Implementer changeset',
          content: 'diff',
          metadata: { outputName: 'changeset', changeSetId: csId },
          createdAt: NOW,
        },
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verification evidence',
          content: JSON.stringify({
            passed: false,
            verdict: 'unknown',
            criteria: criteriaWithUnknown,
            evidenceId: randomUUID(),
          }),
          metadata: {
            outputName: 'verification_report',
            criteria: criteriaWithUnknown,
            changeSetId: csId,
            iteration: 1,
            evidenceId: randomUUID(),
          },
          createdAt: NOW,
        },
      ],
      incomingSlots: new Map(),
    })

    // Fails closed because verdict is UNKNOWN
    expect(result.status).toBe('failed')
    expect(result.error).toContain('Review outcome is UNKNOWN')
  })

  it('6. Claimed FAIL with valid findings produces authoritative FAIL and carries corrections', async () => {
    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        status: 'completed',
        summary: 'Security vulnerability detected in auth flow',
        filesChanged: [],
        commandsRun: [],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
        claimedVerdict: 'fail',
        findings: [
          {
            severity: 'blocker',
            file: 'index.ts',
            line: 42,
            issue: 'Hardcoded secret token',
            requiredChange: 'Move token to secure environment variables',
          },
        ],
      },
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
    })

    const reviewerNode: WorkflowNode = {
      id: 'step-5-reviewer',
      title: 'Reviewer',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
      inputs: [],
      outputs: [
        { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
      ],
    }

    const csId = randomUUID()
    const passingCriteria: CriterionResult[] = [
      {
        kind: 'tests',
        description: 'test suite passes',
        verdict: 'pass',
        reason: 'exited 0',
        evidenceId: null,
      },
    ]

    const attemptId = randomUUID()
    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
      attemptId,
      iteration: 1,
      forkSha,
      signal: new AbortController().signal,
      inputArtifacts: [
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-3-implementer',
          kind: 'changeset',
          format: 'diff',
          title: 'Implementer changeset',
          content: 'diff',
          metadata: { outputName: 'changeset', changeSetId: csId },
          createdAt: NOW,
        },
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verification evidence',
          content: JSON.stringify({
            passed: true,
            verdict: 'pass',
            criteria: passingCriteria,
            evidenceId: randomUUID(),
          }),
          metadata: {
            outputName: 'verification_report',
            criteria: passingCriteria,
            changeSetId: csId,
            iteration: 1,
            evidenceId: randomUUID(),
          },
          createdAt: NOW,
        },
      ],
      incomingSlots: new Map(),
    })

    expect(result.status).toBe('completed')
    const reviewArtifact = result.artifacts![0]!
    expect(reviewArtifact.metadata.verdict).toBe('fail')
    expect(reviewArtifact.metadata.overridden).toBe(false)

    const parsed = reviewOutcomeSchema.parse(JSON.parse(reviewArtifact.content))
    expect(parsed.verdict).toBe('fail')
    expect(parsed.rejectingFindings).toHaveLength(1)
    expect(parsed.corrections[0]).toContain('Hardcoded secret token')
  })

  it('7. Missing or malformed review artifacts fails closed during recovery', async () => {
    const graphRunId = randomUUID()
    createRunRecord(graphRunId)
    workflowStore.startGraphRun(
      {
        graphRunId: graphRunId,
        workflowId,
        projectId,
        templateId: 'test-template',
        startedAt: NOW,
      },
      'system',
    )

    // Node attempt recorded as completed in SQLite, but the review_verdict artifact content is malformed JSON
    const attemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer', 1, 1)

    // Persist malformed artifact
    await persistWorkflowArtifact(graphRunId, attemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'step-5-reviewer-review_verdict',
      content: '{ corrupted json ... not valid',
      metadata: { outputName: 'review_verdict' },
      createdAt: NOW,
    })

    const template: WorkflowTemplateV2 = {
      id: 'test-template',
      name: 'Template',
      description: 'Desc',
      version: 1,
      status: 'published',
      category: 'General',
      nodes: [
        {
          id: 'step-3-implementer',
          title: 'Implementer',
          type: 'agent',
          runtimeType: 'cli-agent',
          config: { role: 'implementer', skills: [], permissionMode: 'developer' },
          inputs: [],
          outputs: [],
        },
        {
          id: 'step-5-reviewer',
          title: 'Reviewer',
          type: 'agent',
          runtimeType: 'cli-agent',
          config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
          inputs: [],
          outputs: [
            { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
          ],
        },
      ],
      edges: [
        {
          id: 'fwd-edge',
          source: 'step-3-implementer',
          target: 'step-5-reviewer',
          isFeedback: false,
        },
        {
          id: 'fb-edge',
          source: 'step-5-reviewer',
          target: 'step-3-implementer',
          isFeedback: true,
          condition: {
            mode: 'all',
            predicates: [{ ref: 'artifacts.review_report.verdict', operator: 'eq', value: 'fail' }],
          },
        },
      ],
      createdAt: NOW,
      updatedAt: NOW,
    }

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn(),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template,
      forkSha,
    })

    // Must fail closed due to malformed review deliverable in recovery
    expect(run.status).toBe('failed')
    expect(run.failedNodeIds).toContain('step-5-reviewer')
    expect(run.error).toContain('malformed JSON')
  })

  it('8. Wrong changeset or iteration lineage is rejected by LeafRunner', async () => {
    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        status: 'completed',
        summary: 'Review completed',
        filesChanged: [],
        commandsRun: [],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
        claimedVerdict: 'pass',
        findings: [],
      },
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      exchangeFn,
    })

    const reviewerNode: WorkflowNode = {
      id: 'step-5-reviewer',
      title: 'Reviewer',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
      inputs: [],
      outputs: [
        { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
      ],
    }

    const currentCsId = randomUUID()
    const staleCsId = randomUUID()
    const criteria: CriterionResult[] = [
      { kind: 'tests', description: 'tests pass', verdict: 'pass', reason: 'ok', evidenceId: null },
    ]

    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
      attemptId: randomUUID(),
      iteration: 2,
      forkSha,
      signal: new AbortController().signal,
      inputArtifacts: [
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-3-implementer',
          kind: 'changeset',
          format: 'diff',
          title: 'Implementer changeset',
          content: 'diff',
          metadata: { outputName: 'changeset', changeSetId: currentCsId },
          createdAt: NOW,
        },
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verification evidence from stale attempt',
          content: JSON.stringify({
            passed: true,
            verdict: 'pass',
            criteria,
            evidenceId: randomUUID(),
          }),
          // Stale changeset reference!
          metadata: {
            outputName: 'verification_report',
            criteria,
            changeSetId: staleCsId,
            iteration: 2,
            evidenceId: randomUUID(),
          },
          createdAt: NOW,
        },
      ],
      incomingSlots: new Map(),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('Lineage rejection')
  })

  // =========================================================================
  // 2. Normal & Recovery Execution in GraphExecutor (Requirements 9 - 14)
  // =========================================================================

  it('9. Normal execution: PASS review verdict avoids feedback edge and completes through normal scheduling', async () => {
    const csId = randomUUID()
    const criteria: CriterionResult[] = [
      {
        kind: 'tests',
        description: 'test suite passes',
        verdict: 'pass',
        reason: 'exited 0',
        evidenceId: null,
      },
    ]

    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      {
        graphRunId: graphRunId,
        workflowId,
        projectId,
        templateId: compiledTemplate.id,
        startedAt: NOW,
      },
      'system',
    )
    createRunRecord(graphRunId)

    const leafExecutor = vi
      .fn()
      .mockImplementation((ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
        if (ctx.node.id === 'step-1-planner') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'plan',
                format: 'markdown',
                title: 'Plan',
                content: '# Plan',
                metadata: { outputName: 'plan' },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-2-user') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'approval',
                format: 'json',
                title: 'Approval',
                content: JSON.stringify({ approved: true }),
                metadata: { outputName: 'approval' },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-3-implementer') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'changeset',
                format: 'diff',
                title: 'Changeset',
                content: 'diff',
                metadata: { outputName: 'changeset', changeSetId: csId },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-4-system') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'evidence',
                format: 'json',
                title: 'Verification report',
                content: JSON.stringify({
                  passed: true,
                  verdict: 'pass',
                  criteria,
                  changeSetId: csId,
                }),
                metadata: { outputName: 'verification_report', criteria, changeSetId: csId },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-5-reviewer') {
          const outcome = {
            verdict: 'pass',
            overridden: false,
            reason: 'All criteria met',
            rejectingFindings: [],
            corrections: [],
            changeSetId: csId,
            stepId: ctx.node.id,
            iteration: 1,
          }
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'review_report',
                format: 'json',
                title: 'Review verdict',
                content: JSON.stringify(outcome),
                metadata: { outputName: 'review_verdict', verdict: 'pass', changeSetId: csId },
                createdAt: NOW,
              },
            ],
          })
        }
        return Promise.resolve({ status: 'completed' })
      })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: leafExecutor,
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: {
        task_objective: 'Test objective',
      },
    })

    expect(run.status).toBe('completed')
    // No feedback transitions taken: completed cleanly in iteration 1
    const transitions = db.all(
      sql`SELECT * FROM graph_transitions WHERE graph_run_id = ${graphRunId}`,
    )
    expect(transitions).toHaveLength(0)

    const storedRun = workflowStore.getGraphRun(graphRunId)
    expect(storedRun?.iteration).toBe(1)
  })

  it('10. Normal execution: FAIL review verdict takes exactly one feedback transition to implementer', async () => {
    const csId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      {
        graphRunId: graphRunId,
        workflowId,
        projectId,
        templateId: compiledTemplate.id,
        startedAt: NOW,
      },
      'system',
    )
    createRunRecord(graphRunId)

    let iterationCount = 1

    const leafExecutor = vi
      .fn()
      .mockImplementation((ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
        if (ctx.node.id === 'step-1-planner') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'plan',
                format: 'markdown',
                title: 'Plan',
                content: '# Plan',
                metadata: { outputName: 'plan' },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-2-user') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'approval',
                format: 'json',
                title: 'Approval',
                content: JSON.stringify({ approved: true }),
                metadata: { outputName: 'approval' },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-3-implementer') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'changeset',
                format: 'diff',
                title: 'Changeset',
                content: `diff iter ${String(iterationCount)}`,
                metadata: { outputName: 'changeset', changeSetId: csId },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-4-system') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'evidence',
                format: 'json',
                title: 'Verification report',
                content: JSON.stringify({
                  passed: true,
                  verdict: 'pass',
                  criteria: [{ kind: 'tests', verdict: 'pass' }],
                }),
                metadata: {
                  outputName: 'verification_report',
                  criteria: [{ kind: 'tests', verdict: 'pass' }],
                  changeSetId: csId,
                },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-5-reviewer') {
          const isIteration1 = iterationCount === 1
          iterationCount++

          const outcome = {
            verdict: isIteration1 ? 'fail' : 'pass',
            overridden: false,
            reason: isIteration1 ? 'Failed on review' : 'Passed second iteration',
            rejectingFindings: isIteration1
              ? [
                  {
                    severity: 'blocker',
                    file: 'index.ts',
                    line: 1,
                    issue: 'bug',
                    requiredChange: 'fix',
                  },
                ]
              : [],
            corrections: isIteration1 ? ['fix bug'] : [],
            changeSetId: csId,
            stepId: ctx.node.id,
            iteration: isIteration1 ? 1 : 2,
          }
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'review_report',
                format: 'json',
                title: 'Review verdict',
                content: JSON.stringify(outcome),
                metadata: {
                  outputName: 'review_verdict',
                  verdict: outcome.verdict,
                  changeSetId: csId,
                },
                createdAt: NOW,
              },
            ],
          })
        }
        return Promise.resolve({ status: 'completed' })
      })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: leafExecutor,
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: {
        task_objective: 'Test objective',
      },
    })

    expect(run.status).toBe('completed')
    // Took exactly one feedback transition
    const transitions = db.all(
      sql`SELECT * FROM graph_transitions WHERE graph_run_id = ${graphRunId}`,
    )
    expect(transitions).toHaveLength(1)
    const t = transitions[0] as {
      from_iteration: number
      to_iteration: number
      source_node_id: string
      target_node_id: string
    }
    expect(t.from_iteration).toBe(1)
    expect(t.to_iteration).toBe(2)
    expect(t.source_node_id).toBe('step-5-reviewer')
    expect(t.target_node_id).toBe('step-3-implementer')

    // Implementer executed twice (attempt 1 in iteration 1, attempt 2 in iteration 2)
    const impAttempts = workflowStore.getNodeAttempts(graphRunId, 'step-3-implementer')
    expect(impAttempts).toHaveLength(2)
  })

  it('11. Recovery: PASS review verdict with no transition does not loop and completes cleanly', async () => {
    const csId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()

    // Simulate crash in Window 2: All 5 nodes completed in iteration 1, review verdict PASS persisted,
    // but process died before terminal run status update
    workflowStore.startGraphRun(
      {
        graphRunId: graphRunId,
        workflowId,
        projectId,
        templateId: compiledTemplate.id,
        startedAt: NOW,
      },
      'system',
    )
    createRunRecord(graphRunId)

    let reviewerAttemptId = ''
    let userAttemptId = ''
    let plannerAttemptId = ''
    let verifAttemptId = ''
    for (const node of compiledTemplate.nodes) {
      const attId = recordCompletedAttempt(graphRunId, node.id, 1, 1)
      if (node.id === 'step-5-reviewer') reviewerAttemptId = attId
      if (node.id === 'step-4-system') verifAttemptId = attId
      if (node.id === 'step-2-user') userAttemptId = attId
      if (node.id === 'step-1-planner') plannerAttemptId = attId
    }

    await persistWorkflowArtifact(graphRunId, plannerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-1-planner',
      kind: 'plan',
      format: 'markdown',
      title: 'step-1-planner-plan',
      content: '# Plan',
      metadata: { outputName: 'plan' },
      createdAt: NOW,
    })

    await persistWorkflowArtifact(graphRunId, userAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-2-user',
      kind: 'approval',
      format: 'json',
      title: 'step-2-user-approval',
      content: JSON.stringify({ approved: true }),
      metadata: { outputName: 'approval' },
      createdAt: NOW,
    })

    const verifEvidenceId = randomUUID()
    await persistWorkflowArtifact(graphRunId, verifAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-4-system',
      kind: 'evidence',
      format: 'json',
      title: 'step-4-system-verification_report',
      content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: verifEvidenceId }),
      metadata: {
        outputName: 'verification_report',
        changeSetId: csId,
        iteration: 1,
        evidenceId: verifEvidenceId,
      },
      createdAt: NOW,
    })

    // Persist reviewer's PASS deliverable
    const passOutcome = {
      verdict: 'pass',
      overridden: false,
      reason: 'All checks passed',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 1,
      evidenceId: verifEvidenceId,
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'step-5-reviewer-review_verdict',
      content: JSON.stringify(passOutcome),
      metadata: {
        outputName: 'review_verdict',
        stepId: reviewerAttemptId,
        changeSetId: csId,
        iteration: 1,
        evidenceId: verifEvidenceId,
      },
      createdAt: NOW,
    })

    const leafExecutor = vi.fn()
    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: leafExecutor,
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: {
        task_objective: 'Test objective',
      },
    })

    // Recovery must evaluate the PASS verdict, determine feedback condition is FALSE,
    // and complete the workflow without taking the feedback edge!
    expect(run.status).toBe('completed')
    expect(leafExecutor).not.toHaveBeenCalled()

    const transitions = db.all(
      sql`SELECT * FROM graph_transitions WHERE graph_run_id = ${graphRunId}`,
    )
    expect(transitions).toHaveLength(0)

    const storedRun = workflowStore.getGraphRun(graphRunId)
    expect(storedRun?.iteration).toBe(1)
  })

  it('12. Recovery: FAIL review verdict with no transition commits exactly one transition', async () => {
    const csId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()

    // Simulate crash in Window 2: Attempt 1 completed with FAIL review verdict,
    // but crash occurred before transition row was committed
    workflowStore.startGraphRun(
      {
        graphRunId: graphRunId,
        workflowId,
        projectId,
        templateId: compiledTemplate.id,
        startedAt: NOW,
      },
      'system',
    )
    createRunRecord(graphRunId)

    let reviewerAttemptId = ''
    let userAttemptId = ''
    let plannerAttemptId = ''
    let verifAttemptId = ''
    for (const node of compiledTemplate.nodes) {
      const attId = recordCompletedAttempt(graphRunId, node.id, 1, 1)
      if (node.id === 'step-5-reviewer') reviewerAttemptId = attId
      if (node.id === 'step-4-system') verifAttemptId = attId
      if (node.id === 'step-2-user') userAttemptId = attId
      if (node.id === 'step-1-planner') plannerAttemptId = attId
    }

    await persistWorkflowArtifact(graphRunId, plannerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-1-planner',
      kind: 'plan',
      format: 'markdown',
      title: 'step-1-planner-plan',
      content: '# Plan',
      metadata: { outputName: 'plan' },
      createdAt: NOW,
    })

    await persistWorkflowArtifact(graphRunId, userAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-2-user',
      kind: 'approval',
      format: 'json',
      title: 'step-2-user-approval',
      content: JSON.stringify({ approved: true }),
      metadata: { outputName: 'approval' },
      createdAt: NOW,
    })

    const verifEvidenceId = randomUUID()
    await persistWorkflowArtifact(graphRunId, verifAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-4-system',
      kind: 'evidence',
      format: 'json',
      title: 'step-4-system-verification_report',
      content: JSON.stringify({ passed: false, verdict: 'fail', evidenceId: verifEvidenceId }),
      metadata: {
        outputName: 'verification_report',
        changeSetId: csId,
        iteration: 1,
        evidenceId: verifEvidenceId,
      },
      createdAt: NOW,
    })

    const failOutcome = {
      verdict: 'fail',
      overridden: false,
      reason: 'Failing tests',
      rejectingFindings: [
        { severity: 'blocker', file: 'index.ts', line: 1, issue: 'bug', requiredChange: 'fix' },
      ],
      corrections: ['fix'],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 1,
      evidenceId: verifEvidenceId,
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'step-5-reviewer-review_verdict',
      content: JSON.stringify(failOutcome),
      metadata: {
        outputName: 'review_verdict',
        verdict: 'fail',
        changeSetId: csId,
        iteration: 1,
        evidenceId: verifEvidenceId,
        stepId: reviewerAttemptId,
      },
      createdAt: NOW,
    })

    // On recovery, implementer attempt 2 and subsequent steps execute
    const leafExecutor = vi
      .fn()
      .mockImplementation((ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
        if (ctx.node.id === 'step-3-implementer') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'changeset',
                format: 'diff',
                title: 'Changeset',
                content: 'diff iter 2',
                metadata: { outputName: 'changeset', changeSetId: csId },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-4-system') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'evidence',
                format: 'json',
                title: 'Verification report',
                content: JSON.stringify({
                  passed: true,
                  verdict: 'pass',
                  criteria: [{ kind: 'tests', verdict: 'pass' }],
                  changeSetId: csId,
                }),
                metadata: {
                  outputName: 'verification_report',
                  criteria: [{ kind: 'tests', verdict: 'pass' }],
                  changeSetId: csId,
                },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-5-reviewer') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'review_report',
                format: 'json',
                title: 'Review verdict',
                content: JSON.stringify({
                  verdict: 'pass',
                  overridden: false,
                  reason: 'fixed',
                  rejectingFindings: [],
                  corrections: [],
                  changeSetId: csId,
                  stepId: ctx.node.id,
                  iteration: 2,
                }),
                metadata: { outputName: 'review_verdict', verdict: 'pass', changeSetId: csId },
                createdAt: NOW,
              },
            ],
          })
        }
        return Promise.resolve({ status: 'completed' })
      })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: leafExecutor,
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: {
        task_objective: 'Test objective',
      },
    })

    expect(run.status).toBe('completed')
    // Exactly 1 transition committed across crash recovery and execution
    const transitions = db.all(
      sql`SELECT * FROM graph_transitions WHERE graph_run_id = ${graphRunId}`,
    )
    expect(transitions).toHaveLength(1)
  })

  it('13. Recovery: an existing committed transition is replayed idempotently without duplication', async () => {
    const csId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()

    // Simulate crash in Window 3: Transition row already committed in graph_transitions,
    // current_iteration already advanced to 2
    workflowStore.startGraphRun(
      {
        graphRunId: graphRunId,
        workflowId,
        projectId,
        templateId: compiledTemplate.id,
        startedAt: NOW,
      },
      'system',
    )
    createRunRecord(graphRunId)

    let reviewerAttemptId = ''
    let userAttemptId = ''
    let plannerAttemptId = ''
    for (const node of compiledTemplate.nodes) {
      const attId = recordCompletedAttempt(graphRunId, node.id, 1, 1)
      if (node.id === 'step-5-reviewer') reviewerAttemptId = attId
      if (node.id === 'step-2-user') userAttemptId = attId
      if (node.id === 'step-1-planner') plannerAttemptId = attId
    }

    await persistWorkflowArtifact(graphRunId, plannerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-1-planner',
      kind: 'plan',
      format: 'markdown',
      title: 'step-1-planner-plan',
      content: '# Plan',
      metadata: { outputName: 'plan' },
      createdAt: NOW,
    })

    await persistWorkflowArtifact(graphRunId, userAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-2-user',
      kind: 'approval',
      format: 'json',
      title: 'step-2-user-approval',
      content: JSON.stringify({ approved: true }),
      metadata: { outputName: 'approval' },
      createdAt: NOW,
    })

    // Persist transition row in SQLite
    workflowStore.advanceLoopIteration({
      projectId,
      actor: 'system',
      graphRunId,
      sourceNodeId: 'step-5-reviewer',
      sourceAttempt: 1,
      targetNodeId: 'step-3-implementer',
      fromIteration: 1,
      toIteration: 2,
      occurredAt: NOW,
    })

    const failOutcome = {
      verdict: 'fail',
      overridden: false,
      reason: 'Failed in iter 1',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 1,
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'step-5-reviewer-review_verdict',
      content: JSON.stringify(failOutcome),
      metadata: { outputName: 'review_verdict', verdict: 'fail', changeSetId: csId },
      createdAt: NOW,
    })

    const leafExecutor = vi
      .fn()
      .mockImplementation((ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
        if (ctx.node.id === 'step-3-implementer') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'changeset',
                format: 'diff',
                title: 'Changeset',
                content: 'diff iter 2',
                metadata: { outputName: 'changeset', changeSetId: csId },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-4-system') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'evidence',
                format: 'json',
                title: 'Verification report',
                content: JSON.stringify({
                  passed: true,
                  verdict: 'pass',
                  criteria: [{ kind: 'tests', verdict: 'pass' }],
                  changeSetId: csId,
                }),
                metadata: {
                  outputName: 'verification_report',
                  criteria: [{ kind: 'tests', verdict: 'pass' }],
                  changeSetId: csId,
                },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-5-reviewer') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'review_report',
                format: 'json',
                title: 'Review verdict',
                content: JSON.stringify({
                  verdict: 'pass',
                  overridden: false,
                  reason: 'fixed',
                  rejectingFindings: [],
                  corrections: [],
                  changeSetId: csId,
                  stepId: ctx.node.id,
                  iteration: 2,
                }),
                metadata: { outputName: 'review_verdict', verdict: 'pass', changeSetId: csId },
                createdAt: NOW,
              },
            ],
          })
        }
        return Promise.resolve({ status: 'completed' })
      })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: leafExecutor,
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: {
        task_objective: 'Test objective',
      },
    })

    expect(run.status).toBe('completed')
    // No duplicate transition row added!
    const transitions = db.all(
      sql`SELECT * FROM graph_transitions WHERE graph_run_id = ${graphRunId}`,
    )
    expect(transitions).toHaveLength(1)
  })

  it('14. Recovery: corrupt or stale evidence fails closed', async () => {
    const csId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()

    workflowStore.startGraphRun(
      {
        graphRunId: graphRunId,
        workflowId,
        projectId,
        templateId: compiledTemplate.id,
        startedAt: NOW,
      },
      'system',
    )
    createRunRecord(graphRunId)

    // Advance graph run to iteration 2
    recordCompletedAttempt(graphRunId, 'step-5-reviewer', 1, 1)
    workflowStore.advanceLoopIteration({
      projectId,
      actor: 'system',
      graphRunId,
      sourceNodeId: 'step-5-reviewer',
      sourceAttempt: 1,
      targetNodeId: 'step-3-implementer',
      fromIteration: 1,
      toIteration: 2,
      occurredAt: NOW,
    })

    // Now record completed attempt 2 for reviewer in iteration 2
    const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer', 2, 2)

    // Persist stale artifact with iteration: 1 while currentIteration: 2
    const evId = randomUUID()
    const staleOutcome = {
      verdict: 'pass',
      overridden: false,
      reason: 'Stale artifact',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 1, // Stale iteration!
      evidenceId: evId,
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'step-5-reviewer-review_verdict',
      content: JSON.stringify(staleOutcome),
      metadata: { outputName: 'review_verdict', evidenceId: evId },
      createdAt: NOW,
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn(),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: {
        task_objective: 'Test objective',
      },
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('does not match current iteration')
  })

  // =========================================================================
  // 3. Loop Exhaustion & Canonical Template Coverage (Requirements 15 - 16)
  // =========================================================================

  it('15. Loop exhaustion preserves established halt behavior with HALTED_LIMIT: max-iterations-exceeded', async () => {
    const csId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      {
        graphRunId: graphRunId,
        workflowId,
        projectId,
        templateId: compiledTemplate.id,
        startedAt: NOW,
      },
      'system',
    )
    createRunRecord(graphRunId)

    // Always returns a failing review
    const leafExecutor = vi
      .fn()
      .mockImplementation((ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
        if (ctx.node.id === 'step-1-planner') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'plan',
                format: 'markdown',
                title: 'Plan',
                content: '# Plan',
                metadata: { outputName: 'plan' },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-2-user') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'approval',
                format: 'json',
                title: 'Approval',
                content: JSON.stringify({ approved: true }),
                metadata: { outputName: 'approval' },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-3-implementer') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'changeset',
                format: 'diff',
                title: 'Changeset',
                content: 'diff',
                metadata: { outputName: 'changeset', changeSetId: csId },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-4-system') {
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'evidence',
                format: 'json',
                title: 'Verification report',
                content: JSON.stringify({
                  passed: true,
                  verdict: 'pass',
                  criteria: [{ kind: 'tests', verdict: 'pass' }],
                  changeSetId: csId,
                }),
                metadata: {
                  outputName: 'verification_report',
                  criteria: [{ kind: 'tests', verdict: 'pass' }],
                  changeSetId: csId,
                },
                createdAt: NOW,
              },
            ],
          })
        }
        if (ctx.node.id === 'step-5-reviewer') {
          const outcome = {
            verdict: 'fail',
            overridden: false,
            reason: 'Still failing',
            rejectingFindings: [
              {
                severity: 'blocker',
                file: 'index.ts',
                line: 1,
                issue: 'bug',
                requiredChange: 'fix',
              },
            ],
            corrections: ['fix'],
            changeSetId: csId,
            stepId: ctx.node.id,
            iteration: ctx.iteration ?? 1,
          }
          return Promise.resolve({
            status: 'completed',
            artifacts: [
              {
                id: randomUUID(),
                workflowId,
                nodeId: ctx.node.id,
                kind: 'review_report',
                format: 'json',
                title: 'Review verdict',
                content: JSON.stringify(outcome),
                metadata: { outputName: 'review_verdict', verdict: 'fail', changeSetId: csId },
                createdAt: NOW,
              },
            ],
          })
        }
        return Promise.resolve({ status: 'completed' })
      })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: leafExecutor,
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: {
        task_objective: 'Test loop exhaustion',
      },
      loopPolicy: {
        maxIterations: 2,
        maxRepeatedStates: 3,
        maxNodeAttempts: 5,
      },
    })

    expect(run.status).toBe('halted')
    expect(run.haltReason).toContain('HALTED_LIMIT: max-iterations-exceeded')
  })

  it('16. Canonical FEATURE_IMPLEMENTATION and BUG_FIX compile and follow intended conditional route', async () => {
    // 1. Verify compilation of FEATURE_IMPLEMENTATION
    const compiledFeature = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    expect(compiledFeature.nodes).toHaveLength(5)
    expect(compiledFeature.edges).toHaveLength(5)
    const featureFeedbackEdge = compiledFeature.edges.find((e) => e.isFeedback)
    expect(featureFeedbackEdge).toBeDefined()
    expect(featureFeedbackEdge!.source).toBe('step-5-reviewer')
    expect(featureFeedbackEdge!.target).toBe('step-3-implementer')
    expect(featureFeedbackEdge!.condition).toEqual({
      mode: 'all',
      predicates: [{ ref: 'artifacts.review_report.verdict', operator: 'eq', value: 'fail' }],
    })

    // 2. Verify compilation of BUG_FIX
    const compiledBugFix = compileLinearTemplateToGraph(BUG_FIX)
    expect(compiledBugFix.nodes).toHaveLength(5)
    expect(compiledBugFix.edges).toHaveLength(5)
    const bugFixFeedbackEdge = compiledBugFix.edges.find((e) => e.isFeedback)
    expect(bugFixFeedbackEdge).toBeDefined()
    expect(bugFixFeedbackEdge!.source).toBe('step-5-reviewer')
    expect(bugFixFeedbackEdge!.target).toBe('step-3-implementer')
    expect(bugFixFeedbackEdge!.condition).toEqual({
      mode: 'all',
      predicates: [{ ref: 'artifacts.review_report.verdict', operator: 'eq', value: 'fail' }],
    })

    // 3. Execute BUG_FIX through GraphExecutor to prove genuine conditional execution
    const csId = randomUUID()
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      {
        graphRunId: graphRunId,
        workflowId,
        projectId,
        templateId: compiledBugFix.id,
        startedAt: NOW,
      },
      'system',
    )
    createRunRecord(graphRunId)

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi
        .fn()
        .mockImplementation((ctx: NodeExecutionContext): Promise<NodeExecutionResult> => {
          if (ctx.node.id === 'step-1-planner') {
            return Promise.resolve({
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: ctx.node.id,
                  kind: 'plan',
                  format: 'markdown',
                  title: 'Plan',
                  content: '# Plan',
                  metadata: { outputName: 'plan' },
                  createdAt: NOW,
                },
              ],
            })
          }
          if (ctx.node.id === 'step-2-user') {
            return Promise.resolve({
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: ctx.node.id,
                  kind: 'approval',
                  format: 'json',
                  title: 'Approval',
                  content: JSON.stringify({ approved: true }),
                  metadata: { outputName: 'approval' },
                  createdAt: NOW,
                },
              ],
            })
          }
          if (ctx.node.id === 'step-3-implementer') {
            return Promise.resolve({
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: ctx.node.id,
                  kind: 'changeset',
                  format: 'diff',
                  title: 'Changeset',
                  content: 'diff',
                  metadata: { outputName: 'changeset', changeSetId: csId },
                  createdAt: NOW,
                },
              ],
            })
          }
          if (ctx.node.id === 'step-4-system') {
            return Promise.resolve({
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: ctx.node.id,
                  kind: 'evidence',
                  format: 'json',
                  title: 'Verification report',
                  content: JSON.stringify({
                    passed: true,
                    verdict: 'pass',
                    criteria: [{ kind: 'tests', verdict: 'pass' }],
                    changeSetId: csId,
                  }),
                  metadata: {
                    outputName: 'verification_report',
                    criteria: [{ kind: 'tests', verdict: 'pass' }],
                    changeSetId: csId,
                  },
                  createdAt: NOW,
                },
              ],
            })
          }
          if (ctx.node.id === 'step-5-reviewer') {
            return Promise.resolve({
              status: 'completed',
              artifacts: [
                {
                  id: randomUUID(),
                  workflowId,
                  nodeId: ctx.node.id,
                  kind: 'review_report',
                  format: 'json',
                  title: 'Review verdict',
                  content: JSON.stringify({
                    verdict: 'pass',
                    overridden: false,
                    reason: 'Bug fix verified',
                    rejectingFindings: [],
                    corrections: [],
                    changeSetId: csId,
                    stepId: ctx.node.id,
                    iteration: 1,
                  }),
                  metadata: { outputName: 'review_verdict', verdict: 'pass' },
                  createdAt: NOW,
                },
              ],
            })
          }
          return Promise.resolve({ status: 'completed' })
        }),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledBugFix,
      forkSha,
      initialContext: {
        task_objective: 'Fix bug in repository',
      },
    })

    expect(run.status).toBe('completed')
    const transitions = db.all(
      sql`SELECT * FROM graph_transitions WHERE graph_run_id = ${graphRunId}`,
    )
    expect(transitions).toHaveLength(0)
  })
})

describe('PR #228 Final Reviewer Lineage and Evidence Integrity Correction', () => {
  const dirsToCleanup: string[] = []
  let db: ForgeDatabase
  let closeDb: () => void
  let workflowStore: WorkflowStore
  let artifactStore: ArtifactStore
  let artifactService: ArtifactService
  let decisionStore: DecisionStore
  let repoDir: string
  let worktreeRoot: string
  let worktreeService: WorktreeService
  let forkSha: Sha
  let projectId: ProjectId
  let taskId: TaskId
  let workflowId: WorkflowId
  let task: Task

  const NOW = new Date().toISOString()

  function createRunRecord(runId: string) {
    new RunStore(db).createRun({
      id: runIdSchema.parse(runId),
      projectId,
      taskId,
      type: 'workflow',
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      exitCode: null,
      summary: null,
      error: null,
      metadata: {},
    })
  }

  function recordCompletedAttempt(
    graphRunId: string,
    nodeId: string,
    attempt = 1,
    iteration = 1,
  ): string {
    const attemptId = randomUUID()
    workflowStore.recordNodeAttempt(
      {
        id: attemptId,
        projectId,
        graphRunId,
        nodeId,
        attempt,
        iteration,
        status: 'ready',
        startedAt: NOW,
      },
      'system',
    )
    workflowStore.updateNodeAttempt(
      {
        projectId,
        graphRunId,
        nodeId,
        attempt,
        status: 'completed',
        finishedAt: NOW,
        occurredAt: NOW,
      },
      'system',
    )
    return attemptId
  }

  async function persistWorkflowArtifact(
    graphRunId: string,
    attemptId: string,
    art: WorkflowArtifact,
    lineageOrder = 0,
    totalArtifacts = 1,
  ) {
    const expectedName = `${art.title}.workflow-artifact.json`
    const envelope = {
      ...art,
      __lineageOrder: lineageOrder,
      __totalArtifacts: totalArtifacts,
    }
    return artifactService.writeArtifact({
      runId: runIdSchema.parse(graphRunId),
      stepId: stepIdSchema.parse(attemptId),
      kind: art.kind as ArtifactKind,
      name: expectedName,
      content: JSON.stringify(envelope),
      mimeType: 'application/json',
      createdAt: art.createdAt,
    })
  }

  function makeRepo(): string {
    const dir = mkdtempSync(join(tmpdir(), 'forge-rev228-repo-'))
    dirsToCleanup.push(dir)
    execFileSync('git', ['init', '-b', 'main', dir])
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: dir })
    execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: dir })
    writeFileSync(join(dir, 'index.ts'), 'export const hello = "world"\n')
    execFileSync('git', ['add', '.'], { cwd: dir })
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: dir })
    return dir
  }

  function mockRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
    return {
      id: 'mock-runtime' as RuntimeId,
      capabilities: [
        'repo-read',
        'file-write',
        'terminal',
        'plan',
        'review',
        'test',
      ] as readonly Capability[],
      simulated: true,
      supportsAccountIsolation: true,
      instructionFilenames: [],
      start: vi.fn().mockImplementation((opts) =>
        Promise.resolve({
          sessionId: 'test-session-1',
          repositoryPath: (opts as { repositoryPath?: string }).repositoryPath ?? repoDir,
        }),
      ),
      send: vi.fn().mockResolvedValue(undefined),
      events: vi.fn().mockReturnValue(
        (async function* () {
          await Promise.resolve()
          yield* []
        })(),
      ),
      status: vi.fn().mockResolvedValue({ state: 'idle' }),
      cancel: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    }
  }

  beforeEach(() => {
    const tempDbDir = mkdtempSync(join(tmpdir(), 'forge-rev228-db-'))
    dirsToCleanup.push(tempDbDir)
    const dbFile = join(tempDbDir, 'forge.db')
    const opened = initialiseDatabase(dbFile)
    db = opened.db
    closeDb = opened.close

    workflowStore = new WorkflowStore(db)
    const eventStore = new EventStore(db)
    decisionStore = new DecisionStore(db, eventStore)
    artifactStore = new ArtifactStore(db)

    const artifactsDir = mkdtempSync(join(tmpdir(), 'forge-rev228-artifacts-'))
    dirsToCleanup.push(artifactsDir)
    artifactService = new ArtifactService(artifactsDir, artifactStore)

    repoDir = makeRepo()
    worktreeRoot = mkdtempSync(join(tmpdir(), 'forge-rev228-wt-'))
    dirsToCleanup.push(worktreeRoot)
    worktreeService = new WorktreeService({ repositoryPath: repoDir, root: worktreeRoot })

    forkSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim()

    projectId = projectIdSchema.parse(randomUUID())
    taskId = taskIdSchema.parse(randomUUID())
    workflowId = workflowIdSchema.parse(randomUUID())

    new ProjectStore(db).create(
      {
        id: projectId,
        name: 'Reviewer PR 228 Test Project',
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: repoDir,
          defaultBranch: 'main',
          buildCommand: 'npm run build',
          testCommand: 'npm test',
          tech: [],
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      'user',
    )

    task = {
      id: taskId,
      objective: 'Implement feature and verify reviewer lineage',
      constraints: ['no regressions'],
      completionCriteria: [
        { kind: 'tests', description: 'test suite passes', params: {} },
        { kind: 'build', description: 'build succeeds', params: {} },
      ],
      scope: { allowedPaths: ['index.ts'], forbiddenPaths: [] },
      lockedDecisionIds: [],
      correctsTaskId: null,
      createdAt: NOW,
    }

    const taskEvent = eventStore.append(
      {
        type: 'task.created',
        payload: { task },
      },
      { projectId, actor: 'user', occurredAt: NOW },
    )
    applyEvent(db, taskEvent)

    workflowStore.start(
      {
        workflowId,
        projectId,
        taskId,
        templateId: 'test-template',
        startedAt: NOW,
      },
      'user',
    )
  })

  afterEach(() => {
    closeDb()
    for (const dir of dirsToCleanup) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // Best effort
      }
    }
  })

  it('1. Verification artifact missing changeSetId fails closed', async () => {
    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        status: 'completed',
        summary: 'Reviewer passed without changeset',
        filesChanged: [],
        commandsRun: [],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
        claimedVerdict: 'pass',
        findings: [],
      },
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({ registry, defaultRuntimeId: 'mock-runtime', exchangeFn })
    const reviewerNode: WorkflowNode = {
      id: 'step-5-reviewer',
      title: 'Reviewer',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
      inputs: [],
      outputs: [
        { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
      ],
    }

    const passingCriteria: CriterionResult[] = [
      { kind: 'tests', description: 'passes', verdict: 'pass', reason: 'ok', evidenceId: null },
    ]

    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
      attemptId: randomUUID(),
      iteration: 1,
      forkSha,
      signal: new AbortController().signal,
      inputArtifacts: [
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verification evidence',
          content: JSON.stringify({ passed: true, verdict: 'pass', criteria: passingCriteria }),
          metadata: {
            outputName: 'verification_report',
            criteria: passingCriteria,
            iteration: 1,
            // changeSetId intentionally omitted
          },
          createdAt: NOW,
        },
      ],
      incomingSlots: new Map(),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('missing authoritative changeSetId metadata')
  })

  it('2. Verification artifact missing iteration fails closed', async () => {
    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        status: 'completed',
        summary: 'Reviewer passed without iteration',
        filesChanged: [],
        commandsRun: [],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
        claimedVerdict: 'pass',
        findings: [],
      },
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({ registry, defaultRuntimeId: 'mock-runtime', exchangeFn })
    const reviewerNode: WorkflowNode = {
      id: 'step-5-reviewer',
      title: 'Reviewer',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
      inputs: [],
      outputs: [
        { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
      ],
    }

    const csId = randomUUID()
    const passingCriteria: CriterionResult[] = [
      { kind: 'tests', description: 'passes', verdict: 'pass', reason: 'ok', evidenceId: null },
    ]

    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
      attemptId: randomUUID(),
      iteration: 1,
      forkSha,
      signal: new AbortController().signal,
      inputArtifacts: [
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verification evidence',
          content: JSON.stringify({ passed: true, verdict: 'pass', criteria: passingCriteria }),
          metadata: {
            outputName: 'verification_report',
            criteria: passingCriteria,
            changeSetId: csId,
            // iteration intentionally omitted
          },
          createdAt: NOW,
        },
      ],
      incomingSlots: new Map(),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('missing valid iteration metadata')
  })

  it('3. Verification artifact with mismatched changeSetId fails closed', async () => {
    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        status: 'completed',
        summary: 'Reviewer passed with mismatched changeset',
        filesChanged: [],
        commandsRun: [],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
        claimedVerdict: 'pass',
        findings: [],
      },
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({ registry, defaultRuntimeId: 'mock-runtime', exchangeFn })
    const reviewerNode: WorkflowNode = {
      id: 'step-5-reviewer',
      title: 'Reviewer',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
      inputs: [],
      outputs: [
        { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
      ],
    }

    const implementerCsId = randomUUID()
    const mismatchedVerifCsId = randomUUID()
    const passingCriteria: CriterionResult[] = [
      { kind: 'tests', description: 'passes', verdict: 'pass', reason: 'ok', evidenceId: null },
    ]

    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
      attemptId: randomUUID(),
      iteration: 1,
      forkSha,
      signal: new AbortController().signal,
      inputArtifacts: [
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-3-implementer',
          kind: 'changeset',
          format: 'diff',
          title: 'Implementer changeset',
          content: 'diff',
          metadata: { outputName: 'changeset', changeSetId: implementerCsId },
          createdAt: NOW,
        },
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verification evidence',
          content: JSON.stringify({ passed: true, verdict: 'pass', criteria: passingCriteria }),
          metadata: {
            outputName: 'verification_report',
            criteria: passingCriteria,
            changeSetId: mismatchedVerifCsId,
            iteration: 1,
          },
          createdAt: NOW,
        },
      ],
      incomingSlots: new Map(),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain('Lineage rejection: verification evidence changeset')
  })

  it('4. Verification artifact with mismatched iteration fails closed', async () => {
    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        status: 'completed',
        summary: 'Reviewer passed with mismatched iteration',
        filesChanged: [],
        commandsRun: [],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
        claimedVerdict: 'pass',
        findings: [],
      },
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({ registry, defaultRuntimeId: 'mock-runtime', exchangeFn })
    const reviewerNode: WorkflowNode = {
      id: 'step-5-reviewer',
      title: 'Reviewer',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
      inputs: [],
      outputs: [
        { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
      ],
    }

    const csId = randomUUID()
    const passingCriteria: CriterionResult[] = [
      { kind: 'tests', description: 'passes', verdict: 'pass', reason: 'ok', evidenceId: null },
    ]

    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
      attemptId: randomUUID(),
      iteration: 2, // Current run is on iteration 2
      forkSha,
      signal: new AbortController().signal,
      inputArtifacts: [
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verification evidence',
          content: JSON.stringify({
            passed: true,
            verdict: 'pass',
            criteria: passingCriteria,
            evidenceId: randomUUID(),
          }),
          metadata: {
            outputName: 'verification_report',
            criteria: passingCriteria,
            changeSetId: csId,
            iteration: 1, // Stale evidence from iteration 1
            evidenceId: randomUUID(),
          },
          createdAt: NOW,
        },
      ],
      incomingSlots: new Map(),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain(
      'Lineage rejection: verification evidence iteration (1) does not match current iteration (2)',
    )
  })

  it('5. Criteria array containing malformed entries fails closed', async () => {
    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        status: 'completed',
        summary: 'Reviewer says looks good',
        filesChanged: [],
        commandsRun: [],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
        claimedVerdict: 'pass',
        findings: [],
      },
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({ registry, defaultRuntimeId: 'mock-runtime', exchangeFn })
    const reviewerNode: WorkflowNode = {
      id: 'step-5-reviewer',
      title: 'Reviewer',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
      inputs: [],
      outputs: [
        { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
      ],
    }

    const csId = randomUUID()
    const malformedCriteria = [{ notAKind: 'invalid', description: 'missing reason and kind' }]

    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
      attemptId: randomUUID(),
      iteration: 1,
      forkSha,
      signal: new AbortController().signal,
      inputArtifacts: [
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verification evidence',
          content: JSON.stringify({
            passed: true,
            verdict: 'pass',
            criteria: malformedCriteria,
            evidenceId: randomUUID(),
          }),
          metadata: {
            outputName: 'verification_report',
            criteria: malformedCriteria,
            changeSetId: csId,
            iteration: 1,
            evidenceId: randomUUID(),
          },
          createdAt: NOW,
        },
      ],
      incomingSlots: new Map(),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain(
      'Verification evidence contains malformed criterion or invalid verdict',
    )

    // Also test domain assessReview fail-closed behavior on malformed criteria
    const domainOutcome = assessReview(
      reviewReportSchema.parse({
        changeSetId: changeSetIdSchema.parse(csId),
        stepId: stepIdSchema.parse(randomUUID()),
        claimedVerdict: 'pass',
        findings: [],
        summary: 'Claims pass',
        reviewedAt: NOW,
      }),
      malformedCriteria,
    )
    expect(domainOutcome.verdict).toBe('unknown')
    expect(domainOutcome.overridden).toBe(true)
    expect(domainOutcome.reason).toContain('criterion result(s) are malformed')
  })

  it('6. Criteria array containing invalid verdict fails closed', async () => {
    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        status: 'completed',
        summary: 'Reviewer claims pass',
        filesChanged: [],
        commandsRun: [],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
        claimedVerdict: 'pass',
        findings: [],
      },
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({ registry, defaultRuntimeId: 'mock-runtime', exchangeFn })
    const reviewerNode: WorkflowNode = {
      id: 'step-5-reviewer',
      title: 'Reviewer',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
      inputs: [],
      outputs: [
        { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
      ],
    }

    const csId = randomUUID()
    const invalidVerdictCriteria = [
      {
        kind: 'tests',
        description: 'tests pass',
        verdict: 'not-a-valid-verdict',
        reason: 'ok',
        evidenceId: null,
      },
    ]

    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
      attemptId: randomUUID(),
      iteration: 1,
      forkSha,
      signal: new AbortController().signal,
      inputArtifacts: [
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verification evidence',
          content: JSON.stringify({
            passed: true,
            verdict: 'pass',
            criteria: invalidVerdictCriteria,
            evidenceId: randomUUID(),
          }),
          metadata: {
            outputName: 'verification_report',
            criteria: invalidVerdictCriteria,
            changeSetId: csId,
            iteration: 1,
            evidenceId: randomUUID(),
          },
          createdAt: NOW,
        },
      ],
      incomingSlots: new Map(),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain(
      'Verification evidence contains malformed criterion or invalid verdict',
    )

    // Also test domain assessReview fail-closed behavior on invalid verdict value
    const domainOutcome = assessReview(
      reviewReportSchema.parse({
        changeSetId: changeSetIdSchema.parse(csId),
        stepId: stepIdSchema.parse(randomUUID()),
        claimedVerdict: 'pass',
        findings: [],
        summary: 'Claims pass',
        reviewedAt: NOW,
      }),
      invalidVerdictCriteria,
    )
    expect(domainOutcome.verdict).toBe('unknown')
    expect(domainOutcome.overridden).toBe(true)
  })

  it('7. Recovery artifact with pass but missing required lineage fails closed', async () => {
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      {
        graphRunId,
        workflowId,
        projectId,
        templateId: 'test-template',
        startedAt: NOW,
      },
      'system',
    )
    createRunRecord(graphRunId)

    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    recordCompletedAttempt(graphRunId, 'step-1-planner')
    recordCompletedAttempt(graphRunId, 'step-2-user')
    recordCompletedAttempt(graphRunId, 'step-3-implementer')
    recordCompletedAttempt(graphRunId, 'step-4-system')
    const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')

    // Persist a review artifact that claims PASS but is missing mandatory changeSetId or iteration
    const incompletePayload = {
      verdict: 'pass',
      overridden: false,
      reason: 'Pass claim without lineage',
      rejectingFindings: [],
      corrections: [],
      // changeSetId missing
      stepId: reviewerAttemptId,
      // iteration missing
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'Reviewer - review_verdict',
      content: JSON.stringify(incompletePayload, null, 2),
      metadata: { outputName: 'review_verdict' },
      createdAt: NOW,
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn().mockResolvedValue({ status: 'completed' }),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: { task_objective: 'Test recovery lineage missing' },
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('violates authoritative verdict contract')
  })

  it('8. Recovery artifact whose changeSetId or reviewer stepId does not match completed attempt fails closed', async () => {
    const csId = randomUUID()
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      {
        graphRunId,
        workflowId,
        projectId,
        templateId: 'test-template',
        startedAt: NOW,
      },
      'system',
    )
    createRunRecord(graphRunId)

    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    recordCompletedAttempt(graphRunId, 'step-1-planner')
    recordCompletedAttempt(graphRunId, 'step-2-user')
    recordCompletedAttempt(graphRunId, 'step-3-implementer')

    // Persist verification evidence for step-4-system with csId
    const evId = randomUUID()
    const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system')
    await persistWorkflowArtifact(graphRunId, verifAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-4-system',
      kind: 'evidence',
      format: 'json',
      title: 'Verification evidence',
      content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
      metadata: {
        outputName: 'verification_report',
        changeSetId: csId,
        iteration: 1,
        evidenceId: evId,
      },
      createdAt: NOW,
    })

    // Part A: stepId mismatch between reviewer attempt and review artifact
    const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
    const mismatchedStepId = randomUUID() // Not equal to reviewerAttemptId

    const mismatchedStepPayload = {
      verdict: 'pass',
      overridden: false,
      reason: 'Verified',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csId,
      stepId: mismatchedStepId,
      iteration: 1,
      evidenceId: evId,
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'Reviewer - review_verdict',
      content: JSON.stringify(mismatchedStepPayload, null, 2),
      metadata: { outputName: 'review_verdict', stepId: mismatchedStepId },
      createdAt: NOW,
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn().mockResolvedValue({ status: 'completed' }),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: { task_objective: 'Test stepId mismatch' },
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('does not match completed reviewer attempt')
  })

  it("9. Multiple candidate review artifacts (stale before current) resolves current attempt's validated artifact", async () => {
    const csId = randomUUID()
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      {
        graphRunId,
        workflowId,
        projectId,
        templateId: 'test-template',
        startedAt: NOW,
      },
      'system',
    )
    createRunRecord(graphRunId)

    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    recordCompletedAttempt(graphRunId, 'step-1-planner', 1, 1)
    recordCompletedAttempt(graphRunId, 'step-2-user', 1, 1)
    recordCompletedAttempt(graphRunId, 'step-3-implementer', 1, 1)

    // Verifier evidence for iteration 1
    const evId = randomUUID()
    const verifAttemptId1 = recordCompletedAttempt(graphRunId, 'step-4-system', 1, 1)
    await persistWorkflowArtifact(graphRunId, verifAttemptId1, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-4-system',
      kind: 'evidence',
      format: 'json',
      title: 'Verification evidence 1',
      content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
      metadata: {
        outputName: 'verification_report',
        changeSetId: csId,
        iteration: 1,
        evidenceId: evId,
      },
      createdAt: NOW,
    })

    // Reviewer attempt 1: emitted FAIL artifact
    const reviewerAttemptId1 = recordCompletedAttempt(graphRunId, 'step-5-reviewer', 1, 1)
    await persistWorkflowArtifact(graphRunId, reviewerAttemptId1, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'Reviewer - review_verdict stale',
      content: JSON.stringify({
        verdict: 'fail',
        overridden: false,
        reason: 'Attempt 1 rejected',
        rejectingFindings: [
          { severity: 'blocker', file: null, line: null, issue: 'bug', requiredChange: 'fix bug' },
        ],
        corrections: ['[blocker] bug — fix bug'],
        changeSetId: csId,
        stepId: reviewerAttemptId1,
        iteration: 1,
        evidenceId: evId,
      }),
      metadata: {
        outputName: 'review_verdict',
        stepId: reviewerAttemptId1,
        verdict: 'fail',
        evidenceId: evId,
      },
      createdAt: NOW,
    })

    // Now attempt 2 runs on iteration 1 and completes with PASS
    const reviewerAttemptId2 = recordCompletedAttempt(graphRunId, 'step-5-reviewer', 2, 1)
    await persistWorkflowArtifact(graphRunId, reviewerAttemptId2, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'Reviewer - review_verdict current',
      content: JSON.stringify({
        verdict: 'pass',
        overridden: false,
        reason: 'Attempt 2 approved',
        rejectingFindings: [],
        corrections: [],
        changeSetId: csId,
        stepId: reviewerAttemptId2,
        iteration: 1,
        evidenceId: evId,
      }),
      metadata: {
        outputName: 'review_verdict',
        stepId: reviewerAttemptId2,
        verdict: 'pass',
        evidenceId: evId,
      },
      createdAt: NOW,
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn().mockResolvedValue({ status: 'completed' }),
    })

    // When recovery runs on completed reviewer attempt 2, it resolves attempt 2's PASS artifact
    // and does NOT take the feedback edge triggered by attempt 1's FAIL artifact!
    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: { task_objective: 'Test multiple candidates resolution' },
    })

    expect(run.status).toBe('completed')
    const transitions = db.all(
      sql`SELECT * FROM graph_transitions WHERE graph_run_id = ${graphRunId}`,
    )
    expect(transitions).toHaveLength(0)
  })

  it('10. Canonical FEATURE_IMPLEMENTATION execution using real graph compiler, LeafRunner, SQLite persistence, and actual configured verification', async () => {
    const compiledFeature = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      {
        graphRunId,
        workflowId,
        projectId,
        templateId: compiledFeature.id,
        startedAt: NOW,
      },
      'system',
    )
    createRunRecord(graphRunId)

    // Pre-record human approval in decisionStore so step-2-user gate approves
    decisionStore.recordGateDecision({
      projectId,
      workflowId,
      graphRunId,
      nodeId: 'step-2-user',
      verdict: 'approved',
      rationale: 'User approves feature plan',
      actor: 'user',
      occurredAt: NOW,
    })

    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())

    const exchangeFn = vi
      .fn()
      .mockImplementation((_runtime: IAgentRuntime, session: unknown, packet: PromptPacket) => {
        const isImplementer = packet.role === 'implementer'
        if (isImplementer) {
          const wt = (session as { repositoryPath?: string }).repositoryPath ?? repoDir
          writeFileSync(join(wt, 'index.ts'), 'export const hello = "feature-world"\n')
        }
        return Promise.resolve({
          ok: true,
          report: {
            status: 'completed' as const,
            summary: `${packet.role} executed cleanly`,
            filesChanged: isImplementer ? ['index.ts'] : [],
            commandsRun: isImplementer ? ['npm test'] : [],
            testsRun: isImplementer,
            openQuestions: [],
            assumptions: [],
            claimedVerdict: 'pass' as const,
            findings: [],
          },
          assessment: { status: 'completed' as const },
          retried: false,
          transcript: [],
        })
      })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      workflowStore,
      projectStore: new ProjectStore(db),
      decisionStore,
      task,
      gitServiceFactory: (path: string) => new GitService({ repositoryPath: path }),
      repository: {
        id: repositoryIdSchema.parse(randomUUID()),
        absolutePath: repoDir,
        defaultBranch: 'main',
        buildCommand: 'echo "build ok"',
        testCommand: 'echo "test ok"',
        tech: [],
      },
      exchangeFn,
      verifyFn: (params) =>
        Promise.resolve({
          passed: true,
          verdict: 'pass',
          detail: 'Build and tests passed',
          artifacts: [
            evidenceArtifactSchema.parse({
              id: randomUUID(),
              workflowId: params.workflowId,
              stepId: params.stepId,
              kind: 'tests',
              command: 'npm test',
              cwd: repoDir,
              outcome: 'completed',
              exitCode: 0,
              durationMs: 40,
              counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
              stdout: '1 passed',
              stderr: '',
              truncated: false,
              failure: null,
              recordedAt: NOW,
            }),
          ],
          criteria: [
            {
              kind: 'tests',
              description: 'test suite passes',
              verdict: 'pass',
              reason: 'exited 0',
              evidenceId: null,
            },
          ],
          findings: [],
          falseClaims: [],
        }),
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: (ctx) => runner.execute(ctx),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledFeature,
      forkSha,
      initialContext: { task_objective: 'Real execution of FEATURE_IMPLEMENTATION' },
    })

    expect(run.status).toBe('completed')

    // Verify reviewer verdict artifact was persisted with authoritative schema
    const attempts = workflowStore.getNodeAttempts(graphRunId, 'step-5-reviewer')
    expect(attempts).toHaveLength(1)
    const reviewerAttempt = attempts[0]!
    expect(reviewerAttempt.status).toBe('completed')

    const reviewerArtifacts = artifactService.listArtifacts(runIdSchema.parse(graphRunId))
    expect(reviewerArtifacts.length).toBeGreaterThan(0)
    const reviewVerdictMeta = reviewerArtifacts.find(
      (a) =>
        a.kind === 'review_report' &&
        (a.stepId === reviewerAttempt.id || a.name.includes('review_verdict')),
    )
    expect(reviewVerdictMeta).toBeDefined()
    const content = (await artifactService.readArtifact(reviewVerdictMeta!.id)).toString('utf-8')
    const envelope = JSON.parse(content) as Record<string, unknown>
    const parsed =
      typeof envelope.content === 'string' ? (JSON.parse(envelope.content) as unknown) : envelope
    const validated = authoritativeReviewVerdictSchema.parse(parsed)
    expect(validated.verdict).toBe('pass')
    expect(validated.stepId).toBe(reviewerAttempt.id)
    expect(validated.iteration).toBe(1)
  })

  it('11. Canonical BUG_FIX execution through the same real path', async () => {
    const compiledBugFix = compileLinearTemplateToGraph(BUG_FIX)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      {
        graphRunId,
        workflowId,
        projectId,
        templateId: compiledBugFix.id,
        startedAt: NOW,
      },
      'system',
    )
    createRunRecord(graphRunId)

    // Pre-record human approval in decisionStore so step-2-user gate approves
    decisionStore.recordGateDecision({
      projectId,
      workflowId,
      graphRunId,
      nodeId: 'step-2-user',
      verdict: 'approved',
      rationale: 'User approves bug fix strategy',
      actor: 'user',
      occurredAt: NOW,
    })

    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())

    const exchangeFn = vi
      .fn()
      .mockImplementation((_runtime: IAgentRuntime, session: unknown, packet: PromptPacket) => {
        const isImplementer = packet.role === 'implementer'
        if (isImplementer) {
          const wt = (session as { repositoryPath?: string }).repositoryPath ?? repoDir
          writeFileSync(join(wt, 'index.ts'), 'export const hello = "bugfix-world"\n')
        }
        return Promise.resolve({
          ok: true,
          report: {
            status: 'completed' as const,
            summary: `${packet.role} executed cleanly`,
            filesChanged: isImplementer ? ['index.ts'] : [],
            commandsRun: isImplementer ? ['npm test'] : [],
            testsRun: isImplementer,
            openQuestions: [],
            assumptions: [],
            claimedVerdict: 'pass' as const,
            findings: [],
          },
          assessment: { status: 'completed' as const },
          retried: false,
          transcript: [],
        })
      })

    const runner = new LeafRunner({
      registry,
      defaultRuntimeId: 'mock-runtime',
      workflowStore,
      projectStore: new ProjectStore(db),
      decisionStore,
      task,
      gitServiceFactory: (path: string) => new GitService({ repositoryPath: path }),
      repository: {
        id: repositoryIdSchema.parse(randomUUID()),
        absolutePath: repoDir,
        defaultBranch: 'main',
        buildCommand: 'echo "build ok"',
        testCommand: 'echo "test ok"',
        tech: [],
      },
      exchangeFn,
      verifyFn: (params) =>
        Promise.resolve({
          passed: true,
          verdict: 'pass',
          detail: 'Regression test and build passed',
          artifacts: [
            evidenceArtifactSchema.parse({
              id: randomUUID(),
              workflowId: params.workflowId,
              stepId: params.stepId,
              kind: 'tests',
              command: 'npm test',
              cwd: repoDir,
              outcome: 'completed',
              exitCode: 0,
              durationMs: 40,
              counts: { total: 1, passed: 1, failed: 0, skipped: 0 },
              stdout: '1 passed',
              stderr: '',
              truncated: false,
              failure: null,
              recordedAt: NOW,
            }),
          ],
          criteria: [
            {
              kind: 'tests',
              description: 'regression test suite passes',
              verdict: 'pass',
              reason: 'exited 0',
              evidenceId: null,
            },
          ],
          findings: [],
          falseClaims: [],
        }),
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: (ctx) => runner.execute(ctx),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledBugFix,
      forkSha,
      initialContext: { task_objective: 'Real execution of BUG_FIX' },
    })

    expect(run.status).toBe('completed')

    const attempts = workflowStore.getNodeAttempts(graphRunId, 'step-5-reviewer')
    expect(attempts).toHaveLength(1)
    const reviewerAttempt = attempts[0]!
    expect(reviewerAttempt.status).toBe('completed')

    const reviewerArtifacts = artifactService.listArtifacts(runIdSchema.parse(graphRunId))
    const reviewVerdictMeta = reviewerArtifacts.find(
      (a) =>
        a.kind === 'review_report' &&
        (a.stepId === reviewerAttempt.id || a.name.includes('review_verdict')),
    )
    expect(reviewVerdictMeta).toBeDefined()
    const content = (await artifactService.readArtifact(reviewVerdictMeta!.id)).toString('utf-8')
    const envelope = JSON.parse(content) as Record<string, unknown>
    const parsed =
      typeof envelope.content === 'string' ? (JSON.parse(envelope.content) as unknown) : envelope
    const validated = authoritativeReviewVerdictSchema.parse(parsed)
    expect(validated.verdict).toBe('pass')
    expect(validated.stepId).toBe(reviewerAttempt.id)
    expect(validated.iteration).toBe(1)
  })

  it('12. Existing recovery cases verified (pass avoids feedback, fail triggers 1 bounded transition, committed transitions not duplicated, unknown evidence fails closed)', async () => {
    const csId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)

    // Case A: PASS avoids feedback edge and completes cleanly
    {
      const graphRunId = randomUUID()
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
        'system',
      )
      createRunRecord(graphRunId)

      recordCompletedAttempt(graphRunId, 'step-1-planner')
      recordCompletedAttempt(graphRunId, 'step-2-user')
      recordCompletedAttempt(graphRunId, 'step-3-implementer')

      const evId = randomUUID()
      const vAttempt = recordCompletedAttempt(graphRunId, 'step-4-system')
      await persistWorkflowArtifact(graphRunId, vAttempt, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-4-system',
        kind: 'evidence',
        format: 'json',
        title: 'Verif Report',
        content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
        metadata: {
          outputName: 'verification_report',
          changeSetId: csId,
          iteration: 1,
          evidenceId: evId,
        },
        createdAt: NOW,
      })

      const rAttempt = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
      await persistWorkflowArtifact(graphRunId, rAttempt, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-5-reviewer',
        kind: 'review_report',
        format: 'json',
        title: 'Reviewer - review_verdict',
        content: JSON.stringify({
          verdict: 'pass',
          overridden: false,
          reason: 'Pass cleanly',
          rejectingFindings: [],
          corrections: [],
          changeSetId: csId,
          stepId: rAttempt,
          iteration: 1,
          evidenceId: evId,
        }),
        metadata: {
          outputName: 'review_verdict',
          stepId: rAttempt,
          verdict: 'pass',
          evidenceId: evId,
        },
        createdAt: NOW,
      })

      const executor = new GraphExecutor({
        workflowStore,
        artifactService,
        worktreeService,
        executeLeafNode: vi.fn().mockResolvedValue({ status: 'completed' }),
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template: compiledTemplate,
        forkSha,
        initialContext: { task_objective: 'Recovery case A: pass' },
      })

      expect(run.status).toBe('completed')
      const transitions = db.all(
        sql`SELECT * FROM graph_transitions WHERE graph_run_id = ${graphRunId}`,
      )
      expect(transitions).toHaveLength(0)
    }

    // Case B: FAIL triggers exactly 1 feedback transition to implementer
    {
      const graphRunId = randomUUID()
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
        'system',
      )
      createRunRecord(graphRunId)

      recordCompletedAttempt(graphRunId, 'step-1-planner')
      recordCompletedAttempt(graphRunId, 'step-2-user')
      recordCompletedAttempt(graphRunId, 'step-3-implementer')

      const evId = randomUUID()
      const vAttempt = recordCompletedAttempt(graphRunId, 'step-4-system')
      await persistWorkflowArtifact(graphRunId, vAttempt, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-4-system',
        kind: 'evidence',
        format: 'json',
        title: 'Verif Report',
        content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
        metadata: {
          outputName: 'verification_report',
          changeSetId: csId,
          iteration: 1,
          evidenceId: evId,
        },
        createdAt: NOW,
      })

      const rAttempt = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
      await persistWorkflowArtifact(graphRunId, rAttempt, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-5-reviewer',
        kind: 'review_report',
        format: 'json',
        title: 'Reviewer - review_verdict',
        content: JSON.stringify({
          verdict: 'fail',
          overridden: false,
          reason: 'Fails with blocker',
          rejectingFindings: [
            { severity: 'blocker', file: null, line: null, issue: 'bug', requiredChange: 'fix' },
          ],
          corrections: ['[blocker] bug — fix'],
          changeSetId: csId,
          stepId: rAttempt,
          iteration: 1,
          evidenceId: evId,
        }),
        metadata: {
          outputName: 'review_verdict',
          stepId: rAttempt,
          verdict: 'fail',
          evidenceId: evId,
        },
        createdAt: NOW,
      })

      const executor = new GraphExecutor({
        workflowStore,
        artifactService,
        worktreeService,
        executeLeafNode: vi.fn().mockResolvedValue({ status: 'completed' }),
      })

      await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template: compiledTemplate,
        forkSha,
        initialContext: { task_objective: 'Recovery case B: fail' },
      })

      const transitions = db.all(
        sql`SELECT * FROM graph_transitions WHERE graph_run_id = ${graphRunId}`,
      )
      expect(transitions).toHaveLength(1)
      const t = transitions[0] as {
        source_node_id: string
        target_node_id: string
        to_iteration: number
      }
      expect(t.source_node_id).toBe('step-5-reviewer')
      expect(t.target_node_id).toBe('step-3-implementer')
      expect(t.to_iteration).toBe(2)
    }

    // Case C: Committed transitions are replayed idempotently without duplication
    {
      const graphRunId = randomUUID()
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
        'system',
      )
      createRunRecord(graphRunId)

      recordCompletedAttempt(graphRunId, 'step-1-planner')
      recordCompletedAttempt(graphRunId, 'step-2-user')
      recordCompletedAttempt(graphRunId, 'step-3-implementer')

      const evId = randomUUID()
      const vAttempt = recordCompletedAttempt(graphRunId, 'step-4-system')
      await persistWorkflowArtifact(graphRunId, vAttempt, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-4-system',
        kind: 'evidence',
        format: 'json',
        title: 'Verif Report',
        content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
        metadata: {
          outputName: 'verification_report',
          changeSetId: csId,
          iteration: 1,
          evidenceId: evId,
        },
        createdAt: NOW,
      })

      const rAttempt = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
      await persistWorkflowArtifact(graphRunId, rAttempt, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-5-reviewer',
        kind: 'review_report',
        format: 'json',
        title: 'Reviewer - review_verdict',
        content: JSON.stringify({
          verdict: 'fail',
          overridden: false,
          reason: 'Fails with blocker',
          rejectingFindings: [
            { severity: 'blocker', file: null, line: null, issue: 'bug', requiredChange: 'fix' },
          ],
          corrections: ['[blocker] bug — fix'],
          changeSetId: csId,
          stepId: rAttempt,
          iteration: 1,
          evidenceId: evId,
        }),
        metadata: {
          outputName: 'review_verdict',
          stepId: rAttempt,
          verdict: 'fail',
          evidenceId: evId,
        },
        createdAt: NOW,
      })

      // Commit transition already
      workflowStore.advanceLoopIteration({
        projectId,
        actor: 'system',
        graphRunId,
        sourceNodeId: 'step-5-reviewer',
        sourceAttempt: 1,
        targetNodeId: 'step-3-implementer',
        fromIteration: 1,
        toIteration: 2,
        occurredAt: NOW,
      })

      const executor = new GraphExecutor({
        workflowStore,
        artifactService,
        worktreeService,
        executeLeafNode: vi.fn().mockResolvedValue({ status: 'completed' }),
      })

      await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template: compiledTemplate,
        forkSha,
        initialContext: { task_objective: 'Recovery case C: deduplication' },
      })

      const transitions = db.all(
        sql`SELECT * FROM graph_transitions WHERE graph_run_id = ${graphRunId}`,
      )
      // Exactly 1 transition, replayed idempotently without duplication
      expect(transitions).toHaveLength(1)
    }

    // Case D: Unknown evidence fails closed
    {
      const graphRunId = randomUUID()
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
        'system',
      )
      createRunRecord(graphRunId)

      recordCompletedAttempt(graphRunId, 'step-1-planner')
      recordCompletedAttempt(graphRunId, 'step-2-user')
      recordCompletedAttempt(graphRunId, 'step-3-implementer')

      const evId = randomUUID()
      const vAttempt = recordCompletedAttempt(graphRunId, 'step-4-system')
      await persistWorkflowArtifact(graphRunId, vAttempt, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-4-system',
        kind: 'evidence',
        format: 'json',
        title: 'Verif Report',
        content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
        metadata: {
          outputName: 'verification_report',
          changeSetId: csId,
          iteration: 1,
          evidenceId: evId,
        },
        createdAt: NOW,
      })

      const rAttempt = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
      await persistWorkflowArtifact(graphRunId, rAttempt, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-5-reviewer',
        kind: 'review_report',
        format: 'json',
        title: 'Reviewer - review_verdict',
        content: JSON.stringify({
          verdict: 'unknown',
          overridden: false,
          reason: 'Evidence could not be decided',
          rejectingFindings: [],
          corrections: [],
          changeSetId: csId,
          stepId: rAttempt,
          iteration: 1,
          evidenceId: evId,
        }),
        metadata: {
          outputName: 'review_verdict',
          stepId: rAttempt,
          verdict: 'unknown',
          evidenceId: evId,
        },
        createdAt: NOW,
      })

      const executor = new GraphExecutor({
        workflowStore,
        artifactService,
        worktreeService,
        executeLeafNode: vi.fn().mockResolvedValue({ status: 'completed' }),
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template: compiledTemplate,
        forkSha,
        initialContext: { task_objective: 'Recovery case D: unknown evidence' },
      })

      expect(run.status).toBe('failed')
      expect(run.error).toContain('is UNKNOWN')
    }
  })
})

describe('PR #228 Final Recovery Lineage Integrity Correction', () => {
  const dirsToCleanup: string[] = []
  let db: ForgeDatabase
  let closeDb: () => void
  let workflowStore: WorkflowStore
  let artifactStore: ArtifactStore
  let artifactService: ArtifactService
  let repoDir: string
  let worktreeRoot: string
  let worktreeService: WorktreeService
  let forkSha: Sha
  let projectId: ProjectId
  let taskId: TaskId
  let workflowId: WorkflowId
  let task: Task

  const NOW = new Date().toISOString()

  function createRunRecord(runId: string) {
    new RunStore(db).createRun({
      id: runIdSchema.parse(runId),
      projectId,
      taskId,
      type: 'workflow',
      status: 'running',
      startedAt: NOW,
      finishedAt: null,
      exitCode: null,
      summary: null,
      error: null,
      metadata: {},
    })
  }

  function recordCompletedAttempt(
    graphRunId: string,
    nodeId: string,
    attempt = 1,
    iteration = 1,
  ): string {
    const attemptId = randomUUID()
    workflowStore.recordNodeAttempt(
      {
        id: attemptId,
        projectId,
        graphRunId,
        nodeId,
        attempt,
        iteration,
        status: 'ready',
        startedAt: NOW,
      },
      'system',
    )
    workflowStore.updateNodeAttempt(
      {
        projectId,
        graphRunId,
        nodeId,
        attempt,
        status: 'completed',
        finishedAt: NOW,
        occurredAt: NOW,
      },
      'system',
    )
    return attemptId
  }

  async function persistWorkflowArtifact(
    graphRunId: string,
    attemptId: string,
    art: WorkflowArtifact,
    lineageOrder = 0,
    totalArtifacts = 1,
  ) {
    const expectedName = `${art.title}.workflow-artifact.json`
    const envelope = {
      ...art,
      __lineageOrder: lineageOrder,
      __totalArtifacts: totalArtifacts,
    }
    return artifactService.writeArtifact({
      runId: runIdSchema.parse(graphRunId),
      stepId: stepIdSchema.parse(attemptId),
      kind: art.kind as ArtifactKind,
      name: expectedName,
      content: JSON.stringify(envelope),
      mimeType: 'application/json',
      createdAt: art.createdAt,
    })
  }

  function mockRuntime(overrides: Partial<IAgentRuntime> = {}): IAgentRuntime {
    return {
      id: 'mock-runtime' as RuntimeId,
      capabilities: [
        'repo-read',
        'file-write',
        'terminal',
        'plan',
        'review',
        'test',
      ] as readonly Capability[],
      simulated: true,
      supportsAccountIsolation: true,
      instructionFilenames: [],
      start: vi.fn().mockImplementation((opts) =>
        Promise.resolve({
          sessionId: 'test-session-1',
          repositoryPath: (opts as { repositoryPath?: string }).repositoryPath ?? repoDir,
        }),
      ),
      send: vi.fn().mockResolvedValue(undefined),
      events: vi.fn().mockReturnValue(
        (async function* () {
          await Promise.resolve()
          yield* []
        })(),
      ),
      status: vi.fn().mockResolvedValue({ state: 'idle' }),
      cancel: vi.fn().mockResolvedValue(undefined),
      dispose: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    }
  }

  beforeEach(() => {
    const tempDbDir = mkdtempSync(join(tmpdir(), 'forge-rev-final-db-'))
    dirsToCleanup.push(tempDbDir)
    const dbFile = join(tempDbDir, 'forge.db')
    const opened = initialiseDatabase(dbFile)
    db = opened.db
    closeDb = opened.close
    workflowStore = new WorkflowStore(db)
    const eventStore = new EventStore(db)
    artifactStore = new ArtifactStore(db)

    const artifactsDir = mkdtempSync(join(tmpdir(), 'forge-rev-final-artifacts-'))
    dirsToCleanup.push(artifactsDir)
    artifactService = new ArtifactService(artifactsDir, artifactStore)

    repoDir = mkdtempSync(join(tmpdir(), 'forge-rev-final-repo-'))
    worktreeRoot = mkdtempSync(join(tmpdir(), 'forge-rev-final-wt-'))
    dirsToCleanup.push(repoDir, worktreeRoot)

    execFileSync('git', ['init', '-b', 'main', repoDir])
    execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoDir })
    execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: repoDir })
    writeFileSync(join(repoDir, 'index.ts'), 'export const hello = "recovery-world"\n')
    execFileSync('git', ['add', '.'], { cwd: repoDir })
    execFileSync('git', ['commit', '-m', 'Initial commit'], { cwd: repoDir })
    forkSha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repoDir }).toString().trim()

    worktreeService = new WorktreeService({
      repositoryPath: repoDir,
      root: worktreeRoot,
    })

    projectId = projectIdSchema.parse(randomUUID())
    taskId = taskIdSchema.parse(randomUUID())
    workflowId = workflowIdSchema.parse(randomUUID())

    new ProjectStore(db).create(
      {
        id: projectId,
        name: 'Recovery Test Project',
        repository: {
          id: repositoryIdSchema.parse(randomUUID()),
          absolutePath: repoDir,
          defaultBranch: 'main',
          buildCommand: 'npm run build',
          testCommand: 'npm test',
          tech: [],
        },
        createdAt: NOW,
        updatedAt: NOW,
      },
      'user',
    )

    task = {
      id: taskId,
      objective: 'Implement feature and verify review recovery',
      constraints: ['no regressions'],
      completionCriteria: [
        { kind: 'tests', description: 'test suite passes', params: {} },
        { kind: 'build', description: 'build succeeds', params: {} },
      ],
      scope: { allowedPaths: ['index.ts'], forbiddenPaths: [] },
      lockedDecisionIds: [],
      correctsTaskId: null,
      createdAt: NOW,
    }

    const taskEvent = eventStore.append(
      {
        type: 'task.created',
        payload: { task },
      },
      { projectId, actor: 'user', occurredAt: NOW },
    )
    applyEvent(db, taskEvent)

    workflowStore.start(
      {
        workflowId,
        projectId,
        taskId,
        templateId: 'test-template',
        startedAt: NOW,
      },
      'user',
    )
  })

  afterEach(() => {
    closeDb()
    for (const dir of dirsToCleanup) {
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // ignore cleanup error
      }
    }
  })

  it('1. Recovery: completed reviewer attempt with no preceding verification artifact fails closed', async () => {
    const csId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
      'system',
    )
    createRunRecord(graphRunId)

    recordCompletedAttempt(graphRunId, 'step-1-planner')
    recordCompletedAttempt(graphRunId, 'step-2-user')
    recordCompletedAttempt(graphRunId, 'step-3-implementer')
    recordCompletedAttempt(graphRunId, 'step-4-system') // Attempt recorded, but NO artifact persisted!
    const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')

    const passPayload = {
      verdict: 'pass',
      overridden: false,
      reason: 'Claims pass',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 1,
      evidenceId: randomUUID(),
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'Reviewer - review_verdict',
      content: JSON.stringify(passPayload),
      metadata: { outputName: 'review_verdict', stepId: reviewerAttemptId, verdict: 'pass' },
      createdAt: NOW,
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn(),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: { task_objective: 'Recovery missing preceding verification artifact' },
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('has no preceding verification artifacts')
  })

  it('2. Recovery: verification evidence without changeSetId fails closed', async () => {
    const csId = randomUUID()
    const evId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
      'system',
    )
    createRunRecord(graphRunId)

    recordCompletedAttempt(graphRunId, 'step-1-planner')
    recordCompletedAttempt(graphRunId, 'step-2-user')
    recordCompletedAttempt(graphRunId, 'step-3-implementer')
    const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system')

    // Persist verification artifact without changeSetId
    await persistWorkflowArtifact(graphRunId, verifAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-4-system',
      kind: 'evidence',
      format: 'json',
      title: 'Verif Report',
      content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
      metadata: { outputName: 'verification_report', iteration: 1, evidenceId: evId }, // Missing changeSetId!
      createdAt: NOW,
    })

    const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
    const passPayload = {
      verdict: 'pass',
      overridden: false,
      reason: 'Claims pass',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 1,
      evidenceId: evId,
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'Reviewer - review_verdict',
      content: JSON.stringify(passPayload),
      metadata: {
        outputName: 'review_verdict',
        stepId: reviewerAttemptId,
        verdict: 'pass',
        changeSetId: csId,
        evidenceId: evId,
      },
      createdAt: NOW,
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn(),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: { task_objective: 'Recovery verification without changeSetId' },
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('is missing authoritative changeSetId metadata')
  })

  it('3. Recovery: verification evidence with malformed changeSetId fails closed', async () => {
    const csId = randomUUID()
    const evId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
      'system',
    )
    createRunRecord(graphRunId)

    recordCompletedAttempt(graphRunId, 'step-1-planner')
    recordCompletedAttempt(graphRunId, 'step-2-user')
    recordCompletedAttempt(graphRunId, 'step-3-implementer')
    const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system')

    // Persist verification artifact with malformed changeSetId
    await persistWorkflowArtifact(graphRunId, verifAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-4-system',
      kind: 'evidence',
      format: 'json',
      title: 'Verif Report',
      content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
      metadata: {
        outputName: 'verification_report',
        iteration: 1,
        evidenceId: evId,
        changeSetId: 'not-a-valid-uuid',
      },
      createdAt: NOW,
    })

    const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
    const passPayload = {
      verdict: 'pass',
      overridden: false,
      reason: 'Claims pass',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 1,
      evidenceId: evId,
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'Reviewer - review_verdict',
      content: JSON.stringify(passPayload),
      metadata: {
        outputName: 'review_verdict',
        stepId: reviewerAttemptId,
        verdict: 'pass',
        changeSetId: csId,
        evidenceId: evId,
      },
      createdAt: NOW,
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn(),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: { task_objective: 'Recovery verification with malformed changeSetId' },
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('contains malformed changeSetId')
  })

  it('4. Recovery: review verdict whose changeset differs from verification evidence fails closed', async () => {
    const csIdVerif = randomUUID()
    const csIdVerdict = randomUUID()
    const evId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
      'system',
    )
    createRunRecord(graphRunId)

    recordCompletedAttempt(graphRunId, 'step-1-planner')
    recordCompletedAttempt(graphRunId, 'step-2-user')
    recordCompletedAttempt(graphRunId, 'step-3-implementer')
    const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system')

    await persistWorkflowArtifact(graphRunId, verifAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-4-system',
      kind: 'evidence',
      format: 'json',
      title: 'Verif Report',
      content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
      metadata: {
        outputName: 'verification_report',
        iteration: 1,
        evidenceId: evId,
        changeSetId: csIdVerif,
      },
      createdAt: NOW,
    })

    const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
    const passPayload = {
      verdict: 'pass',
      overridden: false,
      reason: 'Claims pass',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csIdVerdict, // Differs from csIdVerif!
      stepId: reviewerAttemptId,
      iteration: 1,
      evidenceId: evId,
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'Reviewer - review_verdict',
      content: JSON.stringify(passPayload),
      metadata: {
        outputName: 'review_verdict',
        stepId: reviewerAttemptId,
        verdict: 'pass',
        changeSetId: csIdVerdict,
        evidenceId: evId,
      },
      createdAt: NOW,
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn(),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: { task_objective: 'Recovery changeset mismatch' },
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('does not match verification evidence changeset')
  })

  it('5. Recovery: verdict missing its required evidence identity fails closed', async () => {
    const csId = randomUUID()
    const evId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
      'system',
    )
    createRunRecord(graphRunId)

    recordCompletedAttempt(graphRunId, 'step-1-planner')
    recordCompletedAttempt(graphRunId, 'step-2-user')
    recordCompletedAttempt(graphRunId, 'step-3-implementer')
    const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system')

    await persistWorkflowArtifact(graphRunId, verifAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-4-system',
      kind: 'evidence',
      format: 'json',
      title: 'Verif Report',
      content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
      metadata: {
        outputName: 'verification_report',
        iteration: 1,
        evidenceId: evId,
        changeSetId: csId,
      },
      createdAt: NOW,
    })

    const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
    const payloadMissingEvidenceId = {
      verdict: 'pass',
      overridden: false,
      reason: 'Claims pass',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 1,
      // evidenceId is missing!
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'Reviewer - review_verdict',
      content: JSON.stringify(payloadMissingEvidenceId),
      metadata: {
        outputName: 'review_verdict',
        stepId: reviewerAttemptId,
        verdict: 'pass',
        changeSetId: csId,
      },
      createdAt: NOW,
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn(),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: { task_objective: 'Recovery verdict missing evidenceId' },
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('violates authoritative verdict contract')
  })

  it('6. Recovery: verdict whose evidence identity points to different verification evidence fails closed', async () => {
    const csId = randomUUID()
    const verifEvidenceId = randomUUID()
    const differentEvidenceId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
      'system',
    )
    createRunRecord(graphRunId)

    recordCompletedAttempt(graphRunId, 'step-1-planner')
    recordCompletedAttempt(graphRunId, 'step-2-user')
    recordCompletedAttempt(graphRunId, 'step-3-implementer')
    const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system')

    await persistWorkflowArtifact(graphRunId, verifAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-4-system',
      kind: 'evidence',
      format: 'json',
      title: 'Verif Report',
      content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: verifEvidenceId }),
      metadata: {
        outputName: 'verification_report',
        iteration: 1,
        evidenceId: verifEvidenceId,
        changeSetId: csId,
      },
      createdAt: NOW,
    })

    const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
    const verdictPayload = {
      verdict: 'pass',
      overridden: false,
      reason: 'Claims pass',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 1,
      evidenceId: differentEvidenceId, // Differs from verifEvidenceId!
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'Reviewer - review_verdict',
      content: JSON.stringify(verdictPayload),
      metadata: {
        outputName: 'review_verdict',
        stepId: reviewerAttemptId,
        verdict: 'pass',
        changeSetId: csId,
        evidenceId: differentEvidenceId,
      },
      createdAt: NOW,
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn(),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: { task_objective: 'Recovery evidenceId mismatch' },
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('does not match verification evidence')
  })

  it('7. Recovery: ambiguous or stale verification candidates fails closed', async () => {
    const csId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)

    // Part A: Stale verification candidates only (iteration 0 while currentIteration is 1)
    {
      const graphRunId = randomUUID()
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
        'system',
      )
      createRunRecord(graphRunId)

      recordCompletedAttempt(graphRunId, 'step-1-planner')
      recordCompletedAttempt(graphRunId, 'step-2-user')
      recordCompletedAttempt(graphRunId, 'step-3-implementer')
      const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system')

      const evId = randomUUID()
      await persistWorkflowArtifact(graphRunId, verifAttemptId, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-4-system',
        kind: 'evidence',
        format: 'json',
        title: 'Verif Report Stale',
        content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
        metadata: {
          outputName: 'verification_report',
          iteration: 0,
          evidenceId: evId,
          changeSetId: csId,
        }, // Stale!
        createdAt: NOW,
      })

      const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
      const verdictPayload = {
        verdict: 'pass',
        overridden: false,
        reason: 'Claims pass',
        rejectingFindings: [],
        corrections: [],
        changeSetId: csId,
        stepId: reviewerAttemptId,
        iteration: 1,
        evidenceId: evId,
      }

      await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-5-reviewer',
        kind: 'review_report',
        format: 'json',
        title: 'Reviewer - review_verdict',
        content: JSON.stringify(verdictPayload),
        metadata: {
          outputName: 'review_verdict',
          stepId: reviewerAttemptId,
          verdict: 'pass',
          changeSetId: csId,
          evidenceId: evId,
        },
        createdAt: NOW,
      })

      const executor = new GraphExecutor({
        workflowStore,
        artifactService,
        worktreeService,
        executeLeafNode: vi.fn(),
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template: compiledTemplate,
        forkSha,
        initialContext: { task_objective: 'Recovery stale verification candidate' },
      })

      expect(run.status).toBe('failed')
      expect(run.error).toContain('is stale')
    }

    // Part B: Ambiguous verification candidates (multiple distinct evidence artifacts without unique identity)
    {
      const graphRunId = randomUUID()
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
        'system',
      )
      createRunRecord(graphRunId)

      recordCompletedAttempt(graphRunId, 'step-1-planner')
      recordCompletedAttempt(graphRunId, 'step-2-user')
      recordCompletedAttempt(graphRunId, 'step-3-implementer')
      const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system')

      const evId1 = randomUUID()
      const evId2 = randomUUID()
      // Two verification reports both claiming to be 'verification_report'
      await persistWorkflowArtifact(
        graphRunId,
        verifAttemptId,
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verif Report Candidate 1',
          content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId1 }),
          metadata: {
            outputName: 'verification_report',
            iteration: 1,
            evidenceId: evId1,
            changeSetId: csId,
          },
          createdAt: NOW,
        },
        0,
        2,
      )
      await persistWorkflowArtifact(
        graphRunId,
        verifAttemptId,
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verif Report Candidate 2',
          content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId2 }),
          metadata: {
            outputName: 'verification_report',
            iteration: 1,
            evidenceId: evId2,
            changeSetId: csId,
          },
          createdAt: NOW,
        },
        1,
        2,
      )

      const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
      const verdictPayload = {
        verdict: 'pass',
        overridden: false,
        reason: 'Claims pass',
        rejectingFindings: [],
        corrections: [],
        changeSetId: csId,
        stepId: reviewerAttemptId,
        iteration: 1,
        evidenceId: evId1,
      }

      await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-5-reviewer',
        kind: 'review_report',
        format: 'json',
        title: 'Reviewer - review_verdict',
        content: JSON.stringify(verdictPayload),
        metadata: {
          outputName: 'review_verdict',
          stepId: reviewerAttemptId,
          verdict: 'pass',
          changeSetId: csId,
          evidenceId: evId1,
        },
        createdAt: NOW,
      })

      const executor = new GraphExecutor({
        workflowStore,
        artifactService,
        worktreeService,
        executeLeafNode: vi.fn(),
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template: compiledTemplate,
        forkSha,
        initialContext: { task_objective: 'Recovery ambiguous verification candidates' },
      })

      expect(run.status).toBe('failed')
      expect(run.error).toContain('ambiguous verification evidence')
    }
  })

  it('8. Reviewer invocation with no authoritative attempt ID fails closed even when node ID is a valid UUID', async () => {
    const registry = new RuntimeRegistry()
    registry.register(mockRuntime())
    const exchangeFn = vi.fn().mockResolvedValue({
      ok: true,
      report: {
        status: 'completed',
        summary: 'Reviewer claims pass',
        filesChanged: [],
        commandsRun: [],
        testsRun: true,
        openQuestions: [],
        assumptions: [],
        claimedVerdict: 'pass',
        findings: [],
      },
      assessment: { status: 'completed' },
      retried: false,
      transcript: [],
    })

    const runner = new LeafRunner({ registry, defaultRuntimeId: 'mock-runtime', exchangeFn })
    const validUuidNodeId = randomUUID()
    const reviewerNode: WorkflowNode = {
      id: validUuidNodeId, // Valid UUID for node.id!
      title: 'Reviewer',
      type: 'agent',
      runtimeType: 'cli-agent',
      config: { role: 'reviewer', skills: [], permissionMode: 'read-only' },
      inputs: [],
      outputs: [
        { name: 'review_verdict', kind: 'review_report', format: 'json', requiredSections: [] },
      ],
    }

    const csId = randomUUID()
    const evId = randomUUID()
    const passingCriteria: CriterionResult[] = [
      {
        kind: 'tests',
        description: 'tests pass',
        verdict: 'pass',
        reason: 'ok',
        evidenceId: evId,
      },
    ]

    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
      attemptId: undefined, // Crucial: No attemptId provided!
      iteration: 1,
      forkSha,
      signal: new AbortController().signal,
      inputArtifacts: [
        {
          id: randomUUID(),
          workflowId,
          nodeId: 'step-4-system',
          kind: 'evidence',
          format: 'json',
          title: 'Verification evidence',
          content: JSON.stringify({
            passed: true,
            verdict: 'pass',
            criteria: passingCriteria,
            evidenceId: evId,
          }),
          metadata: {
            outputName: 'verification_report',
            criteria: passingCriteria,
            changeSetId: csId,
            iteration: 1,
            evidenceId: evId,
          },
          createdAt: NOW,
        },
      ],
      incomingSlots: new Map(),
    })

    expect(result.status).toBe('failed')
    expect(result.error).toContain(
      'Reviewer node requires an authoritative attempt identity (UUID)',
    )
  })

  it('9. Recovery: verdict from a previous iteration or reviewer attempt fails closed', async () => {
    const csId = randomUUID()
    const evId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)

    // Part A: Verdict stepId belongs to a previous reviewer attempt
    {
      const graphRunId = randomUUID()
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
        'system',
      )
      createRunRecord(graphRunId)

      recordCompletedAttempt(graphRunId, 'step-1-planner')
      recordCompletedAttempt(graphRunId, 'step-2-user')
      recordCompletedAttempt(graphRunId, 'step-3-implementer')
      const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system')

      await persistWorkflowArtifact(graphRunId, verifAttemptId, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-4-system',
        kind: 'evidence',
        format: 'json',
        title: 'Verif Report',
        content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
        metadata: {
          outputName: 'verification_report',
          iteration: 1,
          evidenceId: evId,
          changeSetId: csId,
        },
        createdAt: NOW,
      })

      const attempt1Id = recordCompletedAttempt(graphRunId, 'step-5-reviewer', 1, 1)
      const attempt2Id = recordCompletedAttempt(graphRunId, 'step-5-reviewer', 2, 1) // Completed attempt is attempt 2!

      // Persist verdict with attempt1Id (previous attempt!)
      const verdictPayload = {
        verdict: 'pass',
        overridden: false,
        reason: 'Claims pass',
        rejectingFindings: [],
        corrections: [],
        changeSetId: csId,
        stepId: attempt1Id, // Mismatched previous attempt ID!
        iteration: 1,
        evidenceId: evId,
      }

      await persistWorkflowArtifact(graphRunId, attempt2Id, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-5-reviewer',
        kind: 'review_report',
        format: 'json',
        title: 'Reviewer - review_verdict',
        content: JSON.stringify(verdictPayload),
        metadata: {
          outputName: 'review_verdict',
          stepId: attempt1Id,
          verdict: 'pass',
          changeSetId: csId,
          evidenceId: evId,
        },
        createdAt: NOW,
      })

      const executor = new GraphExecutor({
        workflowStore,
        artifactService,
        worktreeService,
        executeLeafNode: vi.fn(),
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template: compiledTemplate,
        forkSha,
        initialContext: { task_objective: 'Recovery previous attempt verdict' },
      })

      expect(run.status).toBe('failed')
      expect(run.error).toContain('does not match completed reviewer attempt')
    }

    // Part B: Verdict from previous iteration
    {
      const graphRunId = randomUUID()
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
        'system',
      )
      createRunRecord(graphRunId)

      recordCompletedAttempt(graphRunId, 'step-5-reviewer', 1, 1)
      workflowStore.advanceLoopIteration({
        projectId,
        actor: 'system',
        graphRunId,
        sourceNodeId: 'step-5-reviewer',
        sourceAttempt: 1,
        targetNodeId: 'step-3-implementer',
        fromIteration: 1,
        toIteration: 2,
        occurredAt: NOW,
      })

      const verifAttemptId2 = recordCompletedAttempt(graphRunId, 'step-4-system', 1, 2)
      await persistWorkflowArtifact(graphRunId, verifAttemptId2, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-4-system',
        kind: 'evidence',
        format: 'json',
        title: 'Verif Report Iter 2',
        content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
        metadata: {
          outputName: 'verification_report',
          iteration: 2,
          evidenceId: evId,
          changeSetId: csId,
        },
        createdAt: NOW,
      })

      const reviewerAttemptId2 = recordCompletedAttempt(graphRunId, 'step-5-reviewer', 2, 2)
      const staleIterPayload = {
        verdict: 'pass',
        overridden: false,
        reason: 'Claims pass',
        rejectingFindings: [],
        corrections: [],
        changeSetId: csId,
        stepId: reviewerAttemptId2,
        iteration: 1, // Stale previous iteration!
        evidenceId: evId,
      }

      await persistWorkflowArtifact(graphRunId, reviewerAttemptId2, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-5-reviewer',
        kind: 'review_report',
        format: 'json',
        title: 'Reviewer - review_verdict',
        content: JSON.stringify(staleIterPayload),
        metadata: {
          outputName: 'review_verdict',
          stepId: reviewerAttemptId2,
          verdict: 'pass',
          changeSetId: csId,
          evidenceId: evId,
        },
        createdAt: NOW,
      })

      const executor = new GraphExecutor({
        workflowStore,
        artifactService,
        worktreeService,
        executeLeafNode: vi.fn(),
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template: compiledTemplate,
        forkSha,
        initialContext: { task_objective: 'Recovery previous iteration verdict' },
      })

      expect(run.status).toBe('failed')
      expect(run.error).toContain('does not match current iteration')
    }
  })

  it('10. Recovery: valid canonical execution and crash-recovery replay succeeds with correctly linked persisted evidence', async () => {
    const csId = randomUUID()
    const evId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
      'system',
    )
    createRunRecord(graphRunId)

    const plannerAttemptId = recordCompletedAttempt(graphRunId, 'step-1-planner')
    const userAttemptId = recordCompletedAttempt(graphRunId, 'step-2-user')
    const implAttemptId = recordCompletedAttempt(graphRunId, 'step-3-implementer')
    const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system')
    const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')

    await persistWorkflowArtifact(graphRunId, plannerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-1-planner',
      kind: 'plan',
      format: 'markdown',
      title: 'step-1-planner-plan',
      content: '# Plan',
      metadata: { outputName: 'plan' },
      createdAt: NOW,
    })

    await persistWorkflowArtifact(graphRunId, userAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-2-user',
      kind: 'approval',
      format: 'json',
      title: 'step-2-user-approval',
      content: JSON.stringify({ approved: true }),
      metadata: { outputName: 'approval' },
      createdAt: NOW,
    })

    await persistWorkflowArtifact(graphRunId, implAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-3-implementer',
      kind: 'changeset',
      format: 'diff',
      title: 'step-3-implementer-changeset',
      content: 'diff --git a/index.ts b/index.ts',
      metadata: { outputName: 'changeset', changeSetId: csId },
      createdAt: NOW,
    })

    await persistWorkflowArtifact(graphRunId, verifAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-4-system',
      kind: 'evidence',
      format: 'json',
      title: 'step-4-system-verification_report',
      content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
      metadata: {
        outputName: 'verification_report',
        changeSetId: csId,
        iteration: 1,
        evidenceId: evId,
      },
      createdAt: NOW,
    })

    const passPayload = {
      verdict: 'pass',
      overridden: false,
      reason: 'All checks passed with authoritative evidence',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 1,
      evidenceId: evId,
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'step-5-reviewer-review_verdict',
      content: JSON.stringify(passPayload),
      metadata: {
        outputName: 'review_verdict',
        stepId: reviewerAttemptId,
        changeSetId: csId,
        iteration: 1,
        evidenceId: evId,
        verdict: 'pass',
      },
      createdAt: NOW,
    })

    const leafExecutor = vi.fn()
    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: leafExecutor,
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: { task_objective: 'Canonical recovery replay' },
    })

    expect(run.status).toBe('completed')
    expect(leafExecutor).not.toHaveBeenCalled()

    const transitions = db.all(
      sql`SELECT * FROM graph_transitions WHERE graph_run_id = ${graphRunId}`,
    )
    expect(transitions).toHaveLength(0)

    const storedRun = workflowStore.getGraphRun(graphRunId)
    expect(storedRun?.iteration).toBe(1)
  })

  it('11. Recovery: verification artifact missing iteration metadata on iteration 1 fails closed', async () => {
    const csId = randomUUID()
    const evId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
      'system',
    )
    createRunRecord(graphRunId)

    recordCompletedAttempt(graphRunId, 'step-1-planner')
    recordCompletedAttempt(graphRunId, 'step-2-user')
    recordCompletedAttempt(graphRunId, 'step-3-implementer')
    const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system')

    // Verification artifact on iteration 1 with missing iteration metadata
    await persistWorkflowArtifact(graphRunId, verifAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-4-system',
      kind: 'evidence',
      format: 'json',
      title: 'step-4-system-verification_report',
      content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
      metadata: {
        outputName: 'verification_report',
        changeSetId: csId,
        evidenceId: evId,
        // iteration explicitly omitted!
      },
      createdAt: NOW,
    })

    const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
    const passPayload = {
      verdict: 'pass',
      overridden: false,
      reason: 'Claims pass',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 1,
      evidenceId: evId,
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'step-5-reviewer-review_verdict',
      content: JSON.stringify(passPayload),
      metadata: {
        outputName: 'review_verdict',
        stepId: reviewerAttemptId,
        changeSetId: csId,
        iteration: 1,
        evidenceId: evId,
        verdict: 'pass',
      },
      createdAt: NOW,
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn(),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: { task_objective: 'Missing iteration on iteration 1' },
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('is missing authoritative iteration metadata')
  })

  it('12. Recovery: verification artifact missing iteration metadata on iteration 2 or later fails closed', async () => {
    const csId = randomUUID()
    const evId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
      'system',
    )
    createRunRecord(graphRunId)

    // Set graph run to iteration 2
    db.run(sql`UPDATE graph_runs SET iteration = 2 WHERE id = ${graphRunId}`)

    recordCompletedAttempt(graphRunId, 'step-1-planner', 1, 1)
    recordCompletedAttempt(graphRunId, 'step-2-user', 1, 1)
    recordCompletedAttempt(graphRunId, 'step-3-implementer', 1, 1)
    recordCompletedAttempt(graphRunId, 'step-3-implementer', 2, 2)
    recordCompletedAttempt(graphRunId, 'step-4-system', 1, 1)
    const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system', 2, 2)

    // Verification artifact on iteration 2 missing iteration metadata
    await persistWorkflowArtifact(graphRunId, verifAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-4-system',
      kind: 'evidence',
      format: 'json',
      title: 'step-4-system-verification_report',
      content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
      metadata: {
        outputName: 'verification_report',
        changeSetId: csId,
        evidenceId: evId,
        // iteration explicitly omitted on iteration 2!
      },
      createdAt: NOW,
    })

    recordCompletedAttempt(graphRunId, 'step-5-reviewer', 1, 1)
    const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer', 2, 2)
    const passPayload = {
      verdict: 'pass',
      overridden: false,
      reason: 'Claims pass on iteration 2',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 2,
      evidenceId: evId,
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'step-5-reviewer-review_verdict',
      content: JSON.stringify(passPayload),
      metadata: {
        outputName: 'review_verdict',
        stepId: reviewerAttemptId,
        changeSetId: csId,
        iteration: 2,
        evidenceId: evId,
        verdict: 'pass',
      },
      createdAt: NOW,
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn(),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: { task_objective: 'Missing iteration on iteration 2' },
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('is missing authoritative iteration metadata')
  })

  it('13. Recovery: verification artifact with null, string, zero, negative, or fractional iteration fails closed', async () => {
    const csId = randomUUID()
    const evId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)

    const invalidIterationCases: { label: string; iteration: unknown }[] = [
      { label: 'null', iteration: null },
      { label: 'string', iteration: '1' },
      { label: 'zero', iteration: 0 },
      { label: 'negative', iteration: -1 },
      { label: 'fractional', iteration: 1.5 },
    ]

    for (const testCase of invalidIterationCases) {
      const graphRunId = randomUUID()
      workflowStore.startGraphRun(
        { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
        'system',
      )
      createRunRecord(graphRunId)

      recordCompletedAttempt(graphRunId, 'step-1-planner')
      recordCompletedAttempt(graphRunId, 'step-2-user')
      recordCompletedAttempt(graphRunId, 'step-3-implementer')
      const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system')

      await persistWorkflowArtifact(graphRunId, verifAttemptId, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-4-system',
        kind: 'evidence',
        format: 'json',
        title: `step-4-system-verification_report-${testCase.label}`,
        content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
        metadata: {
          outputName: 'verification_report',
          changeSetId: csId,
          evidenceId: evId,
          iteration: testCase.iteration,
        },
        createdAt: NOW,
      })

      const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
      const passPayload = {
        verdict: 'pass',
        overridden: false,
        reason: 'Claims pass',
        rejectingFindings: [],
        corrections: [],
        changeSetId: csId,
        stepId: reviewerAttemptId,
        iteration: 1,
        evidenceId: evId,
      }

      await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
        id: randomUUID(),
        workflowId,
        nodeId: 'step-5-reviewer',
        kind: 'review_report',
        format: 'json',
        title: `step-5-reviewer-review_verdict-${testCase.label}`,
        content: JSON.stringify(passPayload),
        metadata: {
          outputName: 'review_verdict',
          stepId: reviewerAttemptId,
          changeSetId: csId,
          iteration: 1,
          evidenceId: evId,
          verdict: 'pass',
        },
        createdAt: NOW,
      })

      const executor = new GraphExecutor({
        workflowStore,
        artifactService,
        worktreeService,
        executeLeafNode: vi.fn(),
      })

      const run = await executor.run({
        graphRunId,
        workflowId,
        projectId,
        template: compiledTemplate,
        forkSha,
        initialContext: { task_objective: `Invalid iteration ${testCase.label}` },
      })

      expect(run.status).toBe('failed')
      expect(run.error).toContain('contains invalid iteration metadata')
      expect(run.error).toContain('must be a positive integer')
    }
  })

  it('14. Recovery: verification artifact with valid but mismatched iteration fails closed', async () => {
    const csId = randomUUID()
    const evId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
      'system',
    )
    createRunRecord(graphRunId)

    recordCompletedAttempt(graphRunId, 'step-1-planner')
    recordCompletedAttempt(graphRunId, 'step-2-user')
    recordCompletedAttempt(graphRunId, 'step-3-implementer')
    const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system')

    // Valid positive integer 2, but mismatched with currentIteration 1!
    await persistWorkflowArtifact(graphRunId, verifAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-4-system',
      kind: 'evidence',
      format: 'json',
      title: 'step-4-system-verification_report',
      content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
      metadata: {
        outputName: 'verification_report',
        changeSetId: csId,
        evidenceId: evId,
        iteration: 2, // Mismatched!
      },
      createdAt: NOW,
    })

    const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
    const passPayload = {
      verdict: 'pass',
      overridden: false,
      reason: 'Claims pass',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 1,
      evidenceId: evId,
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'step-5-reviewer-review_verdict',
      content: JSON.stringify(passPayload),
      metadata: {
        outputName: 'review_verdict',
        stepId: reviewerAttemptId,
        changeSetId: csId,
        iteration: 1,
        evidenceId: evId,
        verdict: 'pass',
      },
      createdAt: NOW,
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn(),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: { task_objective: 'Mismatched iteration' },
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('does not match current iteration')
  })

  it('15. Recovery: verification artifact with correct changeset and evidence IDs but invalid iteration fails closed before feedback evaluation', async () => {
    const csId = randomUUID()
    const evId = randomUUID()
    const compiledTemplate = compileLinearTemplateToGraph(FEATURE_IMPLEMENTATION)
    const graphRunId = randomUUID()
    workflowStore.startGraphRun(
      { graphRunId, workflowId, projectId, templateId: compiledTemplate.id, startedAt: NOW },
      'system',
    )
    createRunRecord(graphRunId)

    recordCompletedAttempt(graphRunId, 'step-1-planner')
    recordCompletedAttempt(graphRunId, 'step-2-user')
    recordCompletedAttempt(graphRunId, 'step-3-implementer')
    const verifAttemptId = recordCompletedAttempt(graphRunId, 'step-4-system')

    // Verification evidence has correct changeSetId and evidenceId, but zero iteration
    await persistWorkflowArtifact(graphRunId, verifAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-4-system',
      kind: 'evidence',
      format: 'json',
      title: 'step-4-system-verification_report',
      content: JSON.stringify({ passed: true, verdict: 'pass', evidenceId: evId }),
      metadata: {
        outputName: 'verification_report',
        changeSetId: csId,
        evidenceId: evId,
        iteration: 0, // Invalid!
      },
      createdAt: NOW,
    })

    const reviewerAttemptId = recordCompletedAttempt(graphRunId, 'step-5-reviewer')
    // Review verdict is FAIL with findings - which WOULD normally trigger feedback edge!
    const failPayload = {
      verdict: 'fail',
      overridden: false,
      reason: 'Review rejected',
      rejectingFindings: [
        { severity: 'blocker', file: 'index.ts', line: 1, issue: 'bug', requiredChange: 'fix' },
      ],
      corrections: ['Fix finding'],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 1,
      evidenceId: evId,
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'step-5-reviewer-review_verdict',
      content: JSON.stringify(failPayload),
      metadata: {
        outputName: 'review_verdict',
        stepId: reviewerAttemptId,
        changeSetId: csId,
        iteration: 1,
        evidenceId: evId,
        verdict: 'fail',
      },
      createdAt: NOW,
    })

    const executor = new GraphExecutor({
      workflowStore,
      artifactService,
      worktreeService,
      executeLeafNode: vi.fn(),
    })

    const run = await executor.run({
      graphRunId,
      workflowId,
      projectId,
      template: compiledTemplate,
      forkSha,
      initialContext: {
        task_objective: 'Invalid iteration fails before feedback condition evaluation',
      },
    })

    expect(run.status).toBe('failed')
    expect(run.error).toContain('contains invalid iteration metadata')

    // Must NOT evaluate or commit feedback transition when verification evidence iteration is invalid!
    const transitions = db.all(
      sql`SELECT * FROM graph_transitions WHERE graph_run_id = ${graphRunId}`,
    )
    expect(transitions).toHaveLength(0)
  })
})
