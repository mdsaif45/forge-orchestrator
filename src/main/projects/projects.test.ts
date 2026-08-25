import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FORGE_DEFAULT_RULE_KEYS, projectIdSchema } from '@shared/domain'
import { removeTempDir } from '../../test/tempDir'
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
let dbDir: string
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

  dbDir = mkdtempSync(join(tmpdir(), 'forge-proj-db-'))
  dbFile = join(dbDir, 'forge.db')
  const opened = initialiseDatabase(dbFile)
  db = opened.db
  closeDb = opened.close
})

afterEach(async () => {
  closeDb()
  // git's child processes can still hold the repository directory when this runs,
  // which failed the *next* test rather than this one: the half-deleted tree left
  // `repoPath` present but without a `.git`, so the following case reported
  // NotARepositoryError against a directory it had just created.
  await removeTempDir(repoPath)
  // The directory, not just the `.db` file inside it: deleting the file alone left
  // one empty temp directory behind per test, every run.
  await removeTempDir(dbDir)
})

/** The stored form: canonical and POSIX-separated, matching git output. */
async function storedPath(): Promise<string> {
  // Taken from the probe rather than derived from `repoPath`: main canonicalises,
  // and Windows short names mean a locally recomputed value can differ. The
  // canonicalisation itself is asserted in its own test above.
  return (await validateRepository(repoPath)).path
}

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

  it('accepts a path whose spelling differs from what git reports', async () => {
    // Regression: `isRepo` compared `rev-parse --show-toplevel` against the caller's
    // string, so any equivalent-but-differently-spelled path was rejected as "not a
    // repository". This passed locally and failed on the Windows CI runner, whose
    // temp directory is an 8.3 short name that git resolves to its long form.
    // Trailing separators and mixed slashes are the same class of difference.
    const variants = [
      `${repoPath}${sep}`,
      repoPath.split('\\').join('/'),
      // Case only matters where the filesystem is case-insensitive.
      ...(process.platform === 'win32' ? [repoPath.toUpperCase()] : []),
    ]

    for (const variant of variants) {
      const probe = await validateRepository(variant)
      expect(probe.isRepository, variant).toBe(true)
    }
  })

  it('reports one stable path regardless of the spelling that was typed', async () => {
    // What gets stored must match what git reports, since scope globs and prompt
    // packets compare against git output later. The assertion is that every
    // spelling collapses to the *same* answer, rather than to a value recomputed
    // here: Node's realpath resolves symlinks but does not expand 8.3 short names,
    // so restating main's normalisation would just encode a different bug.
    const spellings = [repoPath, `${repoPath}${sep}`, repoPath.split('\\').join('/')]

    const paths = await Promise.all(
      spellings.map(async (spelling) => (await validateRepository(spelling)).path),
    )

    expect(new Set(paths).size).toBe(1)
    expect(paths[0]).not.toContain('\\')
    // Still the same directory, whatever spelling it settled on.
    expect(await realpath(paths[0] ?? '')).toBe(await realpath(repoPath))
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

  it('reports the default branch separately from the checkout, and lists branches', async () => {
    // The probe is what the create-project dialog renders, so this is the boundary
    // where the #100 defect became visible to the user: it offered the checked-out
    // branch as the only choice for "default branch".
    git('checkout', '--quiet', '-b', 'feature/visual-studio-extension')

    const probe = await validateRepository(repoPath)

    expect(probe.branch).toBe('feature/visual-studio-extension')
    expect(probe.defaultBranch).toBe('main')
    expect(probe.branches).toEqual(['feature/visual-studio-extension', 'main'])
  })
})

describe('ProjectService.create', () => {
  it('persists the project, its repository, and its rules', async () => {
    const service = new ProjectService(db)

    const created = await service.create(request())

    expect(created.name).toBe('InTime')
    expect(created.repository.absolutePath).toBe(await storedPath())
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
    expect(detail?.project.repository.absolutePath).toBe(await storedPath())
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

describe('the rules engine', () => {
  it('resolves Forge defaults for a project with no rules of its own', async () => {
    const service = new ProjectService(db)
    const created = await service.create(request({ rules: [] }))

    const detail = await service.get(created.id)

    expect(detail?.policy.map((entry) => entry.key)).toEqual([...FORGE_DEFAULT_RULE_KEYS].sort())
    // Nothing overrides anything, so every rule is inherited.
    expect(detail?.policy.every((entry) => entry.shadowed.length === 0)).toBe(true)
  })

  it('merges project rules alongside the defaults', async () => {
    const service = new ProjectService(db)
    const created = await service.create(request())

    const detail = await service.get(created.id)

    expect(detail?.policy).toHaveLength(FORGE_DEFAULT_RULE_KEYS.length + 1)
  })

  it('lets a project rule override a Forge default on the same key', async () => {
    const service = new ProjectService(db)
    const created = await service.create(request({ rules: [] }))

    const detail = await service.setRule(
      created.id,
      'project',
      'R4',
      'migrations may be modified in this project',
    )

    const r4 = detail?.policy.find((entry) => entry.key === 'R4')
    expect(r4?.scope).toBe('project')
    expect(r4?.statement).toBe('migrations may be modified in this project')
    // The global rule is retained as shadowed, so the UI can show what was replaced.
    expect(r4?.shadowed).toHaveLength(1)
    expect(r4?.shadowed.at(0)?.scope).toBe('global')
  })

  it('never drops a default, however many overrides are set', async () => {
    const service = new ProjectService(db)
    const created = await service.create(request({ rules: [] }))

    await service.setRule(created.id, 'project', 'R1', 'override one')
    const detail = await service.setRule(created.id, 'project', 'R7', 'override two')

    // An override replaces a statement; it cannot delete the concern.
    expect(detail?.policy.map((entry) => entry.key)).toEqual([...FORGE_DEFAULT_RULE_KEYS].sort())
  })

  it('replaces rather than duplicates when the same key is set twice', async () => {
    const service = new ProjectService(db)
    const created = await service.create(request({ rules: [] }))

    await service.setRule(created.id, 'project', 'custom', 'first')
    const detail = await service.setRule(created.id, 'project', 'custom', 'second')

    const matching = detail?.rules.filter((stored) => stored.key === 'custom') ?? []
    expect(matching).toHaveLength(1)
    expect(matching.at(0)?.statement).toBe('second')
  })

  it('restores the effective policy after a restart', async () => {
    const service = new ProjectService(db)
    const created = await service.create(request({ rules: [] }))
    await service.setRule(created.id, 'project', 'R4', 'migrations are fine here')
    closeDb()

    const reopened = initialiseDatabase(dbFile)
    closeDb = reopened.close

    const detail = await new ProjectService(reopened.db).get(created.id)
    const r4 = detail?.policy.find((entry) => entry.key === 'R4')

    expect(r4?.statement).toBe('migrations are fine here')
    expect(r4?.scope).toBe('project')
  })

  it('removes a stored rule, revealing the default it was hiding', async () => {
    const service = new ProjectService(db)
    const created = await service.create(request({ rules: [] }))

    const withOverride = await service.setRule(created.id, 'project', 'R4', 'anything goes')
    const ruleId = withOverride?.rules.find((stored) => stored.key === 'R4')?.id
    expect(ruleId).toBeDefined()
    if (ruleId === undefined) return

    const detail = await service.removeRule(created.id, ruleId)
    const r4 = detail?.policy.find((entry) => entry.key === 'R4')

    // Back to Forge's own statement, not absent.
    expect(r4?.scope).toBe('global')
    expect(r4?.shadowed).toHaveLength(0)
  })

  it('rejects a scope that is not in the model', async () => {
    const service = new ProjectService(db)
    const created = await service.create(request({ rules: [] }))

    await expect(service.setRule(created.id, 'universe', 'k', 'v')).rejects.toThrow(
      /not a rule scope/,
    )
  })

  it('declares a rule for every heading in docs/FORGE_RULES.md', () => {
    // A document that disagrees with the enforced policy is worse than no document,
    // so the two are compared rather than kept in sync by hand. Asserted here rather
    // than in `shared`, which may not read the filesystem.
    const doc = readFileSync('docs/FORGE_RULES.md', 'utf8')
    const documented = [...doc.matchAll(/^## (R\d+) —/gm)].map((match) => match[1])

    expect(documented.length).toBeGreaterThan(0)
    expect([...FORGE_DEFAULT_RULE_KEYS].sort()).toEqual([...documented].sort())
  })
})

describe('ProjectService.update', () => {
  async function existing(): Promise<{
    readonly projectId: string
    readonly service: ProjectService
  }> {
    const service = new ProjectService(db)
    const created = await service.create(request())
    return { projectId: created.id, service }
  }

  it('corrects a wrong default branch without losing the project', async () => {
    // The consequence #100 could not fix: a project bound mid-feature already stores
    // the wrong diff base, and deleting and recreating it would discard its history.
    const { projectId, service } = await existing()

    const detail = await service.update({ projectId, defaultBranch: 'main' })

    expect(detail?.project.repository.defaultBranch).toBe('main')
    expect(detail?.project.id).toBe(projectId)
  })

  it('sets build and test commands that were unknown at creation', async () => {
    // Frequently not known when a project is bound, and Forge cannot gather evidence
    // without them (A3) — which the workflow preflight now reports as blocking.
    const { projectId, service } = await existing()

    const detail = await service.update({
      projectId,
      buildCommand: 'npm run build',
      testCommand: 'npm test',
    })

    expect(detail?.project.repository.buildCommand).toBe('npm run build')
    expect(detail?.project.repository.testCommand).toBe('npm test')
  })

  it('leaves an omitted field alone but clears an explicit null', async () => {
    // Two different intents. Collapsing them would make it impossible to unset a
    // command once it had been set.
    const { projectId, service } = await existing()
    await service.update({ projectId, buildCommand: 'dotnet build', testCommand: 'dotnet test' })

    const detail = await service.update({ projectId, buildCommand: null })

    expect(detail?.project.repository.buildCommand).toBeNull()
    expect(detail?.project.repository.testCommand).toBe('dotnet test')
  })

  it('records the change as an event, so the log stays the source of truth', async () => {
    const { projectId, service } = await existing()
    await service.update({ projectId, defaultBranch: 'main', name: 'Renamed' })

    // Rebuilt purely from events: if the update had written the projection directly,
    // the rebuild would discard it and the old value would come back (A1).
    new ProjectStore(db).rebuild(projectIdSchema.parse(projectId))
    const detail = await service.get(projectId)

    expect(detail?.project.repository.defaultBranch).toBe('main')
    expect(detail?.project.name).toBe('Renamed')
  })

  it('refuses while a workflow is running, so the diff base cannot move mid-run', async () => {
    const service = new ProjectService(db, () => true)
    const created = await service.create(request({ name: 'Busy' }))

    await expect(service.update({ projectId: created.id, defaultBranch: 'main' })).rejects.toThrow(
      /running workflow/,
    )
  })

  it('resolves null for a project that does not exist', async () => {
    const service = new ProjectService(db)

    await expect(
      service.update({ projectId: '00000000-0000-4000-8000-000000000000', name: 'Ghost' }),
    ).resolves.toBeNull()
  })
})
