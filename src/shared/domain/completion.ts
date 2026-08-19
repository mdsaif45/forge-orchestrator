import { z } from 'zod'
import { criterionKindSchema, verdictSchema, type Verdict } from './enums'
import { evidencePassed, type EvidenceArtifact } from './evidence'
import type { AgentReport } from './runtime'
import type { CompletionCriterion, Task } from './task'
import type { ReconcileResult } from './reconcile'

/**
 * Deciding whether a task is done, from evidence rather than opinion.
 *
 * The rule the whole module exists to enforce:
 *
 * ```
 * pass     the evidence shows the criterion met
 * fail     the evidence shows it unmet
 * unknown  there is no evidence either way        <- NOT a pass
 * ```
 *
 * `unknown` is the load-bearing case. A criterion nobody could check is the most
 * dangerous state in the system, because absence of failure reads as success: a
 * missing test run looks identical to a clean one if you only ask "did anything
 * fail?". So the overall verdict is a pass only when *every* criterion passed, and
 * `unknown` is reported as its own outcome rather than folded into either side.
 *
 * Nothing here consults an agent's claim about its own work. `AgentReport` is an
 * input only for the two criteria that are *about* the report — whether it recorded
 * assumptions, and whether a reviewer reached a verdict.
 */

/** One criterion's outcome, with the reason a user reads in the workflow log. */
export const criterionResultSchema = z.strictObject({
  kind: criterionKindSchema,
  description: z.string().min(1),
  verdict: verdictSchema,
  /** Why this verdict, phrased for a human. Never empty, including on a pass. */
  reason: z.string().min(1),
  /** Which artifact decided it, when one did. */
  evidenceId: z.string().nullable(),
})

export type CriterionResult = z.infer<typeof criterionResultSchema>

export interface CompletionInput {
  readonly task: Task
  /** Everything Forge ran for this step. */
  readonly evidence: readonly EvidenceArtifact[]
  /** Present once the diff has been reconciled against the claim (#34). */
  readonly reconciliation?: ReconcileResult | undefined
  /** The implementer's report, for the criteria that are about the report itself. */
  readonly report?: AgentReport | undefined
  /** The reviewer's verdict, once a review step has produced one (#36). */
  readonly reviewVerdict?: Verdict | undefined
  /**
   * Repository-relative paths that exist, for `file-exists`.
   *
   * Supplied by the caller rather than read here, because this module is pure and
   * must compile into the renderer as well as main.
   */
  readonly existingPaths?: readonly string[] | undefined
}

export interface CompletionAssessment {
  /** `pass` only when every criterion passed. */
  readonly verdict: Verdict
  readonly results: readonly CriterionResult[]
  /** One line for a step log or transition reason. */
  readonly summary: string
  /** Criteria that could not be checked at all. Never silently ignored. */
  readonly unknown: readonly CriterionResult[]
  /** Phrased for the agent that has to fix them. Empty when the verdict is a pass. */
  readonly findings: readonly string[]
}

/**
 * Evaluates every completion criterion on the task.
 *
 * A task with no criteria is `unknown`, not a pass: `taskSchema` requires at least
 * one, so an empty list means something upstream is wrong, and reporting "done"
 * because nothing was asked of it would be exactly the wrong answer.
 */
export function assessCompletion(input: CompletionInput): CompletionAssessment {
  const results = input.task.completionCriteria.map((criterion) => evaluate(criterion, input))

  const unknown = results.filter((result) => result.verdict === 'unknown')
  const failed = results.filter((result) => result.verdict === 'fail')

  // Ordering: a real failure outranks an unverifiable criterion, because a failing
  // build is actionable now while an unknown needs a different fix. Neither is a pass.
  const verdict: Verdict =
    results.length === 0
      ? 'unknown'
      : failed.length > 0
        ? 'fail'
        : unknown.length > 0
          ? 'unknown'
          : 'pass'

  return {
    verdict,
    results,
    summary: summarise(verdict, results, failed.length, unknown.length),
    unknown,
    findings: verdict === 'pass' ? [] : [...failed, ...unknown].map(findingFor),
  }
}

function evaluate(criterion: CompletionCriterion, input: CompletionInput): CriterionResult {
  switch (criterion.kind) {
    case 'build':
      return fromEvidence(criterion, input, 'build')
    case 'tests':
      return fromEvidence(criterion, input, 'tests')
    case 'custom-command':
      return fromCustomCommand(criterion, input)
    case 'diff-scope':
      return fromScope(criterion, input)
    case 'no-assumptions':
      return fromAssumptions(criterion, input)
    case 'reviewer-verdict':
      return fromReview(criterion, input)
    case 'file-exists':
      return fromFileExists(criterion, input)
  }
}

/**
 * A criterion satisfied by a command Forge ran.
 *
 * No artifact of the right kind means `unknown`. The tempting alternative — treat a
 * missing build as "nothing to build, therefore fine" — is the inference A3 exists
 * to prevent, and it is indistinguishable from a build that never got run.
 */
function fromEvidence(
  criterion: CompletionCriterion,
  input: CompletionInput,
  kind: EvidenceArtifact['kind'],
): CriterionResult {
  const artifact = lastOfKind(input.evidence, kind)

  if (artifact === undefined) {
    return unknownResult(criterion, `Forge ran no ${kind} command, so this could not be checked`)
  }

  if (evidencePassed(artifact)) {
    return {
      kind: criterion.kind,
      description: criterion.description,
      verdict: 'pass',
      reason: `\`${artifact.command}\` exited 0`,
      evidenceId: artifact.id,
    }
  }

  return {
    kind: criterion.kind,
    description: criterion.description,
    verdict: 'fail',
    reason:
      artifact.outcome === 'completed'
        ? `\`${artifact.command}\` exited ${String(artifact.exitCode)}`
        : `\`${artifact.command}\` did not finish (${artifact.outcome})`,
    evidenceId: artifact.id,
  }
}

/**
 * A criterion naming its own command in `params.command`.
 *
 * The command must match an artifact Forge actually ran. A criterion whose command
 * was never executed is `unknown` — not a pass, and not a failure of the command.
 */
function fromCustomCommand(
  criterion: CompletionCriterion,
  input: CompletionInput,
): CriterionResult {
  const command = stringParam(criterion, 'command')

  if (command === null) {
    return unknownResult(criterion, 'The criterion names no command in `params.command`')
  }

  const artifact = [...input.evidence].reverse().find((entry) => entry.command === command)

  if (artifact === undefined) {
    return unknownResult(
      criterion,
      `Forge did not run \`${command}\`, so this could not be checked`,
    )
  }

  return {
    kind: criterion.kind,
    description: criterion.description,
    verdict: evidencePassed(artifact) ? 'pass' : 'fail',
    reason: evidencePassed(artifact)
      ? `\`${command}\` exited 0`
      : `\`${command}\` did not pass (${artifact.outcome}, exit ${String(artifact.exitCode)})`,
    evidenceId: artifact.id,
  }
}

/** Whether the change stayed inside the task's scope policy, per reconciliation (#34). */
function fromScope(criterion: CompletionCriterion, input: CompletionInput): CriterionResult {
  const { reconciliation } = input

  if (reconciliation === undefined) {
    return unknownResult(criterion, 'The diff has not been reconciled, so scope is unverified')
  }

  if (reconciliation.inScope) {
    return passResult(criterion, 'Every changed path is within the task scope')
  }

  return failResult(
    criterion,
    `${String(reconciliation.outOfScope.length)} path(s) were changed outside the task scope: ${reconciliation.outOfScope.join(', ')}`,
  )
}

/**
 * Whether the agent recorded any assumption, which rule R1 forbids.
 *
 * No report is `unknown` rather than a pass: an absent report is not evidence of a
 * clean one.
 */
function fromAssumptions(criterion: CompletionCriterion, input: CompletionInput): CriterionResult {
  const { report } = input

  if (report === undefined) {
    return unknownResult(criterion, 'There is no report to check for assumptions')
  }

  if (report.assumptions.length === 0) {
    return passResult(criterion, 'The report records no assumptions')
  }

  return failResult(
    criterion,
    `The report records ${String(report.assumptions.length)} assumption(s), which rule R1 forbids: ${report.assumptions.join('; ')}`,
  )
}

/** Whether a reviewer reached a pass. A reviewer's own `unknown` stays `unknown`. */
function fromReview(criterion: CompletionCriterion, input: CompletionInput): CriterionResult {
  const verdict = input.reviewVerdict

  if (verdict === undefined) {
    return unknownResult(criterion, 'No review has been performed yet')
  }

  switch (verdict) {
    case 'pass':
      return passResult(criterion, 'The reviewer passed the change')
    case 'fail':
      return failResult(criterion, 'The reviewer rejected the change')
    case 'unknown':
      // Propagated rather than collapsed: a reviewer who could not decide has not
      // approved anything.
      return unknownResult(criterion, 'The reviewer could not reach a verdict')
  }
}

/** Whether every path in `params.paths` exists. */
function fromFileExists(criterion: CompletionCriterion, input: CompletionInput): CriterionResult {
  const paths = stringArrayParam(criterion, 'paths')

  if (paths === null || paths.length === 0) {
    return unknownResult(criterion, 'The criterion names no paths in `params.paths`')
  }

  if (input.existingPaths === undefined) {
    return unknownResult(
      criterion,
      'The repository was not inspected, so this could not be checked',
    )
  }

  const present = new Set(input.existingPaths)
  const missing = paths.filter((path) => !present.has(path))

  if (missing.length === 0) {
    return passResult(criterion, `All ${String(paths.length)} required path(s) exist`)
  }

  return failResult(criterion, `Missing: ${missing.join(', ')}`)
}

/** The most recent artifact of a kind, since a correction re-runs the same command. */
function lastOfKind(
  evidence: readonly EvidenceArtifact[],
  kind: EvidenceArtifact['kind'],
): EvidenceArtifact | undefined {
  return [...evidence].reverse().find((artifact) => artifact.kind === kind)
}

function stringParam(criterion: CompletionCriterion, name: string): string | null {
  const value = criterion.params[name]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function stringArrayParam(criterion: CompletionCriterion, name: string): readonly string[] | null {
  const value = criterion.params[name]
  if (!Array.isArray(value)) return null
  const strings = value.filter((entry): entry is string => typeof entry === 'string')
  return strings.length === value.length ? strings : null
}

function passResult(criterion: CompletionCriterion, reason: string): CriterionResult {
  return {
    kind: criterion.kind,
    description: criterion.description,
    verdict: 'pass',
    reason,
    evidenceId: null,
  }
}

function failResult(criterion: CompletionCriterion, reason: string): CriterionResult {
  return {
    kind: criterion.kind,
    description: criterion.description,
    verdict: 'fail',
    reason,
    evidenceId: null,
  }
}

function unknownResult(criterion: CompletionCriterion, reason: string): CriterionResult {
  return {
    kind: criterion.kind,
    description: criterion.description,
    verdict: 'unknown',
    reason,
    evidenceId: null,
  }
}

/**
 * One line naming the outcome and its cause.
 *
 * The unknown count is stated even when something also failed, so a reader never
 * has to infer that some criteria went unchecked.
 */
function summarise(
  verdict: Verdict,
  results: readonly CriterionResult[],
  failedCount: number,
  unknownCount: number,
): string {
  if (results.length === 0) {
    return 'UNKNOWN: the task defines no completion criteria, so completion cannot be judged'
  }

  const total = String(results.length)

  switch (verdict) {
    case 'pass':
      return `PASS: all ${total} criteria met`
    case 'fail':
      return unknownCount > 0
        ? `FAIL: ${String(failedCount)} of ${total} criteria failed, ${String(unknownCount)} unverifiable`
        : `FAIL: ${String(failedCount)} of ${total} criteria failed`
    case 'unknown':
      return `UNKNOWN: ${String(unknownCount)} of ${total} criteria could not be checked`
  }
}

/**
 * A finding phrased for the agent that has to act on it.
 *
 * An unknown is addressed to the *system* rather than the agent — the agent cannot
 * fix a criterion Forge failed to check — so it is worded as a gap in verification
 * rather than as a defect in the work.
 */
function findingFor(result: CriterionResult): string {
  return result.verdict === 'unknown'
    ? `Unverified — ${result.description}: ${result.reason}. This is not a pass; the criterion needs evidence before the task can be considered done.`
    : `Failed — ${result.description}: ${result.reason}`
}
