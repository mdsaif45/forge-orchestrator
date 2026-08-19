import { firstMatching, matchesAny } from './glob'
import type { ChangedFile, Discrepancy } from './changeset'
import type { ScopePolicy } from './task'

/**
 * Reconciles what an agent claimed against what the repository shows.
 *
 * ```
 * report.filesChanged   ──┐
 * real git diff         ──┼──> reconcile
 * task.scope            ──┘        ├── claimed but unchanged   discrepancy
 *                                  ├── changed but unclaimed   discrepancy
 *                                  └── outside allowedPaths    HALTED_POLICY
 * ```
 *
 * This is axiom A3 made mechanical. Everything an agent reports is a claim; this is the
 * function that checks it. Both directions of mismatch matter, and for different reasons:
 *
 *   - **claimed but unchanged** suggests the work was not done. The `liar` scenario.
 *   - **changed but unclaimed** suggests the agent does not know what it did, which is worse
 *     than lying — an agent that misreports its own edits cannot be reasoned with about them.
 *
 * Scope is separate from honesty. An agent can report a forbidden edit perfectly accurately;
 * the violation is the edit, not the report. So `scopeCreep` produces an `outside-scope`
 * discrepancy with no honesty discrepancy at all.
 */

export interface ReconcileInput {
  /** What the agent said it changed. Untrusted. */
  readonly claimed: readonly string[]
  /** What `git diff` shows. The fact (A3). */
  readonly actual: readonly ChangedFile[]
  readonly scope: ScopePolicy
}

export interface ReconcileResult {
  readonly discrepancies: readonly Discrepancy[]
  /** Paths edited outside the scope policy. A policy halt, not a review finding. */
  readonly outOfScope: readonly string[]
  /** True when the claim matches reality exactly. Says nothing about scope. */
  readonly claimAccurate: boolean
  /** True when nothing was edited outside the policy. */
  readonly inScope: boolean
}

/**
 * Whether a path is allowed by the scope policy.
 *
 * `forbiddenPaths` is checked first and wins. A path matching both lists is forbidden, because
 * the alternative — allowing it because something also permitted it — would make a forbidden
 * rule depend on the absence of an allow rule, which is not how a prohibition reads.
 *
 * An empty `allowedPaths` means "anywhere not forbidden". That is the common case early in a
 * project, and defaulting to "nothing is allowed" would halt every workflow until someone
 * wrote a glob.
 */
export function isPathAllowed(path: string, scope: ScopePolicy): boolean {
  if (matchesAny(path, scope.forbiddenPaths)) return false
  if (scope.allowedPaths.length === 0) return true

  return matchesAny(path, scope.allowedPaths)
}

/** Why a path was refused, naming the rule so the user can act on it. */
export function scopeRefusalFor(path: string, scope: ScopePolicy): string | null {
  const forbidden = firstMatching(path, scope.forbiddenPaths)
  if (forbidden !== null) return `matches the forbidden pattern "${forbidden}"`

  if (scope.allowedPaths.length > 0 && !matchesAny(path, scope.allowedPaths)) {
    return `is outside the allowed paths (${scope.allowedPaths.join(', ')})`
  }

  return null
}

/**
 * Compares claim against reality.
 *
 * Ordered deterministically — out-of-scope first, then unclaimed, then unchanged, each sorted
 * by path — because these are shown to a user and written into an event payload. An order that
 * varied by iteration would make two identical reconciliations look different.
 */
export function reconcile(input: ReconcileInput): ReconcileResult {
  // Normalised on both sides: a claim written with backslashes on Windows describes the same
  // file git reports with forward slashes, and treating them as different files would invent
  // two discrepancies out of one correct claim.
  const claimed = new Set(input.claimed.map(normalise))
  const actualPaths = input.actual.map((file) => normalise(file.path))
  const actual = new Set(actualPaths)

  const outOfScope = actualPaths.filter((path) => !isPathAllowed(path, input.scope)).sort(byPath)

  // One file yields one discrepancy. A path that is both out of scope *and* unreported would
  // otherwise be counted twice, inflating the number a user sees and implying two problems
  // where there is one file. Scope is the more serious fact and subsumes the reporting
  // question: the run halts either way, so whether the agent also mentioned it is moot.
  const outOfScopeSet = new Set(outOfScope)

  const changedButUnclaimed = actualPaths
    .filter((path) => !claimed.has(path) && !outOfScopeSet.has(path))
    .sort(byPath)

  const claimedButUnchanged = [...claimed]
    .filter((path) => !actual.has(path) && !outOfScopeSet.has(path))
    .sort(byPath)

  const discrepancies: Discrepancy[] = [
    ...outOfScope.map((path) => ({
      path,
      kind: 'outside-scope' as const,
      detail: `${path} ${scopeRefusalFor(path, input.scope) ?? 'is outside the task scope'}`,
    })),
    ...changedButUnclaimed.map((path) => ({
      path,
      kind: 'changed-but-unclaimed' as const,
      // Worded to say what it implies rather than only what it is: an agent that does not
      // know what it changed is a different problem from one that overstated.
      detail: `${path} was modified but the agent did not report it`,
    })),
    ...claimedButUnchanged.map((path) => ({
      path,
      kind: 'claimed-but-unchanged' as const,
      detail: `${path} was reported as changed but the repository shows no change`,
    })),
  ]

  return {
    discrepancies,
    outOfScope,
    // Computed from the *unfiltered* comparison, not from the reported discrepancies. The
    // discrepancy list suppresses the honesty entry for an out-of-scope file so one file
    // yields one finding — but honesty is a separate question, and reading this off the
    // filtered list would let an unreported forbidden edit count as an accurate claim.
    //
    // Scope is deliberately excluded the other way too: a perfectly honest report of a
    // forbidden edit is still an accurate claim, and conflating the two would hide which
    // thing went wrong.
    claimAccurate:
      actualPaths.every((path) => claimed.has(path)) &&
      [...claimed].every((path) => actual.has(path)),
    inScope: outOfScope.length === 0,
  }
}

/**
 * Whether a reconciliation should halt the workflow.
 *
 * Only a scope violation halts. A dishonest claim is a **review finding** — it goes back to
 * the agent as a correction, which is the loop working as intended. An out-of-scope edit is a
 * policy breach: the agent touched something the task forbade, and continuing would build on
 * a change the user did not sanction (A7).
 */
export function shouldHalt(result: ReconcileResult): boolean {
  return !result.inScope
}

/**
 * Renders discrepancies for a user, worst first.
 *
 * Surfaced prominently rather than buried in a log, which the issue asks for explicitly: a
 * discrepancy that a user has to go looking for is one they will not see, and the entire value
 * of reconciling is that the mismatch is visible.
 */
export function summariseDiscrepancies(result: ReconcileResult): string | null {
  if (result.discrepancies.length === 0) return null

  const counts = {
    'outside-scope': 0,
    'changed-but-unclaimed': 0,
    'claimed-but-unchanged': 0,
  }

  for (const discrepancy of result.discrepancies) counts[discrepancy.kind] += 1

  const parts: string[] = []
  if (counts['outside-scope'] > 0) {
    parts.push(`${String(counts['outside-scope'])} file(s) outside the task scope`)
  }
  if (counts['changed-but-unclaimed'] > 0) {
    parts.push(`${String(counts['changed-but-unclaimed'])} changed but unreported`)
  }
  if (counts['claimed-but-unchanged'] > 0) {
    parts.push(`${String(counts['claimed-but-unchanged'])} reported but unchanged`)
  }

  return parts.join(', ')
}

/**
 * Findings to send back to the agent on a correction.
 *
 * Only the honesty discrepancies: a scope violation halts rather than looping, so there is no
 * correction to ask for. Phrased as instructions rather than accusations, because the next
 * step needs the agent to act on them.
 */
export function correctionFindings(result: ReconcileResult): readonly string[] {
  return result.discrepancies
    .filter((discrepancy) => discrepancy.kind !== 'outside-scope')
    .map((discrepancy) => `${discrepancy.detail}. Report every path you modify, and only those.`)
}

function normalise(path: string): string {
  return path.split('\\').join('/')
}

/** Codepoint order, so the result does not depend on the host locale. */
function byPath(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0
}
