import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
})
