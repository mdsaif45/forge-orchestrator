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
})
