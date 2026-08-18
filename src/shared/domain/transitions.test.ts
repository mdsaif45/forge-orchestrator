import { describe, expect, it } from 'vitest'
import {
  isTerminalWorkflowState,
  TERMINAL_WORKFLOW_STATES,
  WORKFLOW_STATES,
  type WorkflowState,
} from './enums'
import {
  canTransition,
  IllegalTransitionError,
  legalTriggers,
  renderStateDiagram,
  transition,
  TRANSITIONS,
  WORKFLOW_TRIGGERS,
  type WorkflowTrigger,
} from './transitions'

/**
 * The workflow state machine.
 *
 * Tested exhaustively rather than representatively: this decides what Forge does next at
 * every point in a run, and a hole in it is a workflow stuck in a state nothing expects.
 * Being a pure function over data, exhaustive here means genuinely every state and every
 * trigger — 13 × 15 combinations — not a sample.
 */

/** Walks the happy path, which every other test starts from some point along. */
function walkToState(target: WorkflowState): { state: WorkflowState; iteration: number } {
  const path: readonly WorkflowTrigger[] = [
    'start',
    'planProduced',
    'userApproved',
    'implementationStarted',
    'implemented',
    'verified',
    'reviewPassed',
  ]

  let state: WorkflowState = 'DISCOVERY'
  let iteration = 0

  if (target === 'DISCOVERY') return { state, iteration }

  for (const trigger of path) {
    const result = transition(state, trigger, { iteration, maxIterations: 5 })
    state = result.to
    iteration = result.iteration
    if (state === target) break
  }

  return { state, iteration }
}

describe('the transition table', () => {
  it('covers every declared state', () => {
    // A state with no entry would be unreachable by omission rather than by design.
    const states = new Set(TRANSITIONS.map((entry) => entry.from))
    const nonTerminal = WORKFLOW_STATES.filter((state) => !isTerminalWorkflowState(state))

    for (const state of nonTerminal) {
      expect(states.has(state), `${state} has no transitions`).toBe(true)
    }
  })

  it('uses only declared triggers and states', () => {
    for (const entry of TRANSITIONS) {
      expect(WORKFLOW_TRIGGERS).toContain(entry.trigger)
      expect(WORKFLOW_STATES).toContain(entry.from)
      if (entry.to !== null) expect(WORKFLOW_STATES).toContain(entry.to)
    }
  })

  it('declares no duplicate state/trigger pair', () => {
    // Two entries for one pair would make the destination depend on array order.
    const seen = new Set<string>()

    for (const entry of TRANSITIONS) {
      const key = `${entry.from}:${entry.trigger}`
      expect(seen.has(key), `duplicate transition ${key}`).toBe(false)
      seen.add(key)
    }
  })

  it('allows the universal triggers from every non-terminal state', () => {
    // Declared once and applied to all, precisely so a single omission cannot leave a
    // state that cannot be cancelled or halted.
    for (const state of WORKFLOW_STATES) {
      if (isTerminalWorkflowState(state)) continue

      for (const trigger of ['questionRaised', 'limitReached', 'policyViolated', 'cancelled']) {
        expect(canTransition(state, trigger as WorkflowTrigger), `${state} + ${trigger}`).toBe(true)
      }
    }
  })

  it('makes terminal states accept nothing at all', () => {
    // Not even a cancel: the run is over, and letting a late cancel move DONE to
    // CANCELLED would rewrite history.
    for (const state of TERMINAL_WORKFLOW_STATES) {
      expect(legalTriggers(state)).toEqual([])

      for (const trigger of WORKFLOW_TRIGGERS) {
        expect(() => transition(state, trigger)).toThrow(IllegalTransitionError)
      }
    }
  })
})

describe('the happy path', () => {
  it('runs discovery through to done', () => {
    const sequence: readonly [WorkflowTrigger, WorkflowState][] = [
      ['start', 'PLANNING'],
      ['planProduced', 'PLAN_READY'],
      ['userApproved', 'DECISIONS_LOCKED'],
      ['implementationStarted', 'IMPLEMENTING'],
      ['implemented', 'VERIFYING'],
      ['verified', 'REVIEWING'],
      ['reviewPassed', 'DONE'],
    ]

    let state: WorkflowState = 'DISCOVERY'
    for (const [trigger, expected] of sequence) {
      state = transition(state, trigger, { iteration: 0, maxIterations: 5 }).to
      expect(state).toBe(expected)
    }
  })

  it('requires the user to approve the plan', () => {
    // The human gate. Nothing an agent reports can substitute for it, so no other trigger
    // may leave PLAN_READY toward implementation.
    const escapes = legalTriggers('PLAN_READY').filter(
      (trigger) =>
        !['questionRaised', 'limitReached', 'policyViolated', 'cancelled'].includes(trigger),
    )

    expect(escapes).toEqual(['userApproved'])
  })
})

describe('the correction loop', () => {
  it('increments the iteration on re-entering implementation', () => {
    const result = transition('CORRECTION_REQUIRED', 'correctionStarted', {
      iteration: 1,
      maxIterations: 5,
    })

    expect(result.to).toBe('IMPLEMENTING')
    expect(result.iteration).toBe(2)
  })

  it('distinguishes a failed verification from a failed review', () => {
    // One means the build or tests broke, the other means a reviewer read the diff and
    // objected. Both loop back, and the log has to say which happened.
    expect(transition('VERIFYING', 'verificationFailed').to).toBe('CORRECTION_REQUIRED')
    expect(transition('REVIEWING', 'reviewFailed').to).toBe('CORRECTION_REQUIRED')
  })

  it('halts at the iteration cap instead of looping forever', () => {
    // Axiom A5. Enforced on this edge because correction is the only one that can loop.
    const result = transition('CORRECTION_REQUIRED', 'correctionStarted', {
      iteration: 5,
      maxIterations: 5,
    })

    expect(result.to).toBe('HALTED_LIMIT')
    // The recorded trigger is the *reason*, so the log says "limit", not "correction".
    expect(result.trigger).toBe('limitReached')
    expect(result.iteration).toBe(5)
  })

  it('loops while under the cap', () => {
    let state: WorkflowState = 'IMPLEMENTING'
    let iteration = 0

    for (let cycle = 0; cycle < 3; cycle += 1) {
      state = transition(state, 'implemented', { iteration }).to
      state = transition(state, 'verified', { iteration }).to
      state = transition(state, 'reviewFailed', { iteration }).to
      const result = transition(state, 'correctionStarted', { iteration, maxIterations: 5 })
      state = result.to
      iteration = result.iteration
    }

    expect(state).toBe('IMPLEMENTING')
    expect(iteration).toBe(3)
  })

  it('does not cap when no maximum is supplied', () => {
    // The cap belongs to the workflow's limits; a caller that omits them is not silently
    // given one.
    const result = transition('CORRECTION_REQUIRED', 'correctionStarted', { iteration: 99 })

    expect(result.to).toBe('IMPLEMENTING')
    expect(result.iteration).toBe(100)
  })
})

describe('awaiting the user', () => {
  it('records the state it left, so resume is exact', () => {
    const result = transition('IMPLEMENTING', 'questionRaised', { iteration: 2 })

    expect(result.to).toBe('AWAITING_USER')
    expect(result.resumeState).toBe('IMPLEMENTING')
    // The iteration survives the pause: answering a question is not a new attempt.
    expect(result.iteration).toBe(2)
  })

  it('returns to exactly the recorded state', () => {
    for (const state of WORKFLOW_STATES) {
      if (isTerminalWorkflowState(state) || state === 'AWAITING_USER') continue

      const paused = transition(state, 'questionRaised')
      const resumed = transition('AWAITING_USER', 'questionAnswered', {
        resumeState: paused.resumeState,
      })

      expect(resumed.to).toBe(state)
      // Cleared on the way out, or a later validation would reject the workflow.
      expect(resumed.resumeState).toBeNull()
    }
  })

  it('refuses to resume without a recorded state', () => {
    // Guessing a destination here would silently restart work from the wrong point, which
    // is worse than failing loudly.
    expect(() => transition('AWAITING_USER', 'questionAnswered', { resumeState: null })).toThrow(
      /requires the state to return to/,
    )
    expect(() => transition('AWAITING_USER', 'questionAnswered')).toThrow(
      /requires the state to return to/,
    )
  })

  it('can be cancelled or halted while paused', () => {
    expect(transition('AWAITING_USER', 'cancelled').to).toBe('CANCELLED')
    expect(transition('AWAITING_USER', 'policyViolated').to).toBe('HALTED_POLICY')
  })
})

describe('illegal transitions', () => {
  it('throws rather than silently ignoring the move', () => {
    // A workflow that ignored an illegal move would sit in a state nothing expects, and
    // the failure would surface much later as inexplicable behaviour.
    expect(() => transition('DISCOVERY', 'reviewPassed')).toThrow(IllegalTransitionError)
  })

  it('names the state, the trigger, and what would have been legal', () => {
    try {
      transition('DISCOVERY', 'reviewPassed')
      expect.unreachable('the transition should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(IllegalTransitionError)
      if (!(error instanceof IllegalTransitionError)) return

      expect(error.from).toBe('DISCOVERY')
      expect(error.trigger).toBe('reviewPassed')
      expect(error.allowed).toContain('start')
      expect(error.message).toContain('start')
    }
  })

  it('refuses to skip the user approval gate', () => {
    expect(() => transition('PLAN_READY', 'implemented')).toThrow(IllegalTransitionError)
    expect(() => transition('PLANNING', 'userApproved')).toThrow(IllegalTransitionError)
  })

  it('says so plainly when a state is terminal', () => {
    expect(() => transition('DONE', 'cancelled')).toThrow(/terminal/)
  })
})

describe('no sequence can reach an undefined state', () => {
  it('holds for every state crossed with every trigger', () => {
    // The property test the definition of done asks for, done exhaustively rather than
    // randomly: the input space is 13 states × 15 triggers, so sampling would be a weaker
    // claim than simply checking all of it.
    for (const from of WORKFLOW_STATES) {
      for (const trigger of WORKFLOW_TRIGGERS) {
        let result
        try {
          result = transition(from, trigger, {
            resumeState: 'IMPLEMENTING',
            iteration: 1,
            maxIterations: 5,
          })
        } catch (error) {
          // Only these two failures are acceptable, and both are deliberate.
          expect(
            error instanceof IllegalTransitionError ||
              (error instanceof Error && error.message.includes('requires the state to return to')),
            `${from} + ${trigger} threw something unexpected: ${String(error)}`,
          ).toBe(true)
          continue
        }

        expect(WORKFLOW_STATES, `${from} + ${trigger} produced ${result.to}`).toContain(result.to)
        expect(result.iteration).toBeGreaterThanOrEqual(0)
      }
    }
  })

  it('holds across long random walks', () => {
    // A deterministic pseudo-random walk rather than Math.random, so a failure is
    // reproducible. Complements the exhaustive single-step check above: this catches a
    // state reachable only through a particular *sequence*.
    let seed = 20260819

    const nextInt = (bound: number): number => {
      // A linear congruential generator: small, deterministic, and adequate for choosing
      // a trigger. Nothing here depends on statistical quality.
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed % bound
    }

    for (let walk = 0; walk < 200; walk += 1) {
      let state: WorkflowState = 'DISCOVERY'
      let iteration = 0

      for (let step = 0; step < 40; step += 1) {
        const trigger = WORKFLOW_TRIGGERS[nextInt(WORKFLOW_TRIGGERS.length)]
        if (trigger === undefined) continue

        try {
          const result = transition(state, trigger, {
            resumeState: state === 'AWAITING_USER' ? 'IMPLEMENTING' : null,
            iteration,
            maxIterations: 5,
          })
          state = result.to
          iteration = result.iteration
        } catch {
          // An illegal move leaves the state untouched, which is the guarantee: a rejected
          // trigger cannot corrupt the workflow.
          continue
        }

        expect(WORKFLOW_STATES).toContain(state)
        expect(iteration).toBeLessThanOrEqual(5)
      }
    }
  })

  it('reaches every terminal state', () => {
    // The other half of the definition of done. Each is reached through the machine rather
    // than asserted to exist.
    expect(walkToState('DONE').state).toBe('DONE')
    expect(transition('IMPLEMENTING', 'cancelled').to).toBe('CANCELLED')
    expect(transition('VERIFYING', 'policyViolated').to).toBe('HALTED_POLICY')
    expect(
      transition('CORRECTION_REQUIRED', 'correctionStarted', { iteration: 5, maxIterations: 5 }).to,
    ).toBe('HALTED_LIMIT')
  })

  it('reaches every non-terminal state too', () => {
    // `walkToState` follows the happy path, which by definition never fails a review, so
    // CORRECTION_REQUIRED and AWAITING_USER are reached by their own routes. Listing them
    // explicitly is the point: every state must be reachable by *some* real sequence, and
    // a helper that quietly skipped one would hide an unreachable state.
    const offHappyPath: readonly WorkflowState[] = ['CORRECTION_REQUIRED', 'AWAITING_USER']

    for (const state of WORKFLOW_STATES) {
      if (isTerminalWorkflowState(state) || offHappyPath.includes(state)) continue
      expect(walkToState(state).state, `${state} is unreachable`).toBe(state)
    }

    expect(transition('REVIEWING', 'reviewFailed').to).toBe('CORRECTION_REQUIRED')
    expect(transition('VERIFYING', 'verificationFailed').to).toBe('CORRECTION_REQUIRED')
    expect(transition('PLANNING', 'questionRaised').to).toBe('AWAITING_USER')
  })
})

describe('the generated diagram', () => {
  it('is a mermaid state diagram', () => {
    const diagram = renderStateDiagram()

    expect(diagram.startsWith('stateDiagram-v2')).toBe(true)
    expect(diagram).toContain('[*] --> DISCOVERY')
  })

  it('includes every directed edge from the table', () => {
    const diagram = renderStateDiagram()

    for (const entry of TRANSITIONS) {
      // Universal triggers are summarised in a note rather than drawn as 36 edges.
      if (
        ['questionRaised', 'limitReached', 'policyViolated', 'cancelled'].includes(entry.trigger)
      ) {
        continue
      }

      expect(diagram, `missing ${entry.from} --${entry.trigger}-->`).toContain(`${entry.from} -->`)
      expect(diagram).toContain(entry.trigger)
    }
  })

  it('marks every terminal state as an end state', () => {
    const diagram = renderStateDiagram()

    for (const state of TERMINAL_WORKFLOW_STATES) {
      expect(diagram).toContain(`${state} --> [*]`)
    }
  })

  it('summarises the universal triggers rather than drawing them', () => {
    const diagram = renderStateDiagram()

    expect(diagram).toContain('From any non-terminal state')
    expect(diagram).toContain('cancelled --> CANCELLED')
  })

  it('renders identically every time', () => {
    // Committed into docs and compared by a test, so it must be a pure function of the
    // table — no ordering that depends on object iteration order changing.
    expect(renderStateDiagram()).toBe(renderStateDiagram())
  })
})
