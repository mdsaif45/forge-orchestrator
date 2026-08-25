import { randomUUID } from 'node:crypto'
import {
  FORGE_DEFAULT_RULES,
  projectIdSchema,
  repositoryIdSchema,
  resolveEffectivePolicy,
  ruleScopeSchema,
  ruleIdSchema,
  type EffectiveRule,
  type Project,
  type ProjectId,
  type Repository,
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
  private readonly hasRunningWorkflow: (projectId: string) => boolean

  /**
   * `hasRunningWorkflow` is injected rather than resolved from a workflow service.
   *
   * Projects are the lower layer — workflows already depend on this service, so
   * depending back on them would make the cycle real rather than merely awkward. A
   * predicate keeps the direction one-way, and lets a test state the condition
   * directly instead of standing up an orchestrator to imply it.
   */
  constructor(db: ForgeDatabase, hasRunningWorkflow?: (projectId: string) => boolean) {
    this.store = new ProjectStore(db)
    this.rules = new RuleRepository(db)
    this.hasRunningWorkflow = hasRunningWorkflow ?? (() => false)
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

  /**
   * Sets one rule at one scope, then returns the project's new state.
   *
   * The (scope, key) pair is the identity: setting `R4` at project scope overrides
   * the global default rather than adding a second rule beside it, and setting it
   * again replaces it. The projection's upsert enforces that, so an override cannot
   * silently become a duplicate.
   *
   * Returning the whole detail rather than the rule means the caller re-reads the
   * resolved policy in the same round trip — the alternative is a renderer that
   * patches its own copy and drifts from what the resolver would say.
   */
  async setRule(
    rawProjectId: string,
    scope: string,
    key: string,
    statement: string,
  ): Promise<ProjectDetail | null> {
    const parsedProject = projectIdSchema.safeParse(rawProjectId)
    const parsedScope = ruleScopeSchema.safeParse(scope)

    if (!parsedProject.success) return null
    if (!parsedScope.success) {
      throw new Error(`"${scope}" is not a rule scope`)
    }

    const projectId = parsedProject.data
    if (this.store.findById(projectId) === null) return null

    const existing = this.rules.findByKey(projectId, parsedScope.data, key)

    this.store.setRule(
      projectId,
      {
        // Reuses the existing id when overwriting, so the event log reads as one
        // rule changing rather than a new rule appearing at the same coordinates.
        id: existing?.id ?? ruleIdSchema.parse(randomUUID()),
        scope: parsedScope.data,
        key,
        statement: statement.trim(),
        source: 'settings',
        createdAt: existing?.createdAt ?? new Date().toISOString(),
      },
      'user',
    )

    return this.get(rawProjectId)
  }

  async removeRule(rawProjectId: string, rawRuleId: string): Promise<ProjectDetail | null> {
    const parsedProject = projectIdSchema.safeParse(rawProjectId)
    const parsedRule = ruleIdSchema.safeParse(rawRuleId)

    if (!parsedProject.success || !parsedRule.success) return null

    this.store.removeRule(parsedProject.data, parsedRule.data, 'user', new Date().toISOString())

    return this.get(rawProjectId)
  }

  /**
   * The effective policy for a project: Forge's defaults plus its stored rules.
   *
   * Resolved on read rather than stored, because the answer is a function of the
   * rules that exist right now — caching it would mean a rule change that does not
   * take effect until something invalidates the cache.
   *
   * The global defaults are code constants (`FORGE_DEFAULT_RULES`), not rows: they
   * are Forge's own policy, they must be present for the axioms to mean anything,
   * and a narrower scope may override one but nothing can delete it.
   */
  resolvePolicy(projectId: ProjectId): readonly EffectiveRule[] {
    return resolveEffectivePolicy([...FORGE_DEFAULT_RULES, ...this.rules.listForProject(projectId)])
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
  /**
   * Changes a project name and its repository settings.
   *
   * Not the repository path. Pointing a project at a different repository would
   * invalidate every recorded path, diff base, and changeset, so that is a new
   * project rather than an edit — refusing is more honest than silently corrupting
   * what the log means.
   *
   * Refused while a workflow is running: `defaultBranch` is the base a diff is
   * measured against, and moving it mid-run would change what "changed" means
   * halfway through the very comparison it feeds.
   */
  async update(request: {
    readonly projectId: string
    readonly name?: string | undefined
    readonly defaultBranch?: string | undefined
    readonly buildCommand?: string | null | undefined
    readonly testCommand?: string | null | undefined
    readonly tech?: readonly string[] | undefined
  }): Promise<ProjectDetail | null> {
    const projectId = projectIdSchema.parse(request.projectId)

    if (this.hasRunningWorkflow(projectId)) {
      throw new Error(
        'This project has a running workflow. Cancel or finish it before changing settings, so the diff base cannot move mid-run.',
      )
    }

    const existing = this.store.findById(projectId)
    if (existing === null) return null

    const now = new Date().toISOString()

    const name = request.name?.trim()
    if (name !== undefined && name !== '' && name !== existing.name) {
      this.store.rename(projectId, name, 'user', now)
    }

    // Absent means "leave it", which is different from null meaning "clear it" —
    // collapsing the two would make it impossible to unset a build command.
    const repository: Repository = {
      ...existing.repository,
      defaultBranch: request.defaultBranch?.trim() ?? existing.repository.defaultBranch,
      buildCommand:
        request.buildCommand === undefined
          ? existing.repository.buildCommand
          : emptyToNull(request.buildCommand),
      testCommand:
        request.testCommand === undefined
          ? existing.repository.testCommand
          : emptyToNull(request.testCommand),
      tech:
        request.tech === undefined
          ? existing.repository.tech
          : request.tech.map((tag) => tag.trim()).filter((tag) => tag !== ''),
    }

    this.store.updateRepository(projectId, repository, 'user', now)

    return this.get(projectId)
  }

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
      policy: this.resolvePolicy(projectId),
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
