import { z } from 'zod'
import { evidenceIdSchema, stepIdSchema, timestampSchema, workflowIdSchema } from './ids'

/**
 * Why a command run ended.
 *
 * Separated from the exit code because they answer different questions: a run
 * killed at its timeout may still report an exit code, and treating that as a
 * verdict would turn a hang into a pass. `completed` is the only reason for
 * which the exit code means what it usually means.
 */
export const runOutcomeSchema = z.enum(['completed', 'timeout', 'cancelled', 'spawn-failed'])
export type RunOutcome = z.infer<typeof runOutcomeSchema>

/**
 * Counts parsed out of a test runner's own output.
 *
 * Every field is nullable because a parse is best-effort: most runners emit a
 * machine-readable summary, some emit none, and a partial parse is honest where
 * an invented zero would not be. These counts never decide a verdict — the exit
 * code does — they exist so a human reading the evidence sees detail rather than
 * a bare number.
 */
export const testCountsSchema = z.strictObject({
  total: z.number().int().nonnegative().nullable(),
  passed: z.number().int().nonnegative().nullable(),
  failed: z.number().int().nonnegative().nullable(),
  skipped: z.number().int().nonnegative().nullable(),
})

export type TestCounts = z.infer<typeof testCountsSchema>

/**
 * What Forge observed when it ran a command itself.
 *
 * The concrete form of axiom A3. An agent's report says `testsRun: true`; this
 * says which command ran, in which directory, what it printed, and what it
 * exited with. Only one of those two is evidence.
 *
 * Deliberately raw: `stdout` and `stderr` are kept alongside any parsed counts,
 * because a parser that silently mis-reads a format would otherwise destroy the
 * only record of what actually happened.
 */
export const evidenceArtifactSchema = z
  .strictObject({
    id: evidenceIdSchema,
    workflowId: workflowIdSchema,
    stepId: stepIdSchema,
    /** Which criterion this evidence speaks to, matching `criterionKind` (#35). */
    kind: z.enum(['build', 'tests', 'custom-command']),
    /** The command as configured, verbatim, so the run is reproducible by hand. */
    command: z.string().min(1),
    /** Repository-relative or absolute working directory the command ran in. */
    cwd: z.string().min(1),
    outcome: runOutcomeSchema,
    /**
     * Null when the process never reported one — killed at a timeout, or never
     * started. Null is not a pass; see `evidencePassed`.
     */
    exitCode: z.number().int().nullable(),
    durationMs: z.number().int().nonnegative(),
    stdout: z.string(),
    stderr: z.string(),
    /** True when output hit the capture cap, so a reader knows it is partial. */
    truncated: z.boolean(),
    /** Best-effort counts. Never authoritative. */
    counts: testCountsSchema.nullable(),
    /** Set when `outcome` is not `completed`, so the cause needs no inference. */
    failure: z.string().min(1).nullable(),
    recordedAt: timestampSchema,
  })
  .check((ctx) => {
    // A `completed` run always has an exit code, and a code without a completed
    // run would invite reading it as a verdict. Keeping these consistent is what
    // lets `evidencePassed` be a single expression rather than a special case.
    if (ctx.value.outcome === 'completed' && ctx.value.exitCode === null) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'A completed run must carry an exit code',
      })
    }
    if (ctx.value.outcome !== 'completed' && ctx.value.failure === null) {
      ctx.issues.push({
        code: 'custom',
        input: ctx.value,
        message: 'A run that did not complete must say why',
      })
    }
  })

export type EvidenceArtifact = z.infer<typeof evidenceArtifactSchema>

/**
 * Whether this evidence shows success.
 *
 * Exit code zero on a completed run, and nothing else. A timeout, a cancellation,
 * or a spawn failure is not a pass however encouraging the output reads — which is
 * the whole point of A3, and the reason this is a function rather than a stored
 * boolean an agent could influence.
 */
export function evidencePassed(artifact: EvidenceArtifact): boolean {
  return artifact.outcome === 'completed' && artifact.exitCode === 0
}

/**
 * One line describing what happened, for a step log or an event summary.
 *
 * Leads with the verdict because that is what a reader scans for.
 */
export function summariseEvidence(artifact: EvidenceArtifact): string {
  const verdict = evidencePassed(artifact) ? 'PASS' : 'FAIL'
  const detail =
    artifact.outcome === 'completed'
      ? `exit ${String(artifact.exitCode)}`
      : `${artifact.outcome}: ${artifact.failure ?? 'no detail'}`

  const counts = artifact.counts
  const tests =
    counts !== null && counts.total !== null
      ? `, ${String(counts.passed ?? 0)}/${String(counts.total)} passed`
      : ''

  return `${verdict} ${artifact.kind} (${detail}, ${String(artifact.durationMs)}ms${tests})`
}

/**
 * Findings phrased for the agent that has to fix them.
 *
 * Failing evidence feeds the correction loop, so the text is an instruction with
 * the real output attached rather than a status line. The tail of the output is
 * used rather than the head: a compiler prints its errors last.
 */
export function evidenceFindings(artifact: EvidenceArtifact): readonly string[] {
  if (evidencePassed(artifact)) return []

  const output = `${artifact.stdout}\n${artifact.stderr}`.trim()
  const tail = output === '' ? '(no output)' : lastLines(output, 40)

  if (artifact.outcome !== 'completed') {
    return [
      `The ${artifact.kind} command \`${artifact.command}\` did not finish (${artifact.outcome}: ${artifact.failure ?? 'no detail'}). Output so far:\n${tail}`,
    ]
  }

  return [
    `The ${artifact.kind} command \`${artifact.command}\` failed with exit code ${String(artifact.exitCode)}. Fix the cause; do not change the command. Output:\n${tail}`,
  ]
}

/** Keeps the last `count` lines, so a large log does not swamp a prompt packet. */
function lastLines(text: string, count: number): string {
  const lines = text.split('\n')
  if (lines.length <= count) return text
  return `... (${String(lines.length - count)} earlier lines omitted)\n${lines.slice(-count).join('\n')}`
}
