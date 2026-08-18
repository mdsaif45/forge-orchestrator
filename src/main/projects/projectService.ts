import { randomUUID } from 'node:crypto'
import {
  projectIdSchema,
  repositoryIdSchema,
  ruleIdSchema,
  type Project,
  type ProjectId,
  type Rule,
} from '@shared/domain'
import type { CreateProjectRequest, ProjectDetail, ProjectView, RuleView } from '@shared/ipc'
import type { ForgeDatabase } from '../db'
import { ProjectStore } from '../db/projectStore'
import { RuleRepository } from '../db/ruleRepository'
import { validateRepository } from './validateRepository'

/**
 * The application layer for projects.
 *
 * Ids and timestamps are assigned here rather than accepted from the renderer: the
 * renderer is untrusted input, and a client-supplied id would let it overwrite an
 * existing project by guessing one. Forge owns the identity of what it stores
 * (axiom A1).
 */
export class ProjectService {
  private readonly store: ProjectStore
  private readonly rules: RuleRepository

  constructor(db: ForgeDatabase) {
    this.store = new ProjectStore(db)
    this.rules = new RuleRepository(db)
  }

  /**
   * Creates a project, binds its repository, and records its initial rules.
   *
   * The repository is probed first and a genuine blocker refuses the create — a
   * project bound to a path that is not a repository could never run a workflow, so
   * persisting it would only produce a broken row to clean up later. A dirty
   * worktree is deliberately *not* a blocker: work in progress is normal, and the
   * refusal that matters is `GitService.snapshot()` when a base SHA is captured.
   */
  async create(request: CreateProjectRequest): Promise<ProjectView> {
    const probe = await validateRepository(request.repositoryPath)

    if (!probe.isRepository) {
      const reason = probe.problems.at(0)?.detail ?? 'The folder is not a git repository.'
      throw new Error(reason)
    }

    const now = new Date().toISOString()
    const projectId = projectIdSchema.parse(randomUUID())

    const project: Project = {
      id: projectId,
      name: request.name.trim(),
      repository: {
        id: repositoryIdSchema.parse(randomUUID()),
        // The probe's normalised path, not the raw input: it is trimmed and has
        // been confirmed to be the repository root.
        absolutePath: probe.path,
        defaultBranch: request.defaultBranch.trim(),
        buildCommand: emptyToNull(request.buildCommand),
        testCommand: emptyToNull(request.testCommand),
        tech: request.tech.map((tag) => tag.trim()).filter((tag) => tag !== ''),
      },
      createdAt: now,
      updatedAt: now,
    }

    this.store.create(project, 'user')

    // Rules are separate events so each can later be superseded or removed on its
    // own, and so the log shows which rules existed when a workflow ran.
    request.rules.forEach((statement, index) => {
      const trimmed = statement.trim()
      if (trimmed === '') return

      const rule: Rule = {
        id: ruleIdSchema.parse(randomUUID()),
        scope: 'project',
        // Positional key: these arrive as free text with no natural identifier, and
        // a stable key is what lets a narrower scope override the same concern.
        key: `project.rule.${String(index + 1)}`,
        statement: trimmed,
        source: 'project creation',
        createdAt: now,
      }

      this.store.setRule(projectId, rule, 'user')
    })

    return toProjectView(project)
  }

  list(): readonly ProjectView[] {
    return this.store.list().map(toProjectView)
  }

  /**
   * Loads one project with its rules and a fresh look at its repository.
   *
   * The repository state is probed on every read rather than cached at creation:
   * the branch moves, commits land, and the folder can be deleted entirely between
   * one open and the next. A stored copy would be a second truth that quietly goes
   * stale (axiom A1).
   */
  async get(rawProjectId: string): Promise<ProjectDetail | null> {
    const parsed = projectIdSchema.safeParse(rawProjectId)
    if (!parsed.success) return null

    const projectId: ProjectId = parsed.data
    const project = this.store.findById(projectId)
    if (project === null) return null

    const probe = await validateRepository(project.repository.absolutePath)

    return {
      project: toProjectView(project),
      rules: this.rules.listForProject(projectId).map(toRuleView),
      // A path that has stopped being a repository is reported as null rather than
      // as a probe full of problems, so the UI can say "the repository is missing"
      // instead of listing reasons a folder failed validation.
      probe: probe.isRepository ? probe : null,
    }
  }
}

/** Treats a blank command as absent, since the form submits empty strings. */
function emptyToNull(value: string | null): string | null {
  if (value === null) return null
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

function toProjectView(project: Project): ProjectView {
  return {
    id: project.id,
    name: project.name,
    repository: {
      id: project.repository.id,
      absolutePath: project.repository.absolutePath,
      defaultBranch: project.repository.defaultBranch,
      buildCommand: project.repository.buildCommand,
      testCommand: project.repository.testCommand,
      tech: project.repository.tech,
    },
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
  }
}

function toRuleView(rule: Rule): RuleView {
  return {
    id: rule.id,
    scope: rule.scope,
    key: rule.key,
    statement: rule.statement,
    source: rule.source,
    createdAt: rule.createdAt,
  }
}
