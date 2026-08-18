import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { sql } from 'drizzle-orm'
import type { Project, ProjectId } from '@shared/domain'
import { initialiseDatabase, openDatabase, readAppliedCount, readPragmas, runMigrations } from '.'
import { MIGRATIONS } from './migrations.generated'
import { ProjectRepository } from './projectRepository'
import { projects, repositories } from './schema'

const NOW = '2026-08-18T12:00:00.000Z'
const PROJECT_ID = '550e8400-e29b-41d4-a716-446655440000' as ProjectId
const REPO_ID = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'

function sampleProject(overrides: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID,
    name: 'InTime',
    repository: {
      id: REPO_ID as Project['repository']['id'],
      absolutePath: 'D:/Projects/InTime',
      defaultBranch: 'develop',
      buildCommand: 'dotnet build',
      testCommand: 'dotnet test',
      tech: ['.NET 9', 'React'],
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  }
}

describe('migrations', () => {
  it('creates every table on an empty database', () => {
    const { db, close } = openDatabase({ file: ':memory:' })

    try {
      const applied = runMigrations(db, MIGRATIONS)
      expect(applied).toBe(MIGRATIONS.length)

      const tables = db
        .all<{ name: string }>(sql`SELECT name FROM sqlite_master WHERE type = 'table'`)
        .map((row) => row.name)
        .sort()

      expect(tables).toContain('projects')
      expect(tables).toContain('events')
      expect(tables).toContain('workflows')
      expect(tables).toContain('schema_meta')
    } finally {
      close()
    }
  })

  it('is a no-op on a second run', () => {
    const { db, close } = openDatabase({ file: ':memory:' })

    try {
      expect(runMigrations(db, MIGRATIONS)).toBe(MIGRATIONS.length)
      // The whole point of recording a version: reopening must not reapply.
      expect(runMigrations(db, MIGRATIONS)).toBe(0)
      expect(readAppliedCount(db)).toBe(MIGRATIONS.length)
    } finally {
      close()
    }
  })

  it('leaves the version unchanged when a migration fails', () => {
    const { db, close } = openDatabase({ file: ':memory:' })

    try {
      runMigrations(db, MIGRATIONS)
      const before = readAppliedCount(db)

      expect(() =>
        runMigrations(db, [...MIGRATIONS, { tag: '9999_broken', sql: 'THIS IS NOT SQL' }]),
      ).toThrow()

      // A half-applied migration would leave the database at a version that
      // describes neither the old nor the new schema.
      expect(readAppliedCount(db)).toBe(before)
    } finally {
      close()
    }
  })

  it('inlines the SQL rather than reading it from disk at runtime', () => {
    // A packaged app has no migrations directory, so the SQL must be in the bundle.
    expect(MIGRATIONS.length).toBeGreaterThan(0)
    expect(MIGRATIONS[0]?.sql).toContain('CREATE TABLE')
  })
})

describe('pragmas', () => {
  it('enables foreign keys, without which the schema cascades do nothing', () => {
    const { sqlite, close } = openDatabase({ file: ':memory:' })

    try {
      expect(readPragmas(sqlite).foreignKeys).toBe(1)
    } finally {
      close()
    }
  })

  it('uses WAL for a file-backed database', () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-db-'))
    const { sqlite, close } = openDatabase({ file: join(directory, 'forge.db') })

    try {
      expect(readPragmas(sqlite).journalMode).toBe('wal')
    } finally {
      close()
      rmSync(directory, { recursive: true, force: true })
    }
  })
})

describe('foreign keys', () => {
  it('rejects a repository pointing at a project that does not exist', () => {
    const { db, close } = openDatabase({ file: ':memory:' })

    try {
      runMigrations(db, MIGRATIONS)

      expect(() =>
        db
          .insert(repositories)
          .values({
            id: REPO_ID,
            projectId: 'no-such-project',
            absolutePath: 'D:/nowhere',
            defaultBranch: 'main',
            buildCommand: null,
            testCommand: null,
            tech: '[]',
          })
          .run(),
      ).toThrow(/FOREIGN KEY/i)
    } finally {
      close()
    }
  })

  it('cascades a delete from project to repository', () => {
    const { db, close } = openDatabase({ file: ':memory:' })

    try {
      runMigrations(db, MIGRATIONS)
      new ProjectRepository(db).insert(sampleProject())

      db.delete(projects).run()

      expect(db.select().from(repositories).all()).toHaveLength(0)
    } finally {
      close()
    }
  })
})

describe('ProjectRepository', () => {
  let database: ReturnType<typeof openDatabase>
  let repository: ProjectRepository

  beforeEach(() => {
    database = openDatabase({ file: ':memory:' })
    runMigrations(database.db, MIGRATIONS)
    repository = new ProjectRepository(database.db)
  })

  afterEach(() => {
    database.close()
  })

  it('round-trips a project unchanged', () => {
    const project = sampleProject()
    repository.insert(project)

    expect(repository.findById(PROJECT_ID)).toEqual(project)
  })

  it('preserves null commands rather than coercing them', () => {
    const project = sampleProject({
      repository: { ...sampleProject().repository, buildCommand: null, testCommand: null },
    })
    repository.insert(project)

    const loaded = repository.findById(PROJECT_ID)

    expect(loaded?.repository.buildCommand).toBeNull()
    expect(loaded?.repository.testCommand).toBeNull()
  })

  it('round-trips the tech array through JSON', () => {
    repository.insert(sampleProject())

    expect(repository.findById(PROJECT_ID)?.repository.tech).toEqual(['.NET 9', 'React'])
  })

  it('returns null for an unknown project', () => {
    expect(repository.findById('7c9e6679-7425-40de-944b-e07fc1f90ae7' as ProjectId)).toBeNull()
  })

  it('lists projects', () => {
    repository.insert(sampleProject())

    expect(repository.list()).toHaveLength(1)
  })

  it('updates a name', () => {
    repository.insert(sampleProject())
    repository.updateName(PROJECT_ID, 'Renamed', '2026-08-19T00:00:00.000Z')

    const loaded = repository.findById(PROJECT_ID)

    expect(loaded?.name).toBe('Renamed')
    expect(loaded?.updatedAt).toBe('2026-08-19T00:00:00.000Z')
  })

  it('rolls back the project when the repository insert fails', () => {
    // Both rows or neither: a project without its repository is unusable.
    const project = sampleProject()
    repository.insert(project)

    expect(() => {
      repository.insert(project)
    }).toThrow()

    expect(repository.list()).toHaveLength(1)
  })

  it('rejects a row that violates a domain invariant on read', () => {
    repository.insert(sampleProject())

    // Simulates a row written by an older version, or edited by hand. Parsing on
    // read means it fails here with a precise message rather than flowing into the
    // application as a plausible-looking object.
    database.db.run(sql`UPDATE repositories SET default_branch = ''`)

    expect(() => repository.findById(PROJECT_ID)).toThrow(/repositories row/)
  })

  it('rejects malformed JSON in a structured column', () => {
    repository.insert(sampleProject())
    database.db.run(sql`UPDATE repositories SET tech = 'not json'`)

    expect(() => repository.findById(PROJECT_ID)).toThrow(/repositories\.tech/)
  })
})

describe('initialiseDatabase', () => {
  it('creates and migrates a file, then reopens without reapplying', () => {
    const directory = mkdtempSync(join(tmpdir(), 'forge-db-'))
    const file = join(directory, 'forge.db')

    try {
      const first = initialiseDatabase(file)
      expect(first.applied).toBe(MIGRATIONS.length)
      new ProjectRepository(first.db).insert(sampleProject())
      first.close()

      // Restarting the app must find its data and apply nothing.
      const second = initialiseDatabase(file)
      expect(second.applied).toBe(0)
      expect(new ProjectRepository(second.db).findById(PROJECT_ID)?.name).toBe('InTime')
      second.close()
    } finally {
      rmSync(directory, { recursive: true, force: true })
    }
  })
})
