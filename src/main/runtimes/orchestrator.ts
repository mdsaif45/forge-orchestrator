import { randomUUID } from 'node:crypto'
import {
  assessReport,
  assessStepPolicy,
  checkBudgets,
  detectNoProgress,
  fingerprintChange,
  formatPolicyHaltReason,
  haltStateFor,
  questionIdSchema,
  stepIdSchema,
  validateTemplate,
  type Actor,
  type AgentReport,
  type CriterionResult,
  type Discrepancy,
  type HaltCode,
  type OpenQuestion,
  type PromptPacket,
  type QuestionId,
  type ReviewOutcome,
  type Role,
  type WorkflowId,
  type WorkflowLimits,
  type WorkflowState,
  type WorkflowStep,
  type WorkflowTemplate,
} from '@shared/domain'
import type { WorkflowStore } from '../db/workflowStore'
import type { PacketStore } from '../context/packetStore'
import { permits, type BindingSet } from './bindings'
import { exchange } from './exchange'
import type { RuntimeRegistry } from './registry'

/**
 * The orchestrator: it runs a template through the state machine.
 *
 * ```
 * template step ──> binding ──> registry ──> runtime
 *       │                                       │
 *  checkpoint (write-ahead)              exchange(packet)
 *       │                                       │
 *  guards: budgets · no-progress          validated report
 *       │                                       │
 *       └──────────> transition ──> next step ──┘
 * ```
 *
 * Everything it needs was built separately and deliberately: the registry resolves runtimes
 * (#21), `exchange` handles the protocol and its single retry (#26), the transition table
 * decides what may happen next (#27), the store writes the event before the side effect
 * (#28), the guards decide whether to continue (#29), and the context engine assembles what
 * the agent is told (#30). This is where they become a loop.
 *
 * It coordinates and does not decide: every judgement — is this move legal, is the budget
 * spent, is this report acceptable — belongs to one of those modules. That keeps the
 * orchestrator small enough to read, and it means a policy question has exactly one place to
 * be answered.
 */

/** How the orchestrator obtains what only the caller can provide. */
export interface OrchestratorDeps {
  readonly registry: RuntimeRegistry
  readonly workflows: WorkflowStore
  readonly packets: PacketStore
  /**
   * Compiles the packet for a step.
   *
   * Injected rather than called directly because the ranking signals need a filesystem and a
   * git history — #30 deliberately takes them as inputs so the engine stays pure and
   * testable. The orchestrator does not know how they are derived.
   */
  readonly compilePacket: (context: StepContext) => Promise<PromptPacket>
  /**
   * Measures what the repository actually shows after a step.
   *
   * Returns null when there is nothing to measure. Used for the no-progress fingerprint, so
   * it must be the real diff rather than the agent's claim (A3).
   */
  readonly measureChange: () => Promise<{
    readonly files: readonly { path: string; insertions: number; deletions: number }[]
    readonly patch: string
  } | null>
  /**
   * Checks the agent's claim against the repository, and the edits against the task scope.
   *
   * Injected because building a real changeset needs a `GitService` and a snapshot SHA, which
   * are main-process concerns — while the reconciliation itself is pure (#34). Returning null
   * skips the check, which is what a step with nothing to measure does.
   *
   * Called for a *write* step only, and called before the transition: an out-of-scope edit must
   * halt at the step that made it, not after the workflow has moved on.
   */
  readonly reconcileStep?: (report: AgentReport) => Promise<{
    readonly discrepancies: readonly Discrepancy[]
    readonly outOfScope: readonly string[]
    readonly claimAccurate: boolean
    readonly inScope: boolean
  } | null>
  /** Injected so a test asserts an event sequence without depending on the wall clock. */
  readonly now?: () => Date
}

/** What a step is being asked to do, handed to the packet compiler. */
export interface StepContext {
  readonly role: Role
  readonly stepIndex: number
  readonly iteration: number
  readonly reviewFindings: readonly string[]
  readonly previousAttempt: { readonly summary: string; readonly diffStat: string } | null
}

export interface RunOptions {
  readonly workflowId: WorkflowId
  readonly template: WorkflowTemplate
  readonly bindings: BindingSet
  readonly repositoryPath: string
  readonly limits: WorkflowLimits
  /**
   * Resolves a `user` step.
   *
   * Injected because the orchestrator must not decide a human gate. Returning false halts the
   * run rather than proceeding, since an unapproved plan may not be implemented (A4).
   */
  readonly approve: (step: WorkflowStep) => Promise<boolean>
  /**
   * Performs a `system` step and says whether it passed.
   *
   * The evidence layer (#33–#35) will supply this. Until then a caller provides it, which is
   * what lets the loop be exercised end to end before the runners exist.
   */
  readonly verify: (step: WorkflowStep) => Promise<{
    readonly passed: boolean
    readonly detail: string
    /**
     * Per-criterion outcomes, when the evidence layer computed them (#35).
     *
     * Carried forward so the review step can be checked against the same criteria
     * rather than re-deriving them, which would risk two answers.
     */
    readonly criteria?: readonly CriterionResult[]
  }>
  /**
   * Turns a reviewer's report into the verdict of record (#36).
   *
   * Injected rather than computed here because the report has to be parsed from the
   * agent's output and linked to the changeset it reviewed, both of which need the
   * main process. Returning null means the reviewer produced nothing reviewable, which
   * is treated as an unusable review rather than as a pass.
   */
  readonly reviewStep?: (
    step: WorkflowStep,
    report: AgentReport,
    criteria: readonly CriterionResult[],
  ) => Promise<ReviewOutcome | null>
  readonly onQuestion?: (question: OpenQuestion) => Promise<void> | void
  readonly signal?: AbortSignal
}

export interface RunOutcome {
  readonly state: WorkflowState
  readonly iterations: number
  readonly steps: readonly WorkflowStep[]
  readonly haltCode: HaltCode | null
  readonly haltReason: string | null
}

/** Raised before a run starts, when the configuration cannot produce a valid run. */
export class UnrunnableWorkflowError extends Error {
  constructor(readonly problems: readonly string[]) {
    super(`The workflow cannot run:\n- ${problems.join('\n- ')}`)
    this.name = 'UnrunnableWorkflowError'
  }
}

export class Orchestrator {
  private readonly now: () => Date

  constructor(private readonly deps: OrchestratorDeps) {
    this.now = deps.now ?? (() => new Date())
  }

  /**
   * Checks everything that can be checked before doing any work.
   *
   * A run that fails at step three because nobody bound a reviewer has already spent an
   * agent's time and left a half-finished change. Every one of these is knowable in advance,
   * so none of them should be discovered late.
   */
  precheck(options: RunOptions): readonly string[] {
    const problems: string[] = []

    for (const problem of validateTemplate(options.template)) {
      problems.push(`Template step ${String(problem.stepIndex + 1)}: ${problem.detail}`)
    }

    const roles = options.template.steps.map((step) => step.role)
    for (const role of options.bindings.missingFor(roles)) {
      problems.push(`No runtime is bound to the "${role}" role`)
    }

    // A binding whose runtime is no longer registered — an adapter removed between sessions —
    // would fail at the step that needs it.
    for (const role of options.bindings.roles()) {
      const binding = options.bindings.require(role)
      if (!this.deps.registry.has(binding.runtimeId)) {
        problems.push(
          `The "${role}" role is bound to "${binding.runtimeId}", which is not registered`,
        )
      }
    }

    return problems
  }

  /**
   * Runs the workflow to a terminal state.
   *
   * The loop is bounded by the guards rather than by a step count: a correction cycle
   * revisits the same template steps at a higher iteration, so counting steps would either
   * stop a legitimate loop or fail to stop an illegitimate one. The `hardStop` below is a
   * backstop against a bug in the guards themselves, not the actual bound.
   */
  async run(options: RunOptions): Promise<RunOutcome> {
    const problems = this.precheck(options)
    if (problems.length > 0) throw new UnrunnableWorkflowError(problems)

    const startedAt = this.now().getTime()
    const fingerprints: string[] = []
    let reviewFindings: readonly string[] = []
    // Set by the verify step, read by the review step (#35 -> #36).
    let criteria: readonly CriterionResult[] = []
    let previousAttempt: StepContext['previousAttempt'] = null
    let stepCounter = 0

    let workflow = this.deps.workflows.apply(
      options.workflowId,
      'start',
      'system',
      this.timestamp(),
    )

    // A backstop, not the bound. If this is ever what stops a run, a guard is broken and the
    // test asserting the real limit will say so.
    const hardStop = options.template.steps.length * (options.limits.maxIterations + 2) + 10

    for (let guardIndex = 0; guardIndex < hardStop; guardIndex += 1) {
      if (isTerminal(workflow.state)) break

      if (options.signal?.aborted === true) {
        workflow = this.deps.workflows.apply(
          options.workflowId,
          'cancelled',
          'user',
          this.timestamp(),
          { reason: 'The run was cancelled' },
        )
        break
      }

      const budgetHalt = checkBudgets(
        {
          iteration: workflow.iteration,
          elapsedMs: this.now().getTime() - startedAt,
          stepElapsedMs: null,
          stepIdleMs: null,
        },
        options.limits,
      )

      if (budgetHalt !== null) {
        workflow = this.halt(options.workflowId, budgetHalt.code, budgetHalt.reason)
        break
      }

      // A pass-through state with no step of its own: arriving here *is* the locking, so the
      // machine moves straight on. Handled before the step lookup rather than as a template
      // entry, because giving it a step would run the implementer twice (see `stepFor`).
      if (workflow.state === 'DECISIONS_LOCKED') {
        workflow = this.deps.workflows.apply(
          options.workflowId,
          'implementationStarted',
          'system',
          this.timestamp(),
        )
        continue
      }

      const templateStep = this.stepFor(options.template, workflow.state)
      if (templateStep === null) {
        // No template step matches this state. Rather than guess, halt with something a user
        // can act on — the alternative is a run that appears to hang.
        workflow = this.halt(
          options.workflowId,
          'no-progress',
          `No template step handles the ${workflow.state} state`,
        )
        break
      }

      const step: WorkflowStep = {
        id: stepIdSchema.parse(randomUUID()),
        index: stepCounter,
        role: templateStep.role,
        runtimeId: templateStep.performedByForge
          ? null
          : options.bindings.require(templateStep.role).runtimeId,
        state: workflow.state,
        contextRef: null,
        reportStatus: null,
        verdict: null,
        changeSetId: null,
        startedAt: this.timestamp(),
        finishedAt: null,
      }
      stepCounter += 1

      // Write-ahead: the record of what is being attempted exists before the attempt (#28).
      this.deps.workflows.checkpoint(
        options.workflowId,
        {
          stepIndex: step.index,
          state: workflow.state,
          startedAt: step.startedAt ?? this.timestamp(),
          lastOperation: templateStep.label,
          inputRef: null,
        },
        'system',
        this.timestamp(),
      )

      if (templateStep.role === 'user') {
        this.deps.workflows.startStep(options.workflowId, step, 'user', this.timestamp())
        const approved = await options.approve(step)

        this.deps.workflows.finishStep(
          options.workflowId,
          step.id,
          { verdict: approved ? 'pass' : 'fail', changeSetId: null },
          'user',
          this.timestamp(),
        )

        if (!approved) {
          // Not a halt code: the user declining a plan is a decision, not a failure. The
          // workflow is cancelled, which is a terminal state with no blame attached.
          workflow = this.deps.workflows.apply(
            options.workflowId,
            'cancelled',
            'user',
            this.timestamp(),
            { reason: 'The plan was not approved' },
          )
          continue
        }

        workflow = this.deps.workflows.apply(
          options.workflowId,
          templateStep.advanceTrigger,
          'user',
          this.timestamp(),
        )
        continue
      }

      if (templateStep.role === 'system') {
        this.deps.workflows.startStep(options.workflowId, step, 'system', this.timestamp())
        const result = await options.verify(step)

        // Kept for the review step, which is checked against the same criteria rather
        // than re-deriving them — asking twice would risk two answers.
        criteria = result.criteria ?? []

        this.deps.workflows.finishStep(
          options.workflowId,
          step.id,
          { verdict: result.passed ? 'pass' : 'fail', changeSetId: null },
          'system',
          this.timestamp(),
        )

        if (!result.passed) {
          reviewFindings = [result.detail]
          workflow = this.deps.workflows.apply(
            options.workflowId,
            'verificationFailed',
            'system',
            this.timestamp(),
            { reason: result.detail },
          )
          workflow = this.advanceCorrection(options, workflow.state)
          continue
        }

        workflow = this.deps.workflows.apply(
          options.workflowId,
          templateStep.advanceTrigger,
          'system',
          this.timestamp(),
        )
        continue
      }

      // An agent step.
      const binding = options.bindings.require(templateStep.role)
      const runtime = this.deps.registry.resolveForRole(binding.runtimeId, templateStep.role)

      const packet = await this.deps.compilePacket({
        role: templateStep.role,
        stepIndex: step.index,
        iteration: workflow.iteration,
        reviewFindings,
        previousAttempt,
      })

      // Snapshotted before the step runs, so a resumed step replays this exact packet (#28).
      const contextRef = await this.deps.packets.save(packet)
      this.deps.workflows.startStep(
        options.workflowId,
        { ...step, contextRef },
        `agent:${binding.runtimeId}`,
        this.timestamp(),
      )

      // What the worktree already contained before this step ran. A read-only role is
      // checked against this rather than against the base commit, so it answers for its
      // own effect and not for an earlier step's legitimate edits.
      const changedBeforeStep = permits(binding, 'writeFiles')
        ? null
        : new Set(((await this.deps.measureChange())?.files ?? []).map((file) => file.path))

      const session = await runtime.start({
        repositoryPath: options.repositoryPath,
        role: templateStep.role,
        ...(binding.accountId === null ? {} : { accountId: binding.accountId }),
        // Derived from the role's own permissions, never a global default. A planner is
        // read-only by design, so granting it edit rights at the CLI level let it change
        // a file and then be halted for reporting the change — the work done, the
        // workflow refused. Telling the agent what it may do beats punishing it after.
        //
        // `auto` for a read-only role, after measuring the alternatives: `plan` ends by
        // presenting a plan for interactive approval rather than replying, and `manual`
        // waits for an approval that a `-p` run can never give. Both produce no report
        // block at all, so the step fails for a reason unrelated to the work. `auto`
        // lets the agent answer while the CLI decides permissions.
        //
        // Forge's own guards remain the real boundary either way: the reconciler halts
        // a read-only role that reports a modified file, whatever the CLI allowed.
        permissionMode: permits(binding, 'writeFiles') ? 'acceptEdits' : 'auto',
        timeoutMs: options.limits.stepTimeoutMs,
      })

      let report: AgentReport | null = null
      let failure: string | null = null
      let providerLimit = false

      try {
        const result = await exchange(runtime, session, packet)

        if (result.ok) {
          report = result.report
        } else {
          failure = result.message
          providerLimit = result.providerLimit
        }
      } finally {
        await runtime.dispose(session)
      }

      if (report === null) {
        // A spent provider limit is not a failed step. The agent did nothing wrong, the
        // code is fine, and an immediate retry fails identically — recording a `fail`
        // verdict would read as "the agent failed" and spend a retry on a certainty.
        //
        // Left un-finished rather than marked failed, so resuming after switching account
        // or waiting out the window continues from this step (#137).
        if (providerLimit) {
          workflow = this.halt(options.workflowId, 'provider-limit', providerLimitReason(failure))
          break
        }

        this.deps.workflows.finishStep(
          options.workflowId,
          step.id,
          { verdict: 'fail', changeSetId: null },
          'system',
          this.timestamp(),
        )

        // A protocol or runtime failure is a policy halt rather than a limit: the run did not
        // run out of room, something went wrong. Retry policy belongs to the caller, which
        // knows whether the failure was transient (#29).
        workflow = this.halt(
          options.workflowId,
          'permission-violation',
          failure ?? 'The agent produced no usable report',
        )
        break
      }

      const assessment = assessReport(report)

      this.deps.workflows.finishStep(
        options.workflowId,
        step.id,
        { verdict: assessment.verdict === 'accept' ? 'pass' : 'fail', changeSetId: null },
        `agent:${binding.runtimeId}`,
        this.timestamp(),
      )

      if (assessment.verdict === 'await-user') {
        let questionId: QuestionId | undefined
        if (report.openQuestions.length > 0) {
          const first = report.openQuestions[0]
          if (first !== undefined) {
            const qId = questionIdSchema.parse(randomUUID())
            const openQ: OpenQuestion = {
              id: qId,
              question: first.question,
              whyUndetermined: first.whyUndetermined,
              evidence: first.evidence,
              options: first.options,
              recommendation: first.recommendation,
              askedBy: `agent:${binding.runtimeId}` as Actor,
              askedAt: this.timestamp(),
              answer: null,
              answeredAt: null,
              answeredBy: null,
            }
            if (options.onQuestion !== undefined) {
              await options.onQuestion(openQ)
            }
            questionId = qId
          }
        }

        workflow = this.deps.workflows.apply(
          options.workflowId,
          'questionRaised',
          `agent:${binding.runtimeId}`,
          this.timestamp(),
          { reason: assessment.reason, questionId },
        )
        break
      }

      if (assessment.verdict === 'halt-assumption' || assessment.verdict === 'halt-blocked') {
        workflow = this.halt(
          options.workflowId,
          assessment.verdict === 'halt-assumption' ? 'permission-violation' : 'test-failure',
          assessment.reason,
        )
        break
      }

      // What this step actually changed, for a read-only role. Measured here rather than
      // taken from the report, so the policy check below can tell a file the agent *wrote*
      // from one it merely *named* (#144). Null for a writing role, where the claim needs
      // no reconciling because the write was permitted anyway.
      const readOnlyChange = permits(binding, 'writeFiles')
        ? null
        : await this.measuredSince(changedBeforeStep)

      // Axiom A7: Least privilege policy check on permissions, dangerous commands, and forbidden paths (#37)
      const policyAssessment = assessStepPolicy({
        binding,
        report,
        forbiddenPaths: packet.forbiddenPaths,
        ...(readOnlyChange === null ? {} : { changedPaths: readOnlyChange }),
      })

      if (!policyAssessment.allowed) {
        workflow = this.halt(
          options.workflowId,
          'permission-violation',
          formatPolicyHaltReason(policyAssessment.violations),
        )
        break
      }

      // Measured from the repository, not from the report: the whole point of the
      // no-progress guard is catching an agent that describes the same work differently.
      //
      // Fingerprinted only for roles that are *supposed* to change the worktree. A planner
      // and a reviewer legitimately change nothing, so their diffs are identically empty —
      // and feeding those to the detector tripped it on the first implementer step, halting
      // a perfectly good run with "no progress". Found by the end-to-end test; the guard was
      // right and the input was wrong.
      // Reconciled before the transition, so an out-of-scope edit halts at the step that made
      // it rather than after the workflow has already advanced (#34). Only for a write step: a
      // planner or reviewer changing nothing has nothing to reconcile.
      if (permits(binding, 'writeFiles') && this.deps.reconcileStep !== undefined) {
        const reconciliation = await this.deps.reconcileStep(report)

        if (reconciliation !== null && !reconciliation.inScope) {
          workflow = this.halt(
            options.workflowId,
            'unexpected-file-modification',
            `The agent modified ${String(reconciliation.outOfScope.length)} file(s) outside the task scope: ${reconciliation.outOfScope.join(', ')}`,
          )
          break
        }

        // A dishonest claim is a review finding rather than a halt: it goes back to the agent
        // as a correction, which is the loop working as intended.
        if (reconciliation !== null && !reconciliation.claimAccurate) {
          reviewFindings = reconciliation.discrepancies.map((entry) => entry.detail)
        }
      }

      // Structural enforcement: a role without write permission (e.g. discussion /
      // planner) must not have modified any files in the repository.
      //
      // Compared against a snapshot taken before this step, not against the base commit.
      // `measureChange` reports the whole worktree diff, so once an implementer had
      // legitimately edited a file, every later read-only role was blamed for it — the
      // dogfood run in #130 ran all five steps green and then halted saying the
      // *reviewer* had modified a file the *implementer* wrote. A read-only role is
      // answerable for what it changed, not for what it inherited.
      if (!permits(binding, 'writeFiles')) {
        if (readOnlyChange !== null && readOnlyChange.length > 0) {
          workflow = this.halt(
            options.workflowId,
            'permission-violation',
            `Role "${binding.role}" in read-only mode modified ${String(readOnlyChange.length)} file(s) in the worktree: ${readOnlyChange.join(', ')}`,
          )
          break
        }
      }

      const change = permits(binding, 'writeFiles') ? await this.deps.measureChange() : null

      if (change !== null) {
        fingerprints.push(fingerprintChange(change.files, change.patch))
        previousAttempt = {
          summary: report.summary,
          diffStat: `${String(change.files.length)} file(s)`,
        }

        const stalled = detectNoProgress(fingerprints)
        if (stalled !== null) {
          workflow = this.halt(options.workflowId, stalled.code, stalled.reason)
          break
        }
      }

      // The reviewer's verdict is a claim like any other (A3), and it is the one claim
      // that could close the workflow. So it is checked against the evidence before the
      // advance rather than after: a reviewer approving a red build must not reach
      // `DONE` at all, and letting it advance first and correcting afterwards would
      // mean the terminal state had already been recorded.
      if (templateStep.role === 'reviewer' && options.reviewStep !== undefined) {
        const outcome = await options.reviewStep(step, report, criteria)

        if (outcome === null) {
          workflow = this.halt(
            options.workflowId,
            'test-failure',
            'The reviewer produced no reviewable report, so the change is unreviewed. An unusable review is not an approval.',
          )
          break
        }

        this.deps.workflows.finishStep(
          options.workflowId,
          step.id,
          { verdict: outcome.verdict, changeSetId: null },
          `agent:${binding.runtimeId}`,
          this.timestamp(),
        )

        if (outcome.verdict !== 'pass') {
          reviewFindings = outcome.corrections
          workflow = this.deps.workflows.apply(
            options.workflowId,
            'reviewFailed',
            outcome.overridden ? 'system' : `agent:${binding.runtimeId}`,
            this.timestamp(),
            { reason: outcome.reason },
          )
          workflow = this.advanceCorrection(options, workflow.state)
          continue
        }
      }

      workflow = this.deps.workflows.apply(
        options.workflowId,
        templateStep.advanceTrigger,
        `agent:${binding.runtimeId}`,
        this.timestamp(),
      )

      // A reviewer that passed ends the run; the state machine has already moved to DONE.
      if (isTerminal(workflow.state)) break
    }

    const final = this.deps.workflows.find(options.workflowId)

    return {
      state: final?.state ?? workflow.state,
      iterations: final?.iteration ?? workflow.iteration,
      steps: final?.steps ?? [],
      haltCode: this.lastHaltCode,
      haltReason: final?.haltReason ?? null,
    }
  }

  private lastHaltCode: HaltCode | null = null

  /**
   * The paths this step changed, or null when no measurement could be taken.
   *
   * The empty array is load-bearing and distinct from null: it means the step demonstrably
   * changed nothing, which is the answer the policy check needs to clear a read-only role
   * that merely *named* a file (#144). An earlier version returned null for both, which
   * sent that check back to trusting the agent's claim in the most common case of all —
   * the one where the role behaved correctly.
   *
   * Compared against a pre-step snapshot rather than the base commit, so a read-only role
   * answers for what it changed and not for what it inherited (#130).
   */
  private async measuredSince(
    before: ReadonlySet<string> | null,
  ): Promise<readonly string[] | null> {
    if (before === null) return null

    const current = await this.deps.measureChange()
    if (current === null) return null

    const added = current.files.filter((file) => !before.has(file.path))
    return added.map((file) => file.path)
  }
  private halt(workflowId: WorkflowId, code: HaltCode, reason: string) {
    this.lastHaltCode = code

    // The trigger is chosen from the code rather than passed in, so the terminal state and
    // the recorded reason cannot disagree.
    const trigger = haltStateFor(code) === 'HALTED_LIMIT' ? 'limitReached' : 'policyViolated'

    return this.deps.workflows.apply(workflowId, trigger, 'system', this.timestamp(), { reason })
  }

  /**
   * Moves out of `CORRECTION_REQUIRED`, letting the transition table enforce the cap.
   *
   * The cap lives on that edge (#27), so this does not check it — asking twice would risk two
   * answers.
   */
  private advanceCorrection(options: RunOptions, state: WorkflowState) {
    if (state !== 'CORRECTION_REQUIRED') {
      return this.deps.workflows.find(options.workflowId) ?? this.require(options.workflowId)
    }

    return this.deps.workflows.apply(
      options.workflowId,
      'correctionStarted',
      'system',
      this.timestamp(),
    )
  }

  private require(workflowId: WorkflowId) {
    const workflow = this.deps.workflows.find(workflowId)
    if (workflow === null) throw new Error(`Unknown workflow "${workflowId}"`)
    return workflow
  }

  /**
   * The template step that handles a state.
   *
   * Matched on the state a step runs in rather than by position, because a correction loop
   * revisits earlier steps: after `correctionStarted` the workflow is back in `IMPLEMENTING`,
   * and the step that handles it is the implementer again.
   */
  private stepFor(template: WorkflowTemplate, state: WorkflowState) {
    // `DECISIONS_LOCKED` is deliberately absent. It is a pass-through: arriving there *is*
    // the locking, and `implementationStarted` moves straight on to `IMPLEMENTING` (#27).
    // Mapping it to the implementer step as well would run that step twice — once from each
    // state — which is how a template silently double-implements.
    const byState: Partial<Record<WorkflowState, number>> = {
      PLANNING: 0,
      PLAN_READY: 1,
      IMPLEMENTING: 2,
      VERIFYING: 3,
      REVIEWING: 4,
    }

    const index = byState[state]
    if (index === undefined) return null

    return template.steps[index] ?? null
  }

  private timestamp(): string {
    return this.now().toISOString()
  }
}

function isTerminal(state: WorkflowState): boolean {
  return (
    state === 'DONE' ||
    state === 'HALTED_LIMIT' ||
    state === 'HALTED_POLICY' ||
    state === 'CANCELLED'
  )
}

/**
 * What a user is told when a provider's limit is spent.
 *
 * The three remedies are stated plainly because they are genuinely all there is: nothing
 * about the run can be changed to make this attempt succeed. Naming them is the difference
 * between a halt a user can act on and one that just says the run stopped (#137).
 *
 * The provider's own message is kept verbatim underneath, since it is the only part that
 * says *which* limit and, sometimes, when it resets.
 */
export function providerLimitReason(providerMessage: string | null): string {
  const remedies = [
    'This account has reached its provider limit. The work is fine; the account is spent.',
    '',
    'You can:',
    '  · bind this role to another account',
    '  · bind it to a different provider',
    '  · wait for the limit window to refresh, then resume',
  ].join('\n')

  return providerMessage === null
    ? remedies
    : `${remedies}\n\nThe provider said:\n${providerMessage}`
}
