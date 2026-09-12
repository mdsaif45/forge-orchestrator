import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
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
})
