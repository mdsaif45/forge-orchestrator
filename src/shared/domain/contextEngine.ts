import { promptPacketSchema, type PromptPacket } from './runtime'
import { isForbiddenPath, redactSecrets } from './redaction'
import type { Role } from './enums'
import type { EffectiveRule } from './policy'
import type { LockedDecision } from './decision'
import type { Task } from './task'

/**
 * The context engine.
 *
 * ```
 * project state + task + locked decisions + relevant files
 * + previous attempt + review findings + rules + answered questions
 *                          │
 *                   select ─> rank ─> budget ─> redact
 *                          │
 *                PromptPacket  (deterministic, snapshottable)
 * ```
 *
 * Never send the whole history. An agent given five hundred messages performs worse than one
 * given the eight facts that matter, and it costs more — so the job is to assemble the
 * *minimum sufficient* context and nothing else.
 *
 * Three properties are non-negotiable, and each is enforced here rather than trusted:
 *
 *   - **deterministic.** Identical state produces a byte-identical packet. Packets are
 *     snapshotted per step and compared across runs; a packet that varied by iteration order
 *     or wall clock would make every comparison meaningless.
 *   - **redacted.** No `.env`, no key material, nothing secret-shaped (A7, R7). Enforced by
 *     excluding forbidden paths wholesale *and* scrubbing every string that goes in.
 *   - **locked decisions verbatim.** Never truncated, never summarised, never dropped to fit
 *     a budget (A4). If the budget cannot hold them, the budget is wrong.
 */

/** Everything the engine may draw on. Assembled by the caller; selection happens here. */
export interface ContextInput {
  readonly role: Role
  readonly task: Task
  /** Resolved effective policy. Rendered as statements; scopes are not sent (see #19). */
  readonly rules: readonly EffectiveRule[]
  readonly lockedDecisions: readonly LockedDecision[]
  /** Candidate files with the signals used to rank them. */
  readonly files: readonly FileCandidate[]
  readonly previousAttempt: { readonly summary: string; readonly diffStat: string } | null
  readonly reviewFindings: readonly string[]
  readonly answeredQuestions: readonly { readonly question: string; readonly answer: string }[]
  /**
   * The repository's own `CLAUDE.md`, already read by the caller (#133).
   *
   * A string rather than a path, so this module stays pure — the same reason file
   * signals are supplied rather than computed here. Null when the repository has none.
   */
  readonly repositoryInstructions?: string | null
  readonly budget?: Partial<ContextBudget>
}

/**
 * A file the engine may mention, with the signals that decide whether it should.
 *
 * The signals are supplied rather than computed here so this module stays pure: walking an
 * import graph needs a filesystem, and a context engine that could not be tested without one
 * would not be tested properly.
 */
export interface FileCandidate {
  /** Repository-relative POSIX path. */
  readonly path: string
  /** The task's objective or constraints name this path. The strongest signal. */
  readonly mentionedInTask?: boolean
  /** Changed in a recent commit or a previous attempt. */
  readonly recentlyChanged?: boolean
  /** Hops away in the import graph from a file already selected. Lower is closer. */
  readonly importDistance?: number
  /** Within the task's allowed paths. */
  readonly inScope?: boolean
}

export interface ContextBudget {
  /** Characters, not tokens: a token count needs a model-specific tokeniser. */
  readonly maxChars: number
  readonly maxFiles: number
}

const DEFAULT_BUDGET: ContextBudget = { maxChars: 24_000, maxFiles: 40 }

/**
 * The most of a repository's `CLAUDE.md` that is ever sent.
 *
 * An absolute ceiling as well as a share of the budget: a caller that raises `maxChars`
 * for a large task should not thereby send a proportionally larger instruction file, since
 * the useful part of such a file is near the top and the rest is reference material.
 */
const MAX_INSTRUCTION_CHARS = 6_000

/**
 * Truncates on a line boundary, saying so.
 *
 * Cutting mid-sentence would leave an agent acting on half an instruction, which is worse
 * than not sending the tail at all — and a silent cut would leave the user unable to tell
 * why guidance they wrote was ignored.
 */
function capInstructions(text: string | null, maxChars: number): string | null {
  if (text === null) return null

  const trimmed = text.trim()
  if (trimmed === '') return null
  if (trimmed.length <= maxChars) return trimmed

  const cut = trimmed.slice(0, maxChars)
  const lastBreak = cut.lastIndexOf('\n')
  const kept = (lastBreak > 0 ? cut.slice(0, lastBreak) : cut).trimEnd()

  return `${kept}\n\n[Truncated by Forge: this file is ${String(trimmed.length)} characters and only the first ${String(kept.length)} were sent.]`
}

/** What the engine did, so a user can see why an agent was told what it was told. */
export interface ContextTrace {
  readonly role: Role
  readonly filesConsidered: number
  readonly filesIncluded: number
  /** Excluded for holding secrets (A7). Named, so the exclusion is visible. */
  readonly filesForbidden: readonly string[]
  /** Dropped to fit the budget, in the order they would have been added. */
  readonly filesTruncated: readonly string[]
  readonly charsUsed: number
  readonly truncated: boolean
}

export interface CompiledContext {
  readonly packet: PromptPacket
  readonly trace: ContextTrace
}

/**
 * How much of the world each role needs.
 *
 * A planner reasons about structure and must not be handed forty implementation files; an
 * implementer needs the target files and little else; a reviewer needs the diff, which the
 * orchestrator supplies as `previousAttempt` rather than as file contents.
 *
 * Encoded as data rather than as branches so a new role is a table entry, and so the
 * strategy is legible in one place instead of spread across the assembly code.
 */
const ROLE_STRATEGY = {
  planner: { maxFiles: 12, wantsReviewFindings: false, wantsPreviousAttempt: false },
  implementer: { maxFiles: 25, wantsReviewFindings: true, wantsPreviousAttempt: true },
  reviewer: { maxFiles: 15, wantsReviewFindings: true, wantsPreviousAttempt: true },
  tester: { maxFiles: 15, wantsReviewFindings: true, wantsPreviousAttempt: true },
  'security-reviewer': { maxFiles: 20, wantsReviewFindings: true, wantsPreviousAttempt: true },
  // Forge performs these itself; no packet is ever compiled for them.
  system: { maxFiles: 0, wantsReviewFindings: false, wantsPreviousAttempt: false },
  user: { maxFiles: 0, wantsReviewFindings: false, wantsPreviousAttempt: false },
} as const satisfies Record<
  Role,
  { maxFiles: number; wantsReviewFindings: boolean; wantsPreviousAttempt: boolean }
>

/**
 * Scores a file's relevance.
 *
 * Weights are deliberately coarse and far apart, so the ordering is decided by *which*
 * signals fire rather than by arithmetic that happens to tip one way. A task that names a
 * file outranks every heuristic, because the user said so.
 */
function score(candidate: FileCandidate): number {
  let total = 0

  if (candidate.mentionedInTask === true) total += 1000
  if (candidate.inScope === true) total += 100
  if (candidate.recentlyChanged === true) total += 50

  // Closer is better, and the bonus decays: two hops is worth far less than one, and beyond
  // about five hops proximity says nothing useful.
  if (candidate.importDistance !== undefined && candidate.importDistance >= 0) {
    total += Math.max(0, 40 - candidate.importDistance * 8)
  }

  return total
}

/**
 * Ranks candidates, highest first.
 *
 * Ties break on path, alphabetically. That is what makes the result deterministic: without
 * it, two files with identical signals would order by however they arrived, and the packet
 * would differ between runs that were otherwise the same.
 */
export function rankFiles(candidates: readonly FileCandidate[]): readonly FileCandidate[] {
  return [...candidates].sort((left, right) => {
    const difference = score(right) - score(left)
    if (difference !== 0) return difference

    // Codepoint, not localeCompare: the latter reads the host locale, and a packet that
    // ordered differently on another machine would break every snapshot comparison.
    return left.path < right.path ? -1 : left.path > right.path ? 1 : 0
  })
}

/**
 * Assembles a packet.
 *
 * Order of operations matters and is the same every time: select by role, rank, drop
 * forbidden paths, fit the budget, then redact everything that remains. Redaction is last so
 * that nothing added by an earlier stage can slip past it.
 */
export function compileContext(input: ContextInput): CompiledContext {
  const strategy = ROLE_STRATEGY[input.role]
  const budget: ContextBudget = {
    maxChars: input.budget?.maxChars ?? DEFAULT_BUDGET.maxChars,
    maxFiles: Math.min(input.budget?.maxFiles ?? DEFAULT_BUDGET.maxFiles, strategy.maxFiles),
  }

  // Forbidden paths are removed before ranking, not after: a file that can never be sent
  // should not be allowed to displace one that can.
  const forbidden = input.files
    .filter((file) => isForbiddenPath(file.path))
    .map((file) => file.path)
  const allowed = input.files.filter((file) => !isForbiddenPath(file.path))

  const ranked = rankFiles(allowed)
  const selected = ranked.slice(0, budget.maxFiles)
  const droppedByCount = ranked.slice(budget.maxFiles).map((file) => file.path)

  // Locked decisions are measured first and never trimmed. If they do not fit, the budget is
  // wrong — silently dropping one would let an agent contradict a decision the user locked
  // (A4), which is the failure this whole mechanism exists to prevent.
  const lockedStatements = input.lockedDecisions.map(
    (decision) => `${decision.statement} — because ${decision.rationale}`,
  )

  // Capped before it is measured, and measured as fixed cost. A repository's CLAUDE.md is
  // arbitrary-length content that Forge does not control: uncapped, a long one would both
  // bloat every stored packet and consume the budget that ranked files compete for,
  // silently making context worse the more a project documents itself (#133).
  const repositoryInstructions = capInstructions(
    input.repositoryInstructions ?? null,
    Math.min(MAX_INSTRUCTION_CHARS, Math.floor(budget.maxChars / 4)),
  )

  const fixedChars = charsOf([
    input.task.objective,
    ...input.task.constraints,
    ...lockedStatements,
    ...input.rules.map((rule) => rule.statement),
    ...(repositoryInstructions === null ? [] : [repositoryInstructions]),
  ])

  const filePaths: string[] = []
  const droppedByChars: string[] = []
  let used = fixedChars

  for (const file of selected) {
    const cost = file.path.length + 1
    if (used + cost > budget.maxChars) {
      droppedByChars.push(file.path)
      continue
    }

    filePaths.push(file.path)
    used += cost
  }

  const findings = strategy.wantsReviewFindings ? input.reviewFindings : []
  const previousAttempt = strategy.wantsPreviousAttempt ? input.previousAttempt : null

  const packet = promptPacketSchema.parse({
    role: input.role,
    objective: redactSecrets(input.task.objective),
    constraints: input.task.constraints.map(redactSecrets),
    rules: input.rules.map((rule) => redactSecrets(rule.statement)),
    // Redacted like everything else, but never truncated. A decision whose statement
    // happened to contain something secret-shaped is a problem for the user to fix, not a
    // reason to send it partially.
    lockedDecisions: lockedStatements.map(redactSecrets),
    allowedPaths: [...input.task.scope.allowedPaths],
    forbiddenPaths: [...input.task.scope.forbiddenPaths],
    relevantFiles: filePaths,
    reviewFindings: findings.map(redactSecrets),
    previousAttempt:
      previousAttempt === null
        ? null
        : {
            summary: redactSecrets(previousAttempt.summary),
            diffStat: redactSecrets(previousAttempt.diffStat),
          },
    completionCriteria: input.task.completionCriteria.map((criterion) =>
      redactSecrets(criterion.description),
    ),
    answeredQuestions: input.answeredQuestions.map((entry) => ({
      question: redactSecrets(entry.question),
      answer: redactSecrets(entry.answer),
    })),
    // Redacted like every other packet field. This is repository content Forge did not
    // write, so it is exactly the kind of text that can carry something secret-shaped.
    repositoryInstructions:
      repositoryInstructions === null ? null : redactSecrets(repositoryInstructions),
  })

  const truncatedPaths = [...droppedByCount, ...droppedByChars]

  return {
    packet,
    trace: {
      role: input.role,
      filesConsidered: input.files.length,
      filesIncluded: filePaths.length,
      filesForbidden: forbidden,
      filesTruncated: truncatedPaths,
      charsUsed: used,
      truncated: truncatedPaths.length > 0,
    },
  }
}

/**
 * The note appended when files were dropped.
 *
 * An explicit marker rather than a silent cut: an agent that does not know its view was
 * trimmed will reason as though it saw everything, and confidently conclude something wrong.
 */
export function truncationNotice(trace: ContextTrace): string | null {
  if (!trace.truncated) return null

  return `Note: ${String(trace.filesTruncated.length)} further file(s) were relevant but omitted to fit the context budget. Ask if you need one of them: ${trace.filesTruncated.slice(0, 10).join(', ')}${trace.filesTruncated.length > 10 ? ', …' : ''}`
}

function charsOf(values: readonly string[]): number {
  return values.reduce((total, value) => total + value.length + 1, 0)
}
