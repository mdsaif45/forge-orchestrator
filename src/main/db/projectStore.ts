import type { Actor, Project, ProjectId, Rule, RuleId } from '@shared/domain'
import type { ForgeDatabase } from './connection'
import { EventStore } from './eventStore'
import { applyEvent, rebuildProjections } from './projections'
import { ProjectRepository } from './projectRepository'

/**
 * The command layer for projects.
 *
 * Every mutation goes append-then-project: the event is written first and the read
 * model is derived from it, so the log is the source of truth rather than a
 * parallel record that can disagree (axiom A1).
 *
 * `ProjectRepository` stays read-only from here on. Writing directly to a
 * projected table would produce state with no event behind it — invisible to the
 * audit trail, and destroyed by the next rebuild.
 */
export class ProjectStore {
  private readonly events: EventStore
  private readonly reader: ProjectRepository

  constructor(private readonly db: ForgeDatabase) {
    this.events = new EventStore(db)
    this.reader = new ProjectRepository(db)
  }

  /**
   * Creates a project and binds its repository.
   *
   * Two events in one transaction: a project without a repository is unusable, so
   * no observer should ever see that intermediate state.
   */
  create(project: Project, actor: Actor): void {
    this.db.transaction(() => {
      const appended = this.events.appendMany(
        [
          {
            type: 'project.created',
            payload: { name: project.name, createdAt: project.createdAt },
          },
          {
            type: 'repository.bound',
            payload: { repository: project.repository },
          },
        ],
        { projectId: project.id, actor, occurredAt: project.createdAt },
      )

      for (const event of appended) {
        applyEvent(this.db, event)
      }
    })
  }

  rename(projectId: ProjectId, name: string, actor: Actor, occurredAt: string): void {
    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'project.updated', payload: { name, updatedAt: occurredAt } },
        { projectId, actor, occurredAt },
      )

      applyEvent(this.db, event)
    })
  }

  setRule(projectId: ProjectId, rule: Rule, actor: Actor, reason?: string): void {
    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'rule.set', payload: { rule } },
        {
          projectId,
          actor,
          occurredAt: rule.createdAt,
          ...(reason === undefined ? {} : { reason }),
        },
      )

      applyEvent(this.db, event)
    })
  }

  removeRule(projectId: ProjectId, ruleId: RuleId, actor: Actor, occurredAt: string): void {
    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'rule.removed', payload: { ruleId } },
        { projectId, actor, occurredAt },
      )

      applyEvent(this.db, event)
    })
  }

  findById(projectId: ProjectId): Project | null {
    return this.reader.findById(projectId)
  }

  list(): readonly Project[] {
    return this.reader.list()
  }

  /**
   * Rebuilds a project's read models from its events.
   *
   * The read models are a cache; this is the proof of that. Used by the replay
   * test, and available for recovery if a projection is ever found to be wrong.
   */
  rebuild(projectId: ProjectId): void {
    rebuildProjections(this.db, projectId, this.events.read(projectId))
  }

  /** Rebuilds every project, for a schema change that alters a read model. */
  rebuildAll(): void {
    for (const projectId of this.events.projectIds()) {
      this.rebuild(projectId)
    }
  }
}
