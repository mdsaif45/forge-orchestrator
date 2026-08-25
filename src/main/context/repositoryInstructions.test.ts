import { mkdtempSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { removeTempDir } from '../../test/tempDir'
import { readRepositoryInstructions } from './repositoryInstructions'

/**
 * Reading a repository's own agent instructions (#133).
 *
 * The point of reading it here rather than letting the CLI load it: the spawned process
 * runs with `--safe-mode` so that what enters an agent's context is what Forge put there
 * (A1). These assert the reader's contract — present, absent, and unusable — because
 * every one of those is a normal state for this file.
 */

let repoPath: string

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'forge-instructions-'))
})

afterEach(async () => {
  await removeTempDir(repoPath)
})

describe('readRepositoryInstructions', () => {
  it('returns the contents when the repository has a CLAUDE.md', async () => {
    writeFileSync(join(repoPath, 'CLAUDE.md'), '# Conventions\n\nPrefer composition.')

    await expect(readRepositoryInstructions(repoPath, ['CLAUDE.md'])).resolves.toBe(
      '# Conventions\n\nPrefer composition.',
    )
  })

  it('returns null when there is none, because most repositories have none', async () => {
    // Absence is the common case and must not be an error, a warning, or a log line.
    await expect(readRepositoryInstructions(repoPath, ['CLAUDE.md'])).resolves.toBeNull()
  })

  it('treats an empty file as absent', async () => {
    // An empty file would otherwise render a heading with nothing under it, which tells
    // an agent the repository has instructions and then shows it none.
    writeFileSync(join(repoPath, 'CLAUDE.md'), '   \n\n  ')

    await expect(readRepositoryInstructions(repoPath, ['CLAUDE.md'])).resolves.toBeNull()
  })

  it('does not fail a run when the path is unreadable', async () => {
    // A directory where the file should be. The workflow runs fine without this file, so
    // an unusable one must not be the thing that stops it.
    mkdirSync(join(repoPath, 'CLAUDE.md'))

    await expect(readRepositoryInstructions(repoPath, ['CLAUDE.md'])).resolves.toBeNull()
  })

  it('does not fail when the repository path does not exist', async () => {
    await expect(
      readRepositoryInstructions(join(repoPath, 'nope'), ['CLAUDE.md']),
    ).resolves.toBeNull()
  })
})

describe('choosing among several candidate filenames', () => {
  it('takes the first that exists, so a repository with both is unambiguous', async () => {
    writeFileSync(join(repoPath, 'AGENTS.md'), 'from AGENTS')
    writeFileSync(join(repoPath, 'CLAUDE.md'), 'from CLAUDE')

    await expect(readRepositoryInstructions(repoPath, ['AGENTS.md', 'CLAUDE.md'])).resolves.toBe(
      'from AGENTS',
    )
  })

  it('falls through to a later name when the earlier one is absent', async () => {
    writeFileSync(join(repoPath, 'CLAUDE.md'), 'from CLAUDE')

    await expect(readRepositoryInstructions(repoPath, ['AGENTS.md', 'CLAUDE.md'])).resolves.toBe(
      'from CLAUDE',
    )
  })

  it('reads nothing when the runtime declares no convention', async () => {
    // A runtime with no CLI has no such file. Empty is a real answer, and must not be
    // treated as "look for the usual name anyway".
    writeFileSync(join(repoPath, 'CLAUDE.md'), 'ignored')

    await expect(readRepositoryInstructions(repoPath, [])).resolves.toBeNull()
  })
})
