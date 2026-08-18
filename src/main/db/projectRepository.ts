import { eq } from 'drizzle-orm'
import {
  projectSchema,
  repositorySchema,
  type Project,
  type ProjectId,
  type Repository,
} from '@shared/domain'
import type { ForgeDatabase } from './connection'
import { fromJson, parseRow, toJson } from './rows'
import { projects, repositories } from './schema'
import { z } from 'zod'

/**
 * Reads and writes projects with their bound repository.
 *
 * A project and its repository are always loaded together: a project without a
 * repository cannot do anything, so exposing the halves separately would invite
 * callers to handle a state that should not exist.
 */
export class ProjectRepository {
  constructor(private readonly db: ForgeDatabase) {}

  /**
   * Inserts a project and its repository in one transaction.
   *
   * Both or neither: a project row without its repository would be exactly the
   * unusable state the combined read exists to avoid.
   */
  insert(project: Project): void {
    this.db.transaction((tx) => {
      tx.insert(projects)
        .values({
          id: project.id,
          name: project.name,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
        })
        .run()

      tx.insert(repositories)
        .values({
          id: project.repository.id,
          projectId: project.id,
          absolutePath: project.repository.absolutePath,
          defaultBranch: project.repository.defaultBranch,
          buildCommand: project.repository.buildCommand,
          testCommand: project.repository.testCommand,
          tech: toJson(project.repository.tech),
        })
        .run()
    })
  }

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

  updateName(id: ProjectId, name: string, updatedAt: string): void {
    this.db.update(projects).set({ name, updatedAt }).where(eq(projects.id, id)).run()
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
