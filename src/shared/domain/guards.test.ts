import { describe, expect, it } from 'vitest'
import {
  checkBudgets,
  checkStopConditions,
  decideRetry,
  detectNoProgress,
  fingerprintChange,
  HALT_CODES,
  haltStateFor,
  remainingBudget,
  type BudgetState,
  type StepOutcomeSignals,
} from './guards'
import { workflowLimitsSchema, type WorkflowLimits } from './workflow'

/**
 * Loop guards.
 *
 * The failure mode under test is two agents exchanging work forever, each plausibly making
 * progress. Every guard here answers "is it still reasonable to continue", and the
 * interesting cases are the ones where the naive answer is yes.
 */

function limits(overrides: Partial<WorkflowLimits> = {}): WorkflowLimits {
  return workflowLimitsSchema.parse(overrides)
}

function budget(overrides: Partial<BudgetState> = {}): BudgetState {
  return { iteration: 0, elapsedMs: 0, stepElapsedMs: null, stepIdleMs: null, ...overrides }
}

function signals(overrides: Partial<StepOutcomeSignals> = {}): StepOutcomeSignals {
  return {
    buildFailed: false,
    testsFailed: false,
    hasOpenQuestion: false,
    permissionViolated: false,
    modifiedUnexpectedFiles: false,
    ...overrides,
  }
}

describe('the defaults', () => {
  it('match the values the design specifies', () => {
    const defaults = limits()

    expect(defaults.maxIterations).toBe(5)
    expect(defaults.stepTimeoutMs).toBe(30 * 60 * 1000)
    expect(defaults.idleTimeoutMs).toBe(10 * 60 * 1000)
    expect(defaults.totalTimeoutMs).toBe(4 * 60 * 60 * 1000)
    expect(defaults.maxRetries).toBe(3)
    expect(defaults.retryDelayMs).toBe(5000)
  })

  it('defaults the stop-on toggles to the cautious reading', () => {
    const { stopOn } = limits()

    // A failing build or test is left to the correction loop; a policy breach is not.
    expect(stopOn.buildFailure).toBe(false)
    expect(stopOn.testFailure).toBe(false)
    expect(stopOn.unexpectedFileModification).toBe(true)
    expect(stopOn.permissionViolation).toBe(true)
  })

  it('refuses to make a permission violation optional', () => {
    // A7 is not a preference. The schema types the field as `true`, so this cannot be
    // configured away even by a caller trying to.
    expect(() => workflowLimitsSchema.parse({ stopOn: { permissionViolation: false } })).toThrow()
  })
})

describe('checkBudgets', () => {
  it('permits a run that is within every budget', () => {
    expect(checkBudgets(budget({ iteration: 2, elapsedMs: 60_000 }), limits())).toBeNull()
  })

  it('halts at the iteration cap', () => {
    const decision = checkBudgets(budget({ iteration: 6 }), limits({ maxIterations: 5 }))

    expect(decision?.code).toBe('iteration-cap')
    expect(decision?.reason).toContain('5')
  })

  it('halts on the step timeout', () => {
    const decision = checkBudgets(
      budget({ stepElapsedMs: 31 * 60 * 1000 }),
      limits({ stepTimeoutMs: 30 * 60 * 1000 }),
    )

    expect(decision?.code).toBe('step-timeout')
    expect(decision?.reason).toContain('30m')
  })

  it('halts on the idle timeout', () => {
    const decision = checkBudgets(budget({ stepIdleMs: 11 * 60 * 1000 }), limits())

    expect(decision?.code).toBe('idle-timeout')
    expect(decision?.reason).toMatch(/no output/)
  })

  it('reports the total budget before a per-step one', () => {
    // Ordering that matters: a workflow past its overall deadline should say so, not blame
    // whichever step happened to be running. "Step timed out" would send the user looking
    // at the wrong thing.
    const decision = checkBudgets(
      budget({ elapsedMs: 5 * 60 * 60 * 1000, stepElapsedMs: 60 * 60 * 1000 }),
      limits(),
    )

    expect(decision?.code).toBe('total-timeout')
  })

  it('treats reaching a budget exactly as exhausted', () => {
    // `>=`, not `>`: a budget of 30m means 30m is the wall, not the last permitted moment.
    expect(checkBudgets(budget({ stepElapsedMs: 30 * 60 * 1000 }), limits())?.code).toBe(
      'step-timeout',
    )
  })

  it('ignores step budgets between steps', () => {
    // Null means no step is running; a zero would look like a step that just started and
    // is well within budget, which is a different claim.
    expect(checkBudgets(budget({ stepElapsedMs: null, stepIdleMs: null }), limits())).toBeNull()
  })
})

describe('remainingBudget', () => {
  it('reports what is left, for the UI to show before a wall is hit', () => {
    const remaining = remainingBudget(
      budget({ iteration: 2, elapsedMs: 60 * 60 * 1000, stepElapsedMs: 10 * 60 * 1000 }),
      limits(),
    )

    expect(remaining.iterationsLeft).toBe(3)
    expect(remaining.totalMsLeft).toBe(3 * 60 * 60 * 1000)
    expect(remaining.stepMsLeft).toBe(20 * 60 * 1000)
  })

  it('never reports a negative remainder', () => {
    // A user reading "-1 iterations left" learns nothing useful.
    const remaining = remainingBudget(
      budget({ iteration: 99, elapsedMs: 99 * 60 * 60 * 1000 }),
      limits(),
    )

    expect(remaining.iterationsLeft).toBe(0)
    expect(remaining.totalMsLeft).toBe(0)
  })
})

describe('decideRetry', () => {
  it('retries a transient failure with the configured delay', () => {
    const decision = decideRetry('transient', 0, limits())

    expect(decision.shouldRetry).toBe(true)
    expect(decision.attemptsUsed).toBe(1)
    expect(decision.delayMs).toBe(5000)
  })

  it('never retries a semantic failure', () => {
    // The distinction that matters most here: retrying a bad credential or a policy breach
    // spends the budget on a certainty and delays the halt the user needs to see.
    const decision = decideRetry('semantic', 0, limits())

    expect(decision.shouldRetry).toBe(false)
    expect(decision.reason).toMatch(/same request would fail/)
  })

  it('stops once the retry budget is spent', () => {
    expect(decideRetry('transient', 3, limits({ maxRetries: 3 })).shouldRetry).toBe(false)
    expect(decideRetry('transient', 3, limits({ maxRetries: 3 })).reason).toMatch(/Exhausted 3/)
  })

  it('honours a zero retry budget', () => {
    // A project that wants no retries at all must get none, not one.
    expect(decideRetry('transient', 0, limits({ maxRetries: 0 })).shouldRetry).toBe(false)
  })

  it('uses a fixed delay rather than exponential backoff', () => {
    // Exponential backoff earns its complexity when many clients contend for one resource.
    // A single workflow retrying its own local step only takes longer to admit defeat.
    const first = decideRetry('transient', 0, limits())
    const second = decideRetry('transient', 1, limits())

    expect(second.delayMs).toBe(first.delayMs)
  })
})

describe('fingerprintChange', () => {
  const files = [
    { path: 'src/math.ts', insertions: 1, deletions: 1 },
    { path: 'src/other.ts', insertions: 2, deletions: 0 },
  ]

  it('is stable for the same change', () => {
    expect(fingerprintChange(files, 'patch text')).toBe(fingerprintChange(files, 'patch text'))
  })

  it('ignores the order files arrive in', () => {
    // A fingerprint that changed because two files swapped places would report progress
    // that did not happen.
    expect(fingerprintChange([...files].reverse(), 'patch text')).toBe(
      fingerprintChange(files, 'patch text'),
    )
  })

  it('distinguishes a different patch with the same shape', () => {
    // Line counts alone are too coarse: changing a constant to 43 instead of 42 is the same
    // shape and a different change.
    expect(fingerprintChange(files, 'answer = 42')).not.toBe(
      fingerprintChange(files, 'answer = 43'),
    )
  })

  it('distinguishes a different set of files', () => {
    expect(fingerprintChange(files, 'p')).not.toBe(
      fingerprintChange([{ path: 'src/math.ts', insertions: 1, deletions: 1 }], 'p'),
    )
  })

  it('distinguishes different line counts for the same paths', () => {
    expect(fingerprintChange(files, 'p')).not.toBe(
      fingerprintChange([{ ...files[0], insertions: 9 }, files[1]] as typeof files, 'p'),
    )
  })
})

describe('detectNoProgress', () => {
  it('says nothing before there are two iterations to compare', () => {
    expect(detectNoProgress([])).toBeNull()
    expect(detectNoProgress(['a'])).toBeNull()
  })

  it('permits genuine progress', () => {
    expect(detectNoProgress(['a', 'b', 'c'])).toBeNull()
  })

  it('halts when two consecutive iterations are identical', () => {
    // The definition of done: an agent resubmitting the same change is caught immediately
    // rather than after burning the whole iteration budget.
    const decision = detectNoProgress(['a', 'b', 'b'])

    expect(decision?.code).toBe('no-progress')
    expect(decision?.reason).toMatch(/identical change/)
  })

  it('permits a repeat that is not consecutive', () => {
    // A loop that tried something else in between made progress, even if it was
    // eventually reverted.
    expect(detectNoProgress(['a', 'b', 'a'])).toBeNull()
  })

  it('catches an agent that keeps resubmitting the same diff', () => {
    // The scenario from the issue, played out: the reviewer objects, the implementer
    // resubmits, and the guard fires on the second identical attempt rather than the fifth.
    const files = [{ path: 'src/math.ts', insertions: 1, deletions: 1 }]
    const same = fingerprintChange(files, '-const answer = 41\n+const answer = 41\n')

    const history: string[] = []
    let halted: string | null = null

    for (let iteration = 0; iteration < 5; iteration += 1) {
      history.push(same)
      const decision = detectNoProgress(history)
      if (decision !== null) {
        halted = decision.code
        break
      }
    }

    expect(halted).toBe('no-progress')
    // Fired on the second submission, well before the cap of five.
    expect(history).toHaveLength(2)
  })
})

describe('checkStopConditions', () => {
  it('permits a clean step', () => {
    expect(checkStopConditions(signals(), limits())).toBeNull()
  })

  it('halts on a permission violation regardless of configuration', () => {
    // A7 is not a preference. There is no configuration that reaches this line and
    // continues.
    expect(checkStopConditions(signals({ permissionViolated: true }), limits())?.code).toBe(
      'permission-violation',
    )
  })

  it('halts on an out-of-scope modification by default', () => {
    expect(checkStopConditions(signals({ modifiedUnexpectedFiles: true }), limits())?.code).toBe(
      'unexpected-file-modification',
    )
  })

  it('leaves a failing build to the correction loop by default', () => {
    expect(checkStopConditions(signals({ buildFailed: true }), limits())).toBeNull()
  })

  it('halts on a failing build when the project asks it to', () => {
    const decision = checkStopConditions(
      signals({ buildFailed: true }),
      limits({ stopOn: { buildFailure: true } }),
    )

    expect(decision?.code).toBe('build-failure')
  })

  it('halts on a failing test when the project asks it to', () => {
    expect(
      checkStopConditions(signals({ testsFailed: true }), limits({ stopOn: { testFailure: true } }))
        ?.code,
    ).toBe('test-failure')
  })

  it('waits on a question by default rather than halting', () => {
    // A question always pauses the workflow (that is the state machine's job); this toggle
    // only decides whether it halts outright instead.
    expect(checkStopConditions(signals({ hasOpenQuestion: true }), limits())).toBeNull()
  })

  it('halts on a question when the project prefers not to wait', () => {
    expect(
      checkStopConditions(
        signals({ hasOpenQuestion: true }),
        limits({ stopOn: { openQuestion: true } }),
      )?.code,
    ).toBe('open-question')
  })

  it('reports a permission violation ahead of any other signal', () => {
    // Several things can be wrong at once; the policy breach is the one to report.
    const decision = checkStopConditions(
      signals({ permissionViolated: true, buildFailed: true, modifiedUnexpectedFiles: true }),
      limits({ stopOn: { buildFailure: true } }),
    )

    expect(decision?.code).toBe('permission-violation')
  })
})

describe('haltStateFor', () => {
  it('maps every code to a terminal state', () => {
    // Exhaustive: a new code with no mapping would be a compile error in the switch, and
    // this asserts the runtime half.
    for (const code of HALT_CODES) {
      expect(['HALTED_LIMIT', 'HALTED_POLICY']).toContain(haltStateFor(code))
    }
  })

  it('separates exhausting a budget from breaking a rule', () => {
    // What a user needs to tell "it ran out of room" from "it did something it was told
    // not to".
    expect(haltStateFor('iteration-cap')).toBe('HALTED_LIMIT')
    expect(haltStateFor('total-timeout')).toBe('HALTED_LIMIT')
    expect(haltStateFor('no-progress')).toBe('HALTED_LIMIT')

    expect(haltStateFor('permission-violation')).toBe('HALTED_POLICY')
    expect(haltStateFor('unexpected-file-modification')).toBe('HALTED_POLICY')
  })
})
