import { randomUUID } from 'node:crypto'
import {
  decisionIdSchema,
  decisionStatusSchema,
  gateVerdictSchema,
  projectIdSchema,
  workflowIdSchema,
  type Decision,
  type DecisionStatus,
  type WorkflowTemplateV2,
} from '@shared/domain'
import type { DecisionView } from '@shared/views'
import type { DecisionStore } from '../db/decisionStore'
import type { WorkflowStore } from '../db/workflowStore'

export type TemplateResolver = (templateId: string) => WorkflowTemplateV2 | null

export interface DecisionServiceOptions {
  readonly decisions: DecisionStore
  readonly workflowStore?: WorkflowStore | undefined
  readonly templateResolver?: TemplateResolver | undefined
  readonly onDecisionChanged?: ((decision: Decision) => void) | undefined
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

  /**
   * Records and atomically locks an authoritative human gate decision.
   * Performs structural relationship and execution-state preflight checks.
   */
  recordGateDecision(input: {
    readonly projectId: string
    readonly workflowId: string
    readonly graphRunId: string
    readonly nodeId: string
    readonly verdict: 'approved' | 'rejected'
    readonly rationale: string
  }): DecisionView {
    const pId = projectIdSchema.parse(input.projectId)
    const wId = workflowIdSchema.parse(input.workflowId)
    const verdict = gateVerdictSchema.parse(input.verdict)

    // 1. Fail closed if workflowStore is missing
    if (!this.options.workflowStore) {
      throw new Error(
        'Cannot record gate decision: workflowStore is required for authoritative preflight verification',
      )
    }

    // 2. Fail closed if templateResolver is missing
    if (!this.options.templateResolver) {
      throw new Error(
        'Cannot record gate decision: templateResolver is required to verify node type',
      )
    }

    // 3. Validate workflow exists and belongs to projectId
    const wf = this.options.workflowStore.find(wId)
    if (wf === null) {
      throw new Error(`Workflow ${input.workflowId} not found`)
    }
    const actualProjectId = this.options.workflowStore.projectIdOf(wId)
    if (actualProjectId !== pId) {
      throw new Error(
        `Workflow ${input.workflowId} belongs to project ${actualProjectId}, not ${input.projectId}`,
      )
    }

    // 4. Validate graph run exists, belongs to workflowId, and matches requested projectId
    const run = this.options.workflowStore.getGraphRun(input.graphRunId)
    if (run === null) {
      throw new Error(`Graph run ${input.graphRunId} not found`)
    }
    if (run.workflowId !== wId) {
      throw new Error(
        `Graph run ${input.graphRunId} belongs to workflow ${run.workflowId}, not ${input.workflowId}`,
      )
    }
    const graphRunProjectId = this.options.workflowStore.projectIdOfGraphRun(input.graphRunId)
    if (graphRunProjectId !== pId) {
      throw new Error(
        `Graph run ${input.graphRunId} belongs to project ${graphRunProjectId}, not ${input.projectId}`,
      )
    }
    if (run.status === 'completed' || run.status === 'failed' || run.status === 'cancelled') {
      throw new Error(
        `Cannot record gate decision for graph run ${input.graphRunId}: run is already in terminal state "${run.status}"`,
      )
    }

    // 5. Validate node attempt exists and is currently blocked
    const attempts = this.options.workflowStore.getNodeAttempts(input.graphRunId, input.nodeId)
    const latest = attempts.at(-1)
    if (latest === undefined) {
      throw new Error(
        `Cannot record gate decision: node "${input.nodeId}" has no recorded attempts in run "${input.graphRunId}"`,
      )
    }
    if (latest.status !== 'blocked') {
      throw new Error(
        `Cannot record gate decision: node "${input.nodeId}" is currently in status "${latest.status}", not "blocked"`,
      )
    }

    // 6. Validate node is an authentic user_gate in the resolved graph template
    const template = this.options.templateResolver(run.templateId)
    if (template === null) {
      throw new Error(
        `Cannot record gate decision: template "${run.templateId}" could not be resolved`,
      )
    }
    const nodeDef = template.nodes.find((n) => n.id === input.nodeId)
    if (nodeDef === undefined) {
      throw new Error(
        `Cannot record gate decision: node "${input.nodeId}" not found in template "${run.templateId}"`,
      )
    }
    if (nodeDef.type !== 'user_gate') {
      throw new Error(
        `Cannot record gate decision: node "${input.nodeId}" in template "${run.templateId}" has type "${nodeDef.type}", not "user_gate"`,
      )
    }

    const now = new Date().toISOString()
    const decision = this.options.decisions.recordGateDecision({
      projectId: pId,
      workflowId: wId,
      graphRunId: input.graphRunId,
      nodeId: input.nodeId,
      verdict,
      rationale: input.rationale,
      actor: 'user',
      occurredAt: now,
    })

    this.options.onDecisionChanged?.(decision)
    return toView(decision)
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
    workflowId: d.workflowId ?? null,
    graphRunId: d.graphRunId ?? null,
    nodeId: d.nodeId ?? null,
    gateVerdict: d.gateVerdict ?? null,
  }
}
