import { randomUUID } from 'node:crypto'
import {
  changeSetIdSchema,
  changeSetSchema,
  reconcile,
  type Actor,
  type AgentReport,
  type ChangeSet,
  type ChangeSetId,
  type ReconcileResult,
  type ScopePolicy,
  type Sha,
  type StepId,
  type TaskId,
} from '@shared/domain'
import type { GitService } from '../git'

/**
 * Builds a `ChangeSet` from what the repository actually shows.
 *
 * ```
 * snapshot SHA (before the step)  ──┐
 * git diff (after the step)       ──┼──> ChangeSet + discrepancies
 * task scope + agent's claim      ──┘
 * ```
 *
 * The changeset is the evidence half of axiom A3: a step's *output* is what an agent said, and
 * this is what the repository shows. They are reconciled here rather than conflated, and the
 * discrepancies travel with the changeset so a reviewer sees both.
 *
 * Change ownership is recorded on every changeset — which agent, which step, which task, and
 * which earlier changeset this one corrects. That is what makes a correction loop auditable
 * months later rather than a sequence of anonymous diffs.
 */

export interface BuildChangeSetInput {
  /** Captured before the step ran (`GitService.snapshot`). */
  readonly baseSha: Sha
  readonly report: AgentReport
  readonly scope: ScopePolicy
  readonly authorActor: Actor
  readonly stepId: StepId
  readonly taskId: TaskId
  /** The changeset this one is fixing, when the step is a correction. */
  readonly correctsChangeSetId?: ChangeSetId | null
  readonly capturedAt: string
}

export interface BuiltChangeSet {
  readonly changeSet: ChangeSet
  readonly reconciliation: ReconcileResult
}

/**
 * Captures and reconciles in one operation.
 *
 * Deliberately one call: a caller that captured a diff and separately decided whether to
 * reconcile it could skip the check, and a changeset without discrepancies recorded looks
 * identical to one that was verified and found clean.
 */
export async function buildChangeSet(
  git: GitService,
  input: BuildChangeSetInput,
): Promise<BuiltChangeSet> {
  // The worktree, not a commit range: an agent's work is uncommitted in the normal case, so a
  // commit-to-commit diff would report nothing at all (#17).
  const diff = await git.diffWorktree(input.baseSha)

  const reconciliation = reconcile({
    claimed: input.report.filesChanged,
    actual: diff.files,
    scope: input.scope,
  })

  const changeSet = changeSetSchema.parse({
    id: changeSetIdSchema.parse(randomUUID()),
    baseSha: input.baseSha,
    // Null while the work is uncommitted, which is the normal MVP case: the final commit is
    // the user's call.
    headSha: null,
    files: diff.files.map(({ binary: _binary, ...file }) => file),
    patch: diff.patch,
    authorActor: input.authorActor,
    stepId: input.stepId,
    taskId: input.taskId,
    correctsChangeSetId: input.correctsChangeSetId ?? null,
    // Set by the review step (#36), not here: capturing a diff is not reviewing it.
    reviewVerdict: null,
    discrepancies: reconciliation.discrepancies,
    capturedAt: input.capturedAt,
  })

  return { changeSet, reconciliation }
}

/**
 * A one-line diff summary, for a correction packet's `previousAttempt`.
 *
 * Forge's own measurement rather than the agent's claim, which is the point: the next attempt
 * is told what actually happened, not what the last one said happened.
 */
export function diffStatOf(changeSet: ChangeSet): string {
  if (changeSet.files.length === 0) return 'nothing changed'

  const insertions = changeSet.files.reduce((total, file) => total + file.insertions, 0)
  const deletions = changeSet.files.reduce((total, file) => total + file.deletions, 0)

  return `${String(changeSet.files.length)} file(s), +${String(insertions)} -${String(deletions)}`
}
