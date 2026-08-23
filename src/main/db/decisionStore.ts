import { and, eq } from 'drizzle-orm'
import {
  decisionSchema,
  projectIdSchema,
  type Actor,
  type Decision,
  type DecisionId,
  type DecisionStatus,
  type ProjectId,
  type QuestionId,
} from '@shared/domain'
import type { ForgeDatabase } from './connection'
import type { EventStore } from './eventStore'
import { applyEvent } from './projections'
import { parseRow } from './rows'
import { decisions } from './schema'

/**
 * Persists and manages decisions.
 *
 * Implements axiom A4: decisions are binding once approved, and only a user may
 * lock, unlock, or supersede a decision.
 */
export class DecisionStore {
  constructor(
    private readonly db: ForgeDatabase,
    private readonly events: EventStore,
  ) {}

  find(decisionId: DecisionId): Decision | null {
    const row = this.db.select().from(decisions).where(eq(decisions.id, decisionId)).get()

    if (row === undefined) return null
    return toDecision(row)
  }

  listForProject(projectId: ProjectId, status?: DecisionStatus): readonly Decision[] {
    const query =
      status !== undefined
        ? this.db
            .select()
            .from(decisions)
            .where(and(eq(decisions.projectId, projectId), eq(decisions.status, status)))
        : this.db.select().from(decisions).where(eq(decisions.projectId, projectId))

    const rows = query.all()
    return rows.map(toDecision)
  }

  listLocked(projectId: ProjectId): readonly Decision[] {
    return this.listForProject(projectId, 'locked')
  }

  propose(decision: Decision, projectId: ProjectId, actor: Actor, occurredAt: string): Decision {
    decisionSchema.parse(decision)

    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'decision.proposed', payload: { decision } },
        { projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })

    const created = this.find(decision.id)
    if (created === null) {
      throw new Error(`Decision ${decision.id} was not projected after being proposed`)
    }
    return created
  }

  approve(decisionId: DecisionId, actor: Actor, occurredAt: string): Decision {
    const existing = this.find(decisionId)
    if (existing === null) {
      throw new Error(`Decision ${decisionId} not found`)
    }

    const projectId = this.projectIdOf(decisionId)

    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'decision.approved', payload: { decisionId, approvedAt: occurredAt } },
        { projectId, actor, occurredAt },
      )
      applyEvent(this.db, event)
    })

    const updated = this.find(decisionId)
    if (updated === null) {
      throw new Error(`Decision ${decisionId} was not found after approval`)
    }
    return updated
  }

  /**
   * Locks a decision. Enforces Axiom A4: only a user may lock a decision.
   */
  lock(decisionId: DecisionId, actor: Actor, occurredAt: string): Decision {
    if (actor !== 'user') {
      throw new Error('Axiom A4 violation: Only the user may lock a decision')
    }

    const existing = this.find(decisionId)
    if (existing === null) {
      throw new Error(`Decision ${decisionId} not found`)
    }

    const projectId = this.projectIdOf(decisionId)

    this.db.transaction(() => {
      const event = this.events.append(
        { type: 'decision.locked', payload: { decisionId, lockedAt: occurredAt } },
        { projectId, actor: 'user', occurredAt },
      )
      applyEvent(this.db, event)
    })

    const updated = this.find(decisionId)
    if (updated === null) {
      throw new Error(`Decision ${decisionId} was not found after lock`)
    }
    return updated
  }

  /**
   * Supersedes a decision with a replacement. Enforces Axiom A4: user only.
   */
  supersede(
    decisionId: DecisionId,
    replacement: Decision,
    actor: Actor,
    occurredAt: string,
  ): { superseded: Decision; replacement: Decision } {
    if (actor !== 'user') {
      throw new Error('Axiom A4 violation: Only the user may supersede a decision')
    }

    const existing = this.find(decisionId)
    if (existing === null) {
      throw new Error(`Decision ${decisionId} not found`)
    }

    const projectId = this.projectIdOf(decisionId)
    decisionSchema.parse(replacement)

    this.db.transaction(() => {
      // 1. Propose and lock replacement
      const propEvent = this.events.append(
        { type: 'decision.proposed', payload: { decision: replacement } },
        { projectId, actor: 'user', occurredAt },
      )
      applyEvent(this.db, propEvent)

      if (replacement.status === 'locked') {
        const lockEvent = this.events.append(
          {
            type: 'decision.locked',
            payload: { decisionId: replacement.id, lockedAt: occurredAt },
          },
          { projectId, actor: 'user', occurredAt },
        )
        applyEvent(this.db, lockEvent)
      }

      // 2. Mark existing as superseded
      const supEvent = this.events.append(
        {
          type: 'decision.superseded',
          payload: { decisionId, supersededBy: replacement.id },
        },
        { projectId, actor: 'user', occurredAt },
      )
      applyEvent(this.db, supEvent)
    })

    const updatedSuperseded = this.find(decisionId)
    const updatedReplacement = this.find(replacement.id)
    if (updatedSuperseded === null || updatedReplacement === null) {
      throw new Error(`Failed to project superseded decision ${decisionId}`)
    }

    return { superseded: updatedSuperseded, replacement: updatedReplacement }
  }

  promoteFromQuestion(
    questionId: QuestionId,
    statement: string,
    rationale: string,
    actor: 'user',
    occurredAt: string,
    projectId: ProjectId,
    decisionId: DecisionId,
  ): Decision {
    const decision: Decision = {
      id: decisionId,
      statement,
      rationale,
      status: 'locked',
      proposedBy: actor,
      proposedAt: occurredAt,
      lockedAt: occurredAt,
      lockedBy: actor,
      supersededBy: null,
      originQuestionId: questionId,
    }

    return this.propose(decision, projectId, actor, occurredAt)
  }

  private projectIdOf(decisionId: DecisionId): ProjectId {
    const row = this.db
      .select({ projectId: decisions.projectId })
      .from(decisions)
      .where(eq(decisions.id, decisionId))
      .get()

    if (row === undefined) {
      throw new Error(`Decision ${decisionId} not found`)
    }
    return projectIdSchema.parse(row.projectId)
  }
}

function toDecision(row: typeof decisions.$inferSelect): Decision {
  return parseRow(
    decisionSchema,
    {
      id: row.id,
      statement: row.statement,
      rationale: row.rationale,
      status: row.status,
      proposedBy: row.proposedBy,
      proposedAt: row.proposedAt,
      lockedAt: row.lockedAt,
      lockedBy: row.lockedBy,
      supersededBy: row.supersededBy,
      originQuestionId: row.originQuestionId,
    },
    'decisions',
  )
}
