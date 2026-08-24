import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initialiseDatabase, type ForgeDatabase } from '../db'
import { BindingStore } from '../db/bindingStore'
import { EventStore } from '../db/eventStore'
import { ProjectService } from '../projects/projectService'
import { MockAgentRuntime } from '../runtimes/mockRuntime'
import { RuntimeRegistry } from '../runtimes/registry'
import { SCENARIOS } from '../runtimes/scenario'
import { removeTempDir } from '../../test/tempDir'
import { BindingService } from './bindingService'

/**
 * Role bindings, through the event log to the read model.
 *
 * The `agent_bindings` table existed from M1 but nothing wrote to it, and
 * `resolveBindings` hardcoded every role to one runtime — so A6's role-to-runtime
 * seam was real in the types and absent in practice (#102). These tests exercise the
 * real database, because the claim is that a binding survives a restart, and a mocked
 * store would only prove the mock was called.
 */

let repoPath: string
let dbDir: string
let db: ForgeDatabase
let closeDb: () => void
let projectId: string

function registry(): RuntimeRegistry {
  const created = new RuntimeRegistry()
  created.register(new MockAgentRuntime({ scenario: SCENARIOS.fullRun, id: 'mock:default' }))
  created.register(new MockAgentRuntime({ scenario: SCENARIOS.fullRun, id: 'mock:second' }))
  return created
}

beforeEach(async () => {
  repoPath = mkdtempSync(join(tmpdir(), 'forge-binding-repo-'))
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', '.'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: repoPath })
  execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: repoPath })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: repoPath })
  writeFileSync(join(repoPath, 'README.md'), '# test\n')
  execFileSync('git', ['add', '-A'], { cwd: repoPath })
  execFileSync('git', ['commit', '--quiet', '-m', 'first'], { cwd: repoPath })

  dbDir = mkdtempSync(join(tmpdir(), 'forge-binding-db-'))
  const opened = initialiseDatabase(join(dbDir, 'forge.db'))
  db = opened.db
  closeDb = opened.close

  const project = await new ProjectService(db).create({
    name: 'Bound',
    repositoryPath: repoPath,
    defaultBranch: 'main',
    buildCommand: null,
    testCommand: null,
    tech: [],
    rules: [],
  })
  projectId = project.id
})

afterEach(async () => {
  closeDb()
  await removeTempDir(repoPath)
  await removeTempDir(dbDir)
})

describe('BindingService', () => {
  it('offers every assignable role, unbound to begin with', () => {
    const service = new BindingService(new BindingStore(db, new EventStore(db)), registry())

    const { roles } = service.list(projectId)

    expect(roles.map((entry) => entry.role)).toEqual(['planner', 'implementer', 'reviewer'])
    // Unbound is null, not a fabricated default: the page has to be able to say a role
    // has not been configured.
    expect(roles.every((entry) => entry.binding === null)).toBe(true)
  })

  it('persists a binding and reads it back', () => {
    const service = new BindingService(new BindingStore(db, new EventStore(db)), registry())

    service.set({ projectId, role: 'planner', runtimeId: 'mock:second' })

    const planner = service.list(projectId).roles.find((entry) => entry.role === 'planner')
    expect(planner?.binding?.runtimeId).toBe('mock:second')
    // Other roles are untouched — binding one role must not implicitly bind the rest.
    const implementer = service.list(projectId).roles.find((entry) => entry.role === 'implementer')
    expect(implementer?.binding).toBeNull()
  })

  it('replaces rather than accumulates when a role is re-bound', () => {
    const store = new BindingStore(db, new EventStore(db))
    const service = new BindingService(store, registry())

    service.set({ projectId, role: 'planner', runtimeId: 'mock:default' })
    service.set({ projectId, role: 'planner', runtimeId: 'mock:second' })

    // One row per (project, role). The history of what it used to be lives in the
    // event log, which is where A1 says it belongs.
    const stored = store.list(projectIdOf())
    expect(stored.filter((binding) => binding.role === 'planner')).toHaveLength(1)
    expect(stored.find((binding) => binding.role === 'planner')?.runtimeId).toBe('mock:second')
  })

  it('survives a restart, because the binding is an event and not just a row', () => {
    const service = new BindingService(new BindingStore(db, new EventStore(db)), registry())
    service.set({ projectId, role: 'reviewer', runtimeId: 'mock:second' })

    closeDb()
    const reopened = initialiseDatabase(join(dbDir, 'forge.db'))
    db = reopened.db
    closeDb = reopened.close

    const after = new BindingService(new BindingStore(db, new EventStore(db)), registry())
    const reviewer = after.list(projectId).roles.find((entry) => entry.role === 'reviewer')

    expect(reviewer?.binding?.runtimeId).toBe('mock:second')
  })

  it('reports a simulated runtime as simulated', () => {
    const service = new BindingService(new BindingStore(db, new EventStore(db)), registry())

    service.set({ projectId, role: 'implementer', runtimeId: 'mock:default' })

    const implementer = service.list(projectId).roles.find((entry) => entry.role === 'implementer')
    // #101's rule reaches this page too: a mock must never look like real work.
    expect(implementer?.binding?.simulated).toBe(true)
  })
})

/** The project id, typed for the store's stricter parameter. */
function projectIdOf(): Parameters<BindingStore['list']>[0] {
  return projectId as Parameters<BindingStore['list']>[0]
}
