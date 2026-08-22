import { z } from 'zod'
import { verdictSchema, type Verdict } from './enums'
import { changeSetIdSchema, repoPathSchema, stepIdSchema, timestampSchema } from './ids'
import type { CriterionResult } from './completion'

/**
 * The reviewer's output, and the rule that Forge — not the reviewer — decides.
 *
 * A reviewer is an agent, so its verdict is a claim like any other (A3). The one
 * asymmetry worth stating plainly:
 *
 * ```
 * reviewer says FAIL  ->  believed. nobody argues a change into being good.
 * reviewer says PASS  ->  checked against the evidence, and OVERRIDDEN if a
 *                         criterion is failing.
 * ```
 *
 * That asymmetry is deliberate. A false FAIL costs an iteration; a false PASS closes
 * a workflow over a red build, which is the failure this module exists to prevent.
 */

/**
 * How much a finding matters.
 *
 * `blocker` and `major` force a correction; `minor` and `nit` are recorded and shown
 * but do not by themselves reject a change — otherwise a reviewer with opinions about
 * naming could loop the workflow until the iteration cap.
 */
export const findingSeveritySchema = z.enum(['blocker', 'major', 'minor', 'nit'])
export type FindingSeverity = z.infer<typeof findingSeveritySchema>

/** Severities that reject a change on their own. */
const REJECTING: ReadonlySet<FindingSeverity> = new Set<FindingSeverity>(['blocker', 'major'])

/**
 * One reviewable defect, structured rather than prose.
 *
 * `requiredChange` is separate from `issue` because they serve different readers: the
 * issue explains the problem to a human, and the required change is what goes into
 * the correction task as a constraint. A single prose blob would force the next agent
 * to infer its own instructions, which is where "fixed something adjacent" comes from.
 */
export const findingSchema = z.strictObject({
  severity: findingSeveritySchema,
  /** Null when the finding is about the change as a whole rather than one file. */
  file: repoPathSchema.nullable(),
  /** Null when the finding is about a file rather than a specific line. */
  line: z.number().int().positive().nullable(),
  /** What is wrong. */
  issue: z.string().min(1),
  /** What must change. Phrased as an instruction, because it becomes one. */
  requiredChange: z.string().min(1),
})

export type Finding = z.infer<typeof findingSchema>

/**
 * A completed review of one changeset.
 *
 * `changeSetId` is required and never inferred: across correction iterations there
 * are several changesets and several reviews, and a review that cannot name what it
 * reviewed is unusable as an audit trail.
 */
export const reviewReportSchema = z
  .strictObject({
    changeSetId: changeSetIdSchema,
    stepId: stepIdSchema,
    /** What the reviewer concluded. Not necessarily what Forge records. */
    claimedVerdict: verdictSchema,
    findings: z.array(findingSchema).readonly(),
    summary: z.string().min(1),
    reviewedAt: timestampSchema,
  })
  .check((ctx) => {
    // A fail with no finding gives the correction step nothing to act on, so the loop
    // would re-run the same work and rely on the iteration cap to stop it.
    if (ctx.value.claimedVerdict === 'fail' && ctx.value.findings.length === 0) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        path: ['findings'],
        message: 'A failing review must name at least one finding',
      })
    }
  })

export type ReviewReport = z.infer<typeof reviewReportSchema>

/** What Forge concluded, and whether it had to disagree with the reviewer. */
export interface ReviewOutcome {
  /** The verdict of record. */
  readonly verdict: Verdict
  /** True when Forge overrode a reviewer's PASS. */
  readonly overridden: boolean
  /** Why this verdict, for the workflow log. */
  readonly reason: string
  /** Findings that must be fixed, ordered most severe first. */
  readonly rejectingFindings: readonly Finding[]
  /** Instructions for the correcting agent. Empty on a pass. */
  readonly corrections: readonly string[]
}

/**
 * Decides the verdict of record for a review.
 *
 * The override is the point of this function. A reviewer claiming PASS while a
 * completion criterion is failing does not close the workflow — Forge substitutes
 * FAIL and says why. Evidence outranks opinion even when the opinion is favourable,
 * and *especially* then.
 */
export function assessReview(
  report: ReviewReport,
  criteria: readonly CriterionResult[],
): ReviewOutcome {
  const rejectingFindings = [...report.findings]
    .filter((finding) => REJECTING.has(finding.severity))
    .sort(bySeverity)

  const failingCriteria = criteria.filter((result) => result.verdict === 'fail')
  const unknownCriteria = criteria.filter((result) => result.verdict === 'unknown')

  // Checked before the reviewer's own verdict, so a favourable claim cannot skip it.
  if (report.claimedVerdict === 'pass' && failingCriteria.length > 0) {
    return {
      verdict: 'fail',
      overridden: true,
      reason: `The reviewer passed the change, but ${String(failingCriteria.length)} completion criterion/criteria are failing: ${failingCriteria.map((result) => result.description).join('; ')}. Forge records FAIL — a review cannot approve a change the evidence contradicts.`,
      rejectingFindings,
      corrections: [
        ...failingCriteria.map(
          (result) => `Failing criterion — ${result.description}: ${result.reason}`,
        ),
        ...rejectingFindings.map(instructionFor),
      ],
    }
  }

  // An unverified criterion is not a failure, so it does not become FAIL — but it is
  // not an approval either, and `unknown` is what stops the workflow advancing (#35).
  if (report.claimedVerdict === 'pass' && unknownCriteria.length > 0) {
    return {
      verdict: 'unknown',
      overridden: true,
      reason: `The reviewer passed the change, but ${String(unknownCriteria.length)} criterion/criteria could not be verified: ${unknownCriteria.map((result) => result.description).join('; ')}. Forge records UNKNOWN rather than closing the workflow on unverified work.`,
      rejectingFindings,
      corrections: unknownCriteria.map(
        (result) => `Unverified criterion — ${result.description}: ${result.reason}`,
      ),
    }
  }

  // A reviewer that passed while filing a blocker has contradicted itself. Believed on
  // the pessimistic reading: the finding is concrete and the verdict is a summary.
  if (report.claimedVerdict === 'pass' && rejectingFindings.length > 0) {
    return {
      verdict: 'fail',
      overridden: true,
      reason: `The reviewer passed the change while recording ${String(rejectingFindings.length)} blocking finding(s). Forge records FAIL: a blocker is not compatible with approval.`,
      rejectingFindings,
      corrections: rejectingFindings.map(instructionFor),
    }
  }

  if (report.claimedVerdict === 'fail') {
    return {
      verdict: 'fail',
      overridden: false,
      // A fail is taken at its word: nobody argues a change into being good.
      reason: `The reviewer rejected the change: ${report.summary}`,
      rejectingFindings,
      // Every finding travels, not only the rejecting ones — a minor noted alongside a
      // blocker is cheapest to fix in the same pass.
      corrections: [...report.findings].sort(bySeverity).map(instructionFor),
    }
  }

  if (report.claimedVerdict === 'unknown') {
    return {
      verdict: 'unknown',
      overridden: false,
      reason: `The reviewer could not reach a verdict: ${report.summary}`,
      rejectingFindings,
      corrections: [...report.findings].sort(bySeverity).map(instructionFor),
    }
  }

  return {
    verdict: 'pass',
    overridden: false,
    reason:
      criteria.length === 0
        ? `The reviewer passed the change: ${report.summary}`
        : `The reviewer passed the change and all ${String(criteria.length)} completion criteria are met`,
    rejectingFindings: [],
    corrections: [],
  }
}

/**
 * The constraints a correction task carries.
 *
 * The original task's constraints come first and the review's instructions after, so
 * a correction cannot quietly widen its remit: whatever bounded the first attempt
 * still bounds the fix.
 */
export function correctionConstraints(
  originalConstraints: readonly string[],
  outcome: ReviewOutcome,
): readonly string[] {
  return [
    ...originalConstraints,
    ...outcome.corrections,
    'Fix only what the findings name. Do not refactor adjacent code in the same pass.',
  ]
}

/** One finding as an instruction, with its location when it has one. */
function instructionFor(finding: Finding): string {
  const location =
    finding.file === null
      ? ''
      : finding.line === null
        ? ` (${finding.file})`
        : ` (${finding.file}:${String(finding.line)})`

  return `[${finding.severity}]${location} ${finding.issue} — ${finding.requiredChange}`
}

const SEVERITY_ORDER: readonly FindingSeverity[] = ['blocker', 'major', 'minor', 'nit']

/**
 * Most severe first, stable within a severity.
 *
 * Ordered by an explicit index rather than by string comparison: these are shown to a
 * user and written into an event payload, and `localeCompare` is host-locale dependent.
 */
function bySeverity(left: Finding, right: Finding): number {
  return SEVERITY_ORDER.indexOf(left.severity) - SEVERITY_ORDER.indexOf(right.severity)
}
