import { z } from 'zod'
import {
  agentReportSchema,
  ROLE_REQUIRED_CAPABILITIES,
  type AgentReport,
  type PromptPacket,
} from './runtime'
import type { Capability } from './enums'

/**
 * The wire protocol between Forge and an agent.
 *
 * This is the piece that replaces the user as the message bus. Agents do not talk to each
 * other in prose: Forge renders a packet, the agent replies with a fenced report, and the
 * report is parsed and validated before anything downstream sees it.
 *
 * ```
 * PromptPacket ──render──> text ──> agent ──> stdout ──extract──> JSON ──validate──> AgentReport
 *                                                          │                  │
 *                                                    no fence found      schema failure
 *                                                          └────── re-prompt once ──────┘
 *                                                                        │
 *                                                                  still bad -> fail the step
 * ```
 *
 * Everything in a report is a **claim**. `filesChanged` is reconciled against a real diff
 * in #34, `testsRun` is re-run by Forge in #33. Validation here establishes only that the
 * agent answered in the required shape — not that it told the truth.
 */

/**
 * The fences the report is delimited by.
 *
 * Deliberately not a bare ```json block: agents emit those constantly for ordinary code
 * samples, so a generic fence cannot be distinguished from the report. A distinctive
 * sentinel can be searched for unambiguously even when the model wraps it in commentary,
 * which — per rule R5 — it will.
 */
export const REPORT_BEGIN = 'FORGE_REPORT_BEGIN'
export const REPORT_END = 'FORGE_REPORT_END'

/** Why extracting a report failed. Coded so a caller branches without matching strings. */
export const protocolErrorCodeSchema = z.enum([
  'no-report',
  'unterminated-report',
  'invalid-json',
  'schema-violation',
])

export type ProtocolErrorCode = z.infer<typeof protocolErrorCodeSchema>

export interface ProtocolFailure {
  readonly ok: false
  readonly code: ProtocolErrorCode
  /** Written for the agent, since it is fed back verbatim on the re-prompt. */
  readonly message: string
}

export interface ProtocolSuccess {
  readonly ok: true
  readonly report: AgentReport
}

export type ProtocolResult = ProtocolSuccess | ProtocolFailure

/**
 * Extracts and validates a report from whatever the agent printed.
 *
 * Tolerant about surroundings and strict about content: an agent narrating before and
 * after its report is normal and must not be a failure, while a report missing a field is
 * a failure even if it looks plausible. That asymmetry is the point — the shape is the
 * contract, the prose is not.
 */
export function parseAgentReport(output: string): ProtocolResult {
  const begin = output.indexOf(REPORT_BEGIN)
  if (begin === -1) {
    return {
      ok: false,
      code: 'no-report',
      message: `No ${REPORT_BEGIN} block found. Reply with the report between ${REPORT_BEGIN} and ${REPORT_END}.`,
    }
  }

  // The *last* end fence, so a report whose content mentions the sentinel — an agent
  // quoting these instructions back, which happens — still parses.
  const end = output.lastIndexOf(REPORT_END)
  if (end === -1 || end < begin) {
    return {
      ok: false,
      code: 'unterminated-report',
      message: `Found ${REPORT_BEGIN} but no closing ${REPORT_END}.`,
    }
  }

  const body = output.slice(begin + REPORT_BEGIN.length, end).trim()

  // A fenced code block inside the sentinels is stripped: models add one reflexively even
  // when told not to, and rejecting for it would burn a retry on formatting rather than
  // substance.
  const unfenced = body
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```$/, '')
    .trim()

  let parsed: unknown
  try {
    parsed = JSON.parse(unfenced)
  } catch (error) {
    return {
      ok: false,
      code: 'invalid-json',
      message: `The report block is not valid JSON: ${error instanceof Error ? error.message : 'parse failed'}`,
    }
  }

  const result = agentReportSchema.safeParse(parsed)
  if (!result.success) {
    return {
      ok: false,
      code: 'schema-violation',
      // The full validation detail, because this text is what the re-prompt shows the
      // agent — a vague "invalid report" would make the retry a guess.
      message: z.prettifyError(result.error),
    }
  }

  return { ok: true, report: result.data }
}

/**
 * What Forge does about a report, once it is structurally valid.
 *
 * Separate from parsing because these are different judgements: parsing asks "did the
 * agent answer in the required shape", this asks "what does the answer mean for the
 * workflow". A valid report can still halt the run.
 */
export const reportVerdictSchema = z.enum([
  /** Proceed to verification. The claims are still unverified (A3). */
  'accept',
  /** `status: question` — route to the question queue and pause (A2). */
  'await-user',
  /** A non-empty `assumptions[]`. Rule R1 makes this a violation, not a note. */
  'halt-assumption',
  /** The agent reported itself blocked. */
  'halt-blocked',
])

export type ReportVerdict = z.infer<typeof reportVerdictSchema>

export interface ReportAssessment {
  readonly verdict: ReportVerdict
  /** Why, in words a user reads in the workflow log. */
  readonly reason: string
}

/**
 * Decides what a structurally valid report means.
 *
 * The ordering matters. An assumption is checked **before** status, so an agent that
 * admits an assumption while claiming `completed` is halted rather than accepted — the
 * combination is precisely how rule R1 gets violated in practice, and taking `status` at
 * face value first would let it through.
 */
export function assessReport(report: AgentReport): ReportAssessment {
  if (report.assumptions.length > 0) {
    return {
      verdict: 'halt-assumption',
      reason: `The agent recorded ${String(report.assumptions.length)} assumption(s), which rule R1 forbids: ${report.assumptions.join('; ')}`,
    }
  }

  switch (report.status) {
    case 'question': {
      if (report.openQuestions.length === 0) {
        // Claiming a question without asking one leaves the workflow with nothing to put
        // in the queue and nothing to wait for.
        return {
          verdict: 'halt-blocked',
          reason: 'The agent reported status "question" but raised no question',
        }
      }

      return {
        verdict: 'await-user',
        reason: `${String(report.openQuestions.length)} question(s) need a decision before work can continue`,
      }
    }

    case 'blocked': {
      return { verdict: 'halt-blocked', reason: report.summary }
    }

    case 'completed': {
      return {
        verdict: 'accept',
        // Worded to keep the distinction visible in the log: this is a claim entering
        // verification, not a finished step.
        reason: 'The agent reported completion; the claims are now checked against the repository',
      }
    }
  }
}

/**
 * Renders a packet as the text an agent receives.
 *
 * Sections are omitted when empty rather than shown as "none": a packet is snapshotted per
 * step and compared across runs, and a wall of empty headings makes a real change harder
 * to see. Ordering is fixed so two packets differing only in content produce a minimal
 * diff.
 *
 * The rules are stated without their scopes, deliberately — an agent is told what the
 * rules *are*. Knowing a rule came from a project rather than from Forge invites treating
 * it as negotiable.
 */
export function renderPromptPacket(packet: PromptPacket): string {
  const sections: string[] = []

  sections.push(`ROLE\n${packet.role}`)
  sections.push(`OBJECTIVE\n${packet.objective}`)

  if (packet.constraints.length > 0) {
    sections.push(`CONSTRAINTS\n${bullets(packet.constraints)}`)
  }

  if (packet.rules.length > 0) {
    sections.push(`RULES\n${numbered(packet.rules)}`)
  }

  if (packet.lockedDecisions.length > 0) {
    sections.push(
      `LOCKED DECISIONS — binding; to change one, stop and say so (R3)\n${bullets(packet.lockedDecisions)}`,
    )
  }

  if (packet.allowedPaths.length > 0) {
    sections.push(`YOU MAY MODIFY\n${bullets(packet.allowedPaths)}`)
  }

  if (packet.forbiddenPaths.length > 0) {
    sections.push(`YOU MAY NOT MODIFY\n${bullets(packet.forbiddenPaths)}`)
  }

  if (packet.relevantFiles.length > 0) {
    sections.push(
      `RELEVANT FILES — a starting point, not a limit\n${bullets(packet.relevantFiles)}`,
    )
  }

  if (packet.previousAttempt !== null) {
    sections.push(
      `PREVIOUS ATTEMPT\n${packet.previousAttempt.summary}\n\nWhat it actually changed, as measured by Forge:\n${packet.previousAttempt.diffStat || '(nothing)'}`,
    )
  }

  if (packet.reviewFindings.length > 0) {
    sections.push(`REVIEW FINDINGS TO ADDRESS\n${numbered(packet.reviewFindings)}`)
  }

  if (packet.answeredQuestions.length > 0) {
    sections.push(
      `ANSWERED QUESTIONS — settled; do not ask again\n${packet.answeredQuestions
        .map((entry) => `Q: ${entry.question}\nA: ${entry.answer}`)
        .join('\n\n')}`,
    )
  }

  if (packet.completionCriteria.length > 0) {
    sections.push(
      `HOW COMPLETION IS JUDGED — Forge checks these itself (R6)\n${bullets(packet.completionCriteria)}`,
    )
  }

  // Stated before the reply instructions, and derived from the role rather than written
  // per-template: a read-only role that edits anyway is halted by the reconciler, and
  // an agent that was never told it may not write is being punished for a rule it could
  // not have known. In the dogfood run (#130) the planner fixed the bug it was asked to
  // plan, correctly and uselessly — the work was done and the workflow refused it.
  //
  // No CLI permission mode expresses "answer normally but do not write": `plan` ends by
  // asking for approval instead of replying, `manual` waits for an approval a headless
  // run cannot give, and `auto` permits the edit. Measured, all three. So the constraint
  // is stated in the packet and enforced by Forge, which is where it belonged anyway.
  // Widened deliberately: `as const` gives each entry a narrow tuple type, so `includes`
  // rejects any capability that role does not already list — which is the question being
  // asked here.
  const required: readonly Capability[] = ROLE_REQUIRED_CAPABILITIES[packet.role]
  if (!required.includes('file-write')) {
    sections.push(
      `YOU MAY NOT MODIFY ANY FILE
This role is read-only. Describe the change you would make; a later step makes it.
Editing anything fails this step, even if the edit is correct.`,
    )
  }

  sections.push(REPORT_INSTRUCTIONS)

  return sections.join('\n\n')
}

function bullets(items: readonly string[]): string {
  return items.map((item) => `- ${item}`).join('\n')
}

function numbered(items: readonly string[]): string {
  return items.map((item, index) => `${String(index + 1)}. ${item}`).join('\n')
}

/**
 * The reply instructions, appended to every packet.
 *
 * Written as a filled-in example rather than a schema, because a model reproduces a shape
 * it has seen far more reliably than one it has to infer from field descriptions. The
 * `assumptions` note is emphatic on purpose: it is the field agents most want to use as a
 * footnote, and rule R1 makes it a violation.
 */
export const REPORT_INSTRUCTIONS = `HOW TO REPLY

Do the work first. Then reply with exactly one report block. Anything you write outside
the block is ignored, so put every conclusion inside it.

${REPORT_BEGIN}
{
  "status": "completed",
  "summary": "what you changed and why",
  "filesChanged": ["src/example.ts"],
  "commandsRun": ["npm test"],
  "testsRun": true,
  "openQuestions": [],
  "assumptions": []
}
${REPORT_END}

Rules for the report:

- "status" is "completed", "blocked", or "question".
- "filesChanged" lists every path you modified. Forge diffs the repository and compares;
  a path you did not touch, or a change you did not list, is a discrepancy.
- "assumptions" MUST be empty. If something is undetermined, inspect the repository, the
  configuration, and the related implementation. If it is still undetermined, reply with
  "status": "question" and fill in "openQuestions" instead of guessing.
- each open question needs "question", "whyUndetermined", "evidence" (paths you inspected,
  with a line number where one applies, and what you concluded), "options", and
  "recommendation" (or null).
- you do not decide whether the task is done. Report; Forge runs the build, runs the tests,
  and diffs the tree.`
