import { and, asc, eq } from 'drizzle-orm'
import { ruleSchema, type ProjectId, type Rule } from '@shared/domain'
import type { ForgeDatabase } from './connection'
import { parseRow } from './rows'
import { rules } from './schema'

/**
 * Reads rules.
 *
 * **Read-only by design**, for the same reason as `ProjectRepository`: rules are
 * projected from `rule.set` and `rule.removed` events, so a write here would create
 * state with no event behind it and be erased by the next rebuild (axiom A1).
 *
 * Scope resolution — global through task, most specific winning — is #19's job. This
 * only returns what is stored.
 */
export class RuleRepository {
  constructor(private readonly db: ForgeDatabase) {}

  /**
   * Every rule attached to one project.
   *
   * Ordered by scope then key so the list is stable between reads; an unordered
   * query would let SQLite reorder rows and make the overview appear to shuffle.
   */
  listForProject(projectId: ProjectId): readonly Rule[] {
    return this.db
      .select()
      .from(rules)
      .where(eq(rules.projectId, projectId))
      .orderBy(asc(rules.scope), asc(rules.key))
      .all()
      .map((row) => this.toDomain(row))
  }

  findByKey(projectId: ProjectId, scope: Rule['scope'], key: string): Rule | null {
    const row = this.db
      .select()
      .from(rules)
      .where(and(eq(rules.projectId, projectId), eq(rules.scope, scope), eq(rules.key, key)))
      .all()
      .at(0)

    return row === undefined ? null : this.toDomain(row)
  }

  private toDomain(row: typeof rules.$inferSelect): Rule {
    return parseRow(
      ruleSchema,
      {
        id: row.id,
        scope: row.scope,
        key: row.key,
        statement: row.statement,
        source: row.source,
        createdAt: row.createdAt,
      },
      'rules row',
    )
  }
}
