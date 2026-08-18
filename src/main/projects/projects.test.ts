import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initialiseDatabase } from '../db'
import type { ForgeDatabase } from '../db'
import { ProjectStore } from '../db/projectStore'
import { ProjectService } from './projectService'
import { validateRepository } from './validateRepository'

/**
 * Project creation, end to end through the event log.
 *
 * Real repositories and a real (temporary) database, for the same reason the git
 * tests use them: the whole claim being made is that state survives a restart, and
 * a mocked store would prove only that the mock was called.
 */

let repoPath: string
let dbFile: string
let db: ForgeDatabase
let closeDb: () => void

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repoPath, encoding: 'utf8' })
}

function initRepository(directory: string): void {
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', '.'], { cwd: directory })
  execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: directory })
  execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: directory })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: directory })
}

beforeEach(() => {
  repoPath = mkdtempSync(join(tmpdir(), 'forge-proj-repo-'))
  initRepository(repoPath)
  writeFileSync(join(repoPath, 'README.md'), '# test\n')
  git('add', '-A')
  git('commit', '--quiet', '-m', 'first')

  dbFile = join(mkdtempSync(join(tmpdir(), 'forge-proj-db-')), 'forge.db')
  const opened = initialiseDatabase(dbFile)
  db = opened.db
  closeDb = opened.close
})

afterEach(() => {
  closeDb()
  rmSync(repoPath, { recursive: true, force: true })
  rmSync(dbFile, { recursive: true, force: true })
})

function request(overrides: Record<string, unknown> = {}): Parameters<ProjectService['create']>[0] {
  return {
    name: 'InTime',
    repositoryPath: repoPath,
    defaultBranch: 'main',
    buildCommand: 'dotnet build',
    testCommand: 'dotnet test',
    tech: ['.NET 9', 'React'],
    rules: ['never modify migrations without approval'],
    ...overrides,
  }
}

describe('validateRepository', () => {
  it('reports a bound repository with its branch and head', async () => {
    const probe = await validateRepository(repoPath)

    expect(probe.isRepository).toBe(true)
    expect(probe.branch).toBe('main')
    expect(probe.headSha).toBe(git('rev-parse', 'HEAD').trim())
    expect(probe.problems).toEqual([])
  })

  it('names a missing path rather than failing generically', async () => {
    const probe = await validateRepository(join(repoPath, 'does-not-exist'))

    expect(probe.isRepository).toBe(false)
    expect(probe.problems.at(0)?.code).toBe('missing')
  })

  it('rejects a relative path, which would resolve against the wrong directory', async () => {
    const probe = await validateRepository('./somewhere')

    expect(probe.problems.at(0)?.code).toBe('not-absolute')
  })

  it('distinguishes a plain folder from a subdirectory of a repository', async () => {
    // These need different instructions -- "run git init" versus "pick the parent"
    // -- so collapsing them into one message would leave the user guessing.
    const plain = mkdtempSync(join(tmpdir(), 'forge-plain-'))
    const nested = join(repoPath, 'src')
    mkdirSync(nested)

    try {
      const outside = await validateRepository(plain)
      expect(outside.problems.at(0)?.code).toBe('not-a-repository')

      const inside = await validateRepository(nested)
      expect(inside.problems.at(0)?.code).toBe('inside-repository')
      // The message must name the root, since that is the folder to pick instead.
      expect(inside.problems.at(0)?.detail).toContain('Bind that folder instead')
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('reports a dirty worktree without making it a problem', async () => {
    writeFileSync(join(repoPath, 'scratch.txt'), 'uncommitted\n')

    const probe = await validateRepository(repoPath)

    expect(probe.dirty).toBe(true)
    expect(probe.dirtyPaths).toContain('scratch.txt')
    // Binding a repository with work in progress is normal; the refusal happens
    // later, when a workflow captures a base SHA.
    expect(probe.problems).toEqual([])
  })

  it('warns, but does not block, on a repository with no commits', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'forge-empty-'))
    initRepository(empty)

    try {
      const probe = await validateRepository(empty)

      expect(probe.isRepository).toBe(true)
      expect(probe.headSha).toBeNull()
      expect(probe.problems.map((problem) => problem.code)).toContain('no-commits')
    } finally {
      rmSync(empty, { recursive: true, force: true })
    }
  })

  it('warns on a detached head', async () => {
    git('checkout', '--quiet', '--detach', 'HEAD')

    const probe = await validateRepository(repoPath)

    expect(probe.branch).toBeNull()
    expect(probe.problems.map((problem) => problem.code)).toContain('detached-head')
  })
})

describe('ProjectService.create', () => {
  it('persists the project, its repository, and its rules', async () => {
    const service = new ProjectService(db)

    const created = await service.create(request())

    expect(created.name).toBe('InTime')
    expect(created.repository.absolutePath).toBe(repoPath)
    expect(created.repository.buildCommand).toBe('dotnet build')

    const detail = await service.get(created.id)
    expect(detail?.rules.map((rule) => rule.statement)).toEqual([
      'never modify migrations without approval',
    ])
    expect(detail?.rules.at(0)?.scope).toBe('project')
  })

  it('assigns its own id rather than trusting the caller', async () => {
    const service = new ProjectService(db)

    const first = await service.create(request({ name: 'One' }))
    const second = await service.create(request({ name: 'Two' }))

    // A renderer-supplied id could overwrite an existing project by guessing one.
    expect(first.id).not.toBe(second.id)
    expect(service.list()).toHaveLength(2)
  })

  it('refuses a path that is not a repository, with the reason', async () => {
    const plain = mkdtempSync(join(tmpdir(), 'forge-plain-'))
    const service = new ProjectService(db)

    try {
      await expect(service.create(request({ repositoryPath: plain }))).rejects.toThrow(
        /not a git repository/,
      )
      // Nothing may be left behind by a rejected create.
      expect(service.list()).toEqual([])
    } finally {
      rmSync(plain, { recursive: true, force: true })
    }
  })

  it('creates a project against a dirty repository', async () => {
    writeFileSync(join(repoPath, 'scratch.txt'), 'uncommitted\n')
    const service = new ProjectService(db)

    const created = await service.create(request())

    expect(created.id).toBeTruthy()
  })

  it('treats a blank command as absent rather than storing an empty string', async () => {
    const service = new ProjectService(db)

    const created = await service.create(request({ buildCommand: '   ', testCommand: null }))

    expect(created.repository.buildCommand).toBeNull()
    expect(created.repository.testCommand).toBeNull()
  })

  it('ignores blank rule lines from the textarea', async () => {
    const service = new ProjectService(db)

    const created = await service.create(request({ rules: ['keep this', '   ', ''] }))
    const detail = await service.get(created.id)

    expect(detail?.rules).toHaveLength(1)
  })

  it('reads repository state live, so a new commit is reflected', async () => {
    const service = new ProjectService(db)
    const created = await service.create(request())

    const before = await service.get(created.id)

    writeFileSync(join(repoPath, 'second.md'), '# second\n')
    git('add', '-A')
    git('commit', '--quiet', '-m', 'second')

    const after = await service.get(created.id)

    // A head SHA cached at creation would still report the first commit.
    expect(after?.probe?.headSha).not.toBe(before?.probe?.headSha)
    expect(after?.probe?.headSha).toBe(git('rev-parse', 'HEAD').trim())
  })

  it('reports a repository that has stopped existing as unavailable', async () => {
    const service = new ProjectService(db)
    const created = await service.create(request())

    rmSync(repoPath, { recursive: true, force: true })

    const detail = await service.get(created.id)

    // The project itself survives -- it is Forge's state, not the folder's.
    expect(detail?.project.name).toBe('InTime')
    expect(detail?.probe).toBeNull()
  })

  it('resolves null for an id that does not exist, and for a malformed one', async () => {
    const service = new ProjectService(db)

    await expect(service.get('550e8400-e29b-41d4-a716-446655440000')).resolves.toBeNull()
    await expect(service.get('not-a-uuid')).resolves.toBeNull()
  })
})

describe('restart', () => {
  it('restores the project, repository, and rules from disk', async () => {
    // The definition of done: create, quit, reopen, everything is still there.
    const created = await new ProjectService(db).create(request())
    closeDb()

    const reopened = initialiseDatabase(dbFile)
    closeDb = reopened.close

    const service = new ProjectService(reopened.db)
    const detail = await service.get(created.id)

    expect(service.list()).toHaveLength(1)
    expect(detail?.project.name).toBe('InTime')
    expect(detail?.project.repository.absolutePath).toBe(repoPath)
    expect(detail?.project.repository.tech).toEqual(['.NET 9', 'React'])
    expect(detail?.rules.map((rule) => rule.statement)).toEqual([
      'never modify migrations without approval',
    ])
  })

  it('rebuilds the same state from the event log alone', async () => {
    // Proves the projections are a cache: dropping and replaying must reproduce
    // exactly what was read before (axiom A1).
    const service = new ProjectService(db)
    const created = await service.create(request())

    const before = await service.get(created.id)

    new ProjectStore(db).rebuildAll()

    const after = await service.get(created.id)

    expect(after?.project).toEqual(before?.project)
    expect(after?.rules).toEqual(before?.rules)
  })
})
