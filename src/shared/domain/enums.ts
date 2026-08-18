import { z } from 'zod'

/**
 * The closed sets the domain switches on.
 *
 * Each is a string union rather than a TypeScript `enum`, so the values survive
 * JSON, SQLite, and prompt packets unchanged, and an exhaustive `switch` is a
 * compile-time guarantee (enforced by `switch-exhaustiveness-check`).
 */

/**
 * Workflow state. See `docs/DOMAIN.md` for the transition diagram.
 *
 * Terminal states are listed in `TERMINAL_WORKFLOW_STATES`; the transition table
 * in #27 is the authority on which moves are legal.
 */
export const WORKFLOW_STATES = [
  'DISCOVERY',
  'PLANNING',
  'PLAN_READY',
  'DECISIONS_LOCKED',
  'IMPLEMENTING',
  'VERIFYING',
  'REVIEWING',
  'CORRECTION_REQUIRED',
  'AWAITING_USER',
  'DONE',
  'HALTED_LIMIT',
  'HALTED_POLICY',
  'CANCELLED',
] as const

export const workflowStateSchema = z.enum(WORKFLOW_STATES)
export type WorkflowState = z.infer<typeof workflowStateSchema>

/** Once here, a workflow does not advance again. */
export const TERMINAL_WORKFLOW_STATES = [
  'DONE',
  'HALTED_LIMIT',
  'HALTED_POLICY',
  'CANCELLED',
] as const satisfies readonly WorkflowState[]

export function isTerminalWorkflowState(state: WorkflowState): boolean {
  return (TERMINAL_WORKFLOW_STATES as readonly WorkflowState[]).includes(state)
}

/**
 * Decision lifecycle (axiom A4).
 *
 * Only a user may move a decision to `locked`, and only a user may supersede one.
 * No agent-reachable path may perform either — enforced in #40.
 */
export const decisionStatusSchema = z.enum(['proposed', 'approved', 'locked', 'superseded'])
export type DecisionStatus = z.infer<typeof decisionStatusSchema>

/**
 * A role a workflow step is performed by.
 *
 * Roles are bound to runtimes per project, so any runtime may hold any role it
 * declares the capability for (axiom A6). `system` covers the steps Forge performs
 * itself — running a build, diffing a tree — which are the ones that produce
 * evidence rather than claims.
 */
export const roleSchema = z.enum([
  'planner',
  'implementer',
  'reviewer',
  'tester',
  'security-reviewer',
  'system',
  'user',
])
export type Role = z.infer<typeof roleSchema>

/** What a runtime is able to do. Checked when a role is bound (#31). */
export const capabilitySchema = z.enum([
  'repo-read',
  'file-write',
  'terminal',
  'plan',
  'review',
  'test',
])
export type Capability = z.infer<typeof capabilitySchema>

/**
 * The scope a rule is set at. Order is significant: later entries are more
 * specific and win on conflict (#19).
 */
export const RULE_SCOPES = ['global', 'workspace', 'project', 'workflow', 'agent', 'task'] as const

export const ruleScopeSchema = z.enum(RULE_SCOPES)
export type RuleScope = z.infer<typeof ruleScopeSchema>

/** How specific a scope is; higher wins. */
export function ruleScopeSpecificity(scope: RuleScope): number {
  return RULE_SCOPES.indexOf(scope)
}

/** The verdict of a review or a criteria evaluation. */
export const verdictSchema = z.enum(['pass', 'fail', 'unknown'])
export type Verdict = z.infer<typeof verdictSchema>

/** What an agent reported about its own step. Reconciled against evidence in #34. */
export const reportStatusSchema = z.enum(['completed', 'blocked', 'question'])
export type ReportStatus = z.infer<typeof reportStatusSchema>

/** How a file changed, mirroring git's own status letters. */
export const changeTypeSchema = z.enum(['added', 'modified', 'deleted', 'renamed'])
export type ChangeType = z.infer<typeof changeTypeSchema>

/** The kinds of machine-checkable completion criteria (#35). */
export const criterionKindSchema = z.enum([
  'build',
  'tests',
  'diff-scope',
  'no-assumptions',
  'reviewer-verdict',
  'file-exists',
  'custom-command',
])
export type CriterionKind = z.infer<typeof criterionKindSchema>
