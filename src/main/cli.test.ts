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
})
