import { z } from 'zod'
import {
  isTerminalWorkflowState,
  WORKFLOW_STATES,
  workflowStateSchema,
  type WorkflowState,
} from './enums'

/**
 * The workflow state machine, as data.
 *
 * One table rather than `if` chains scattered through the engine. That matters for three
 * reasons, in descending order of how much trouble each would otherwise cause:
 *
 *   1. an illegal move throws instead of silently doing nothing, so a wrong transition is
 *      a loud bug rather than a workflow quietly stuck in the wrong state
 *   2. the diagram in `docs/DOMAIN.md` is generated from this table, so the documentation
 *      cannot drift from the behaviour
 *   3. the whole machine is testable without a runtime, a database, or a repository
 *
 * The table is the authority. `WORKFLOW_STATES` lists the states; this says how they
 * connect.
 */

/**
 * What causes a state change.
 *
 * Named for the *cause* rather than the destination, because several triggers can lead to
 * the same state and the reason is what the event log needs to record. `verified` and
 * `reviewPassed` both move toward completion, and conflating them would lose which check
 * actually cleared the work.
 */
export const WORKFLOW_TRIGGERS = [
  'start',
  'planProduced',
  'userApproved',
  'implementationStarted',
  'implemented',
  'verified',
  'verificationFailed',
  'reviewPassed',
  'reviewFailed',
  'correctionStarted',
  'questionRaised',
  'questionAnswered',
  'limitReached',
  'policyViolated',
  'cancelled',
] as const

export const workflowTriggerSchema = z.enum(WORKFLOW_TRIGGERS)
export type WorkflowTrigger = z.infer<typeof workflowTriggerSchema>

/**
 * The legal moves, keyed by state.
 *
 * A trigger absent from a state's entry is illegal *from that state* — that is the whole
 * point. `questionRaised`, `limitReached`, `policyViolated` and `cancelled` are legal from
 * any non-terminal state, so they are applied universally below rather than repeated in
 * fifteen places where one omission would be an invisible hole.
 */
const DIRECTED_TRANSITIONS = {
  DISCOVERY: { start: 'PLANNING' },
  PLANNING: { planProduced: 'PLAN_READY' },
  // The user's approval is the only way out. A6 is about providers; this is the human
  // gate, and nothing an agent reports can substitute for it.
  PLAN_READY: { userApproved: 'DECISIONS_LOCKED' },
  // Automatic: arriving here IS the locking, so there is no second approval. The trigger
  // names the work starting, which is what actually happens next.
  DECISIONS_LOCKED: { implementationStarted: 'IMPLEMENTING' },
  IMPLEMENTING: { implemented: 'VERIFYING' },
  // Verification failing is not the same as review failing: one means the build or tests
  // broke, the other means a reviewer read the diff and objected. Both loop back, and the
  // log has to say which happened.
  VERIFYING: { verified: 'REVIEWING', verificationFailed: 'CORRECTION_REQUIRED' },
  REVIEWING: { reviewPassed: 'DONE', reviewFailed: 'CORRECTION_REQUIRED' },
  CORRECTION_REQUIRED: { correctionStarted: 'IMPLEMENTING' },
  // Resume goes wherever `resumeState` says, so the destination is computed rather than
  // fixed. The trigger is still declared here so the move is legal.
  AWAITING_USER: { questionAnswered: null },
  DONE: {},
  HALTED_LIMIT: {},
  HALTED_POLICY: {},
  CANCELLED: {},
} as const satisfies Record<WorkflowState, Partial<Record<WorkflowTrigger, WorkflowState | null>>>

/** Triggers legal from any state that has not finished. */
const UNIVERSAL_TRANSITIONS = {
  questionRaised: 'AWAITING_USER',
  limitReached: 'HALTED_LIMIT',
  policyViolated: 'HALTED_POLICY',
  cancelled: 'CANCELLED',
} as const satisfies Partial<Record<WorkflowTrigger, WorkflowState>>

/** A resolved move: where a trigger leads, and whether the destination is dynamic. */
export interface Transition {
  readonly from: WorkflowState
  readonly trigger: WorkflowTrigger
  /** Null when the destination is `resumeState`, known only at runtime. */
  readonly to: WorkflowState | null
}

/**
 * Every legal move, flattened.
 *
 * Built once from the two tables above so callers never have to remember that universal
 * triggers exist. Generated rather than written out, because a hand-maintained list of
 * fifty-odd moves is exactly the kind of thing that goes stale silently.
 */
export const TRANSITIONS: readonly Transition[] = WORKFLOW_STATES.flatMap((from) => {
  const directed = Object.entries(DIRECTED_TRANSITIONS[from]).map(([trigger, to]) => ({
    from,
    trigger: trigger as WorkflowTrigger,
    to,
  }))

  // A terminal state accepts nothing, not even a cancel: the run is over, and letting a
  // late cancel move `DONE` to `CANCELLED` would rewrite history.
  if (isTerminalWorkflowState(from)) return directed

  const universal = Object.entries(UNIVERSAL_TRANSITIONS).map(([trigger, to]) => ({
    from,
    trigger: trigger as WorkflowTrigger,
    to,
  }))

  return [...directed, ...universal]
})

/** Raised when a trigger is not legal from the current state. */
export class IllegalTransitionError extends Error {
  constructor(
    readonly from: WorkflowState,
    readonly trigger: WorkflowTrigger,
    readonly allowed: readonly WorkflowTrigger[],
  ) {
    super(
      `"${trigger}" is not a legal transition from ${from}. Legal from here: ${
        allowed.length === 0 ? '(none — this state is terminal)' : allowed.join(', ')
      }`,
    )
    this.name = 'IllegalTransitionError'
  }
}

/** Every trigger legal from a state. */
export function legalTriggers(from: WorkflowState): readonly WorkflowTrigger[] {
  return TRANSITIONS.filter((transition) => transition.from === from).map(
    (transition) => transition.trigger,
  )
}

export function canTransition(from: WorkflowState, trigger: WorkflowTrigger): boolean {
  return TRANSITIONS.some(
    (transition) => transition.from === from && transition.trigger === trigger,
  )
}

export interface TransitionContext {
  /** Where to return to when the trigger is `questionAnswered`. */
  readonly resumeState?: WorkflowState | null
  readonly iteration?: number
  readonly maxIterations?: number
}

export interface TransitionResult {
  readonly from: WorkflowState
  readonly to: WorkflowState
  readonly trigger: WorkflowTrigger
  /** Incremented when re-entering `IMPLEMENTING` after a correction. */
  readonly iteration: number
  /** Set when the move is into `AWAITING_USER`, cleared on the way out. */
  readonly resumeState: WorkflowState | null
}

/**
 * Applies a trigger, or throws.
 *
 * Throwing is the design, not a rough edge: a workflow that silently ignored an illegal
 * move would sit in a state nothing expects, and the failure would surface much later as
 * inexplicable behaviour. A thrown error names the state, the trigger, and what *would*
 * have been legal.
 *
 * Pure. The engine writes the event and then applies the result, which is what makes the
 * write-ahead ordering in #28 possible — this function cannot have side effects to
 * order incorrectly.
 */
export function transition(
  from: WorkflowState,
  trigger: WorkflowTrigger,
  context: TransitionContext = {},
): TransitionResult {
  const move = TRANSITIONS.find(
    (candidate) => candidate.from === from && candidate.trigger === trigger,
  )

  if (move === undefined) {
    throw new IllegalTransitionError(from, trigger, legalTriggers(from))
  }

  const iteration = context.iteration ?? 0

  if (trigger === 'questionAnswered') {
    const resumeState = context.resumeState
    if (resumeState === undefined || resumeState === null) {
      throw new Error(
        'Resuming from AWAITING_USER requires the state to return to; the workflow recorded none',
      )
    }

    return { from, to: resumeState, trigger, iteration, resumeState: null }
  }

  if (trigger === 'questionRaised') {
    // The state being left is what resume returns to. Recorded here rather than by the
    // caller, so it cannot be forgotten.
    return { from, to: 'AWAITING_USER', trigger, iteration, resumeState: from }
  }

  if (trigger === 'correctionStarted') {
    const next = iteration + 1
    const max = context.maxIterations

    // The cap is enforced here rather than left to the caller, because this is the only
    // edge that can loop: correction is what A5 exists to bound. Halting at the boundary
    // means the log shows a limit, not a workflow that mysteriously stopped.
    if (max !== undefined && next > max) {
      return {
        from,
        to: 'HALTED_LIMIT',
        trigger: 'limitReached',
        iteration,
        resumeState: null,
      }
    }

    return { from, to: 'IMPLEMENTING', trigger, iteration: next, resumeState: null }
  }

  if (move.to === null) {
    // Only `questionAnswered` has a dynamic destination, and it returned above.
    throw new Error(`Transition ${from} --${trigger}--> has no destination`)
  }

  return { from, to: move.to, trigger, iteration, resumeState: null }
}

/**
 * Renders the transition table as a Mermaid state diagram.
 *
 * Generated so `docs/DOMAIN.md` cannot drift from the code — a diagram maintained by hand
 * beside a table is a diagram that will eventually lie. A test compares the committed
 * documentation against this output.
 *
 * Universal triggers are summarised in a note rather than drawn: four edges from every one
 * of nine non-terminal states is thirty-six lines that hide the actual flow.
 */
export function renderStateDiagram(): string {
  const lines = ['stateDiagram-v2', '    [*] --> DISCOVERY']

  for (const state of WORKFLOW_STATES) {
    for (const [trigger, to] of Object.entries(DIRECTED_TRANSITIONS[state])) {
      if (to === null) {
        // The dynamic edge, drawn to show that resume returns somewhere rather than
        // dead-ending.
        lines.push(`    ${state} --> ${state}: ${trigger} (returns to resumeState)`)
        continue
      }

      lines.push(`    ${state} --> ${to}: ${trigger}`)
    }
  }

  for (const state of WORKFLOW_STATES) {
    if (isTerminalWorkflowState(state)) lines.push(`    ${state} --> [*]`)
  }

  lines.push(
    '',
    '    note right of DISCOVERY',
    '        From any non-terminal state:',
    ...Object.entries(UNIVERSAL_TRANSITIONS).map(([trigger, to]) => `        ${trigger} --> ${to}`),
    '    end note',
  )

  return lines.join('\n')
}

/** Parses an unknown value as a state, for data crossing a boundary. */
export function parseWorkflowState(value: unknown): WorkflowState {
  return workflowStateSchema.parse(value)
}
