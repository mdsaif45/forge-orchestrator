import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  runtimeIdSchema,
  sessionIdSchema,
  type IAgentRuntime,
  type RuntimeEvent,
  type RuntimeStatus,
  type SessionHandle,
} from '@shared/domain'
import { createForgeCore, type ForgeCore } from './forgeCore'
import { executeDirectTask, type DirectTaskEvent } from './taskRunner'

describe('executeDirectTask', () => {
  let tempDir: string
  let repoPath: string
  let core: ForgeCore

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'forge-task-runner-'))
    repoPath = join(tempDir, 'repo')
    execFileSync('git', ['init', repoPath], { encoding: 'utf8' })
    execFileSync('git', ['config', 'user.name', 'Forge Tester'], { cwd: repoPath })
    execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: repoPath })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoPath })

    writeFileSync(join(repoPath, 'README.md'), '# Initial README\n')
    execFileSync('git', ['add', '.'], { cwd: repoPath })
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoPath })

    core = createForgeCore({ dataDir: join(tempDir, 'data') })
  })

  afterEach(async () => {
    await core.close()
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore temp cleanup errors
    }
  })

  it(
    'executes task, detects physical git modifications, and records authoritative changeset',
    { timeout: 30_000 },
    async () => {
      const events: DirectTaskEvent[] = []

      const result = await executeDirectTask(core, {
        workspacePath: repoPath,
        task: 'Update README with project details',
        onEvent: (event) => events.push(event),
        runTurn: async (_request, onEvent) => {
          await Promise.resolve()
          onEvent({ kind: 'tool', text: 'edit_file README.md' })
          // Simulate agent editing README.md on disk
          writeFileSync(
            join(repoPath, 'README.md'),
            '# Initial README\n\nUpdated by Forge Agent!\n',
          )
          return {
            ok: true,
            content: 'Updated README.md with detailed project descriptions.',
            reasoning: 'The README needed extra details.',
            toolsUsed: [{ name: 'edit_file', ok: true }],
            rounds: 1,
            error: null,
            stoppedAtLimit: false,
            plan: {
              capabilities: { tools: true, vision: false, thinking: false, source: 'reported' },
              usedTools: true,
            },
          }
        },
      })

      expect(result.ok).toBe(true)
      expect(result.exitCode).toBe(0)
      expect(result.filesChanged).toContain('README.md')
      expect(result.physicalDiff.files.length).toBe(1)
      expect(result.physicalDiff.files[0]?.path).toBe('README.md')
      expect(result.physicalDiff.patch).toContain('Updated by Forge Agent!')

      // Check project was created
      const projectList = core.projects.list()
      expect(projectList.length).toBe(1)

      // Check changeset was recorded
      const changesets = core.changeSets.list(projectList[0]!.id)
      expect(changesets.length).toBe(1)
      expect(changesets[0]!.patch).toContain('Updated by Forge Agent!')

      // Check authoritative StepEvidence was produced (EVIDENCE-001)
      expect(result.evidence).toBeDefined()
      expect(result.evidence.passed).toBe(true)
      expect(result.evidence.verdict).toBe('pass')
      expect(result.evidence.changeSet?.patch).toContain('Updated by Forge Agent!')
      expect(result.evidence.discrepancies.length).toBe(0)

      // Check completion criteria evaluation (CRIT-001)
      expect(result.verification).toBeDefined()
      expect(result.verification?.passed).toBe(true)
      expect(result.verification?.criteria).toBeDefined()
      expect(result.verification?.criteria?.length).toBeGreaterThan(0)
      expect(result.verification?.criteria?.some((c) => c.kind === 'no-assumptions')).toBe(true)
      expect(result.evidence.criteria.length).toBeGreaterThan(0)
      expect(
        result.evidence.criteria.some((c) => c.kind === 'no-assumptions' && c.verdict === 'pass'),
      ).toBe(true)

      // Events were streamed
      expect(events.some((e) => e.kind === 'status')).toBe(true)
      expect(events.some((e) => e.kind === 'tool_start')).toBe(true)

      // Check durable RunRecord and StepRecord were recorded (STATE-001)
      expect(result.runId).toBeDefined()
      const runRecord = core.runs.getRun(result.runId)
      expect(runRecord).not.toBeNull()
      expect(runRecord?.status).toBe('completed')
      expect(runRecord?.exitCode).toBe(0)

      const steps = core.runs.listStepsForRun(result.runId)
      expect(steps.length).toBe(1)
      expect(steps[0]?.role).toBe('implementer')
      expect(steps[0]?.status).toBe('completed')
      expect(steps[0]?.changeSetId).toBe(changesets[0]!.id)

      // Check run events were logged sequentially (STATE-001)
      const runEvents = core.runs.listEventsForRun(result.runId)
      expect(runEvents.length).toBeGreaterThan(0)
      expect(runEvents[0]?.seq).toBe(1)
      expect(runEvents.some((e) => e.type === 'run.started')).toBe(true)
      expect(runEvents.some((e) => e.type === 'run.finished')).toBe(true)

      // Check physical file artifacts were stored on disk and recorded in SQLite (STATE-001)
      const artifacts = core.artifacts.listArtifacts(result.runId)
      expect(artifacts.length).toBeGreaterThan(0)
      expect(artifacts.some((a) => a.kind === 'prompt-packet')).toBe(true)
      expect(artifacts.some((a) => a.kind === 'diff')).toBe(true)

      const diffArtifact = artifacts.find((a) => a.kind === 'diff')!
      const patchContent = await core.artifacts.readArtifactText(diffArtifact.id)
      expect(patchContent).toContain('Updated by Forge Agent!')
    },
  )

  it(
    'detects discrepancies and halts with exitCode 2 when edits violate declared scope',
    { timeout: 30_000 },
    async () => {
      const result = await executeDirectTask(core, {
        workspacePath: repoPath,
        task: 'Modify secret configuration',
        allowedPaths: ['docs/**'], // Only docs are allowed
        runTurn: async () => {
          await Promise.resolve()
          // Agent touches README.md which is NOT under docs/**
          writeFileSync(join(repoPath, 'README.md'), '# Tampered\n')
          return {
            ok: true,
            content: 'I modified README.md',
            reasoning: 'None',
            toolsUsed: [{ name: 'edit_file', ok: true }],
            rounds: 1,
            error: null,
            stoppedAtLimit: false,
            plan: {
              capabilities: { tools: true, vision: false, thinking: false, source: 'reported' },
              usedTools: true,
            },
          }
        },
      })

      expect(result.ok).toBe(false)
      expect(result.exitCode).toBe(2) // Policy violation exit code
      expect(result.outOfScopeFiles).toContain('README.md')
      expect(result.evidence.passed).toBe(false)
      expect(result.evidence.verdict).toBe('fail')
      expect(result.evidence.discrepancies.some((d) => d.kind === 'outside-scope')).toBe(true)
    },
  )

  it(
    'executes task through custom IAgentRuntime, verifying first-class agent abstraction',
    { timeout: 30_000 },
    async () => {
      let startCalled = false
      let sendCalled = false
      let disposeCalled = false

      const customRuntime: IAgentRuntime = {
        id: runtimeIdSchema.parse('custom-test-agent'),
        capabilities: ['repo-read', 'file-write', 'test', 'plan', 'review', 'terminal'],
        simulated: false,
        supportsAccountIsolation: false,
        instructionFilenames: [],
        // eslint-disable-next-line @typescript-eslint/require-await
        async start(): Promise<SessionHandle> {
          startCalled = true
          return {
            sessionId: sessionIdSchema.parse(`custom-session-${randomUUID()}`),
            runtimeId: runtimeIdSchema.parse('custom-test-agent'),
          }
        },
        // eslint-disable-next-line @typescript-eslint/require-await
        async send(): Promise<void> {
          sendCalled = true
          writeFileSync(join(repoPath, 'README.md'), '# Updated via Custom IAgentRuntime\n')
        },
        // eslint-disable-next-line @typescript-eslint/require-await
        async *events(): AsyncIterable<RuntimeEvent> {
          yield {
            type: 'chunk',
            at: new Date().toISOString(),
            text: 'I have updated README via custom IAgentRuntime.',
          }
          yield { type: 'state', at: new Date().toISOString(), state: 'completed' }
        },
        // eslint-disable-next-line @typescript-eslint/require-await
        async status(session): Promise<RuntimeStatus> {
          return {
            sessionId: session.sessionId,
            state: 'completed',
            lastActivityAt: new Date().toISOString(),
            failure: null,
          }
        },
        cancel(): Promise<void> {
          return Promise.resolve()
        },
        dispose(): Promise<void> {
          disposeCalled = true
          return Promise.resolve()
        },
      }

      const result = await executeDirectTask(core, {
        workspacePath: repoPath,
        task: 'Update README using custom IAgentRuntime',
        runtime: customRuntime,
      })

      expect(startCalled).toBe(true)
      expect(sendCalled).toBe(true)
      expect(disposeCalled).toBe(true)
      expect(result.ok).toBe(true)
      expect(result.exitCode).toBe(0)
      expect(result.filesChanged).toContain('README.md')
      expect(result.evidence.passed).toBe(true)
      expect(result.evidence.changeSet?.patch).toContain('Updated via Custom IAgentRuntime')
    },
  )

  it(
    'evaluates completion criteria and fails with exitCode 1 when agent admits unverified assumptions',
    { timeout: 30_000 },
    async () => {
      const result = await executeDirectTask(core, {
        workspacePath: repoPath,
        task: 'Refactor configuration',
        runTurn: async () => {
          await Promise.resolve()
          writeFileSync(join(repoPath, 'README.md'), '# Refactored\n')
          return {
            ok: true,
            content: JSON.stringify({
              status: 'completed',
              summary: 'Refactored configuration assuming port 8080 is available',
              filesChanged: ['README.md'],
              assumptions: ['Assumed port 8080 is always open'],
            }),
            reasoning: 'I assumed port 8080 without checking',
            toolsUsed: [{ name: 'edit_file', ok: true }],
            rounds: 1,
            error: null,
            stoppedAtLimit: false,
            plan: {
              capabilities: { tools: true, vision: false, thinking: false, source: 'reported' },
              usedTools: true,
            },
          }
        },
      })

      expect(result.ok).toBe(false)
      expect(result.exitCode).toBe(1)
      expect(result.verification).toBeDefined()
      expect(result.verification?.passed).toBe(false)
      expect(
        result.verification?.criteria?.some(
          (c) => c.kind === 'no-assumptions' && c.verdict === 'fail',
        ),
      ).toBe(true)
      expect(result.evidence.passed).toBe(false)
      expect(result.evidence.verdict).toBe('fail')
      expect(
        result.evidence.criteria.some((c) => c.kind === 'no-assumptions' && c.verdict === 'fail'),
      ).toBe(true)
    },
  )
})
