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
  /**
   * The repository's own `CLAUDE.md`, when it has one (#133).
   *
   * Present because the spawned CLI runs with `--safe-mode`, which stops it loading the
   * file itself. That is deliberate: a packet whose meaning depends on how the host
   * machine is configured is not a packet (A1). Forge reads the file and decides to
   * include it, so what the agent was told is the artifact stored per step rather than
   * whatever happened to be on disk.
   *
   * Null when the repository has none, which is the common case and not a warning.
   * Rendered under its own heading so an agent is not told two things in one voice —
   * Forge's rules are policy, this is the repository's own guidance.
   */
  repositoryInstructions: z.string().min(1).nullable().default(null),
  /**
   * Why the previous reply was rejected, on the single re-prompt of a malformed report.
   *
   * On the packet rather than passed alongside it, because a runtime receives a packet and
   * renders the text itself. `exchange()` used to build the corrected prompt as a string
   * and then send the unchanged packet, so every adapter re-rendered from the packet and
   * the correction reached no agent — while the transcript recorded it as sent. A run
   * would halt reporting `retried: true` after two byte-identical attempts (#135).
   *
   * Distinct from `reviewFindings`, which is a judgement about the *work*. This is about
   * the shape of the *reply*, and it is transport-level: never persisted as a finding.
   */
  correction: z.string().min(1).nullable().default(null),
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
  /**
   * What the turn cost, as the provider reported it (#137).
   *
   * Emitted when the provider says; never estimated. Recording it lets a user watch an
   * account approach its limit rather than discover it mid-run, which is the difference
   * between planning around a limit and being stopped by one.
   *
   * Every field is optional because providers report different things — cost without token
   * counts, counts without cost — and a shape demanding all of them would force an adapter
   * to invent the rest (A3).
   */
  z.strictObject({
    type: z.literal('usage'),
    at: timestampSchema,
    costUsd: z.number().nonnegative().nullable().default(null),
    inputTokens: z.number().int().nonnegative().nullable().default(null),
    outputTokens: z.number().int().nonnegative().nullable().default(null),
  }),
  /** The runtime itself failed — crash, timeout, unparseable output, auth failure. */
  z.strictObject({
    type: z.literal('error'),
    at: timestampSchema,
    message: z.string().min(1),
    /** True when retrying could plausibly succeed; false for auth or policy failures. */
    retryable: z.boolean(),
    /**
     * The provider refused because this account's limit is spent (#137).
     *
     * Declared by the adapter, which owns its provider's wire format, and acted on by core,
     * which must never match on a provider's error text (A6). A limit is not a failure of
     * the work: the agent did nothing wrong, the code is fine, and retrying immediately
     * fails identically — so this halts with a stated remedy instead of spending a retry.
     *
     * Absent means "an ordinary error", which is the safe default: a missed limit is
     * reported as a plain failure, where a false positive would halt a healthy run and
     * tell the user to go find another account.
     */
    providerLimit: z.boolean().default(false),
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
  /**
   * A stable name for this step's conversation, so a runtime that can resume one
   * knows which to resume.
   *
   * Opaque and provider-neutral: core supplies an identity, and each adapter
   * decides what its CLI does with it — one derives a UUID for `--session-id`,
   * another may have no equivalent and ignore it entirely (A6).
   *
   * Derived from the workflow, step, and iteration rather than stored, so it
   * survives a Forge restart. Storing whatever the provider reported would work
   * right up until the process holding it died mid-run, which is exactly when
   * resuming matters.
   */
  readonly resumeKey?:
    | {
        readonly workflowId: string
        readonly stepIndex: number
        /** A retry is a new conversation, not a continuation of the rejected one. */
        readonly iteration: number
      }
    | undefined
  /**
   * Hands the caller a way to reach this session's process once it starts (#170).
   *
   * The workflow pane used to spawn its own CLI session and render that, while the
   * agent doing the work ran unobserved. Attaching to the real one needs a
   * reference to it, and only the runtime has that.
   *
   * `write`, `resize`, and `onData` are optional because not every transport carries them: a
   * pipe closes stdin after the prompt and has no window size, a pty has all three.
   * Declaring the absence lets the UI say "this session cannot take input" rather
   * than accepting text that goes nowhere — a dead input control is worse than a
   * missing one, and this app has already shipped that mistake once.
   *
   * No provider is named here: core learns that a process exists and how to speak
   * to it, never what it is (A6).
   */
  readonly onProcess?:
    | ((process: {
        readonly write?: (input: string) => void
        readonly resize?: (cols: number, rows: number) => void
        readonly onData?: (listener: (chunk: string) => void) => () => void
      }) => void)
    | undefined
}

/**
 * The canonical session key a step's process is published under for UI attachment (#170).
 * Composed as `${workflowId}#${stepIndex}`.
 */
export function agentSessionKey(workflowId: string, stepIndex: number): string {
  return `${workflowId}#${String(stepIndex)}`
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
  /**
   * The filenames this provider's CLI would read a repository's instructions from.
   *
   * Declared here rather than hardcoded in core, for the same reason as the two fields
   * above: the name is provider-specific, and core must not contain one (A6). Forge reads
   * the file and puts it in the packet itself, because the spawned process runs with its
   * host configuration disabled so that what enters an agent's context is what Forge put
   * there (A1, #133).
   *
   * Ordered by preference; the first that exists is used. Empty means this runtime has no
   * such convention, which is a legitimate answer and not a gap.
   */
  readonly instructionFilenames: readonly string[]

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
