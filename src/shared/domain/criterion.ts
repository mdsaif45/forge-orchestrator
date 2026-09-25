import { z } from 'zod'
import { criterionKindSchema, verdictSchema } from './enums'

/**
 * One criterion's outcome, with the reason a user reads in the workflow log or CLI report.
 *
 * Grounded strictly in Axiom A3: physical evidence decides the verdict, never
 * agent self-report or optimism.
 */
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

/**
 * Formats a criterion result for terminal and log display.
 */
export function formatCriterionResult(result: CriterionResult): string {
  const icon = result.verdict === 'pass' ? '✓' : result.verdict === 'fail' ? '✗' : '?'
  return `${icon} [${result.kind}] ${result.description} — ${result.reason}`
}
