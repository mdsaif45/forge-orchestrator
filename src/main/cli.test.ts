import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { projectIdSchema, runIdSchema, stepIdSchema, taskIdSchema } from '@shared/domain'
import { createForgeCore } from './core/forgeCore'
import { runCli } from './cli'

describe('Forge CLI (runCli)', () => {
  let tempDir: string
  let repoPath: string
  let dataDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'forge-cli-test-'))
    repoPath = join(tempDir, 'repo')
    dataDir = join(tempDir, 'data')

    execFileSync('git', ['init', repoPath], { encoding: 'utf8' })
    execFileSync('git', ['config', 'user.name', 'Forge Tester'], { cwd: repoPath })
    execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: repoPath })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoPath })

    writeFileSync(join(repoPath, 'README.md'), '# Initial README\n')
    execFileSync('git', ['add', '.'], { cwd: repoPath })
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoPath })
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  it('prints version and returns exit code 0', async () => {
    const code = await runCli(['--version'])
    expect(code).toBe(0)
  })

  it('prints help and returns exit code 0', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const code = await runCli(['--help'])
    expect(code).toBe(0)
    expect(consoleLog).toHaveBeenCalledWith(
      expect.stringContaining(
        "Output machine-readable JSON (NDJSON stream for 'run', JSON document for inspection commands)",
      ),
    )
    consoleLog.mockRestore()
  })

  it('reports repository status in json mode with exit code 0', async () => {
    const code = await runCli(['status', '--cwd', repoPath, '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
  })

  it('configures and reads active models with exit code 0', async () => {
    const setCode = await runCli([
      'models',
      'set',
      'ollama',
      'qwen2.5-coder:7b',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(setCode).toBe(0)

    const listCode = await runCli(['models', 'list', '--data-dir', dataDir, '--json'])
    expect(listCode).toBe(0)
  })

  it('handles models auto when daemon is offline with code 1 (MODEL-001)', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    const autoCode = await runCli(['models', 'auto', '--data-dir', dataDir, '--json'])
    expect(autoCode).toBe(1)
    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as { ok: boolean; error: string }
    expect(parsed.ok).toBe(false)
    expect(parsed.error).toContain('Ollama is offline')

    consoleLog.mockRestore()
  })

  it('fails with exit code 1 when run is called without a task', async () => {
    const code = await runCli(['run', '--cwd', repoPath, '--data-dir', dataDir])
    expect(code).toBe(1)
  })

  it('fails with exit code 1 when runs is called without --all in an unregistered project directory', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const code = await runCli(['runs', '--cwd', repoPath, '--data-dir', dataDir])
    expect(code).toBe(1)
    expect(consoleError).toHaveBeenCalledWith(
      expect.stringContaining(
        'is not a registered Forge project. Use --all to list runs across all projects.',
      ),
    )
    consoleError.mockRestore()

    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => undefined)
    const jsonCode = await runCli(['runs', '--cwd', repoPath, '--data-dir', dataDir, '--json'])
    expect(jsonCode).toBe(1)
    expect(consoleLog).toHaveBeenCalledWith(
      JSON.stringify({
        error: `Current directory "${repoPath}" is not a registered Forge project. Use --all to list runs across all projects.`,
      }),
    )
    consoleLog.mockRestore()
  })

  it('lists runs in empty state when --all is supplied', async () => {
    const code = await runCli(['runs', '--data-dir', dataDir, '--all'])
    expect(code).toBe(0)

    const jsonCode = await runCli(['runs', 'list', '--data-dir', dataDir, '--all', '--json'])
    expect(jsonCode).toBe(0)
  })

  it('inspects runs, steps, events, and artifacts across subcommands', async () => {
    const core = createForgeCore({ dataDir })
    const projectView = await core.projects.create({
      name: 'Test Project',
      repositoryPath: repoPath,
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: [],
      rules: [],
    })
    const projectId = projectIdSchema.parse(projectView.id)
    const runId = runIdSchema.parse(randomUUID())
    const stepId = stepIdSchema.parse(randomUUID())
    const taskId = taskIdSchema.parse(randomUUID())

    core.runs.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'completed',
      startedAt: new Date(Date.now() - 10000).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: 'Test task execution succeeded',
      error: null,
      metadata: {
        task: 'Implement unit tests',
        baseSha: '0123456789abcdef',
      },
    })

    core.runs.createStep({
      id: stepId,
      runId,
      index: 1,
      role: 'agent',
      runtimeId: null,
      status: 'completed',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: new Date().toISOString(),
      summary: 'Executed agent step successfully',
      changeSetId: null,
      evidenceId: null,
    })

    core.runs.appendEvent(runId, {
      stepId,
      type: 'run.started',
      payload: { message: 'Run initiated' },
    })

    const artifact = await core.artifacts.writeArtifact({
      runId,
      stepId,
      kind: 'stdout',
      name: 'test-output.txt',
      content: 'Hello Forge artifact verification',
    })

    // Create a second project to test project scoping
    const repoPath2 = join(tempDir, 'repo2')
    execFileSync('git', ['init', repoPath2], { encoding: 'utf8' })
    execFileSync('git', ['config', 'user.name', 'Forge Tester'], { cwd: repoPath2 })
    execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: repoPath2 })
    execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoPath2 })
    writeFileSync(join(repoPath2, 'README.md'), '# Repo 2\n')
    execFileSync('git', ['add', '.'], { cwd: repoPath2 })
    execFileSync('git', ['commit', '-m', 'initial commit'], { cwd: repoPath2 })

    const projectView2 = await core.projects.create({
      name: 'Second Project',
      repositoryPath: repoPath2,
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: [],
      rules: [],
    })
    const projectId2 = projectIdSchema.parse(projectView2.id)
    const runId2 = runIdSchema.parse(randomUUID())
    const taskId2 = taskIdSchema.parse(randomUUID())

    core.runs.createRun({
      id: runId2,
      projectId: projectId2,
      taskId: taskId2,
      type: 'direct-task',
      status: 'failed',
      startedAt: new Date(Date.now() - 2000).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 1,
      summary: 'Task 2 failed',
      error: 'Build failed',
      metadata: { task: 'Second task' },
    })

    await core.close()

    // 1. List runs with project scope resolution (Fix 1)
    // Running against registered repoPath only lists runId
    const scopedLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg: string) => {
      scopedLogs.push(msg)
    })

    const scopedCode = await runCli(['runs', '--cwd', repoPath, '--data-dir', dataDir, '--json'])
    expect(scopedCode).toBe(0)
    const scopedParsed = JSON.parse(scopedLogs[scopedLogs.length - 1] ?? '{}') as {
      runs: { id: string }[]
    }
    expect(scopedParsed.runs.length).toBe(1)
    expect(scopedParsed.runs[0]?.id).toBe(runId)

    // Running against registered repoPath2 only lists runId2
    const scopedCode2 = await runCli(['runs', '--cwd', repoPath2, '--data-dir', dataDir, '--json'])
    expect(scopedCode2).toBe(0)
    const scopedParsed2 = JSON.parse(scopedLogs[scopedLogs.length - 1] ?? '{}') as {
      runs: { id: string }[]
    }
    expect(scopedParsed2.runs.length).toBe(1)
    expect(scopedParsed2.runs[0]?.id).toBe(runId2)

    // Running with --all lists runs from both projects
    const allCode = await runCli(['runs', 'list', '--data-dir', dataDir, '--all', '--json'])
    expect(allCode).toBe(0)
    const allParsed = JSON.parse(scopedLogs[scopedLogs.length - 1] ?? '{}') as {
      runs: { id: string }[]
    }
    expect(allParsed.runs.length).toBe(2)

    // Status filtering works with --all
    const filterStatusCode = await runCli([
      'runs',
      '--data-dir',
      dataDir,
      '--all',
      '--status',
      'completed',
      '--json',
    ])
    expect(filterStatusCode).toBe(0)
    const statusParsed = JSON.parse(scopedLogs[scopedLogs.length - 1] ?? '{}') as {
      runs: { id: string; status: string }[]
    }
    expect(statusParsed.runs.every((r) => r.status === 'completed')).toBe(true)

    // Limit filtering works with --all
    const limitCode = await runCli([
      'runs',
      '--data-dir',
      dataDir,
      '--all',
      '--limit',
      '1',
      '--json',
    ])
    expect(limitCode).toBe(0)
    const limitParsed = JSON.parse(scopedLogs[scopedLogs.length - 1] ?? '{}') as {
      runs: { id: string }[]
    }
    expect(limitParsed.runs.length).toBe(1)

    // Plain text list runs also succeeds
    const listTextCode = await runCli(['runs', '--cwd', repoPath, '--data-dir', dataDir])
    expect(listTextCode).toBe(0)

    // 2. Inspect run with ID boundary validation (Fix 2 & Fix 3)
    const inspectCode = await runCli(['runs', 'inspect', runId, '--data-dir', dataDir])
    expect(inspectCode).toBe(0)

    const inspectJsonCode = await runCli([
      'runs',
      'inspect',
      runId,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(inspectJsonCode).toBe(0)
    const inspectParsed = JSON.parse(scopedLogs[scopedLogs.length - 1] ?? '{}') as {
      run: { id: string }
      steps: unknown[]
      artifacts: unknown[]
    }
    expect(inspectParsed.run.id).toBe(runId)
    expect(inspectParsed.steps.length).toBe(1)
    expect(inspectParsed.artifacts.length).toBe(1)

    // Malformed UUID at CLI boundary
    const malformedRunLogs: string[] = []
    const consoleError = vi.spyOn(console, 'error').mockImplementation((msg: string) => {
      malformedRunLogs.push(msg)
    })

    const inspectMalformed = await runCli(['runs', 'inspect', 'not-a-uuid', '--data-dir', dataDir])
    expect(inspectMalformed).toBe(1)
    expect(malformedRunLogs.some((l) => l.includes('Expected a valid UUID'))).toBe(true)

    // Non-existent valid UUID
    const nonExistentRunId = randomUUID()
    const inspectNotFound = await runCli([
      'runs',
      'inspect',
      nonExistentRunId,
      '--data-dir',
      dataDir,
    ])
    expect(inspectNotFound).toBe(1)
    expect(malformedRunLogs.some((l) => l.includes(`Run "${nonExistentRunId}" not found`))).toBe(
      true,
    )

    // 3. Events with ID boundary validation (Fix 2 & Fix 3)
    const eventsCode = await runCli(['runs', 'events', runId, '--data-dir', dataDir])
    expect(eventsCode).toBe(0)

    const eventsJsonCode = await runCli([
      'runs',
      'events',
      runId,
      '--from',
      '1',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(eventsJsonCode).toBe(0)
    const eventsParsed = JSON.parse(scopedLogs[scopedLogs.length - 1] ?? '{}') as {
      events: { seq: number; type: string }[]
    }
    expect(eventsParsed.events.length).toBeGreaterThan(0)

    const eventsMalformed = await runCli(['runs', 'events', 'not-a-uuid', '--data-dir', dataDir])
    expect(eventsMalformed).toBe(1)
    expect(malformedRunLogs.some((l) => l.includes('Expected a valid UUID'))).toBe(true)

    // 4. Artifacts list with ID boundary validation (Fix 2 & Fix 3)
    const artListCode = await runCli(['artifacts', 'list', runId, '--data-dir', dataDir])
    expect(artListCode).toBe(0)

    const artListJsonCode = await runCli(['artifacts', runId, '--data-dir', dataDir, '--json'])
    expect(artListJsonCode).toBe(0)
    const artListParsed = JSON.parse(scopedLogs[scopedLogs.length - 1] ?? '{}') as {
      artifacts: { id: string; name: string }[]
    }
    expect(artListParsed.artifacts.length).toBe(1)
    expect(artListParsed.artifacts[0]?.id).toBe(artifact.id)

    const artListMalformed = await runCli([
      'artifacts',
      'list',
      'not-a-uuid',
      '--data-dir',
      dataDir,
    ])
    expect(artListMalformed).toBe(1)
    expect(malformedRunLogs.some((l) => l.includes('Expected a valid UUID'))).toBe(true)

    // 5. Artifacts cat with ID boundary validation (Fix 2 & Fix 3)
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const catCode = await runCli(['artifacts', 'cat', artifact.id, '--data-dir', dataDir])
    expect(catCode).toBe(0)
    expect(stdoutWrite).toHaveBeenCalled()

    const catJsonCode = await runCli([
      'artifacts',
      'cat',
      artifact.id,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(catJsonCode).toBe(0)
    const catParsed = JSON.parse(scopedLogs[scopedLogs.length - 1] ?? '{}') as {
      artifactId: string
      sizeBytes: number
      data: string
    }
    expect(catParsed.artifactId).toBe(artifact.id)
    expect(catParsed.data).toBe('Hello Forge artifact verification')

    const catWindowCode = await runCli([
      'artifacts',
      'cat',
      artifact.id,
      '--offset',
      '0',
      '--length',
      '5',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(catWindowCode).toBe(0)
    const catWindowParsed = JSON.parse(scopedLogs[scopedLogs.length - 1] ?? '{}') as {
      artifactId: string
      offset: number
      length: number
      totalBytes: number
      data: string
    }
    expect(catWindowParsed.artifactId).toBe(artifact.id)
    expect(catWindowParsed.offset).toBe(0)
    expect(catWindowParsed.length).toBe(5)
    expect(catWindowParsed.data).toBe('Hello')

    // 5b. Binary artifact cat with byte preservation and safe TTY handling
    const nonUtf8Bytes = Buffer.from([
      0x00, 0xff, 0xfe, 0x80, 0xc0, 0xc1, 0xed, 0xa0, 0x80, 0xf4, 0x90, 0x80, 0x80,
    ])
    const helperCore = createForgeCore({ dataDir })
    const binaryArtifact = await helperCore.artifacts.writeArtifact({
      runId,
      kind: 'tool-output',
      name: 'spill.bin',
      content: nonUtf8Bytes,
      mimeType: 'application/octet-stream',
    })
    await helperCore.close()

    // Prove naive UTF-8 alters the raw bytes
    const naiveDecoded = nonUtf8Bytes.toString('utf-8')
    const naiveReencoded = Buffer.from(naiveDecoded, 'utf-8')
    expect(naiveReencoded.equals(nonUtf8Bytes)).toBe(false)
    expect(naiveDecoded).toContain('\uFFFD')

    // Read full binary artifact via --json (base64 encoded)
    const binCatJsonCode = await runCli([
      'artifacts',
      'cat',
      binaryArtifact.id,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(binCatJsonCode).toBe(0)
    const binCatParsed = JSON.parse(scopedLogs[scopedLogs.length - 1] ?? '{}') as {
      artifactId: string
      sizeBytes: number
      encoding: string
      data: string
    }
    expect(binCatParsed.artifactId).toBe(binaryArtifact.id)
    expect(binCatParsed.encoding).toBe('base64')
    expect(Buffer.from(binCatParsed.data, 'base64').equals(nonUtf8Bytes)).toBe(true)

    // Read windowed binary artifact via --json
    const binCatWindowCode = await runCli([
      'artifacts',
      'cat',
      binaryArtifact.id,
      '--offset',
      '2',
      '--length',
      '6',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(binCatWindowCode).toBe(0)
    const binCatWindowParsed = JSON.parse(scopedLogs[scopedLogs.length - 1] ?? '{}') as {
      artifactId: string
      offset: number
      length: number
      totalBytes: number
      encoding: string
      data: string
    }
    expect(binCatWindowParsed.artifactId).toBe(binaryArtifact.id)
    expect(binCatWindowParsed.offset).toBe(2)
    expect(binCatWindowParsed.length).toBe(6)
    expect(binCatWindowParsed.encoding).toBe('base64')
    expect(Buffer.from(binCatWindowParsed.data, 'base64').equals(nonUtf8Bytes.subarray(2, 8))).toBe(
      true,
    )

    // Streaming non-TTY (piped) preserves exact raw bytes
    stdoutWrite.mockClear()
    const binPipedCode = await runCli([
      'artifacts',
      'cat',
      binaryArtifact.id,
      '--data-dir',
      dataDir,
    ])
    expect(binPipedCode).toBe(0)
    expect(stdoutWrite).toHaveBeenCalledWith(nonUtf8Bytes)

    // TTY mode suppresses raw binary and emits safe warning to stderr
    stdoutWrite.mockClear()
    const origIsTTY = process.stdout.isTTY
    try {
      process.stdout.isTTY = true
      const binTtyCode = await runCli([
        'artifacts',
        'cat',
        binaryArtifact.id,
        '--data-dir',
        dataDir,
      ])
      expect(binTtyCode).toBe(0)
      expect(stdoutWrite).not.toHaveBeenCalled()
      expect(malformedRunLogs.some((l) => l.includes('Binary artifact detected'))).toBe(true)
    } finally {
      process.stdout.isTTY = origIsTTY
    }

    // Malformed artifact ID
    const catMalformed = await runCli(['artifacts', 'cat', 'not-a-uuid', '--data-dir', dataDir])
    expect(catMalformed).toBe(1)
    expect(malformedRunLogs.some((l) => l.includes('Expected a valid UUID'))).toBe(true)

    // Non-existent valid UUID
    const nonExistentArtId = randomUUID()
    const catNotFound = await runCli(['artifacts', 'cat', nonExistentArtId, '--data-dir', dataDir])
    expect(catNotFound).toBe(1)
    expect(
      malformedRunLogs.some((l) => l.includes(`Artifact "${nonExistentArtId}" not found`)),
    ).toBe(true)

    stdoutWrite.mockRestore()
    consoleError.mockRestore()
    consoleLog.mockRestore()
  })

  it('lists and inspects workflows in json and text mode (CLI-006)', async () => {
    const core = createForgeCore({ dataDir })
    const project = await core.projects.create({
      name: 'Workflow CLI Project',
      repositoryPath: repoPath,
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: ['ts'],
      rules: [],
    })
    const started = await core.workflows.start({
      projectId: project.id,
      objective: 'Verify workflows cli command',
      autoRun: false,
    })
    await core.close()

    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    // List workflows in json mode
    const listJsonCode = await runCli([
      'workflows',
      'list',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(listJsonCode).toBe(0)
    const parsedList = JSON.parse(consoleLogs[0] ?? '{}') as { workflows: { id: string }[] }
    expect(parsedList.workflows).toHaveLength(1)
    expect(parsedList.workflows[0]?.id).toBe(started.id)

    consoleLogs.length = 0

    // Inspect workflow in json mode
    const inspectJsonCode = await runCli([
      'workflows',
      'inspect',
      started.id,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(inspectJsonCode).toBe(0)
    const parsedInspect = JSON.parse(consoleLogs[0] ?? '{}') as { id: string; templateId: string }
    expect(parsedInspect.id).toBe(started.id)

    consoleLogs.length = 0

    // Inspect in human-readable mode
    const inspectTextCode = await runCli([
      'workflows',
      'inspect',
      started.id,
      '--data-dir',
      dataDir,
    ])
    expect(inspectTextCode).toBe(0)
    expect(consoleLogs.some((l) => l.includes(started.id))).toBe(true)

    consoleLog.mockRestore()
  })

  it('manages workflow lifecycle via run, cancel, and approve subcommands (WORK-007)', async () => {
    const core = createForgeCore({ dataDir })
    const project = await core.projects.create({
      name: 'Lifecycle Project',
      repositoryPath: repoPath,
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: ['ts'],
      rules: [],
    })
    const started = await core.workflows.start({
      projectId: project.id,
      objective: 'Verify lifecycle subcommands',
      autoRun: false,
    })
    await core.close()

    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    // 1. Cancel workflow via CLI
    const cancelCode = await runCli([
      'workflows',
      'cancel',
      started.id,
      '--data-dir',
      dataDir,
      '--reason',
      'User requested cancellation',
      '--json',
    ])
    expect(cancelCode).toBe(0)
    const cancelRes = JSON.parse(consoleLogs[0] ?? '{}') as {
      ok: boolean
      cancelled: boolean
      state: string
    }
    expect(cancelRes.ok).toBe(true)
    expect(cancelRes.cancelled).toBe(true)
    expect(cancelRes.state).toBe('CANCELLED')

    consoleLogs.length = 0

    // 2. Running a cancelled workflow fails closed
    const runCancelledCode = await runCli([
      'workflows',
      'run',
      started.id,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(runCancelledCode).toBe(1)

    consoleLogs.length = 0

    // 3. Start a second workflow to test run/resume
    const core2 = createForgeCore({ dataDir })
    const wf2 = await core2.workflows.start({
      projectId: project.id,
      objective: 'Second workflow',
      autoRun: false,
    })
    await core2.close()

    const runCode = await runCli(['workflows', 'run', wf2.id, '--data-dir', dataDir, '--json'])
    expect(runCode).toBe(0)
    const runRes = JSON.parse(consoleLogs[0] ?? '{}') as { ok: boolean; workflowId: string }
    expect(runRes.ok).toBe(true)
    expect(runRes.workflowId).toBe(wf2.id)

    consoleLog.mockRestore()
  })

  it('initializes a workflow via forge workflows init (WORK-008)', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    const code = await runCli([
      'workflows',
      'init',
      '--project',
      repoPath,
      '--template',
      'bugfix',
      '--objective',
      'Fix parser edge-case',
      '--data-dir',
      dataDir,
      '--json',
    ])

    expect(code).toBe(0)
    const res = JSON.parse(consoleLogs[0] ?? '{}') as {
      ok: boolean
      workflowId: string
      templateId: string
      objective: string
      autoRun: boolean
    }
    expect(res.ok).toBe(true)
    expect(res.templateId).toBe('bugfix')
    expect(res.objective).toBe('Fix parser edge-case')
    expect(res.autoRun).toBe(false)
    expect(res.workflowId).toBeDefined()

    consoleLog.mockRestore()
  })

  it('searches artifact content via forge artifacts grep (ARTIFACT-002)', async () => {
    const core = createForgeCore({ dataDir })
    const project = await core.projects.create({
      name: 'Grep Project',
      repositoryPath: repoPath,
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: [],
      rules: [],
    })
    const projectId = projectIdSchema.parse(project.id)
    const runId = runIdSchema.parse(randomUUID())
    const taskId = taskIdSchema.parse(randomUUID())

    core.runs.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'completed',
      startedAt: new Date(Date.now() - 2000).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: 'Sample task for grep test',
      error: null,
      metadata: { task: 'Sample task for grep test' },
    })

    await core.artifacts.writeArtifact({
      runId,
      name: 'execution.log',
      kind: 'stdout',
      content:
        '2026-11-18 10:00:00 INFO: Starting task execution\n2026-11-18 10:00:05 CRITICAL: Network connection timeout\n2026-11-18 10:00:06 INFO: Retrying connection\n',
    })
    await core.close()

    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    // Search case-insensitively for "timeout"
    const code = await runCli([
      'artifacts',
      'grep',
      runId,
      'TIMEOUT',
      '--data-dir',
      dataDir,
      '-i',
      '--json',
    ])

    expect(code).toBe(0)
    const res = JSON.parse(consoleLogs[0] ?? '{}') as {
      runId: string
      pattern: string
      matchCount: number
      matches: { line: number; content: string; artifactName: string }[]
    }

    expect(res.runId).toBe(runId)
    expect(res.matchCount).toBe(1)
    expect(res.matches[0]?.line).toBe(2)
    expect(res.matches[0]?.content).toContain('CRITICAL: Network connection timeout')
    expect(res.matches[0]?.artifactName).toBe('execution.log')

    consoleLog.mockRestore()
  })

  it('inspects registered runtimes and health via forge runtimes list (RUNTIME-001)', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    const code = await runCli(['runtimes', 'list', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)

    const res = JSON.parse(consoleLogs[0] ?? '{}') as {
      runtimes: {
        id: string
        health: string
        capabilities: string[]
        label: { name: string } | null
      }[]
    }

    expect(Array.isArray(res.runtimes)).toBe(true)
    expect(res.runtimes.length).toBeGreaterThan(0)
    const native = res.runtimes.find((r) => r.id === 'forge-native-agent')
    expect(native).toBeDefined()
    expect(native?.health).toBe('healthy')

    consoleLog.mockRestore()
  })

  it('inspects and updates user configuration via forge config (CONFIG-002)', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    // 1. Initial list
    const listCode = await runCli(['config', 'list', '--cwd', repoPath, '--json'])
    expect(listCode).toBe(0)

    // 2. Set key
    const setCode = await runCli([
      'config',
      'set',
      'logLevel',
      'debug',
      '--cwd',
      repoPath,
      '--json',
    ])
    expect(setCode).toBe(0)

    consoleLogs.length = 0

    // 3. Get key
    const getCode = await runCli(['config', 'get', 'logLevel', '--cwd', repoPath, '--json'])
    expect(getCode).toBe(0)
    const getRes = JSON.parse(consoleLogs[0] ?? '{}') as { key: string; value: string }
    expect(getRes.key).toBe('logLevel')
    expect(getRes.value).toBe('debug')

    consoleLog.mockRestore()
  })

  it('inspects database statistics and executes vacuum via forge db (STATE-002)', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    // 1. Database stats
    const statsCode = await runCli(['db', 'stats', '--data-dir', dataDir, '--json'])
    expect(statsCode).toBe(0)
    const statsRes = JSON.parse(consoleLogs[0] ?? '{}') as {
      dbFile: string
      stats: { pageCount: number; tables: { tableName: string }[] }
    }
    expect(statsRes.stats.pageCount).toBeGreaterThan(0)
    expect(statsRes.stats.tables.map((t) => t.tableName)).toContain('projects')

    consoleLogs.length = 0

    // 2. Database vacuum
    const vacuumCode = await runCli(['db', 'vacuum', '--data-dir', dataDir, '--json'])
    expect(vacuumCode).toBe(0)
    const vacuumRes = JSON.parse(consoleLogs[0] ?? '{}') as {
      dbFile: string
      result: { durationMs: number; reclaimedBytes: number }
    }
    expect(vacuumRes.result.durationMs).toBeGreaterThanOrEqual(0)

    consoleLog.mockRestore()
  })

  it('validates workflow DAG topologies via forge workflows validate (WORK-009)', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    // 1. Validate all default templates in JSON mode
    const validateAllCode = await runCli(['workflows', 'validate', '--data-dir', dataDir, '--json'])
    expect(validateAllCode).toBe(0)

    const res = JSON.parse(consoleLogs[0] ?? '{}') as {
      validations: {
        templateId: string
        name: string
        result: { valid: boolean; metrics: { nodeCount: number; edgeCount: number } }
      }[]
    }
    expect(Array.isArray(res.validations)).toBe(true)
    expect(res.validations.length).toBeGreaterThan(0)
    expect(res.validations.every((v) => v.result.valid)).toBe(true)

    consoleLogs.length = 0

    // 2. Validate a specific known template
    const validateFeatureCode = await runCli([
      'workflows',
      'validate',
      'feature',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(validateFeatureCode).toBe(0)
    const featureRes = JSON.parse(consoleLogs[0] ?? '{}') as {
      validations: { templateId: string; result: { valid: boolean } }[]
    }
    expect(featureRes.validations[0]?.templateId).toBe('compiled-feature')
    expect(featureRes.validations[0]?.result.valid).toBe(true)

    consoleLog.mockRestore()
  })

  it('inspects compiled prompt context packets via forge context inspect (PROMPT-002)', async () => {
    const core = createForgeCore({ dataDir })
    const project = await core.projects.create({
      name: 'Context Test Project',
      repositoryPath: repoPath,
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: ['ts'],
      rules: [],
    })
    const runId = runIdSchema.parse(randomUUID())
    const stepId = stepIdSchema.parse(randomUUID())
    const projectId = projectIdSchema.parse(project.id)
    const taskId = taskIdSchema.parse(randomUUID())

    core.runs.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'completed',
      startedAt: new Date(Date.now() - 2000).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: 'Context packet inspection test',
      error: null,
      metadata: { task: 'Context packet inspection test' },
    })

    await core.artifacts.writeArtifact({
      runId,
      stepId,
      kind: 'prompt-packet',
      name: 'prompt-packet.json',
      content: JSON.stringify({
        objective: 'Test prompt packet inspection',
        systemPrompt: 'You are Forge test assistant.',
        contextFiles: ['src/main.ts', 'src/cli.ts'],
      }),
      mimeType: 'application/json',
    })
    await core.close()

    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    const inspectCode = await runCli(['context', 'inspect', runId, '--data-dir', dataDir, '--json'])
    expect(inspectCode).toBe(0)

    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as {
      runId: string
      stepId: string
      packet: { objective: string; contextFiles: string[] }
    }
    expect(parsed.runId).toBe(runId)
    expect(parsed.stepId).toBe(stepId)
    expect(parsed.packet.objective).toBe('Test prompt packet inspection')
    expect(parsed.packet.contextFiles).toEqual(['src/main.ts', 'src/cli.ts'])

    consoleLog.mockRestore()
  })

  it('tests runtime execution and latency via forge runtimes test (RUNTIME-002)', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    const testCode = await runCli([
      'runtimes',
      'test',
      'forge-native-agent',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(testCode).toBe(0)

    const res = JSON.parse(consoleLogs[0] ?? '{}') as {
      success: boolean
      runtimeId: string
      executable: string | null
      durationMs: number
    }
    expect(res.success).toBe(true)
    expect(res.runtimeId).toBe('forge-native-agent')
    expect(res.executable).toBeNull()

    consoleLog.mockRestore()
  })

  it('plans workflow execution DAG via forge workflows plan (WORK-010)', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    const planCode = await runCli(['workflows', 'plan', 'feature', '--json'])
    expect(planCode).toBe(0)

    const plan = JSON.parse(consoleLogs[0] ?? '{}') as {
      valid: boolean
      templateId: string
      stageCount: number
      asciiDiagram: string
    }
    expect(plan.valid).toBe(true)
    expect(plan.templateId).toBe('compiled-feature')
    expect(plan.stageCount).toBe(5)
    expect(plan.asciiDiagram).toContain('Workflow Execution Plan: compiled-feature')

    consoleLog.mockRestore()
  })

  it('inspects physical changeset diff via forge diff (DIFF-001)', async () => {
    const core = createForgeCore({ dataDir })
    const runId = runIdSchema.parse(randomUUID())
    const stepId = stepIdSchema.parse(randomUUID())
    const project = await core.projects.create({
      name: 'Diff Test Project',
      repositoryPath: repoPath,
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: ['ts'],
      rules: [],
    })
    const projectId = projectIdSchema.parse(project.id)
    const taskId = taskIdSchema.parse(randomUUID())

    core.runs.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'completed',
      startedAt: new Date(Date.now() - 2000).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: 'Diff inspection test',
      error: null,
      metadata: { task: 'Diff inspection test' },
    })

    const samplePatch = `
diff --git a/file.txt b/file.txt
new file mode 100644
--- /dev/null
+++ b/file.txt
@@ -0,0 +1,2 @@
+line 1
+line 2
`.trim()

    await core.artifacts.writeArtifact({
      runId,
      stepId,
      kind: 'changeset',
      name: 'changes.patch',
      content: samplePatch,
      mimeType: 'text/x-diff',
    })
    await core.close()

    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    const diffCode = await runCli(['diff', runId, '--data-dir', dataDir, '--json'])
    expect(diffCode).toBe(0)

    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as {
      valid: boolean
      runId: string
      totalFiles: number
      totalAdditions: number
      files: { path: string; status: string }[]
    }
    expect(parsed.valid).toBe(true)
    expect(parsed.runId).toBe(runId)
    expect(parsed.totalFiles).toBe(1)
    expect(parsed.totalAdditions).toBe(2)
    expect(parsed.files[0]?.path).toBe('file.txt')

    consoleLog.mockRestore()
  })

  it('verifies artifact checksums and integrity via forge artifacts verify (VERIFY-004)', async () => {
    const core = createForgeCore({ dataDir })
    const runId = runIdSchema.parse(randomUUID())
    const project = await core.projects.create({
      name: 'Verify Test Project',
      repositoryPath: repoPath,
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: ['ts'],
      rules: [],
    })
    const projectId = projectIdSchema.parse(project.id)
    const taskId = taskIdSchema.parse(randomUUID())

    core.runs.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'completed',
      startedAt: new Date(Date.now() - 2000).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: 'Checksum audit test',
      error: null,
      metadata: { task: 'Checksum audit test' },
    })

    await core.artifacts.writeArtifact({
      runId,
      kind: 'diff',
      name: 'audit.patch',
      content: 'genuine physical content',
      mimeType: 'text/plain',
    })
    await core.close()

    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    const verifyCode = await runCli(['artifacts', 'verify', runId, '--data-dir', dataDir, '--json'])
    expect(verifyCode).toBe(0)

    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as {
      valid: boolean
      verifiedCount: number
      tamperedCount: number
      missingCount: number
    }
    expect(parsed.valid).toBe(true)
    expect(parsed.verifiedCount).toBe(1)
    expect(parsed.tamperedCount).toBe(0)

    consoleLog.mockRestore()
  })

  it('lists background process metrics via forge processes list (PROCESS-003)', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    const procCode = await runCli(['processes', 'list', '--data-dir', dataDir, '--json'])
    expect(procCode).toBe(0)

    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as {
      processes: unknown[]
    }
    expect(Array.isArray(parsed.processes)).toBe(true)

    consoleLog.mockRestore()
  })

  it('manages configuration profiles via forge config profile (CONFIG-002)', async () => {
    const configContent = JSON.stringify(
      {
        activeProfile: 'staging',
        profiles: {
          dev: { logLevel: 'debug' },
          staging: { logLevel: 'info' },
          prod: { logLevel: 'warn' },
        },
      },
      null,
      2,
    )
    const configPath = join(repoPath, '.forgerc')
    writeFileSync(configPath, configContent, 'utf8')

    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg?: unknown) => {
      consoleLogs.push(String(msg))
    })

    // 1. List profiles
    const listCode = await runCli(['config', 'profile', 'list', '--cwd', repoPath, '--json'])
    expect(listCode).toBe(0)
    const listParsed = JSON.parse(consoleLogs[0] ?? '{}') as {
      activeProfile: string
      profiles: string[]
    }
    expect(listParsed.activeProfile).toBe('staging')
    expect(listParsed.profiles).toEqual(['dev', 'prod', 'staging'])

    consoleLogs.length = 0

    // 2. Switch profile
    const useCode = await runCli(['config', 'profile', 'use', 'prod', '--cwd', repoPath, '--json'])
    expect(useCode).toBe(0)
    const useParsed = JSON.parse(consoleLogs[0] ?? '{}') as {
      previousProfile: string
      newProfile: string
    }
    expect(useParsed.previousProfile).toBe('staging')
    expect(useParsed.newProfile).toBe('prod')

    consoleLogs.length = 0

    // 3. Show profile config
    const showCode = await runCli([
      'config',
      'profile',
      'show',
      'prod',
      '--cwd',
      repoPath,
      '--json',
    ])
    expect(showCode).toBe(0)
    const showParsed = JSON.parse(consoleLogs[0] ?? '{}') as {
      profile: string
      config: { logLevel: string }
    }
    expect(showParsed.profile).toBe('prod')
    expect(showParsed.config.logLevel).toBe('warn')

    consoleLog.mockRestore()
  })

  it('runs config doctor command and reports environment audit in json mode', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg) => {
      consoleLogs.push(String(msg))
    })

    const code = await runCli([
      'config',
      'doctor',
      '--data-dir',
      dataDir,
      '--cwd',
      repoPath,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as { healthy: boolean; checks: unknown[] }
    expect(parsed.healthy).toBe(true)
    expect(Array.isArray(parsed.checks)).toBe(true)

    consoleLog.mockRestore()
  })

  it('handles workflows profile command for non-existent run with exit code 1', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg) => {
      consoleLogs.push(String(msg))
    })

    const fakeRunId = randomUUID()
    const code = await runCli(['workflows', 'profile', fakeRunId, '--data-dir', dataDir, '--json'])
    expect(code).toBe(1)
    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as { valid: boolean; error: string }
    expect(parsed.valid).toBe(false)
    expect(parsed.error).toContain('Run not found')

    consoleLog.mockRestore()
  })

  it('handles diff revert command for non-existent run with exit code 1', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg) => {
      consoleLogs.push(String(msg))
    })

    const fakeRunId = randomUUID()
    const code = await runCli([
      'diff',
      'revert',
      fakeRunId,
      '--data-dir',
      dataDir,
      '--cwd',
      repoPath,
      '--json',
    ])
    expect(code).toBe(1)
    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as { success: boolean; error: string }
    expect(parsed.success).toBe(false)
    expect(parsed.error).toContain('No changeset or diff artifact found')

    consoleLog.mockRestore()
  })

  it('handles artifacts export command for non-existent run with exit code 1', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg) => {
      consoleLogs.push(String(msg))
    })

    const fakeRunId = randomUUID()
    const code = await runCli(['artifacts', 'export', fakeRunId, '--data-dir', dataDir, '--json'])
    expect(code).toBe(1)
    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as { valid: boolean; error: string }
    expect(parsed.valid).toBe(false)
    expect(parsed.error).toContain('Run not found')

    consoleLog.mockRestore()
  })

  it('handles verify pipeline command when pipeline config is missing or invalid', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg) => {
      consoleLogs.push(String(msg))
    })

    const code = await runCli([
      'verify',
      'pipeline',
      'non-existent-config.json',
      '--data-dir',
      dataDir,
      '--cwd',
      repoPath,
      '--json',
    ])
    expect(code).toBe(1)
    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as { error: string }
    expect(parsed.error).toContain('Failed to read pipeline configuration file')

    consoleLog.mockRestore()
  })

  it('lists custom workflow templates with forge workflows templates --json (WORK-012)', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg) => {
      consoleLogs.push(String(msg))
    })

    const code = await runCli([
      'workflows',
      'templates',
      '--data-dir',
      dataDir,
      '--cwd',
      repoPath,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as { templates: unknown[]; errors: unknown[] }
    expect(Array.isArray(parsed.templates)).toBe(true)
    expect(Array.isArray(parsed.errors)).toBe(true)

    consoleLog.mockRestore()
  })

  it('inspects sanitized child process environment with forge runtimes env --json (RUNTIME-004)', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg) => {
      consoleLogs.push(String(msg))
    })

    const code = await runCli(['runtimes', 'env', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as {
      mode: string
      env: Record<string, string>
      withheldKeys: string[]
    }
    expect(parsed.mode).toBe('strict')
    expect(parsed.env).toBeDefined()
    expect(Array.isArray(parsed.withheldKeys)).toBe(true)

    consoleLog.mockRestore()
  })

  it('fails closed when calculating cost for non-existent run with forge runs cost (AGENT-005)', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg) => {
      consoleLogs.push(String(msg))
    })

    const fakeRunId = randomUUID()
    const code = await runCli(['runs', 'cost', fakeRunId, '--data-dir', dataDir, '--json'])
    expect(code).toBe(1)
    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as { valid: boolean; error: string }
    expect(parsed.valid).toBe(false)
    expect(parsed.error).toContain('Run not found')

    consoleLog.mockRestore()
  })

  it('reports clean audit when no changeset exists with forge diff security (EVIDENCE-002)', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg) => {
      consoleLogs.push(String(msg))
    })

    const fakeRunId = randomUUID()
    const code = await runCli(['diff', 'security', fakeRunId, '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as {
      clean: boolean
      formattedSummary: string
    }
    expect(parsed.clean).toBe(true)
    expect(parsed.formattedSummary).toContain('No changeset or diff artifacts found')

    consoleLog.mockRestore()
  })

  it('fails closed with invalid runId on forge diff security (EVIDENCE-002)', async () => {
    const consoleLogs: string[] = []
    const consoleLog = vi.spyOn(console, 'log').mockImplementation((msg) => {
      consoleLogs.push(String(msg))
    })

    const code = await runCli(['diff', 'security', 'invalid-uuid', '--data-dir', dataDir, '--json'])
    expect(code).toBe(1)
    const parsed = JSON.parse(consoleLogs[0] ?? '{}') as { error: string }
    expect(parsed.error).toContain('Invalid run ID')

    consoleLog.mockRestore()
  })

  it('executes database backup and restore with forge db backup and restore (STATE-003)', async () => {
    // 1. Initialize core to ensure forge.db exists
    const core = createForgeCore({ dataDir })
    await core.close()

    const backupFile = join(tempDir, 'snapshot.db')
    const backupLogs: string[] = []
    const logSpy1 = vi.spyOn(console, 'log').mockImplementation((msg) => {
      backupLogs.push(String(msg))
    })

    const backupCode = await runCli(['db', 'backup', backupFile, '--data-dir', dataDir, '--json'])
    expect(backupCode).toBe(0)
    const backupParsed = JSON.parse(backupLogs[0] ?? '{}') as { valid: boolean; sha256: string }
    expect(backupParsed.valid).toBe(true)
    expect(backupParsed.sha256).toBeDefined()
    logSpy1.mockRestore()

    // 2. Restore from snapshot
    const restoreLogs: string[] = []
    const logSpy2 = vi.spyOn(console, 'log').mockImplementation((msg) => {
      restoreLogs.push(String(msg))
    })

    const restoreCode = await runCli([
      'db',
      'restore',
      backupFile,
      '--force',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(restoreCode).toBe(0)
    const restoreParsed = JSON.parse(restoreLogs[0] ?? '{}') as { success: boolean; sha256: string }
    expect(restoreParsed.success).toBe(true)
    logSpy2.mockRestore()
  })

  it('plans parallel node execution with forge workflows parallel --json (WORK-013)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['workflows', 'parallel', 'feature', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as { valid: boolean; totalBatches: number }
    expect(parsed.valid).toBe(true)
    expect(parsed.totalBatches).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('manages encrypted secret vault with forge config vault [set|get|list] --json (CONFIG-004)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const setCode = await runCli([
      'config',
      'vault',
      'set',
      'OPENAI_API_KEY',
      'sk-test-secret-12345',
      '--passphrase',
      'test-passphrase',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(setCode).toBe(0)

    logs.length = 0
    const getCode = await runCli([
      'config',
      'vault',
      'get',
      'OPENAI_API_KEY',
      '--passphrase',
      'test-passphrase',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(getCode).toBe(0)
    const getParsed = JSON.parse(logs[0] ?? '{}') as { key: string; value: string }
    expect(getParsed.key).toBe('OPENAI_API_KEY')
    expect(getParsed.value).toBe('sk-test-secret-12345')

    logs.length = 0
    const listCode = await runCli([
      'config',
      'vault',
      'list',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(listCode).toBe(0)
    const listParsed = JSON.parse(logs[0] ?? '{}') as {
      secretCount: number
      secrets: { key: string }[]
    }
    expect(listParsed.secretCount).toBe(1)
    expect(listParsed.secrets.map((s) => s.key)).toContain('OPENAI_API_KEY')

    logSpy.mockRestore()
  })

  it('compacts run event ledger with forge db compact --dry-run --json (STATE-004)', async () => {
    const core = createForgeCore({ dataDir })
    await core.close()

    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['db', 'compact', '--dry-run', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as { valid: boolean; dryRun: boolean }
    expect(parsed.valid).toBe(true)
    expect(parsed.dryRun).toBe(true)

    logSpy.mockRestore()
  })

  it('handles diff commit synthesis error on missing run or diffs with forge diff commit --json (DIFF-003)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const fakeRunId = randomUUID()
    const code = await runCli(['diff', 'commit', fakeRunId, '--data-dir', dataDir, '--json'])
    expect(code).toBe(1)
    const parsed = JSON.parse(logs[0] ?? '{}') as { error: string }
    expect(parsed.error).toContain('No changeset or diff artifacts found')

    logSpy.mockRestore()
  })

  it('optimizes prompt packet prefix caching with forge context optimize --json (AGENT-006)', async () => {
    const core = createForgeCore({ dataDir })
    const project = await core.projects.create({
      name: 'Optimize Test Project',
      repositoryPath: repoPath,
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: ['ts'],
      rules: [],
    })
    const runId = runIdSchema.parse(randomUUID())
    const stepId = stepIdSchema.parse(randomUUID())
    const projectId = projectIdSchema.parse(project.id)
    const taskId = taskIdSchema.parse(randomUUID())
    core.runs.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'completed',
      startedAt: new Date(Date.now() - 2000).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: 'Prompt packet optimization test',
      error: null,
      metadata: { task: 'test optimization' },
    })

    const packetContent = JSON.stringify({
      objective: 'Build caching feature',
      systemPrompt: 'You are Forge engine system instructions. Keep deterministic.',
      contextFiles: ['src/main/cli.ts'],
      turns: [
        { role: 'user', content: 'First message' },
        { role: 'assistant', content: 'First answer' },
      ],
    })

    await core.artifacts.writeArtifact({
      runId,
      stepId,
      kind: 'prompt-packet',
      name: 'prompt-packet.json',
      content: packetContent,
      mimeType: 'application/json',
    })
    await core.close()

    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['context', 'optimize', runId, '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      valid: boolean
      staticPrefixTokens: number
      cacheabilityRatio: number
    }
    expect(parsed.valid).toBe(true)
    expect(parsed.staticPrefixTokens).toBeGreaterThan(0)
    expect(parsed.cacheabilityRatio).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('inspects cross-run solution memory stats via CLI', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['memory', 'stats', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as { totalRuns: number; completedRuns: number }
    expect(parsed.totalRuns).toBeDefined()
    expect(parsed.completedRuns).toBeDefined()

    logSpy.mockRestore()
  })

  it('creates and lists workflow snapshots via CLI', async () => {
    const runId = runIdSchema.parse(randomUUID())
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const createCode = await runCli([
      'workflows',
      'snapshot',
      'create',
      runId,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(createCode).toBe(0)

    const listCode = await runCli([
      'workflows',
      'snapshot',
      'list',
      runId,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(listCode).toBe(0)
    const listResult = JSON.parse(logs[1] ?? '{}') as {
      totalSnapshots: number
      snapshots: unknown[]
    }
    expect(listResult.totalSnapshots).toBe(1)

    logSpy.mockRestore()
  })

  it('audits diff conflicts between runs via CLI', async () => {
    const runIdA = runIdSchema.parse(randomUUID())
    const runIdB = runIdSchema.parse(randomUUID())
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['diff', 'merge', runIdA, runIdB, '--data-dir', dataDir, '--json'])
    // Without conflicting diffs, returns 0 (clean / no conflicts)
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as { hasConflicts: boolean; totalFiles: number }
    expect(parsed.hasConflicts).toBe(false)

    logSpy.mockRestore()
  })

  it('inspects runtime resource quotas via CLI', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['runtimes', 'quota', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      valid: boolean
      budget: unknown
      memoryFlags: string[]
    }
    expect(parsed.valid).toBe(true)
    expect(parsed.budget).toBeDefined()
    expect(parsed.memoryFlags).toBeDefined()

    logSpy.mockRestore()
  })

  it('bootstraps workspace configuration via CLI', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['config', 'init', '--cwd', repoPath, '--force', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      valid: boolean
      created: boolean
      configPath: string
    }
    expect(parsed.valid).toBe(true)
    expect(parsed.created).toBe(true)

    logSpy.mockRestore()
  })

  it('inspects model fallback routes and circuit breakers via CLI (AGENT-008)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code1 = await runCli(['models', 'fallback', '--data-dir', dataDir, '--json'])
    expect(code1).toBe(0)
    const parsed1 = JSON.parse(logs[0] ?? '{}') as { fallbackConfig: unknown }
    expect(parsed1.fallbackConfig).toBeDefined()

    logs.length = 0
    const code2 = await runCli(['models', 'circuit', '--data-dir', dataDir, '--json'])
    expect(code2).toBe(0)
    const parsed2 = JSON.parse(logs[0] ?? '{}') as { circuits: unknown[] }
    expect(Array.isArray(parsed2.circuits)).toBe(true)

    logSpy.mockRestore()
  })

  it('inspects and purges workflow dead-letter queue via CLI (WORK-015)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const listCode = await runCli(['workflows', 'dlq', 'list', '--data-dir', dataDir, '--json'])
    expect(listCode).toBe(0)
    const listParsed = JSON.parse(logs[0] ?? '{}') as { valid: boolean; records: unknown[] }
    expect(listParsed.valid).toBe(true)
    expect(Array.isArray(listParsed.records)).toBe(true)

    logs.length = 0
    const purgeCode = await runCli(['workflows', 'dlq', 'purge', '--data-dir', dataDir, '--json'])
    expect(purgeCode).toBe(0)
    const purgeParsed = JSON.parse(logs[0] ?? '{}') as { purgedCount: number }
    expect(typeof purgeParsed.purgedCount).toBe('number')

    logSpy.mockRestore()
  })

  it('audits code coverage delta regression via CLI (EVIDENCE-003)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const coverageDir = join(repoPath, 'coverage')
    execFileSync('git', ['init'], { cwd: repoPath })
    const { mkdirSync } = await import('node:fs')
    mkdirSync(coverageDir, { recursive: true })
    writeFileSync(
      join(coverageDir, 'lcov.info'),
      'TN:\nSF:src/index.ts\nDA:1,1\nDA:2,1\nLF:2\nLH:2\nend_of_record\n',
    )

    const code = await runCli([
      'verify',
      'coverage',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      valid: boolean
      meetsThreshold: boolean
      overallModifiedCoveragePct: number
    }
    expect(parsed.valid).toBe(true)
    expect(parsed.meetsThreshold).toBe(true)
    expect(parsed.overallModifiedCoveragePct).toBe(100)

    logSpy.mockRestore()
  })

  it('inspects multi-project workspace registry and prunes missing projects via CLI (STATE-005)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const listCode = await runCli(['projects', 'list', '--data-dir', dataDir, '--json'])
    expect(listCode).toBe(0)
    const listParsed = JSON.parse(logs[0] ?? '{}') as {
      valid: boolean
      totalProjects: number
      projects: unknown[]
    }
    expect(listParsed.valid).toBe(true)
    expect(typeof listParsed.totalProjects).toBe('number')
    expect(Array.isArray(listParsed.projects)).toBe(true)

    logs.length = 0
    const pruneCode = await runCli(['projects', 'prune', '--data-dir', dataDir, '--json'])
    expect(pruneCode).toBe(0)
    const pruneParsed = JSON.parse(logs[0] ?? '{}') as {
      valid: boolean
      purgedCount?: number
      prunedCount?: number
    }
    expect(pruneParsed.valid).toBe(true)

    logSpy.mockRestore()
  })

  it('audits hierarchical configuration against administrative policies via CLI (CONFIG-006)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'config',
      'policy',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as { valid: boolean; violations: unknown[] }
    expect(parsed.valid).toBe(true)
    expect(Array.isArray(parsed.violations)).toBe(true)

    logSpy.mockRestore()
  })

  it('inspects tool rate limiter and throttler metrics via CLI (AGENT-009)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const codeJson = await runCli(['runtimes', 'rate-limit', '--data-dir', dataDir, '--json'])
    expect(codeJson).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      capacity: number
      refillRatePerSec: number
      maxConcurrency: number
      currentTokens: number
    }
    expect(parsed.capacity).toBe(60)
    expect(parsed.maxConcurrency).toBe(5)
    expect(parsed.refillRatePerSec).toBe(1)

    logs.length = 0
    const codeText = await runCli(['runtimes', 'rate-limit', '--data-dir', dataDir])
    expect(codeText).toBe(0)
    expect(logs.some((l) => l.includes('TOOL RATE LIMITER & THROTTLER METRICS'))).toBe(true)

    logSpy.mockRestore()
  })

  it('inspects workflow step timeout supervisor status via CLI (WORK-016)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const codeJson = await runCli(['workflows', 'timeout', '--data-dir', dataDir, '--json'])
    expect(codeJson).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      supervisorStatus: string
      activeLeases: unknown[]
      history: unknown[]
    }
    expect(parsed.supervisorStatus).toBe('active')
    expect(Array.isArray(parsed.activeLeases)).toBe(true)
    expect(Array.isArray(parsed.history)).toBe(true)

    logs.length = 0
    const codeText = await runCli(['workflows', 'timeout', '--data-dir', dataDir])
    expect(codeText).toBe(0)
    expect(logs.some((l) => l.includes('WORKFLOW STEP TIMEOUT SUPERVISOR'))).toBe(true)

    logSpy.mockRestore()
  })

  it('audits diff changesets for credential and secret leaks via CLI (EVIDENCE-004)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })
    const errLogs: string[] = []
    const errSpy = vi.spyOn(console, 'error').mockImplementation((msg) => {
      errLogs.push(String(msg))
    })

    // Missing run ID fails with code 1
    const missingCode = await runCli(['diff', 'secrets', '--data-dir', dataDir, '--json'])
    expect(missingCode).toBe(1)

    // Run ID with no artifacts returns valid clean result
    logs.length = 0
    const runId = randomUUID()
    const cleanCode = await runCli(['diff', 'secrets', runId, '--data-dir', dataDir, '--json'])
    expect(cleanCode).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      valid: boolean
      hasLeaks: boolean
      violations: unknown[]
    }
    expect(parsed.valid).toBe(true)
    expect(parsed.hasLeaks).toBe(false)

    logSpy.mockRestore()
    errSpy.mockRestore()
  })

  it('audits database integrity and prunes orphaned records via CLI (STATE-006)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    // Audit SQLite database
    const auditCode = await runCli(['db', 'audit', '--data-dir', dataDir, '--json'])
    expect(auditCode).toBe(0)
    const auditParsed = JSON.parse(logs[0] ?? '{}') as {
      valid: boolean
      integrityCheckPassed: boolean
      totalOrphans: number
    }
    expect(auditParsed.valid).toBe(true)
    expect(auditParsed.integrityCheckPassed).toBe(true)
    expect(auditParsed.totalOrphans).toBe(0)

    // Prune orphans with --fix
    logs.length = 0
    const fixCode = await runCli(['db', 'audit', '--fix', '--data-dir', dataDir, '--json'])
    expect(fixCode).toBe(0)
    const fixParsed = JSON.parse(logs[0] ?? '{}') as {
      valid: boolean
      totalPruned: number
    }
    expect(fixParsed.valid).toBe(true)
    expect(fixParsed.totalPruned).toBe(0)

    logSpy.mockRestore()
  })

  it('interpolates environment variables with default fallbacks via CLI (CONFIG-007)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'config',
      'interpolate',
      'http://${FORGE_CLI_TEST_HOST:-localhost}:${FORGE_CLI_TEST_PORT:-8080}/api',
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      success: boolean
      interpolated: string
    }
    expect(parsed.success).toBe(true)
    expect(parsed.interpolated).toBe('http://localhost:8080/api')

    logSpy.mockRestore()
  })

  it('inspects and clears tool idempotency cache via CLI (AGENT-010)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const statsCode = await runCli(['runtimes', 'cache', '--json'])
    expect(statsCode).toBe(0)
    const statsParsed = JSON.parse(logs[0] ?? '{}') as {
      size: number
      hits: number
      misses: number
    }
    expect(typeof statsParsed.size).toBe('number')
    expect(typeof statsParsed.hits).toBe('number')

    logs.length = 0
    const clearCode = await runCli(['runtimes', 'cache', 'clear', '--json'])
    expect(clearCode).toBe(0)
    const clearParsed = JSON.parse(logs[0] ?? '{}') as { cleared: boolean }
    expect(clearParsed.cleared).toBe(true)

    logSpy.mockRestore()
  })

  it('estimates workflow execution tokens and cost offline via CLI (WORK-017)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['workflows', 'estimate', 'cr-sdlc', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      valid: boolean
      totalNodes: number
      maxInputTokens: number
      maxEstimatedCostUsd: number
    }
    expect(parsed.valid).toBe(true)
    expect(parsed.totalNodes).toBeGreaterThan(0)
    expect(parsed.maxInputTokens).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('validates conventional commit messages via CLI (EVIDENCE-005)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    // Valid conventional commit
    const validCode = await runCli([
      'verify',
      'commit',
      'feat(core): implement tool idempotency cache (#296)',
      '--json',
    ])
    expect(validCode).toBe(0)
    const validParsed = JSON.parse(logs[0] ?? '{}') as {
      valid: boolean
      type: string
      scope: string
      isBreaking: boolean
    }
    expect(validParsed.valid).toBe(true)
    expect(validParsed.type).toBe('feat')
    expect(validParsed.scope).toBe('core')
    expect(validParsed.isBreaking).toBe(false)

    // Invalid commit message
    logs.length = 0
    const invalidCode = await runCli(['verify', 'commit', 'bad commit with no type', '--json'])
    expect(invalidCode).toBe(1)
    const invalidParsed = JSON.parse(logs[0] ?? '{}') as {
      valid: boolean
      errors: string[]
    }
    expect(invalidParsed.valid).toBe(false)
    expect(invalidParsed.errors.length).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('executes SQLite WAL checkpoint and monitors storage quota via CLI (STATE-007)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    // Run WAL checkpoint
    const checkpointCode = await runCli([
      'db',
      'checkpoint',
      '--force',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(checkpointCode).toBe(0)
    const checkpointParsed = JSON.parse(logs[0] ?? '{}') as {
      valid: boolean
      checkpointExecuted: boolean
    }
    expect(checkpointParsed.valid).toBe(true)
    expect(checkpointParsed.checkpointExecuted).toBe(true)

    // Check storage quota
    logs.length = 0
    const quotaCode = await runCli(['db', 'quota', '--data-dir', dataDir, '--json'])
    expect(quotaCode).toBe(0)
    const quotaParsed = JSON.parse(logs[0] ?? '{}') as {
      quotaExceeded: boolean
      totalStorageBytes: number
    }
    expect(quotaParsed.quotaExceeded).toBe(false)
    expect(quotaParsed.totalStorageBytes).toBeGreaterThanOrEqual(0)

    logSpy.mockRestore()
  })

  it('exports configuration with sensitive values masked via CLI (CONFIG-008)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'config',
      'export',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--safe',
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(typeof parsed).toBe('object')

    logSpy.mockRestore()
  })

  it('coerces tool parameters with schema via CLI (AGENT-011)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'runtimes',
      'coerce',
      'read_file',
      '{"path": 42, "encoding": "utf-8"}',
      '--schema',
      JSON.stringify({
        properties: {
          path: { type: 'string', required: true },
          encoding: { type: 'string' },
        },
      }),
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.toolName).toBe('read_file')
    expect(parsed.valid).toBe(true)
    expect(parsed.coercedParams).toBeDefined()
    const coerced = parsed.coercedParams as Record<string, unknown>
    expect(coerced.path).toBe('42')

    logSpy.mockRestore()
  })

  it('evaluates workflow condition expressions via CLI (WORK-018)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'workflows',
      'eval',
      'exitCode == 0',
      '--context',
      '{"exitCode": 0}',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.result).toBe(true)

    logSpy.mockRestore()
  })

  it('generates artifact merkle lineage tree via CLI (EVIDENCE-006)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const core = createForgeCore({ dataDir })
    const projectView = await core.projects.create({
      name: 'Merkle Test Project',
      repositoryPath: repoPath,
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: [],
      rules: [],
    })
    const projectId = projectIdSchema.parse(projectView.id)
    const taskId = taskIdSchema.parse(randomUUID())
    const runId = runIdSchema.parse(randomUUID())
    const stepId = stepIdSchema.parse(randomUUID())
    core.runs.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'completed',
      startedAt: new Date(Date.now() - 10000).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: 'merkle test run',
      error: null,
      metadata: {},
    })
    await core.artifacts.writeArtifact({
      runId,
      stepId,
      kind: 'stdout',
      name: 'merkle-test-output.txt',
      content: 'Merkle lineage test artifact content',
    })
    await core.close()

    const code = await runCli([
      'artifacts',
      'merkle',
      runId,
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.runId).toBe(runId)
    expect(typeof parsed.rootHash).toBe('string')
    expect(parsed.artifactCount).toBeGreaterThanOrEqual(1)

    logSpy.mockRestore()
  })

  it('exports event journal with hash chain via CLI (STATE-008)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const core = createForgeCore({ dataDir })
    const projectView = await core.projects.create({
      name: 'Journal Test Project',
      repositoryPath: repoPath,
      defaultBranch: 'master',
      buildCommand: null,
      testCommand: null,
      tech: [],
      rules: [],
    })
    const projectId = projectIdSchema.parse(projectView.id)
    const taskId = taskIdSchema.parse(randomUUID())
    const runId = runIdSchema.parse(randomUUID())
    core.runs.createRun({
      id: runId,
      projectId,
      taskId,
      type: 'direct-task',
      status: 'completed',
      startedAt: new Date(Date.now() - 10000).toISOString(),
      finishedAt: new Date().toISOString(),
      exitCode: 0,
      summary: 'journal test run',
      error: null,
      metadata: {},
    })
    core.runs.appendEvent(runId, {
      type: 'step:start',
      payload: { step: 'init' },
    })
    core.runs.appendEvent(runId, {
      type: 'step:complete',
      payload: { step: 'init', exitCode: 0 },
    })
    await core.close()

    const code = await runCli(['db', 'journal', runId, '--verify', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    const exportReport = parsed.export as Record<string, unknown>
    const verification = parsed.verification as Record<string, unknown>
    expect(exportReport.runId).toBe(runId)
    expect(exportReport.eventCount).toBeGreaterThanOrEqual(2)
    expect(verification.valid).toBe(true)

    logSpy.mockRestore()
  })

  it('resolves workspace feature flags via CLI (CONFIG-009)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'config',
      'features',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.flags).toBeDefined()
    const flags = parsed.flags as Record<string, unknown>
    expect(typeof flags.toolCaching).toBe('boolean')

    logSpy.mockRestore()
  })

  it('truncates large tool output stream with forge runtimes truncate (AGENT-012)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const sample = 'Line A\n' + 'x'.repeat(1000) + '\nLine Z'
    const code = await runCli([
      'runtimes',
      'truncate',
      sample,
      '--max-bytes',
      '200',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.truncated).toBe(true)
    expect(parsed.truncatedBytes).toBeGreaterThan(0)
    expect(typeof parsed.output).toBe('string')

    logSpy.mockRestore()
  })

  it('creates workflow checkpoint via forge workflows checkpoint (WORK-019)', async () => {
    const core = createForgeCore({ dataDir })
    const project = await core.projects.create({
      name: 'Checkpoint Test Project',
      repositoryPath: repoPath,
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
      type: 'workflow',
      status: 'running',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: null,
      exitCode: null,
      summary: 'Checkpoint workflow run',
      error: null,
      metadata: {},
    })
    await core.close()

    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['workflows', 'checkpoint', runId, '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    const checkpoint = parsed.checkpoint as Record<string, unknown>
    expect(checkpoint.runId).toBe(runId)
    expect(checkpoint.checksum).toBeDefined()
    expect(checkpoint.createdAt).toBeDefined()

    logSpy.mockRestore()
  })

  it('generates and verifies reproducible verification manifest with forge verify manifest (EVIDENCE-007)', async () => {
    const core = createForgeCore({ dataDir })
    const project = await core.projects.create({
      name: 'Manifest Test Project',
      repositoryPath: repoPath,
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
      summary: 'Manifest test run',
      error: null,
      metadata: {},
    })
    await core.close()

    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'verify',
      'manifest',
      runId,
      '--verify',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.manifest).toBeDefined()
    expect(parsed.verification).toBeDefined()
    const verification = parsed.verification as Record<string, unknown>
    expect(verification.valid).toBe(true)

    logSpy.mockRestore()
  })

  it('replays event ledger to reconstruct state projection with forge db replay (STATE-009)', async () => {
    const core = createForgeCore({ dataDir })
    const project = await core.projects.create({
      name: 'Replay Test Project',
      repositoryPath: repoPath,
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
      status: 'running',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: null,
      exitCode: null,
      summary: 'Replay test run',
      error: null,
      metadata: {},
    })
    core.runs.appendEvent(runId, {
      type: 'run:started',
      payload: {},
    })
    core.runs.appendEvent(runId, {
      type: 'step:started',
      stepId: stepIdSchema.parse(randomUUID()),
      payload: { step: 'step-1' },
    })
    await core.close()

    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'db',
      'replay',
      runId,
      '--to-seq',
      '2',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.runId).toBe(runId)
    expect(parsed.appliedEventsCount).toBeLessThanOrEqual(2)

    logSpy.mockRestore()
  })

  it('migrates configuration schema version with forge config migrate (CONFIG-010)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'config',
      'migrate',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.toVersion).toBe(2)
    expect(parsed.migratedConfig).toBeDefined()

    logSpy.mockRestore()
  })

  it('compacts prompt context turns with sliding window with forge context compact (AGENT-013)', async () => {
    const core = createForgeCore({ dataDir })
    const project = await core.projects.create({
      name: 'Compactor Test Project',
      repositoryPath: repoPath,
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
      status: 'running',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: null,
      exitCode: null,
      summary: 'Prompt compact test run',
      error: null,
      metadata: {},
    })

    const turnsData = {
      turns: [
        { role: 'system', content: 'You are an autonomous engineering agent.', turnIndex: 0 },
        { role: 'user', content: 'Turn 1 task requirements', turnIndex: 1 },
        { role: 'assistant', content: 'Turn 2 thinking and action', turnIndex: 2 },
        { role: 'tool', content: 'Turn 3 tool execution results', turnIndex: 3 },
        { role: 'user', content: 'Turn 4 follow up instructions', turnIndex: 4 },
        { role: 'assistant', content: 'Turn 5 final completion response', turnIndex: 5 },
      ],
    }

    await core.artifacts.writeArtifact({
      runId,
      kind: 'prompt-packet',
      name: 'prompt-packet.json',
      content: JSON.stringify(turnsData),
      mimeType: 'application/json',
    })
    await core.close()

    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'context',
      'compact',
      runId,
      '--max-tokens',
      '40',
      '--keep-turns',
      '2',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.originalTurnCount).toBe(6)
    expect(parsed.compactedTurnCount).toBeLessThan(6)
    expect(parsed.compressedTurnCount).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('simulates workflow DAG execution and critical path with forge workflows simulate (WORK-020)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['workflows', 'simulate', 'feature', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.criticalPathDurationMs).toBeGreaterThan(0)
    expect(Array.isArray(parsed.criticalPathNodeIds)).toBe(true)
    expect(Array.isArray(parsed.parallelStages)).toBe(true)

    logSpy.mockRestore()
  })

  it('audits changeset public export surface with forge diff exports (EVIDENCE-008)', async () => {
    const core = createForgeCore({ dataDir })
    const project = await core.projects.create({
      name: 'Diff Exports Project',
      repositoryPath: repoPath,
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
      status: 'running',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: null,
      exitCode: null,
      summary: 'Export surface test run',
      error: null,
      metadata: {},
    })

    const sampleDiff = `diff --git a/src/service.ts b/src/service.ts
index 1111111..2222222 100644
--- a/src/service.ts
+++ b/src/service.ts
@@ -1,2 +1,3 @@
 export function existingFunction(): void {}
+export function newFunction(): string { return 'ok' }
`

    await core.artifacts.writeArtifact({
      runId,
      kind: 'diff',
      name: 'changeset.diff',
      content: sampleDiff,
      mimeType: 'text/x-diff',
    })
    await core.close()

    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['diff', 'exports', runId, '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.totalChanges).toBe(1)
    expect(parsed.riskTier).toBe('low')
    expect(parsed.addedCount).toBe(1)

    logSpy.mockRestore()
  })

  it('verifies event ledger replication and sequence integrity with forge db verify-ledger (STATE-010)', async () => {
    const core = createForgeCore({ dataDir })
    const project = await core.projects.create({
      name: 'Ledger Verifier Project',
      repositoryPath: repoPath,
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
      status: 'running',
      startedAt: new Date(Date.now() - 5000).toISOString(),
      finishedAt: null,
      exitCode: null,
      summary: 'Ledger verifier test run',
      error: null,
      metadata: {},
    })
    core.runs.appendEvent(runId, {
      type: 'run:started',
      payload: {},
    })
    core.runs.appendEvent(runId, {
      type: 'step:started',
      payload: { step: 'step-1' },
    })
    await core.close()

    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['db', 'verify-ledger', runId, '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.totalEventsAudited).toBeGreaterThanOrEqual(2)
    const counts = parsed.counts as Record<string, unknown>
    expect(counts.totalRuns).toBe(1)

    logSpy.mockRestore()
  })

  it('synchronizes configuration environment variables with forge config sync-env (CONFIG-011)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'config',
      'sync-env',
      '--dry-run',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.written).toBe(false)
    expect(typeof parsed.activeProfile).toBe('string')
    expect(typeof parsed.formattedDotEnv).toBe('string')
    expect(typeof parsed.maskedDotEnv).toBe('string')
    expect(parsed.summary).toBeDefined()

    logSpy.mockRestore()
  })

  it('multiplexes streaming turn events with forge runtimes stream-turn (AGENT-014)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const streamEvents = [
      { type: 'token', text: 'Hello ' },
      { type: 'token', text: 'world from stream multiplexer!' },
    ]
    const code = await runCli([
      'runtimes',
      'stream-turn',
      JSON.stringify(streamEvents),
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.completedText).toBe('Hello world from stream multiplexer!')
    expect(parsed.totalTokens).toBe(2)

    logSpy.mockRestore()
  })

  it('extracts workflow subgraph neighborhood with forge workflows subgraph (WORK-021)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'workflows',
      'subgraph',
      'cr-sdlc',
      'agent-1',
      '--direction',
      'downstream',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.targetNodeId).toBe('agent-1')
    expect(parsed.direction).toBe('downstream')
    expect(parsed.nodeCount).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('audits patch fuzziness and hunk offsets with forge diff hunks (EVIDENCE-009)', async () => {
    const targetFile = join(repoPath, 'math.ts')
    writeFileSync(
      targetFile,
      'export function add(a: number, b: number): number {\n  return a + b\n}\n',
    )

    const patchPath = join(tempDir, 'test.patch')
    const samplePatch = [
      'diff --git a/math.ts b/math.ts',
      '--- a/math.ts',
      '+++ b/math.ts',
      '@@ -1,3 +1,4 @@',
      ' export function add(a: number, b: number): number {',
      '+  // Added comment',
      '   return a + b',
      ' }',
      '',
    ].join('\n')
    writeFileSync(patchPath, samplePatch)

    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'diff',
      'hunks',
      patchPath,
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.overallStatus).toBe('clean')
    expect(parsed.cleanHunks).toBe(1)

    logSpy.mockRestore()
  })

  it('diffs sqlite database snapshots with forge db diff-snapshots (STATE-011)', async () => {
    const snapA = join(tempDir, 'snapA.db')
    const snapB = join(tempDir, 'snapB.db')

    const dbA = new Database(snapA)
    dbA.exec('CREATE TABLE test (id TEXT PRIMARY KEY, val TEXT);')
    dbA.exec("INSERT INTO test VALUES ('1', 'apple');")
    dbA.close()

    const dbB = new Database(snapB)
    dbB.exec('CREATE TABLE test (id TEXT PRIMARY KEY, val TEXT);')
    dbB.exec("INSERT INTO test VALUES ('1', 'apple');")
    dbB.exec("INSERT INTO test VALUES ('2', 'banana');")
    dbB.close()

    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'db',
      'diff-snapshots',
      snapA,
      snapB,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.hasDivergence).toBe(true)
    expect(parsed.tableDeltas).toBeDefined()

    logSpy.mockRestore()
  })

  it('audits configuration drift and schema conformance with forge config drift (CONFIG-012)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'config',
      'drift',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(typeof parsed.hasDrift).toBe('boolean')
    expect(typeof parsed.formattedSummary).toBe('string')

    logSpy.mockRestore()
  })

  it('reflects agent tool schemas and provider descriptors with forge runtimes reflect (AGENT-015)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['runtimes', 'reflect', 'read_file', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.name).toBe('read_file')
    expect(parsed.openAI).toBeDefined()
    expect(parsed.anthropic).toBeDefined()
    expect(parsed.gemini).toBeDefined()

    logSpy.mockRestore()
  })

  it('evaluates step retry policies and exponential backoff with forge workflows retry (WORK-022)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'workflows',
      'retry',
      'Connection timed out',
      '2',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.shouldRetry).toBe(true)
    expect(parsed.errorClassification).toBe('transient')
    expect(parsed.backoffMs).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('aggregates assertions and outputs test reports with forge verify report (EVIDENCE-010)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['verify', 'report', '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.totalTests).toBe(1)
    expect(parsed.passRate).toBe(100)

    logSpy.mockRestore()
  })

  it('manages transactional savepoints with forge db savepoint (STATE-012)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'db',
      'savepoint',
      'create',
      'sp_test',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.savepointName).toBe('sp_test')
    expect(parsed.action).toBe('create')
    expect(parsed.depth).toBe(1)

    logSpy.mockRestore()
  })

  it('generates configuration templates with forge config template (CONFIG-013)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'config',
      'template',
      'node-ts',
      '.forgerc.node-test',
      '--cwd',
      tempDir,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.created).toBe(true)
    expect(parsed.preset).toBe('node-ts')

    logSpy.mockRestore()
  })

  it('audits prompt context window budgeting with forge context budget (AGENT-016)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['context', 'budget', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.modelMaxTokens).toBeGreaterThan(0)
    expect(parsed.reservedHeadroomTokens).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('manages workflow step concurrency semaphore with forge workflows semaphore (WORK-023)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['workflows', 'semaphore', 'status', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.capacity).toBe(4)
    expect(parsed.availablePermits).toBe(4)

    logSpy.mockRestore()
  })

  it('audits changeset dependency cycles with forge diff cycles (EVIDENCE-011)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'diff',
      'cycles',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.hasCycles).toBe(false)

    logSpy.mockRestore()
  })

  it('searches event store payloads with forge db search (STATE-013)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['db', 'search', 'start', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(typeof parsed.totalHits).toBe('number')
    expect(Array.isArray(parsed.hits)).toBe(true)

    logSpy.mockRestore()
  })

  it('enforces workspace boundary containment with forge config boundary (CONFIG-014)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'config',
      'boundary',
      'src/main.ts',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.allowed).toBe(true)
    expect(parsed.violationKind).toBe('none')

    logSpy.mockRestore()
  })

  it('compresses conversation turns with forge context compress (AGENT-017)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['context', 'compress', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(typeof parsed.originalTurns).toBe('number')
    expect(typeof parsed.compressedTurns).toBe('number')
    expect(Array.isArray(parsed.turns)).toBe(true)

    logSpy.mockRestore()
  })

  it('evaluates step preflight conditions with forge workflows preflight (WORK-024)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['workflows', 'preflight', 'build', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.pass).toBe(true)
    expect(parsed.shouldSkip).toBe(false)

    logSpy.mockRestore()
  })

  it('sanitizes log ansi codes and extracts diagnostics with forge verify diagnostics (EVIDENCE-012)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'verify',
      'diagnostics',
      'src/file.ts(1,1): error TS2304: Cannot find name foo.',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(1) // failureCount > 0 returns exit code 1
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.failureCount).toBe(1)
    expect(Array.isArray(parsed.failures)).toBe(true)

    logSpy.mockRestore()
  })

  it('manages database schema migrations with forge db migrate (STATE-014)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['db', 'migrate', 'status', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(typeof parsed.currentVersion).toBe('number')
    expect(typeof parsed.pendingCount).toBe('number')

    logSpy.mockRestore()
  })

  it('redacts sensitive secrets and keys with forge config sanitize (CONFIG-015)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'config',
      'sanitize',
      'api_key: sk-proj-1234567890abcdef1234567890',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.totalRedactions).toBe(1)
    expect(parsed.sanitizedText).toContain('[REDACTED_API_KEY]')

    logSpy.mockRestore()
  })

  it('coalesces multi-turn tool observations with forge context coalesce (AGENT-018)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['context', 'coalesce', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.duplicateCount).toBe(1)
    expect(parsed.originalCount).toBe(3)
    expect(Array.isArray(parsed.turns)).toBe(true)

    logSpy.mockRestore()
  })

  it('plans topological execution waves with forge workflows waves (WORK-025)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['workflows', 'waves', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.totalWaves).toBeGreaterThanOrEqual(2)
    expect(parsed.hasCycles).toBe(false)
    expect(Array.isArray(parsed.waves)).toBe(true)

    logSpy.mockRestore()
  })

  it('parses universal test reports with forge verify test-report (EVIDENCE-013)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const xml = '<testsuite name="cliSuite"><testcase name="pass_1"/></testsuite>'
    const code = await runCli(['verify', 'test-report', xml, '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.format).toBe('junit')
    expect(parsed.verdict).toBe('pass')
    expect(parsed.totalTests).toBe(1)

    logSpy.mockRestore()
  })

  it('executes sandboxed read-only SQL queries with forge db query (STATE-015)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['db', 'query', 'SELECT 42 as num;', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.rowCount).toBe(1)
    expect(parsed.rows).toEqual([{ num: 42 }])

    logSpy.mockRestore()
  })

  it('audits tool execution against sandbox policy with forge config policy-tool (CONFIG-016)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'config',
      'policy-tool',
      'git',
      'status',
      '--cwd',
      repoPath,
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.allowed).toBe(true)
    expect(parsed.binary).toBe('git')

    logSpy.mockRestore()
  })

  it('evaluates adaptive tool retry with forge context retry-tool (AGENT-019)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'context',
      'retry-tool',
      'bash',
      '1',
      '--task',
      'ETIMEDOUT: Connection timed out',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.shouldRetry).toBe(true)
    expect(parsed.classification).toBe('timeout')
    expect(parsed.backoffMs).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('evaluates step execution SLA with forge workflows sla (WORK-026)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'workflows',
      'sla',
      'lint_step',
      '2000',
      '--concurrency',
      '5000',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.stepId).toBe('lint_step')
    expect(parsed.status).toBe('nominal')
    expect(parsed.percentConsumed).toBe(40)

    logSpy.mockRestore()
  })

  it('generates and verifies in-toto provenance statement with forge verify provenance (EVIDENCE-014)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'verify',
      'provenance',
      'run-test-123',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      statement: Record<string, unknown>
      verification: Record<string, unknown>
    }
    expect(parsed.verification.valid).toBe(true)
    expect(parsed.verification.subjectCount).toBe(1)
    expect(parsed.statement._type).toBe('https://in-toto.io/Statement/v1')

    logSpy.mockRestore()
  })

  it('analyzes sqlite query execution plans with forge db analyze-query (STATE-016)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'db',
      'analyze-query',
      'SELECT * FROM runs;',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(typeof parsed.score).toBe('number')
    expect(Array.isArray(parsed.nodes)).toBe(true)
    expect(Array.isArray(parsed.recommendations)).toBe(true)

    logSpy.mockRestore()
  })

  it('resolves layered configuration inheritance with forge config resolve-layers (CONFIG-017)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['config', 'resolve-layers', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.valid).toBe(true)
    expect(parsed.conflicts).toEqual([])
    expect(parsed.originMap).toBeDefined()

    logSpy.mockRestore()
  })

  it('schedules speculative tool prefetch with forge context prefetch (AGENT-020)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['context', 'prefetch', 'read_file', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.candidateCount).toBeGreaterThanOrEqual(1)
    expect(parsed.concurrency).toBe(2)
    expect(parsed.formattedSummary).toContain('[Speculative Prefetch]')

    logSpy.mockRestore()
  })

  it('plans dynamic fork-join subflow execution with forge workflows fork-join (WORK-027)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'workflows',
      'fork-join',
      '6',
      '--concurrency',
      '3',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.totalTasks).toBe(6)
    expect(parsed.batchCount).toBe(2)
    expect(parsed.maxConcurrency).toBe(3)

    logSpy.mockRestore()
  })

  it('analyzes source code change impact with forge verify impact (EVIDENCE-015)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'verify',
      'impact',
      'src/main/core/taskRunner.ts',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.isGlobalImpact).toBe(false)
    expect(Array.isArray(parsed.selectedTestSuites)).toBe(true)
    expect(parsed.totalSuitesSelected).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('audits sqlite journal transaction deltas with forge db journal-diff (STATE-017)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['db', 'journal-diff', '1', '10', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(typeof parsed.totalEventsAnalyzed).toBe('number')
    expect(parsed.isContiguous).toBe(true)

    logSpy.mockRestore()
  })

  it('transforms deprecated configuration keys with forge config deprecations (CONFIG-018)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['config', 'deprecations', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.isUpToDate).toBe(false)
    expect(parsed.deprecationCount).toBeGreaterThan(0)
    expect((parsed.transformedConfig as Record<string, unknown>).timeoutMs).toBe(5000)

    logSpy.mockRestore()
  })

  it('decomposes engineering goals into subtasks with forge context decompose (AGENT-021)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'context',
      'decompose',
      '--task',
      'Implement multi-tenant sharding',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.goal).toBe('Implement multi-tenant sharding')
    expect(parsed.totalSubtasks).toBe(5)
    expect(Array.isArray(parsed.executionOrder)).toBe(true)
    expect(parsed.hasCycles).toBe(false)

    logSpy.mockRestore()
  })

  it('evaluates workflow step retry and DLQ escalation with forge workflows retry-schedule (WORK-028)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'workflows',
      'retry-schedule',
      'step-fetch-data',
      '1',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.stepId).toBe('step-fetch-data')
    expect(parsed.shouldRetry).toBe(true)
    expect(parsed.escalatedToDlq).toBe(false)
    expect(parsed.failureCategory).toBe('transient_network')

    logSpy.mockRestore()
  })

  it('chunks unified git diff into semantic change hunks with forge diff semantic (EVIDENCE-016)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['diff', 'semantic', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.totalChunks).toBeGreaterThan(0)
    expect(parsed.overallRisk).toBeDefined()
    expect(parsed.dominantCategory).toBeDefined()

    logSpy.mockRestore()
  })

  it('resolves sandboxed multi-tenant database shard with forge db shard (STATE-018)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['db', 'shard', 'tenant_alpha', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.projectId).toBe('tenant_alpha')
    expect(parsed.isSandboxed).toBe(true)
    expect(typeof parsed.resolvedPath).toBe('string')
    expect((parsed.resolvedPath as string).includes('shards')).toBe(true)

    logSpy.mockRestore()
  })

  it('evaluates dynamic configuration hot-reload with forge config reload-check (CONFIG-019)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['config', 'reload-check', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.isValid).toBe(true)
    expect(parsed.hasChanges).toBe(true)
    expect(parsed.requiresRestart).toBe(false)

    logSpy.mockRestore()
  })

  it('manages agent working scratchpad buffer with forge context scratchpad (AGENT-022)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const setCode = await runCli([
      'context',
      'scratchpad',
      'set',
      'decision_key',
      'use_savepoints',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(setCode).toBe(0)

    logs.length = 0
    const statsCode = await runCli(['context', 'scratchpad', '--data-dir', dataDir, '--json'])
    expect(statsCode).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.stats).toBeDefined()
    expect((parsed.stats as Record<string, unknown>).maxEntries).toBe(20)

    logSpy.mockRestore()
  })

  it('evaluates fan-in step synchronization barrier quorum with forge workflows barrier-check (WORK-029)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'workflows',
      'barrier-check',
      'step-join',
      'MAJORITY_SUCCEEDED',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.barrierStepId).toBe('step-join')
    expect(parsed.policy).toBe('MAJORITY_SUCCEEDED')
    expect(parsed.isSatisfied).toBe(true)

    logSpy.mockRestore()
  })

  it('traces symbol changes and downstream dependencies with forge diff symbols (EVIDENCE-017)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['diff', 'symbols', '--data-dir', dataDir, '--json'])
    expect(code).toBe(1)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.totalSymbols).toBe(2)
    expect(parsed.highestRiskLevel).toBe('CRITICAL')
    expect(parsed.isContractSafe).toBe(false)
    expect(Array.isArray(parsed.contractRisks)).toBe(true)

    logSpy.mockRestore()
  })

  it('manages sqlite transaction savepoint stack with forge db savepoint-stack (STATE-019)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const pushCode = await runCli([
      'db',
      'savepoint-stack',
      'push',
      'sp_checkpoint_1',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(pushCode).toBe(0)
    const parsedPush = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsedPush.action).toBe('push')
    expect(parsedPush.name).toBe('sp_checkpoint_1')
    expect(parsedPush.depth).toBe(1)

    logs.length = 0
    const statusCode = await runCli([
      'db',
      'savepoint-stack',
      'status',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(statusCode).toBe(0)
    const parsedStatus = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsedStatus.currentDepth).toBe(0)

    logSpy.mockRestore()
  })

  it('supervises secret lifetime and rotation schedule with forge config secret-audit (CONFIG-020)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['config', 'secret-audit', '--data-dir', dataDir, '--json'])
    expect(code).toBe(1)
    const parsed = JSON.parse(logs[0] ?? '{}') as Record<string, unknown>
    expect(parsed.totalSecrets).toBe(3)
    expect(parsed.expiredCount).toBe(1)
    expect(parsed.requiresImmediateAction).toBe(true)

    logSpy.mockRestore()
  })

  it('throttles agent token budget with forge context throttler (AGENT-023)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'context',
      'throttler',
      '1000',
      '500',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      check: { status: string; isThrottled: boolean }
      stats: { recordCount: number; totalTokensInWindow: number }
    }
    expect(parsed.check.isThrottled).toBe(false)
    expect(parsed.stats.recordCount).toBe(1)
    expect(parsed.stats.totalTokensInWindow).toBe(1500)

    logSpy.mockRestore()
  })

  it('detects workflow execution deadlocks with forge workflows deadlock-check (WORK-030)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['workflows', 'deadlock-check', '--data-dir', dataDir, '--json'])
    expect(code).toBe(1)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      isDeadlocked: boolean
      cyclePaths: string[][]
      summary: string
    }
    expect(parsed.isDeadlocked).toBe(true)
    expect(parsed.cyclePaths.length).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('audits changeset paths for traversal escapes with forge diff path-audit (EVIDENCE-018)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['diff', 'path-audit', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      isSafe: boolean
      totalFilesScanned: number
      violations: unknown[]
    }
    expect(parsed.isSafe).toBe(true)
    expect(parsed.totalFilesScanned).toBe(2)
    expect(parsed.violations).toHaveLength(0)

    logSpy.mockRestore()
  })

  it('inspects sqlite connection pool health with forge db pool-status (STATE-020)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['db', 'pool-status', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      telemetry: { maxConnections: number; activeLeases: number; availableConnections: number }
      summary: string
    }
    expect(parsed.telemetry.maxConnections).toBe(16)
    expect(parsed.telemetry.activeLeases).toBe(0)
    expect(parsed.telemetry.availableConnections).toBe(16)
    expect(parsed.summary).toContain('SQLite Connection Pool Summary')

    logSpy.mockRestore()
  })

  it('coerces and validates config with forge config coerce-validate (CONFIG-021)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'config',
      'coerce-validate',
      '9090',
      'false',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      valid: boolean
      coerced: { port: number; debug: boolean; tags: string[] }
      errors: unknown[]
    }
    expect(parsed.valid).toBe(true)
    expect(parsed.coerced.port).toBe(9090)
    expect(parsed.coerced.debug).toBe(false)
    expect(parsed.coerced.tags).toEqual(['agent', 'workflows', 'orchestrator'])

    logSpy.mockRestore()
  })

  it('serializes and hydrates subgoal checkpoint with forge context checkpoint (AGENT-024)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'context',
      'checkpoint',
      'run-test-warm',
      'subgoal-01',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      checkpoint: { checkpointId: string; runId: string; checksum: string }
      warmContext: { resumedStepIndex: number; canResume: boolean; completedCount: number }
      summary: string
    }
    expect(parsed.checkpoint.checkpointId).toBeDefined()
    expect(parsed.checkpoint.runId).toBe('run-test-warm')
    expect(parsed.warmContext.resumedStepIndex).toBe(3)
    expect(parsed.warmContext.completedCount).toBe(2)
    expect(parsed.warmContext.canResume).toBe(true)

    logSpy.mockRestore()
  })

  it('partitions workflow fan-out execution into batches and waves with forge workflows fan-out (WORK-031)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['workflows', 'fan-out', '12', '4', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      totalItems: number
      batchCount: number
      waveCount: number
      waves: { waveIndex: number; batchIndices: number[] }[]
    }
    expect(parsed.totalItems).toBe(12)
    expect(parsed.batchCount).toBe(3)
    expect(parsed.waveCount).toBe(1)
    expect(parsed.waves[0]?.batchIndices).toEqual([0, 1, 2])

    logSpy.mockRestore()
  })

  it('masks sensitive tokens and credentials in diffs with forge diff mask (EVIDENCE-019)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['diff', 'mask', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      maskedDiff: string
      report: { totalReplacements: number; uniqueTokensCount: number }
    }
    expect(parsed.maskedDiff).not.toContain('sk-1234567890abcdef1234567890abcdef')
    expect(parsed.maskedDiff).toContain('[REDACTED_CREDENTIAL_1]')
    expect(parsed.report.totalReplacements).toBe(3)
    expect(parsed.report.uniqueTokensCount).toBe(3)

    logSpy.mockRestore()
  })

  it('manages sqlite read consistency snapshot barrier with forge db snapshot-barrier (STATE-021)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'db',
      'snapshot-barrier',
      'test-read-audit',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      barrier: { barrierId: string; purpose: string; released: boolean }
      stats: { totalCreated: number; activeCount: number }
      summary: string
    }
    expect(parsed.barrier.barrierId).toBeDefined()
    expect(parsed.barrier.purpose).toBe('test-read-audit')
    expect(parsed.stats.totalCreated).toBe(1)
    expect(parsed.stats.activeCount).toBe(1)

    logSpy.mockRestore()
  })

  it('synthesizes configuration policy drift remediation plan with forge config remediate (CONFIG-022)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'config',
      'remediate',
      'info',
      'true',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      isCompliant: boolean
      complianceScore: number
      driftCount: number
      actions: unknown[]
    }
    expect(parsed.isCompliant).toBe(true)
    expect(parsed.complianceScore).toBe(1)
    expect(parsed.driftCount).toBe(0)

    logSpy.mockRestore()
  })

  it('validates agent tool capability prerequisites with forge context validate-capability (AGENT-025)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'context',
      'validate-capability',
      'git-operation',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      capabilityId: string
      isReady: boolean
      missingBinaries: string[]
      platformSupported: boolean
    }
    expect(parsed.capabilityId).toBe('git-operation')
    expect(parsed.isReady).toBe(true)
    expect(parsed.missingBinaries).toEqual([])
    expect(parsed.platformSupported).toBe(true)

    logSpy.mockRestore()
  })

  it('intercepts and evaluates workflow circuit breaker with forge workflows breaker (WORK-032)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'workflows',
      'breaker',
      'check',
      'step-compiler',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      check: { allowed: boolean; state: string }
      metrics: { state: string; totalFailures: number }
    }
    expect(parsed.check.allowed).toBe(true)
    expect(parsed.check.state).toBe('CLOSED')
    expect(parsed.metrics.totalFailures).toBe(0)

    logSpy.mockRestore()
  })

  it('audits changeset entropy and detects oversized hunks with forge diff audit-entropy (EVIDENCE-020)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['diff', 'audit-entropy', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      isSafe: boolean
      overallEntropy: number
      violations: unknown[]
      hunksAudited: number
    }
    expect(parsed.isSafe).toBe(true)
    expect(parsed.overallEntropy).toBeGreaterThan(0)
    expect(parsed.violations).toHaveLength(0)
    expect(parsed.hunksAudited).toBe(1)

    logSpy.mockRestore()
  })

  it('compacts and verifies sqlite audit log event stream with forge db compact-audit (STATE-022)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'db',
      'compact-audit',
      'run-test-compact',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      record: { runId: string; eventCount: number; merkleRoot: string }
      isValid: boolean
    }
    expect(parsed.record.runId).toBe('run-test-compact')
    expect(parsed.record.eventCount).toBe(2)
    expect(parsed.record.merkleRoot).toHaveLength(64)
    expect(parsed.isValid).toBe(true)

    logSpy.mockRestore()
  })

  it('sanitizes workspace environment variables and preserves system baseline with forge config sanitize-env (CONFIG-023)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['config', 'sanitize-env', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      originalCount: number
      retainedCount: number
      strippedKeys: string[]
      missingRequiredKeys: string[]
    }
    expect(parsed.strippedKeys).toContain('AWS_SECRET_KEY')
    expect(parsed.strippedKeys).toContain('GITHUB_TOKEN')
    expect(parsed.missingRequiredKeys).toHaveLength(0)
    expect(parsed.retainedCount).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('simulates agent tool execution and evaluates blast radius with forge context dry-run (AGENT-026)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'context',
      'dry-run',
      'workspace_edit',
      'src/main/cli.ts',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      toolName: string
      severity: string
      isAllowed: boolean
      blastRadiusScore: number
    }
    expect(parsed.toolName).toBe('workspace_edit')
    expect(parsed.severity).toBe('WORKSPACE_MUTATION')
    expect(parsed.isAllowed).toBe(true)
    expect(parsed.blastRadiusScore).toBeGreaterThanOrEqual(1)

    logSpy.mockRestore()
  })

  it('supervises workflow queue load and backpressure with forge workflows backpressure (WORK-033)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'workflows',
      'backpressure',
      'enqueue',
      'step-compiler',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      evalResult: { allowSubmission: boolean; delayMs: number }
      metrics: { state: string; pendingQueueDepth: number }
    }
    expect(parsed.evalResult.allowSubmission).toBe(true)
    expect(parsed.metrics.state).toBe('NORMAL')
    expect(parsed.metrics.pendingQueueDepth).toBe(1)

    logSpy.mockRestore()
  })

  it('slices unified changeset hunks to fit LLM token budget with forge diff slice-budget (EVIDENCE-021)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['diff', 'slice-budget', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      totalHunks: number
      retainedHunks: number
      omittedHunks: number
      slicedDiff: string
    }
    expect(parsed.totalHunks).toBe(2)
    expect(parsed.retainedHunks).toBe(1)
    expect(parsed.omittedHunks).toBe(1)
    expect(parsed.slicedDiff).toContain('# [Hunk omitted:')

    logSpy.mockRestore()
  })

  it('coordinates SQLite transaction write lock leases with forge db write-lease (STATE-023)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['db', 'write-lease', 'writer-cli', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      lease: { holderId: string; fencingToken: number }
      isValid: boolean
      released: boolean
    }
    expect(parsed.lease.holderId).toBe('writer-cli')
    expect(parsed.lease.fencingToken).toBe(1)
    expect(parsed.isValid).toBe(true)
    expect(parsed.released).toBe(true)

    logSpy.mockRestore()
  })

  it('manages configuration snapshot provenance and rollbacks with forge config rollback (CONFIG-024)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['config', 'rollback', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      revertedTo: string
      currentSnapshot: { tags?: string[]; configState: Record<string, unknown> }
      integrity: { valid: boolean; totalSnapshots: number }
    }
    expect(parsed.integrity.valid).toBe(true)
    expect(parsed.integrity.totalSnapshots).toBe(3)
    expect(parsed.currentSnapshot.tags).toContain('rollback')
    expect(parsed.currentSnapshot.configState).toEqual({ theme: 'dark', maxRetries: 3 })

    logSpy.mockRestore()
  })

  it('forecasts multi-turn token consumption and compaction advisories with forge context forecast (AGENT-027)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['context', 'forecast', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      healthStatus: string
      currentTokens: number
      maxWindowTokens: number
      projectedRemainingTurns: number
      advisoryRecommendations: string[]
    }
    expect(parsed.healthStatus).toBe('WARN_COMPACT_SOON')
    expect(parsed.currentTokens).toBe(6500)
    expect(parsed.maxWindowTokens).toBe(16384)
    expect(parsed.advisoryRecommendations.length).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('evaluates step journal and idempotent resume plan with forge workflows journal-resume (WORK-034)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'workflows',
      'journal-resume',
      'run-journal-sample',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      totalNodes: number
      replayedNodesCount: number
      nodesToExecuteCount: number
      isFullyResumable: boolean
    }
    expect(parsed.totalNodes).toBe(2)
    expect(parsed.replayedNodesCount).toBe(1)
    expect(parsed.nodesToExecuteCount).toBe(1)
    expect(parsed.isFullyResumable).toBe(true)

    logSpy.mockRestore()
  })

  it('analyzes multi-changeset conflict matrix with forge diff conflict-matrix (EVIDENCE-022)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'diff',
      'conflict-matrix',
      'branch-alpha',
      'branch-beta',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      totalChangesets: number
      mergeFeasibilityScore: number
      isMergeFeasible: boolean
      directCollisionsCount: number
    }
    expect(parsed.totalChangesets).toBe(2)
    expect(parsed.mergeFeasibilityScore).toBe(100)
    expect(parsed.isMergeFeasible).toBe(true)
    expect(parsed.directCollisionsCount).toBe(0)

    logSpy.mockRestore()
  })

  it('evaluates query plan and generates index DDL with forge db index-advisor (STATE-024)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['db', 'index-advisor', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      hasTableScan: boolean
      scannedTables: string[]
      overallCostScore: number
      recommendations: { tableName: string; ddlStatement: string }[]
    }
    expect(parsed.hasTableScan).toBe(true)
    expect(parsed.scannedTables).toContain('events')
    expect(parsed.overallCostScore).toBeGreaterThanOrEqual(500)
    expect(parsed.recommendations.length).toBeGreaterThan(0)
    expect(parsed.recommendations[0]?.ddlStatement).toContain('CREATE INDEX IF NOT EXISTS')

    logSpy.mockRestore()
  })

  it('attests workspace security credentials zero-knowledge with forge config attest-secrets (CONFIG-025)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['config', 'attest-secrets', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      isAttested: boolean
      attestationToken: string
      verifiedKeys: string[]
      missingKeys: string[]
    }
    expect(parsed.isAttested).toBe(true)
    expect(parsed.attestationToken).toHaveLength(64)
    expect(parsed.verifiedKeys).toContain('APP_TOKEN')
    expect(parsed.verifiedKeys).toContain('GITHUB_KEY')
    expect(parsed.missingKeys).toHaveLength(0)

    logSpy.mockRestore()
  })

  it('coordinates speculative execution DAG and commits results with forge context speculative-exec (AGENT-028)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['context', 'speculative-exec', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      totalCount: number
      speculativeCount: number
      committedCount: number
      rollbackTriggered: boolean
    }
    expect(parsed.totalCount).toBe(3)
    expect(parsed.speculativeCount).toBe(2)
    expect(parsed.committedCount).toBe(3)
    expect(parsed.rollbackTriggered).toBe(false)

    logSpy.mockRestore()
  })

  it('evaluates step resource quota utilization with forge workflows quota-eval (WORK-035)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli([
      'workflows',
      'quota-eval',
      'step-compile',
      '--data-dir',
      dataDir,
      '--json',
    ])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      stepId: string
      status: string
      shouldEvict: boolean
      recommendedAction: string
    }
    expect(parsed.stepId).toBe('step-compile')
    expect(parsed.status).toBe('WITHIN_LIMITS')
    expect(parsed.shouldEvict).toBe(false)
    expect(parsed.recommendedAction).toBe('CONTINUE')

    logSpy.mockRestore()
  })

  it('audits export symbol regressions in diff with forge diff symbol-regression (EVIDENCE-023)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['diff', 'symbol-regression', '--data-dir', dataDir, '--json'])
    expect(code).toBe(1) // 1 because breaking regression was detected fail-closed
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      hasBreakingChanges: boolean
      breakingCount: number
      totalSeverityScore: number
      recommendations: string[]
    }
    expect(parsed.hasBreakingChanges).toBe(true)
    expect(parsed.breakingCount).toBe(1)
    expect(parsed.totalSeverityScore).toBe(25)
    expect(parsed.recommendations.length).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('evaluates partition shard imbalance and compaction with forge db shard-rebalance (STATE-025)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['db', 'shard-rebalance', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      plan: { isRebalanceNeeded: boolean; moves: { fromShardId: string; toShardId: string }[] }
      compaction: { shardId: string; pagesFreed: number; bytesReclaimed: number }
    }
    expect(parsed.plan.isRebalanceNeeded).toBe(true)
    expect(parsed.plan.moves.length).toBeGreaterThan(0)
    expect(parsed.compaction.shardId).toBe('shard-01')
    expect(parsed.compaction.pagesFreed).toBeGreaterThan(0)

    logSpy.mockRestore()
  })

  it('audits workspace permission escalation and capability sandbox with forge config audit-escalation (CONFIG-026)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['config', 'audit-escalation', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      isApproved: boolean
      agentId: string
      tier: string
      capability: string
      violations: unknown[]
      auditFingerprint: string
    }
    expect(parsed.isApproved).toBe(true)
    expect(parsed.tier).toBe('STANDARD')
    expect(parsed.capability).toBe('FILE_WRITE')
    expect(parsed.violations).toHaveLength(0)
    expect(parsed.auditFingerprint).toMatch(/^audit-[0-9a-f]{16}$/)

    logSpy.mockRestore()
  })

  it('evaluates speculative execution cache hit and stats with forge context cache-eval (AGENT-029)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['context', 'cache-eval', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      toolName: string
      hit: boolean
      reason: string
      key: string
      stats: { hits: number; misses: number; entryCount: number }
    }
    expect(parsed.toolName).toBe('read_file')
    expect(parsed.hit).toBe(true)
    expect(parsed.reason).toBe('hit')
    expect(parsed.stats.hits).toBe(1)
    expect(parsed.stats.entryCount).toBe(1)

    logSpy.mockRestore()
  })

  it('evaluates workflow consensus epoch fencing and quorum commit with forge workflows consensus-fence (WORK-036)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['workflows', 'consensus-fence', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      status: string
      epochNumber: number
      votesCount: number
      approvedCount: number
      requiredQuorum: number
      quorumAchieved: boolean
    }
    expect(parsed.status).toBe('admitted')
    expect(parsed.epochNumber).toBe(1)
    expect(parsed.votesCount).toBe(2)
    expect(parsed.approvedCount).toBe(2)
    expect(parsed.quorumAchieved).toBe(true)

    logSpy.mockRestore()
  })

  it('stabilizes diff hunk line offsets with forge diff stabilize-offsets (EVIDENCE-024)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['diff', 'stabilize-offsets', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      success: boolean
      stabilizedHunks: { hunkIndex: number; stabilizedOldStart: number; offsetDelta: number }[]
      totalDrift: number
    }
    expect(parsed.success).toBe(true)
    expect(parsed.stabilizedHunks).toHaveLength(1)
    expect(parsed.stabilizedHunks[0]?.stabilizedOldStart).toBe(2)

    logSpy.mockRestore()
  })

  it('coordinates SQLite hot-backup checkpoint and point-in-time recovery with forge db hot-backup-pitr (STATE-026)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['db', 'hot-backup-pitr', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      success: boolean
      restoredLsn: number
      replayedEventCount: number
      integrityVerified: boolean
    }
    expect(parsed.success).toBe(true)
    expect(parsed.restoredLsn).toBe(2)
    expect(parsed.replayedEventCount).toBe(2)
    expect(parsed.integrityVerified).toBe(true)

    logSpy.mockRestore()
  })

  it('audits workspace secret lifecycle and rotation schedules with forge config secret-lifecycle (CONFIG-027)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['config', 'secret-lifecycle', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      totalSecrets: number
      activeCount: number
      violationsCount: number
      records: { secretName: string; state: string }[]
    }
    expect(parsed.totalSecrets).toBe(1)
    expect(parsed.activeCount).toBe(1)
    expect(parsed.violationsCount).toBe(0)
    expect(parsed.records[0]?.secretName).toBe('OPENAI_API_KEY')
    expect(parsed.records[0]?.state).toBe('active')

    logSpy.mockRestore()
  })

  it('evaluates conversation keyframe pruning and token compression with forge context pruner-eval (AGENT-030)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['context', 'pruner-eval', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      originalTurnCount: number
      retainedTurnCount: number
      tokenReductionPercentage: number
      turns: { role: string; content: string }[]
    }
    expect(parsed.originalTurnCount).toBe(4)
    expect(parsed.retainedTurnCount).toBe(4)
    expect(parsed.tokenReductionPercentage).toBeGreaterThan(0)
    const toolTurn = parsed.turns.find((t) => t.role === 'tool')
    expect(toolTurn?.content).toContain('[Truncated observation')

    logSpy.mockRestore()
  })

  it('coordinates distributed step 2PC Prepare/Commit with forge workflows 2pc-arbitrate (WORK-037)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['workflows', '2pc-arbitrate', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      txId: string
      phase: string
      participants: string[]
      votes: { participantId: string; vote: string }[]
    }
    expect(parsed.phase).toBe('COMMITTED')
    expect(parsed.participants).toEqual(['worker-1', 'worker-2'])
    expect(parsed.votes).toHaveLength(2)

    logSpy.mockRestore()
  })

  it('formats diff chunks with gutters and ANSI styling with forge diff highlight-ansi (EVIDENCE-025)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['diff', 'highlight-ansi', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      filePath: string
      hunksCount: number
      additionsCount: number
      deletionsCount: number
      renderedAnsi: string
      renderedClean: string
    }
    expect(parsed.filePath).toBe('src/app.ts')
    expect(parsed.hunksCount).toBe(1)
    expect(parsed.additionsCount).toBe(1)
    expect(parsed.deletionsCount).toBe(1)
    expect(parsed.renderedAnsi).toContain('\x1b[32m')
    expect(parsed.renderedClean).not.toContain('\x1b[')

    logSpy.mockRestore()
  })

  it('performs indexed BM25 full-text search with forge db fts-search (STATE-027)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['db', 'fts-search', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      query: string
      totalMatches: number
      matches: { docId: string; score: number; titleSnippet: string; bodySnippet: string }[]
    }
    expect(parsed.totalMatches).toBe(1)
    expect(parsed.matches[0]?.docId).toBe('doc-001')
    expect(parsed.matches[0]?.score).toBeGreaterThan(0)
    expect(parsed.matches[0]?.titleSnippet).toContain('<mark>electron</mark>')

    logSpy.mockRestore()
  })

  it('audits workspace dependencies against CVE advisory gates with forge config audit-deps (CONFIG-028)', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((msg) => {
      logs.push(String(msg))
    })

    const code = await runCli(['config', 'audit-deps', '--data-dir', dataDir, '--json'])
    expect(code).toBe(0)
    const parsed = JSON.parse(logs[0] ?? '{}') as {
      scannedPackagesCount: number
      vulnerabilitiesCount: number
      gateApproved: boolean
      summary: string
    }
    expect(parsed.scannedPackagesCount).toBe(3)
    expect(parsed.vulnerabilitiesCount).toBe(0)
    expect(parsed.gateApproved).toBe(true)
    expect(parsed.summary).toContain('Audit PASSED')

    logSpy.mockRestore()
  })
})
