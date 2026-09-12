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
    const code = await runCli(['--help'])
    expect(code).toBe(0)
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

  it('lists runs in empty state', async () => {
    const code = await runCli(['runs', '--data-dir', dataDir])
    expect(code).toBe(0)

    const jsonCode = await runCli(['runs', 'list', '--data-dir', dataDir, '--json'])
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

    await core.close()

    // 1. List runs
    const listCode = await runCli(['runs', '--data-dir', dataDir, '--all'])
    expect(listCode).toBe(0)

    const listJsonCode = await runCli(['runs', 'list', '--data-dir', dataDir, '--all', '--json'])
    expect(listJsonCode).toBe(0)

    // 2. Inspect run
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

    const inspectNotFound = await runCli(['runs', 'inspect', 'non-existent', '--data-dir', dataDir])
    expect(inspectNotFound).toBe(1)

    // 3. Events
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

    // 4. Artifacts list
    const artListCode = await runCli(['artifacts', 'list', runId, '--data-dir', dataDir])
    expect(artListCode).toBe(0)

    const artListJsonCode = await runCli(['artifacts', runId, '--data-dir', dataDir, '--json'])
    expect(artListJsonCode).toBe(0)

    // 5. Artifacts cat
    const stdoutWrite = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const catCode = await runCli(['artifacts', 'cat', artifact.id, '--data-dir', dataDir])
    expect(catCode).toBe(0)
    expect(stdoutWrite).toHaveBeenCalled()

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

    const catNotFound = await runCli(['artifacts', 'cat', 'non-existent', '--data-dir', dataDir])
    expect(catNotFound).toBe(1)

    stdoutWrite.mockRestore()
  })
})
