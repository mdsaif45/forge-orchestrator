import { eq } from 'drizzle-orm'
import type { DomainEvent, EventPayloads, EventType, ProjectId } from '@shared/domain'
import type { ForgeDatabase } from './connection'
import { projects, repositories, rules } from './schema'
import { toJson } from './rows'

/**
 * Read models, derived from the event log.
 *
 * The tables these write are a cache: they can be dropped and rebuilt from events
 * alone, which is the property that makes the log authoritative rather than
 * decorative. A test asserts the rebuild reproduces byte-identical rows.
 *
 * Only the entities #18 needs are projected here. Each remaining entity gets its
 * projection with the feature that reads it, so an unused read model cannot drift
 * unnoticed.
 */

/** Narrows an event to a specific type, so the payload type follows. */
function isType<T extends EventType>(
  event: DomainEvent,
  type: T,
): event is DomainEvent & { type: T; payload: EventPayloads[T] } {
  return event.type === type
}

/**
 * Applies one event to the read models.
 *
 * Exhaustive over `EventType` by construction: the `default` branch throws on an
 * unhandled type rather than ignoring it, because a silently skipped event means a
 * projection that quietly disagrees with the log.
 */
export function applyEvent(db: ForgeDatabase, event: DomainEvent): void {
  if (isType(event, 'project.created')) {
    db.insert(projects)
      .values({
        id: event.projectId,
        name: event.payload.name,
        createdAt: event.payload.createdAt,
        updatedAt: event.payload.createdAt,
      })
      .onConflictDoUpdate({
        target: projects.id,
        set: { name: event.payload.name, updatedAt: event.payload.createdAt },
      })
      .run()
    return
  }

  if (isType(event, 'project.updated')) {
    db.update(projects)
      .set({ name: event.payload.name, updatedAt: event.payload.updatedAt })
      .where(eq(projects.id, event.projectId))
      .run()
    return
  }

  if (isType(event, 'repository.bound')) {
    const repository = event.payload.repository
    db.insert(repositories)
      .values({
        id: repository.id,
        projectId: event.projectId,
        absolutePath: repository.absolutePath,
        defaultBranch: repository.defaultBranch,
        buildCommand: repository.buildCommand,
        testCommand: repository.testCommand,
        tech: toJson(repository.tech),
      })
      .onConflictDoUpdate({
        target: repositories.id,
        set: {
          absolutePath: repository.absolutePath,
          defaultBranch: repository.defaultBranch,
          buildCommand: repository.buildCommand,
          testCommand: repository.testCommand,
          tech: toJson(repository.tech),
        },
      })
      .run()
    return
  }

  if (isType(event, 'rule.set')) {
    const rule = event.payload.rule
    db.insert(rules)
      .values({
        id: rule.id,
        projectId: event.projectId,
        scope: rule.scope,
        key: rule.key,
        statement: rule.statement,
        source: rule.source,
        createdAt: rule.createdAt,
      })
      .onConflictDoUpdate({
        target: [rules.projectId, rules.scope, rules.key],
        set: { statement: rule.statement, source: rule.source, id: rule.id },
      })
      .run()
    return
  }

  if (isType(event, 'rule.removed')) {
    db.delete(rules).where(eq(rules.id, event.payload.ruleId)).run()
    return
  }

  // Everything else is recorded in the log but has no read model yet. This is a
  // deliberate no-op rather than an error: the events are still replayable, and
  // their projections arrive with the features that read them.
  if (PROJECTED_LATER.has(event.type)) return

  throw new Error(`No projection for event type "${event.type}"`)
}

/**
 * Event types that are logged now and projected later, with the issue that will
 * do it. Listing them explicitly means a genuinely unknown type still throws.
 */
const PROJECTED_LATER: ReadonlySet<EventType> = new Set([
  'binding.set', // #31
  'decision.proposed', // #40
  'decision.approved', // #40
  'decision.locked', // #40
  'decision.superseded', // #40
  'question.asked', // #38
  'question.answered', // #38
  'task.created', // #35
  'workflow.started', // #27
  'workflow.transitioned', // #27
  'workflow.checkpointed', // #28
  'workflow.halted', // #29
  'workflow.finished', // #27
  'step.started', // #27
  'step.finished', // #27
  'changeset.captured', // #34
  'changeset.reviewed', // #36
  'evidence.recorded', // #33
])

/**
 * Rebuilds every read model for a project from its events.
 *
 * Deletes the projected rows first, so the result depends only on the log. If a
 * rebuild produced different output from the incremental path, one of the two is
 * wrong — and the test that compares them is how that gets caught.
 */
export function rebuildProjections(
  db: ForgeDatabase,
  projectId: ProjectId,
  events: readonly DomainEvent[],
): void {
  db.transaction((tx) => {
    // Cascades from `projects` remove repositories and rules, so this one delete
    // clears the whole projected tree.
    tx.delete(projects).where(eq(projects.id, projectId)).run()

    for (const event of events) {
      applyEvent(tx, event)
    }
  })
}
