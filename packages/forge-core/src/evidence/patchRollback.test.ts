import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { runGit } from '../git/exec'
import { applyRollbackPatch, generateReversePatch } from './patchRollback'

describe('generateReversePatch', () => {
  it('inverts file modifications accurately', () => {
    const originalPatch = [
      'diff --git a/src/index.ts b/src/index.ts',
      '--- a/src/index.ts',
      '+++ b/src/index.ts',
      '@@ -10,3 +10,4 @@ function hello() {',
      ' const a = 1',
      '-const b = 2',
      '+const b = 20',
      '+const c = 30',
      ' return a + b',
    ].join('\n')

    const reverse = generateReversePatch(originalPatch)

    expect(reverse).toContain('--- a/src/index.ts')
    expect(reverse).toContain('+++ b/src/index.ts')
    expect(reverse).toContain('@@ -10,4 +10,3 @@ function hello() {')
    expect(reverse).toContain('+const b = 2')
    expect(reverse).toContain('-const b = 20')
    expect(reverse).toContain('-const c = 30')
  })

  it('inverts newly added files into deleted files', () => {
    const addPatch = [
      'diff --git a/new-file.txt b/new-file.txt',
      'new file mode 100644',
      '--- /dev/null',
      '+++ b/new-file.txt',
      '@@ -0,0 +1,2 @@',
      '+line 1',
      '+line 2',
    ].join('\n')

    const reverse = generateReversePatch(addPatch)

    expect(reverse).toContain('deleted file mode 100644')
    expect(reverse).toContain('--- a/new-file.txt')
    expect(reverse).toContain('+++ /dev/null')
    expect(reverse).toContain('-line 1')
    expect(reverse).toContain('-line 2')
  })

  it('inverts deleted files into added files', () => {
    const delPatch = [
      'diff --git a/old-file.txt b/old-file.txt',
      'deleted file mode 100644',
      '--- a/old-file.txt',
      '+++ /dev/null',
      '@@ -1,2 +0,0 @@',
      '-line 1',
      '-line 2',
    ].join('\n')

    const reverse = generateReversePatch(delPatch)

    expect(reverse).toContain('new file mode 100644')
    expect(reverse).toContain('--- /dev/null')
    expect(reverse).toContain('+++ b/old-file.txt')
    expect(reverse).toContain('+line 1')
    expect(reverse).toContain('+line 2')
  })
})

describe('applyRollbackPatch in git repo', () => {
  let testRepoDir: string

  beforeEach(async () => {
    testRepoDir = await mkdtemp(join(tmpdir(), 'forge-rollback-test-'))
    await runGit(['init', '-b', 'master'], { cwd: testRepoDir })
    await runGit(['config', 'user.name', 'Forge Tester'], { cwd: testRepoDir })
    await runGit(['config', 'user.email', 'tester@forge.local'], { cwd: testRepoDir })

    await writeFile(join(testRepoDir, 'app.txt'), 'Initial baseline line\n', 'utf8')
    await runGit(['add', '.'], { cwd: testRepoDir })
    await runGit(['commit', '-m', 'Initial commit'], { cwd: testRepoDir })
  })

  afterEach(async () => {
    await rm(testRepoDir, { recursive: true, force: true }).catch(() => undefined)
  })

  it('restores modified file to baseline state', async () => {
    // Modify file
    await writeFile(join(testRepoDir, 'app.txt'), 'Modified content line\n', 'utf8')

    // Capture diff
    const diffRes = await runGit(['diff'], { cwd: testRepoDir })
    expect(diffRes.stdout).toContain('-Initial baseline line')
    expect(diffRes.stdout).toContain('+Modified content line')

    const reversePatch = generateReversePatch(diffRes.stdout)

    // Dry-run first
    const dryResult = await applyRollbackPatch(testRepoDir, reversePatch, { dryRun: true })
    expect(dryResult.success).toBe(true)
    expect(dryResult.dryRun).toBe(true)
    // File still has modified content
    expect(await readFile(join(testRepoDir, 'app.txt'), 'utf8')).toBe('Modified content line\n')

    // Actual rollback
    const realResult = await applyRollbackPatch(testRepoDir, reversePatch, { dryRun: false })
    expect(realResult.success).toBe(true)
    expect(realResult.appliedFiles).toContain('app.txt')

    // File restored to pristine initial state
    expect(await readFile(join(testRepoDir, 'app.txt'), 'utf8')).toBe('Initial baseline line\n')
  })
})
