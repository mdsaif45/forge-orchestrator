import { z } from 'zod'
import type { PermissionMode } from './permissionMode'
import { reportStatusSchema, roleSchema, type Capability } from './enums'
import { evidenceRefSchema } from './question'
import { repoPathSchema, timestampSchema } from './ids'

/**
 * The runtime contract — the only thing the application layer knows about agents.
 *
 * Axiom A6 lives here. Nothing outside `src/main/runtimes/*` may name a provider, so
 * the engine talks to `IAgentRuntime` and an adapter translates. That indirection is
 * what let the #20 spike's finding (Antigravity ships no headless CLI) be a scoping
 * decision rather than a rewrite.
 *
 * Types are zod schemas because an agent's reply is untrusted input. A runtime that
 * returns a malformed report must fail at the boundary with a precise message, not
 * flow into the workflow engine as a plausible-looking object.
 */

/**
 * Identifies a runtime implementation.
 *
 * An opaque string, not an enum: the domain must not enumerate providers, or adding
 * one would mean editing core (A6). The registry validates that an id is *registered*,
 * which is the only property core needs.
 */
export const runtimeIdSchema = z.string().min(1).brand<'RuntimeId'>()
export type RuntimeId = z.infer<typeof runtimeIdSchema>

/** Identifies one live session with a runtime. */
export const sessionIdSchema = z.string().min(1).brand<'AgentSessionId'>()
export type AgentSessionId = z.infer<typeof sessionIdSchema>

/**
 * What a runtime is asked to do, compiled by the context engine (#30).
 *
 * Deliberately a closed shape rather than a free-form string: the packet is
 * snapshotted per step so a run can be replayed and two runs compared. A prompt
 * assembled ad hoc at the call site could not be either.
 *
 * `rules` arrives already resolved — the effective policy from
 * `resolveEffectivePolicy`, rendered as statements. An agent is told what the rules
 * are, never which scope they came from.
 */
export const promptPacketSchema = z.strictObject({
  /** Which role this step is performed as, which decides the system framing. */
  role: roleSchema,
  objective: z.string().min(1),
  constraints: z.array(z.string().min(1)).readonly(),
  /** The effective policy, most-specific-wins already applied. */
  rules: z.array(z.string().min(1)).readonly(),
  /** Locked decisions the agent may not contradict (A4). */
  lockedDecisions: z.array(z.string().min(1)).readonly(),
  /** Repository-relative paths the agent may modify. Empty means unconstrained. */
  allowedPaths: z.array(z.string().min(1)).readonly(),
  forbiddenPaths: z.array(z.string().min(1)).readonly(),
  /**
   * Files the context engine judged relevant, ranked (#30).
   *
   * A hint, not a restriction — `allowedPaths` is the restriction. Listing them saves the
   * agent rediscovering the same files on every step, which is the difference between a
   * focused packet and dumping the repository.
   */
  relevantFiles: z.array(z.string().min(1)).readonly(),
  /** Findings from a previous attempt, when this step is a correction. */
  reviewFindings: z.array(z.string().min(1)).readonly(),
  /**
   * What the previous attempt did, when this step is a correction.
   *
   * `diffStat` is Forge's own measurement rather than the previous agent's claim, so a
   * correction step starts from what actually happened (A3).
   */
  previousAttempt: z
    .strictObject({
      summary: z.string().min(1),
      diffStat: z.string(),
    })
    .nullable(),
  /**
   * The conditions Forge will check the work against.
   *
   * Sent deliberately: an agent that knows how completion is judged can aim at it, and
   * hiding the criteria would only invite a report that satisfies nothing measurable.
   * Forge still evaluates them itself (#35) — telling the agent is not delegating.
   */
  completionCriteria: z.array(z.string().min(1)).readonly(),
  /** Answers to questions the agent previously raised, so it need not ask twice. */
  answeredQuestions: z
    .array(z.strictObject({ question: z.string().min(1), answer: z.string().min(1) }))
    .readonly(),
})

export type PromptPacket = z.infer<typeof promptPacketSchema>

/**
 * What an agent says it did.
 *
 * Every field here is a **claim**, not a fact. The naming is deliberate: `#34`
 * reconciles `filesChanged` against a real git diff, and `#35` evaluates completion
 * criteria against evidence Forge gathered itself. A runtime returning this object
 * has reported, not finished (A3, and rule R6).
 *
 * `assumptions` must be empty. Rule R1 makes an assumption a violation rather than a
 * note, so a populated array is a signal for the engine to halt, not to proceed.
 */
export const agentReportSchema = z.strictObject({
  status: reportStatusSchema,
  summary: z.string().min(1),
  /** Claimed, not observed. Reconciled against `git diff` in #34. */
  filesChanged: z.array(repoPathSchema).readonly(),
  commandsRun: z.array(z.string().min(1)).readonly(),
  testsRun: z.boolean(),
  /** Present when `status` is `question`; the workflow then waits for the user. */
  openQuestions: z
    .array(
      z.strictObject({
        question: z.string().min(1),
        whyUndetermined: z.string().min(1),
        /**
         * Non-empty, matching `openQuestionSchema`.
         *
         * Rule R2 is enforced *here*, at the boundary where an agent's reply arrives,
         * rather than only on the stored entity — a question that skipped investigation
         * has to be refused as it comes in, not discovered later when something tries to
         * persist it. The two schemas disagreed on this at first, which meant the
         * enforcement existed everywhere except the one place it mattered.
         */
        evidence: z.array(evidenceRefSchema).min(1).readonly(),
        options: z.array(z.string().min(1)).readonly(),
        recommendation: z.string().min(1).nullable(),
      }),
    )
    .readonly(),
  /** Must be empty. Anything here halts the workflow rather than being accepted. */
  assumptions: z.array(z.string().min(1)).readonly(),
})

export type AgentReport = z.infer<typeof agentReportSchema>

/** True when a report claims completion while admitting an assumption (R1 breach). */
export function hasDisqualifyingAssumptions(report: AgentReport): boolean {
  return report.assumptions.length > 0
}

/**
 * Lifecycle of one session, as the engine sees it.
 *
 * `failed` is distinct from `cancelled`: one is the runtime breaking, the other is
 * Forge deciding to stop. The workflow's terminal states depend on telling them
 * apart — a crash may be retried, a cancellation must not be.
 */
export const runtimeSessionStateSchema = z.enum([
  'starting',
  'idle',
  'working',
  'completed',
  'failed',
  'cancelled',
])

export type RuntimeSessionState = z.infer<typeof runtimeSessionStateSchema>

export const runtimeStatusSchema = z.strictObject({
  sessionId: sessionIdSchema,
  state: runtimeSessionStateSchema,
  /** Set when the state is `failed`, so a caller need not parse the event stream. */
  failure: z.string().nullable(),
  /** Last time the runtime produced anything, for the no-progress detector (#29). */
  lastActivityAt: timestampSchema,
})

export type RuntimeStatus = z.infer<typeof runtimeStatusSchema>

/**
 * One thing that happened inside a session.
 *
 * A discriminated union so a consumer's `switch` is exhaustive at compile time, and
 * so an unknown event type cannot be silently ignored.
 *
 * The shape is drawn from what the #20 spike measured, not from what would be
 * convenient. Two findings in particular:
 *
 *   - a failure may arrive on **stdout** rather than stderr, so `error` is its own
 *     event rather than something inferred from a stream name
 *   - the CLI's own result envelope reported `subtype: "success"` while `is_error`
 *     was true, so `result` carries an explicit report and adapters must never map a
 *     provider's optimistic status field onto it
 */
export const runtimeEventSchema = z.discriminatedUnion('type', [
  /** Human-readable output, for the live log. Never parsed for meaning. */
  z.strictObject({
    type: z.literal('chunk'),
    at: timestampSchema,
    text: z.string(),
  }),
  /** A tool the agent invoked, as the runtime reported it. Still a claim. */
  z.strictObject({
    type: z.literal('tool'),
    at: timestampSchema,
    name: z.string().min(1),
    detail: z.string(),
  }),
  z.strictObject({
    type: z.literal('state'),
    at: timestampSchema,
    state: runtimeSessionStateSchema,
  }),
  /** The agent's structured report. Terminal for the step. */
  z.strictObject({
    type: z.literal('result'),
    at: timestampSchema,
    report: agentReportSchema,
  }),
  /** The runtime itself failed — crash, timeout, unparseable output, auth failure. */
  z.strictObject({
    type: z.literal('error'),
    at: timestampSchema,
    message: z.string().min(1),
    /** True when retrying could plausibly succeed; false for auth or policy failures. */
    retryable: z.boolean(),
  }),
])

export type RuntimeEvent = z.infer<typeof runtimeEventSchema>

/** How a session is set up. */
export interface SessionOptions {
  /** Absolute path the agent runs in. Every path it reports is relative to this. */
  readonly repositoryPath: string
  readonly role: z.infer<typeof roleSchema>
  /**
   * Which account to use, when a runtime supports several.
   *
   * Opaque to core: only the adapter knows what an account identifier means (A6).
   * Switching accounts must not disturb Forge's own state, which is why this belongs
   * to the session rather than to the runtime.
   */
  readonly accountId?: string | undefined
  /**
   * How much the agent may do without stopping to ask.
   *
   * Passed to the runtime rather than assumed by it: the dogfood run in #130 halted
   * because no mode reached the CLI, which then denied every tool call — an agent
   * that could reason but never read a file or write a change.
   */
  readonly permissionMode?: PermissionMode | undefined
  /** Hard ceiling for the step, enforced by the runtime. */
  readonly timeoutMs?: number | undefined
}

/** A live session. Opaque to the engine beyond its identifiers. */
export interface SessionHandle {
  readonly sessionId: AgentSessionId
  readonly runtimeId: RuntimeId
}

/**
 * What every agent runtime must implement.
 *
 * `events` is an async iterable rather than a callback registry so a consumer can
 * `for await` and have back-pressure and cancellation fall out of the language,
 * instead of each adapter inventing its own buffering.
 */
export interface IAgentRuntime {
  readonly id: RuntimeId
  /** Declared, then checked against the role when a binding is made (#31). */
  readonly capabilities: readonly Capability[]
  /**
   * True when this runtime produces scripted output rather than doing real work.
   *
   * Declared rather than inferred from the id. The UI previously had no way to tell a
   * mock's replayed `PASS` from evidence Forge actually gathered, and rendered both
   * identically (#101) — which is the very substitution of a claim for a verified fact
   * that A3 exists to prevent. Matching on an id prefix would have worked, but it puts
   * a provider-specific literal in core logic (A6) and fails silently the moment a mock
   * is renamed. A required field cannot be forgotten by a new runtime.
   */
  readonly simulated: boolean
  /**
   * Whether two concurrent sessions of this runtime can hold different accounts.
   *
   * Measured per provider in #111, and the two differ, which is why this is declared
   * rather than assumed globally:
   *
   * ```
   * claude  credential at ~/.claude/.credentials.json  -> a redirected home isolates
   * agy     credential in the Windows Credential Manager under one fixed target name
   *         -> every process reads the same identity, whatever environment it is given
   * ```
   *
   * A single global assumption is wrong in both directions. Assuming isolation works
   * would let two nominally different Antigravity accounts silently be one identity —
   * parallel work quietly running serial, at a third of the expected throughput, with
   * no visible cause. Assuming it does not would needlessly serialise Claude accounts
   * that demonstrably run in parallel.
   */
  readonly supportsAccountIsolation: boolean

  start(options: SessionOptions): Promise<SessionHandle>
  send(session: SessionHandle, packet: PromptPacket): Promise<void>
  events(session: SessionHandle): AsyncIterable<RuntimeEvent>
  status(session: SessionHandle): Promise<RuntimeStatus>
  /** Stops work. Must leave the worktree coherent (rule R8). */
  cancel(session: SessionHandle, reason: string): Promise<void>
  /** Releases resources. Safe to call twice. */
  dispose(session: SessionHandle): Promise<void>
}

/** Every capability a role needs before a runtime may hold it (#31). */
export const ROLE_REQUIRED_CAPABILITIES = {
  planner: ['repo-read', 'plan'],
  implementer: ['repo-read', 'file-write'],
  reviewer: ['repo-read', 'review'],
  tester: ['repo-read', 'test'],
  'security-reviewer': ['repo-read', 'review'],
  // Forge performs these itself; no runtime is involved.
  system: [],
  user: [],
} as const satisfies Record<z.infer<typeof roleSchema>, readonly Capability[]>

/**
 * Whether a runtime may hold a role.
 *
 * Capability-based rather than identity-based: any runtime may hold any role it can
 * actually perform, which is what makes planner and builder swappable (A6). A wrong
 * answer here would let a read-only runtime be bound as the implementer and fail only
 * once a workflow was already running.
 */
export function canHoldRole(
  capabilities: readonly Capability[],
  role: z.infer<typeof roleSchema>,
): boolean {
  return ROLE_REQUIRED_CAPABILITIES[role].every((required) => capabilities.includes(required))
}

/** Capabilities a role needs but the runtime does not declare. */
export function missingCapabilities(
  capabilities: readonly Capability[],
  role: z.infer<typeof roleSchema>,
): readonly Capability[] {
  return ROLE_REQUIRED_CAPABILITIES[role].filter((required) => !capabilities.includes(required))
}
