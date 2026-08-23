import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ProjectView, WorkflowDetailView } from '@shared/ipc'
import { initialiseDatabase, type ForgeDatabase } from '../db'
import { ProjectService } from '../projects/projectService'
import { RuntimeRegistry } from '../runtimes/registry'
import { WorkflowService } from './workflowService'

function initRepository(directory: string): void {
  execFileSync('git', ['init', '--quiet', '--initial-branch=main', '.'], { cwd: directory })
  execFileSync('git', ['config', 'user.email', 'test@forge.local'], { cwd: directory })
  execFileSync('git', ['config', 'user.name', 'Forge Test'], { cwd: directory })
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: directory })
  writeFileSync(join(directory, 'package.json'), '{}\n')
  execFileSync('git', ['add', '-A'], { cwd: directory })
  execFileSync('git', ['commit', '--quiet', '-m', 'first'], { cwd: directory })
}

describe('WorkflowService', () => {
  let tempDir: string
  let dbHandle: { readonly db: ForgeDatabase; readonly close: () => void }
  let projects: ProjectService
  let workflows: WorkflowService

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'forge-workflow-service-test-'))
    const dbFile = join(tempDir, 'test.db')
    dbHandle = initialiseDatabase(dbFile)
    projects = new ProjectService(dbHandle.db)
    workflows = new WorkflowService({
      db: dbHandle.db,
      projects,
      packetDir: join(tempDir, 'packets'),
      registry: new RuntimeRegistry(),
    })
  })

  afterEach(() => {
    dbHandle.close()
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('lists workflows for a project', async () => {
    const repoPath = join(tempDir, 'repo')
    mkdirSync(repoPath, { recursive: true })
    initRepository(repoPath)

    const project: ProjectView = await projects.create({
      name: 'Test Project',
      repositoryPath: repoPath,
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: ['ts'],
      rules: [],
    })

    const initial = workflows.list(project.id)
    expect(initial).toEqual([])

    const started: WorkflowDetailView = await workflows.start({
      projectId: project.id,
      objective: 'Do math fix',
      autoRun: false,
    })

    expect(started.id).toBeDefined()
    expect(started.state).toBe('DISCOVERY')

    const list = workflows.list(project.id)
    expect(list).toHaveLength(1)
    expect(list[0]?.id).toBe(started.id)

    const active = workflows.getActive(project.id)
    expect(active?.id).toBe(started.id)

    const detail = workflows.get(started.id)
    expect(detail?.id).toBe(started.id)
  })

  it('cancels an active workflow', async () => {
    const repoPath = join(tempDir, 'repo2')
    mkdirSync(repoPath, { recursive: true })
    initRepository(repoPath)

    const project: ProjectView = await projects.create({
      name: 'Cancel Test Project',
      repositoryPath: repoPath,
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: [],
      rules: [],
    })

    const started: WorkflowDetailView = await workflows.start({
      projectId: project.id,
      autoRun: false,
    })

    const cancelled = workflows.cancel(started.id, 'User stopped')
    expect(cancelled?.state).toBe('CANCELLED')

    const fetched = workflows.get(started.id)
    expect(fetched?.state).toBe('CANCELLED')
  })
})
