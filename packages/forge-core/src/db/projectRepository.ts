import { eq } from 'drizzle-orm'
import {
  projectSchema,
  repositorySchema,
  type Project,
  type ProjectId,
  type Repository,
} from '@shared/domain'
import type { ForgeDatabase } from './connection'
import { fromJson, parseRow } from './rows'
import { projects, repositories } from './schema'
import { z } from 'zod'

/**
 * Reads projects with their bound repository.
 *
 * **Read-only by design.** Every mutation goes through `ProjectStore`, which
 * appends an event and then projects it. A write here would produce state with no
 * event behind it — invisible to the audit trail, and erased by the next rebuild
 * (axiom A1). The projection in `projections.ts` is the only writer of these
 * tables.
 *
 * A project and its repository are always loaded together: a project without a
 * repository cannot do anything, so exposing the halves separately would invite
 * callers to handle a state that should not exist.
 */
export class ProjectRepository {
  constructor(private readonly db: ForgeDatabase) {}

  findById(id: ProjectId): Project | null {
    const rows = this.db
      .select()
      .from(projects)
      .innerJoin(repositories, eq(repositories.projectId, projects.id))
      .where(eq(projects.id, id))
      .all()

    const row = rows.at(0)
    return row === undefined ? null : this.toDomain(row)
  }

  list(): readonly Project[] {
    return this.db
      .select()
      .from(projects)
      .innerJoin(repositories, eq(repositories.projectId, projects.id))
      .all()
      .map((row) => this.toDomain(row))
  }

  /**
   * Assembles the domain object and validates it.
   *
   * Parsing on the way *out* is the point: it means a row written by an older
   * version, or edited by hand, fails here with a precise message rather than
   * flowing into the application as a plausible-looking object.
   */
  private toDomain(row: {
    projects: typeof projects.$inferSelect
    repositories: typeof repositories.$inferSelect
  }): Project {
    const repository: Repository = parseRow(
      repositorySchema,
      {
        id: row.repositories.id,
        absolutePath: row.repositories.absolutePath,
        defaultBranch: row.repositories.defaultBranch,
        buildCommand: row.repositories.buildCommand,
        testCommand: row.repositories.testCommand,
        tech: fromJson(z.array(z.string()), row.repositories.tech, 'repositories.tech'),
      },
      'repositories row',
    )

    return parseRow(
      projectSchema,
      {
        id: row.projects.id,
        name: row.projects.name,
        repository,
        createdAt: row.projects.createdAt,
        updatedAt: row.projects.updatedAt,
      },
      'projects row',
    )
  }
}
