import { randomUUID } from 'node:crypto'
import { and, eq } from 'drizzle-orm'
import {
  decisionIdSchema,
  decisionSchema,
  projectIdSchema,
  type Actor,
  type Decision,
  type DecisionId,
  type DecisionStatus,
  type GateVerdict,
  type ProjectId,
  type QuestionId,
  type WorkflowId,
} from '@shared/domain'
import type { ForgeDatabase } from './connection'
import type { EventStore } from './eventStore'
import { applyEvent } from './projections'
import { parseRow } from './rows'
import { decisions, graphRuns, workflows } from './schema'

export class DecisionConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DecisionConflictError'
  }
}

export interface RecordGateDecisionInput {
  readonly projectId: ProjectId
  readonly workflowId: WorkflowId
  readonly graphRunId: string
  readonly nodeId: string
  readonly verdict: GateVerdict
  readonly rationale: string
  readonly actor: Actor
  readonly occurredAt: string
}

export interface GateScopeContext {
  readonly projectId?: ProjectId | undefined
  readonly workflowId?: WorkflowId | undefined
}

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

  /**
   * Authoritatively looks up the effective locked decision for a specific gate attempt in a graph run.
   * Revalidates decision scope against the authoritative graph run, workflow, and current execution context.
   *
   * Fails closed by returning null if:
   * - no locked decision exists for this gate;
   * - the authoritative graph-run row does not exist in the database;
   * - the workflow row referenced by the graph run does not exist in the database;
   * - the decision's project or workflow coordinates do not exactly match the authoritative run and workflow;
   * - the supplied execution scope (projectId or workflowId) does not match the decision.
   *
   * @throws {Error} Invariant violation if multiple locked decisions exist for the same gate.
   */
  findGateDecision(
    graphRunId: string,
    nodeId: string,
    expectedScope?: GateScopeContext,
  ): Decision | null {
    const rows = this.db
      .select()
      .from(decisions)
      .where(
        and(
          eq(decisions.graphRunId, graphRunId),
          eq(decisions.nodeId, nodeId),
          eq(decisions.status, 'locked'),
        ),
      )
      .all()

    const first = rows[0]
    if (first === undefined) return null
    if (rows.length > 1) {
      throw new Error(
        `Invariant violation: Multiple locked decisions found for gate (graphRunId: ${graphRunId}, nodeId: ${nodeId})`,
      )
    }

    // 1. Authoritative graph-run validation against DB (fail-closed if missing or mismatched)
    const runRow = this.db.select().from(graphRuns).where(eq(graphRuns.id, graphRunId)).all().at(0)
    if (runRow === undefined) {
      return null
    }
    if (first.workflowId !== runRow.workflowId) {
      return null
    }
    if (runRow.projectId !== null && first.projectId !== runRow.projectId) {
      return null
    }

    // 2. Authoritative workflow validation against DB (fail-closed if missing or mismatched)
    const wfRow = this.db
      .select()
      .from(workflows)
      .where(eq(workflows.id, runRow.workflowId))
      .all()
      .at(0)
    if (wfRow === undefined) {
      return null
    }
    if (first.projectId !== wfRow.projectId) {
      return null
    }

    // 3. Current execution context validation against expected scope
    if (expectedScope?.projectId !== undefined && first.projectId !== expectedScope.projectId) {
      return null
    }
    if (expectedScope?.workflowId !== undefined && first.workflowId !== expectedScope.workflowId) {
      return null
    }

    return toDecision(first)
  }

  /**
   * Atomically records and locks an authoritative human decision for a specific gate.
   * Enforces Axiom A4: only the user may lock a decision.
   * Prevents contradictory verdicts for the same gate unless explicitly superseded.
   * Repeated submissions with the identical verdict are handled idempotently.
   */
  recordGateDecision(input: RecordGateDecisionInput): Decision {
    if (input.actor !== 'user') {
      throw new Error('Axiom A4 violation: Only the user may lock a decision')
    }

    return this.db.transaction(() => {
      // 1. Check for existing locked decision for this gate execution attempt
      const existing = this.findGateDecision(input.graphRunId, input.nodeId)
      if (existing !== null) {
        if (existing.gateVerdict === input.verdict) {
          // Idempotent repetition of identical verdict
          return existing
        }
        throw new DecisionConflictError(
          `Cannot record contradictory verdict "${input.verdict}" for gate "${input.nodeId}" in run "${input.graphRunId}". Existing locked verdict is "${String(existing.gateVerdict)}".`,
        )
      }

      // 2. Propose & atomically lock the gate decision
      const decisionId = decisionIdSchema.parse(randomUUID())
      const decision: Decision = {
        id: decisionId,
        statement: `User gate "${input.nodeId}" verdict: ${input.verdict}`,
        rationale: input.rationale,
        status: 'locked',
        proposedBy: 'user',
        proposedAt: input.occurredAt,
        lockedAt: input.occurredAt,
        lockedBy: 'user',
        supersededBy: null,
        originQuestionId: null,
        workflowId: input.workflowId,
        graphRunId: input.graphRunId,
        nodeId: input.nodeId,
        gateVerdict: input.verdict,
      }

      decisionSchema.parse(decision)

      const propEvent = this.events.append(
        { type: 'decision.proposed', payload: { decision } },
        { projectId: input.projectId, actor: 'user', occurredAt: input.occurredAt },
      )
      applyEvent(this.db, propEvent)

      const lockEvent = this.events.append(
        { type: 'decision.locked', payload: { decisionId, lockedAt: input.occurredAt } },
        { projectId: input.projectId, actor: 'user', occurredAt: input.occurredAt },
      )
      applyEvent(this.db, lockEvent)

      const created = this.find(decisionId)
      if (created === null) {
        throw new Error(`Gate decision ${decisionId} was not found after being recorded and locked`)
      }
      return created
    })
  }

  /**
   * Explicitly supersedes a gate decision with a replacement decision.
   * Enforces Axiom A4: only the user may supersede a decision.
   */
  supersedeGateDecision(
    decisionId: DecisionId,
    replacementInput: Omit<RecordGateDecisionInput, 'actor' | 'occurredAt'>,
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

    const replacementId = decisionIdSchema.parse(randomUUID())
    const replacement: Decision = {
      id: replacementId,
      statement: `User gate "${replacementInput.nodeId}" verdict: ${replacementInput.verdict}`,
      rationale: replacementInput.rationale,
      status: 'locked',
      proposedBy: 'user',
      proposedAt: occurredAt,
      lockedAt: occurredAt,
      lockedBy: 'user',
      supersededBy: null,
      originQuestionId: null,
      workflowId: replacementInput.workflowId,
      graphRunId: replacementInput.graphRunId,
      nodeId: replacementInput.nodeId,
      gateVerdict: replacementInput.verdict,
    }

    return this.supersede(decisionId, replacement, actor, occurredAt)
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
      workflowId: row.workflowId ?? null,
      graphRunId: row.graphRunId ?? null,
      nodeId: row.nodeId ?? null,
      gateVerdict: row.gateVerdict ?? null,
    },
    'decisions',
  )
}
