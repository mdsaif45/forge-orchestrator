import { execFileSync } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { sql } from 'drizzle-orm'
import {
  assessReview,
  changeSetIdSchema,
  compileLinearTemplateToGraph,
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
import { EventStore } from '../db/eventStore'
import { ProjectStore } from '../db/projectStore'
import { applyEvent } from '../db/projections'
import { WorkflowStore } from '../db/workflowStore'
import { RunStore } from '../db/runStore'
import { WorktreeService } from '../git'
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
  ) {
    const expectedName = `${art.title}.workflow-artifact.json`
    const envelope = {
      ...art,
      __lineageOrder: 0,
      __totalArtifacts: 1,
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
      start: vi.fn().mockResolvedValue({ sessionId: 'test-session-1' }),
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
          content: JSON.stringify({ passed: true, verdict: 'unknown', criteria: [] }),
          metadata: { outputName: 'verification_report', criteria: [], changeSetId: csId },
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

    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
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
          content: JSON.stringify({ passed: true, verdict: 'pass', criteria: passingCriteria }),
          metadata: {
            outputName: 'verification_report',
            criteria: passingCriteria,
            changeSetId: csId,
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

    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
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
          }),
          metadata: {
            outputName: 'verification_report',
            criteria: criteriaWithFailure,
            changeSetId: csId,
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

    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
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
          }),
          metadata: {
            outputName: 'verification_report',
            criteria: criteriaWithUnknown,
            changeSetId: csId,
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

    const result = await runner.execute({
      graphRunId: randomUUID(),
      workflowId,
      projectId,
      node: reviewerNode,
      attempt: 1,
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
          content: JSON.stringify({ passed: true, verdict: 'pass', criteria: passingCriteria }),
          metadata: {
            outputName: 'verification_report',
            criteria: passingCriteria,
            changeSetId: csId,
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
          content: JSON.stringify({ passed: true, verdict: 'pass', criteria }),
          // Stale changeset reference!
          metadata: {
            outputName: 'verification_report',
            criteria,
            changeSetId: staleCsId,
            iteration: 2,
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
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'step-5-reviewer-review_verdict',
      content: JSON.stringify(passOutcome),
      metadata: { outputName: 'review_verdict' },
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
    const staleOutcome = {
      verdict: 'pass',
      overridden: false,
      reason: 'Stale artifact',
      rejectingFindings: [],
      corrections: [],
      changeSetId: csId,
      stepId: reviewerAttemptId,
      iteration: 1, // Stale iteration!
    }

    await persistWorkflowArtifact(graphRunId, reviewerAttemptId, {
      id: randomUUID(),
      workflowId,
      nodeId: 'step-5-reviewer',
      kind: 'review_report',
      format: 'json',
      title: 'step-5-reviewer-review_verdict',
      content: JSON.stringify(staleOutcome),
      metadata: { outputName: 'review_verdict' },
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
