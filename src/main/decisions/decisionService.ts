import { randomUUID } from 'node:crypto'
import {
  decisionIdSchema,
  decisionStatusSchema,
  projectIdSchema,
  type Decision,
  type DecisionStatus,
} from '@shared/domain'
import type { DecisionView } from '@shared/ipc'
import type { DecisionStore } from '../db/decisionStore'

export interface DecisionServiceOptions {
  readonly decisions: DecisionStore
  readonly onDecisionChanged?: (decision: Decision) => void
}

export class DecisionService {
  constructor(private readonly options: DecisionServiceOptions) {}

  list(projectId: string, status?: string): readonly DecisionView[] {
    const pId = projectIdSchema.parse(projectId)
    const stat: DecisionStatus | undefined =
      status !== undefined ? decisionStatusSchema.parse(status) : undefined
    const list = this.options.decisions.listForProject(pId, stat)
    return list.map(toView)
  }

  get(decisionId: string): DecisionView | null {
    const dId = decisionIdSchema.parse(decisionId)
    const d = this.options.decisions.find(dId)
    return d === null ? null : toView(d)
  }

  propose(input: {
    readonly projectId: string
    readonly statement: string
    readonly rationale: string
  }): DecisionView {
    const pId = projectIdSchema.parse(input.projectId)
    const dId = decisionIdSchema.parse(randomUUID())
    const now = new Date().toISOString()

    const decision: Decision = {
      id: dId,
      statement: input.statement,
      rationale: input.rationale,
      status: 'proposed',
      proposedBy: 'user',
      proposedAt: now,
      lockedAt: null,
      lockedBy: null,
      supersededBy: null,
      originQuestionId: null,
    }

    const created = this.options.decisions.propose(decision, pId, 'user', now)
    this.options.onDecisionChanged?.(created)
    return toView(created)
  }

  approve(decisionId: string): DecisionView {
    const dId = decisionIdSchema.parse(decisionId)
    const now = new Date().toISOString()
    const updated = this.options.decisions.approve(dId, 'user', now)
    this.options.onDecisionChanged?.(updated)
    return toView(updated)
  }

  lock(decisionId: string): DecisionView {
    const dId = decisionIdSchema.parse(decisionId)
    const now = new Date().toISOString()
    const updated = this.options.decisions.lock(dId, 'user', now)
    this.options.onDecisionChanged?.(updated)
    return toView(updated)
  }

  supersede(input: {
    readonly decisionId: string
    readonly replacementStatement: string
    readonly replacementRationale: string
  }): { readonly superseded: DecisionView; readonly replacement: DecisionView } {
    const dId = decisionIdSchema.parse(input.decisionId)
    const replacementId = decisionIdSchema.parse(randomUUID())
    const now = new Date().toISOString()

    const replacement: Decision = {
      id: replacementId,
      statement: input.replacementStatement,
      rationale: input.replacementRationale,
      status: 'locked',
      proposedBy: 'user',
      proposedAt: now,
      lockedAt: now,
      lockedBy: 'user',
      supersededBy: null,
      originQuestionId: null,
    }

    const { superseded, replacement: newDec } = this.options.decisions.supersede(
      dId,
      replacement,
      'user',
      now,
    )

    this.options.onDecisionChanged?.(superseded)
    this.options.onDecisionChanged?.(newDec)

    return {
      superseded: toView(superseded),
      replacement: toView(newDec),
    }
  }
}

function toView(d: Decision): DecisionView {
  return {
    id: d.id,
    statement: d.statement,
    rationale: d.rationale,
    status: d.status,
    proposedBy: d.proposedBy,
    proposedAt: d.proposedAt,
    lockedAt: d.lockedAt,
    lockedBy: d.lockedBy,
    supersededBy: d.supersededBy,
    originQuestionId: d.originQuestionId,
  }
}
