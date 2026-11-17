import { randomUUID } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  compileContext,
  compileLinearTemplateToGraph,
  decisionIdSchema,
  TEMPLATES,
  isTemplateId,
  FORGE_DEFAULT_RULES,
  isTerminalWorkflowState,
  projectIdSchema,
  questionIdSchema,
  resolveEffectivePolicy,
  stepIdSchema,
  taskIdSchema,
  workflowIdSchema,
  type AgentBinding,
  type CompletionCriterion,
  type LockedDecision,
  type OpenQuestion,
  type ProjectId,
  type PromptPacket,
  type ResolvableRule,
  type Role,
  type RuleScope,
  type RuntimeEvent,
  type Task,
  type TemplateId,
  type Workflow,
  type WorkflowId,
} from '@shared/domain'
import type {
  OpenQuestionView,
  PromptPacketView,
  WorkflowDetailView,
  WorkflowEventPayload,
  WorkflowLogPayload,
  WorkflowSummaryView,
} from '@shared/views'
import type { ForgeDatabase } from '../db/connection'
import { EventStore } from '../db/eventStore'
import { applyEvent } from '../db/projections'
import { WorkflowStore } from '../db/workflowStore'
import { QuestionStore } from '../db/questionStore'
import { DecisionStore } from '../db/decisionStore'
import { ChangeSetStore } from '../db/changeSetStore'
import { PacketStore } from '../context/packetStore'
import { readRepositoryInstructions } from '../context/repositoryInstructions'
import { GitService } from '../git'
import { bindRole, BindingSet } from '../runtimes/bindings'
import { BindingStore } from '../db/bindingStore'
import { agentSessionKey, type AgentSessionRegistry } from '../terminal/sessionRegistry'
import type { RuntimeRegistry } from '../runtimes/registry'
import type { ProjectService } from '../projects/projectService'
import { ArtifactService } from '../artifacts/artifactService'
import { ArtifactStore } from '../db/artifactStore'
import { createGraphExecutorWithLeafRunner } from './graphFactory'

export interface WorkflowServiceOptions {
  readonly db: ForgeDatabase
  readonly projects: ProjectService
  readonly packetDir: string
  readonly artifactService?: ArtifactService
  readonly artifactDir?: string
  /**
   * Where per-workflow isolated worktrees are created.
   *
   * Optional so existing callers (tests, the dogfood harness) keep working; when it is
   * absent a workflow runs against the project checkout exactly as before.
   */
  readonly worktreeRoot?: string
  readonly registry: RuntimeRegistry
  /**
   * Where a running step's process is published, so the UI can attach to it (#170).
   *
   * Optional so existing callers keep working: without it a workflow still runs,
   * and the pane simply has nothing live to show.
   */
  readonly sessions?: AgentSessionRegistry
  readonly emitEvent?: (event: WorkflowEventPayload) => void
  readonly emitLog?: (log: WorkflowLogPayload) => void
}

export class WorkflowService {
  private readonly workflows: WorkflowStore
  private readonly questions: QuestionStore
  private readonly decisions: DecisionStore
  private readonly changeSets: ChangeSetStore
  private readonly packets: PacketStore
  private readonly events: EventStore
  private readonly registry: RuntimeRegistry
  private readonly bindings: BindingStore
  private readonly artifactService: ArtifactService
  private readonly running = new Map<string, AbortController>()
  private readonly stepLogs = new Map<string, WorkflowLogPayload[]>()

  constructor(private readonly options: WorkflowServiceOptions) {
    this.workflows = new WorkflowStore(options.db)
    this.events = new EventStore(options.db)
    this.questions = new QuestionStore(options.db, this.events)
    this.decisions = new DecisionStore(options.db, this.events)
    this.changeSets = new ChangeSetStore(options.db, this.events)
    this.packets = new PacketStore({ directory: options.packetDir })
    this.registry = options.registry
    this.bindings = new BindingStore(options.db, this.events)
    this.artifactService =
      options.artifactService ??
      new ArtifactService(
        options.artifactDir ?? join(tmpdir(), 'forge-artifacts'),
        new ArtifactStore(options.db),
      )
  }

  getArtifactService(): ArtifactService {
    return this.artifactService
  }

  getQuestionStore(): QuestionStore {
    return this.questions
  }

  getDecisionStore(): DecisionStore {
    return this.decisions
  }

  getChangeSetStore(): ChangeSetStore {
    return this.changeSets
  }

  getWorkflowStore(): WorkflowStore {
    return this.workflows
  }

  getBindingStore(): BindingStore {
    return this.bindings
  }

  list(projectId: string): readonly WorkflowSummaryView[] {
    const list = this.workflows.listForProject(projectIdSchema.parse(projectId))
    return list.map((wf) => ({
      id: wf.id,
      taskId: wf.taskId,
      templateId: wf.templateId,
      state: wf.state,
      iteration: wf.iteration,
      maxIterations: wf.limits.maxIterations,
      haltReason: wf.haltReason,
      startedAt: wf.startedAt,
      finishedAt: wf.finishedAt,
      stepCount: wf.steps.length,
    }))
  }

  get(workflowId: string): WorkflowDetailView | null {
    const wf = this.workflows.find(workflowIdSchema.parse(workflowId))
    if (wf === null) return null
    return this.toDetailView(wf)
  }

  getProjectId(workflowId: string): string | null {
    try {
      return this.workflows.projectIdOf(workflowIdSchema.parse(workflowId))
    } catch {
      return null
    }
  }

  getActive(projectId: string): WorkflowDetailView | null {
    const list = this.workflows.listForProject(projectIdSchema.parse(projectId))
    const active = list.find((wf) => wf.finishedAt === null && !isTerminalWorkflowState(wf.state))
    return active === undefined ? null : this.toDetailView(active)
  }

  getLogs(request: { workflowId: string; stepIndex?: number | undefined }): {
    readonly logs: readonly WorkflowLogPayload[]
  } {
    const list = this.stepLogs.get(request.workflowId) ?? []
    if (request.stepIndex !== undefined) {
      return { logs: list.filter((l) => l.stepIndex === request.stepIndex) }
    }
    return { logs: list }
  }

  logStep(workflowId: string, log: { stepIndex: number; text: string; at?: string }): void {
    const at = log.at ?? new Date().toISOString()
    const payload: WorkflowLogPayload = {
      workflowId,
      stepIndex: log.stepIndex,
      text: log.text,
      at,
    }
    const current = this.stepLogs.get(workflowId) ?? []
    current.push(payload)
    this.stepLogs.set(workflowId, current)
    this.options.emitLog?.(payload)
  }

  async getPacket(packetRef: string): Promise<PromptPacketView | null> {
    try {
      const packet: PromptPacket | null = await this.packets.load(packetRef)
      if (packet === null) return null
      return {
        role: packet.role,
        objective: packet.objective,
        constraints: packet.constraints,
        rules: packet.rules,
        lockedDecisions: packet.lockedDecisions,
        allowedPaths: packet.allowedPaths,
        forbiddenPaths: packet.forbiddenPaths,
        relevantFiles: packet.relevantFiles,
        reviewFindings: packet.reviewFindings,
        previousAttempt: packet.previousAttempt,
        completionCriteria: packet.completionCriteria,
        answeredQuestions: packet.answeredQuestions,
      }
    } catch {
      return null
    }
  }

  async start(input: {
    readonly projectId: string
    readonly taskId?: string | undefined
    readonly templateId?: string | undefined
    readonly objective?: string | undefined
    readonly autoRun?: boolean | undefined
  }): Promise<WorkflowDetailView> {
    const pId = projectIdSchema.parse(input.projectId)
    const projectDetail = await this.options.projects.get(pId)
    if (projectDetail === null) throw new Error(`Project ${input.projectId} not found`)

    const now = new Date().toISOString()
    const tId = taskIdSchema.parse(input.taskId ?? randomUUID())

    // Create default task with criteria tailored to repository capabilities
    const completionCriteria: CompletionCriterion[] = [
      { kind: 'no-assumptions', description: 'No unverified assumptions', params: {} },
    ]

    if (projectDetail.project.repository.buildCommand !== null) {
      completionCriteria.push({
        kind: 'build',
        description: 'Build passes',
        params: {},
      })
    }

    if (projectDetail.project.repository.testCommand !== null) {
      completionCriteria.push({
        kind: 'tests',
        description: 'Test suite passes',
        params: {},
      })
    }

    const task: Task = {
      id: tId,
      objective: input.objective ?? `Implement feature in ${projectDetail.project.name}`,
      constraints: [],
      completionCriteria,
      scope: { allowedPaths: [], forbiddenPaths: [] },
      lockedDecisionIds: [],
      correctsTaskId: null,
      createdAt: now,
    }

    this.options.db.transaction(() => {
      const event = this.events.append(
        { type: 'task.created', payload: { task } },
        { projectId: pId, actor: 'user', occurredAt: now },
      )
      applyEvent(this.options.db, event)
    })

    const wId = workflowIdSchema.parse(randomUUID())
    const workflow = this.workflows.start(
      {
        workflowId: wId,
        projectId: pId,
        taskId: tId,
        templateId: input.templateId ?? 'feature',
        startedAt: now,
      },
      'user',
    )

    this.notifyEvent({
      workflowId: wId,
      type: 'workflow.started',
      state: workflow.state,
      at: now,
    })

    // Spawn orchestrator execution asynchronously in background
    if (input.autoRun !== false) {
      void this.executeWorkflow(
        pId,
        wId,
        task,
        projectDetail.project.repository.absolutePath,
      ).catch((_err: unknown) => {
        void 0
      })
    }

    return this.toDetailView(workflow)
  }

  cancel(workflowId: string, reason = 'Cancelled by user'): WorkflowDetailView | null {
    const wId = workflowIdSchema.parse(workflowId)
    const controller = this.running.get(wId)
    if (controller !== undefined) {
      controller.abort()
      this.running.delete(wId)
    }

    const now = new Date().toISOString()
    try {
      const current = this.workflows.find(wId)
      if (current !== null && isTerminalWorkflowState(current.state)) {
        if (current.finishedAt === null) {
          const finished = this.events.append(
            {
              type: 'workflow.finished',
              payload: { workflowId: wId, state: current.state, finishedAt: now },
            },
            { projectId: this.workflows.projectIdOf(wId), actor: 'user', occurredAt: now },
          )
          applyEvent(this.options.db, finished)
        }
        const refreshed = this.workflows.find(wId)
        return refreshed === null ? null : this.toDetailView(refreshed)
      }

      const wf = this.workflows.apply(wId, 'cancelled', 'user', now, { reason })
      this.notifyEvent({
        workflowId: wId,
        type: 'workflow.cancelled',
        state: wf.state,
        detail: reason,
        at: now,
      })
      return this.toDetailView(wf)
    } catch {
      const current = this.workflows.find(wId)
      return current === null ? null : this.toDetailView(current)
    }
  }

  resume(workflowId: string): WorkflowDetailView | null {
    const wId = workflowIdSchema.parse(workflowId)
    const wf = this.workflows.find(wId)
    if (wf?.finishedAt !== null) return wf === null ? null : this.toDetailView(wf)

    return this.toDetailView(wf)
  }

  approveAndStartImplementation(workflowId: string): WorkflowDetailView {
    const wId = workflowIdSchema.parse(workflowId)
    const wf = this.workflows.find(wId)
    if (wf === null) {
      throw new Error(`Workflow ${workflowId} not found`)
    }

    const projectId = this.workflows.projectIdOf(wId)

    // 1. Structural verification: at least one approved/locked decision exists
    const projectDecisions = this.decisions.listForProject(projectId)
    const hasApprovedOrLocked = projectDecisions.some(
      (d) => d.status === 'locked' || d.status === 'approved',
    )
    if (!hasApprovedOrLocked) {
      throw new Error(
        'Cannot enter implementation mode: at least one approved or locked architectural decision is required (Axiom A4).',
      )
    }

    // 2. Advance the workflow from AWAITING_APPROVAL to IMPLEMENTING
    const now = new Date().toISOString()

    // Record authoritative gate decision for any active graph run
    const graphRun = this.workflows.findGraphRunForWorkflow(wId)
    if (graphRun !== null) {
      try {
        this.decisions.recordGateDecision({
          graphRunId: graphRun.id,
          nodeId: 'step-2-user',
          verdict: 'approved',
          rationale: 'User approved implementation plan and architectural decisions',
          actor: 'user',
          occurredAt: now,
          projectId,
          workflowId: wId,
        })
      } catch {
        // Idempotent or already recorded
      }
    }

    const updated = this.workflows.apply(wId, 'userApproved', 'user', now)
    this.notifyEvent({
      workflowId: wId,
      type: 'workflow.mode_transition',
      state: updated.state,
      detail: 'Discussion mode -> Implementation mode (Decisions locked, criteria verified)',
      at: now,
    })

    // 3. Resume background orchestrator execution
    void this.options.projects
      .get(projectId)
      .then((prj) => {
        if (prj !== null) {
          const domainTask = this.workflows.getTask(wf.taskId)
          if (domainTask !== null) {
            void this.executeWorkflow(
              projectId,
              wId,
              domainTask,
              prj.project.repository.absolutePath,
            ).catch((_err: unknown) => {
              void 0
            })
          }
        }
      })
      .catch((_err: unknown) => {
        void 0
      })

    return this.toDetailView(updated)
  }

  rejectImplementation(workflowId: string, feedback: string): WorkflowDetailView {
    const wId = workflowIdSchema.parse(workflowId)
    const wf = this.workflows.find(wId)
    if (wf === null) {
      throw new Error(`Workflow ${workflowId} not found`)
    }

    const projectId = this.workflows.projectIdOf(wId)
    const now = new Date().toISOString()
    const graphRun = this.workflows.findGraphRunForWorkflow(wId)
    if (graphRun !== null) {
      try {
        this.decisions.recordGateDecision({
          graphRunId: graphRun.id,
          nodeId: 'step-2-user',
          verdict: 'rejected',
          rationale: feedback,
          actor: 'user',
          occurredAt: now,
          projectId,
          workflowId: wId,
        })
      } catch {
        // Idempotent or already recorded
      }
    }

    const updated = this.cancel(workflowId, `Implementation rejected by user: ${feedback}`)
    return updated ?? this.toDetailView(wf)
  }

  answerQuestion(
    questionId: string,
    answer: string,
    promoteToDecision?: boolean,
  ): OpenQuestionView {
    const qId = questionIdSchema.parse(questionId)
    const now = new Date().toISOString()
    const updated = this.questions.answer(qId, answer, 'user', now)

    // Find any workflow in this project waiting on this question or awaiting user
    const q = this.questions.find(qId)
    if (q !== null) {
      const projectsList = this.options.projects.list()
      for (const prj of projectsList) {
        const pId = projectIdSchema.parse(prj.id)

        if (promoteToDecision) {
          const decId = decisionIdSchema.parse(randomUUID())
          this.decisions.promoteFromQuestion(
            qId,
            answer,
            `Promoted from answered question: ${updated.question}`,
            'user',
            now,
            pId,
            decId,
          )
        }

        const list = this.workflows.listForProject(pId)
        const waiting = list.find(
          (wf) =>
            wf.state === 'AWAITING_USER' &&
            (wf.blockedByQuestionId === null || wf.blockedByQuestionId === qId),
        )

        if (waiting !== undefined) {
          const resumed = this.workflows.apply(waiting.id, 'questionAnswered', 'user', now)
          this.notifyEvent({
            workflowId: waiting.id,
            type: 'workflow.resumed',
            state: resumed.state,
            at: now,
          })

          void this.options.projects
            .get(pId)
            .then((projectDetail) => {
              if (projectDetail !== null) {
                const completionCriteria: CompletionCriterion[] = [
                  { kind: 'no-assumptions', description: 'No unverified assumptions', params: {} },
                ]
                if (projectDetail.project.repository.buildCommand !== null) {
                  completionCriteria.push({
                    kind: 'build',
                    description: 'Build passes',
                    params: {},
                  })
                }
                if (projectDetail.project.repository.testCommand !== null) {
                  completionCriteria.push({
                    kind: 'tests',
                    description: 'Test suite passes',
                    params: {},
                  })
                }

                const task: Task = {
                  id: waiting.taskId,
                  objective: `Continue task ${waiting.taskId}`,
                  constraints: [],
                  completionCriteria,
                  scope: { allowedPaths: [], forbiddenPaths: [] },
                  lockedDecisionIds: [],
                  correctsTaskId: null,
                  createdAt: waiting.startedAt,
                }
                void this.executeWorkflow(
                  pId,
                  waiting.id,
                  task,
                  projectDetail.project.repository.absolutePath,
                ).catch((_err: unknown) => {
                  void 0
                })
              }
            })
            .catch((_err: unknown) => {
              void 0
            })
        }
      }
    }

    return {
      id: updated.id,
      question: updated.question,
      whyUndetermined: updated.whyUndetermined,
      evidence: updated.evidence.map((e) => ({
        path: e.path,
        line: e.line,
        note: e.note,
      })),
      options: [...updated.options],
      recommendation: updated.recommendation,
      askedBy: updated.askedBy,
      askedAt: updated.askedAt,
      answer: updated.answer,
      answeredAt: updated.answeredAt,
      answeredBy: updated.answeredBy,
    }
  }

  private async executeWorkflow(
    projectId: ProjectId,
    workflowId: WorkflowId,
    task: Task,
    repositoryPath: string,
  ): Promise<void> {
    const existing = this.workflows.find(workflowId)
    if (existing === null) return
    if (existing.finishedAt !== null || isTerminalWorkflowState(existing.state)) return

    const controller = new AbortController()
    this.running.set(workflowId, controller)

    // Narrowed by lookup rather than cast: the stored value is a plain string from the
    // database, so a row written by an older build (or a template since removed) must
    // fall back rather than index TEMPLATES with a key it does not have.
    const templateId: TemplateId = isTemplateId(existing.templateId)
      ? existing.templateId
      : 'feature'

    // Retired in the `finally` below, so a crashed or cancelled run does not leave
    // the pane attached to processes that are gone.
    const liveSessions: { key: string; handle: { write?: (i: string) => void } }[] = []

    try {
      const baseSha = await new GitService({ repositoryPath }).headSha()
      const worktreeRoot =
        this.options.worktreeRoot ?? join(tmpdir(), `forge-worktrees-${workflowId}`)
      mkdirSync(worktreeRoot, { recursive: true })

      const bindings = this.resolveBindings(projectId, workflowId)

      const linearTemplate = TEMPLATES[templateId]
      const graphTemplate = compileLinearTemplateToGraph(linearTemplate, existing.limits)

      const composition = createGraphExecutorWithLeafRunner({
        db: this.options.db,
        eventStore: this.events,
        worktreeRoot,
        repositoryPath,
        artifactService: this.artifactService,
        registry: this.registry,
        bindings,
        actor: 'system',
        compilePacket: async (_ctx, role) => {
          const projectDetail = await this.options.projects.get(projectId)
          const rawRules: ResolvableRule[] = [
            ...FORGE_DEFAULT_RULES,
            ...(projectDetail?.rules.map((r) => ({
              scope: r.scope as RuleScope,
              key: r.key,
              statement: r.statement,
              source: r.source,
            })) ?? []),
          ]
          const effectivePolicy = resolveEffectivePolicy(rawRules)

          const allProjectQuestions = this.questions.listForProject(projectId)
          const answeredQuestions = allProjectQuestions
            .filter((q): q is OpenQuestion & { answer: string } => q.answer !== null)
            .map((q) => ({ question: q.question, answer: q.answer }))

          const locked = this.decisions.listLocked(projectId)
          const lockedDecisions: LockedDecision[] = locked.map((d) => ({
            id: d.id,
            statement: d.statement,
            rationale: d.rationale,
          }))

          const boundRuntimeId = bindings.get(role)?.runtimeId ?? null
          const instructionFilenames =
            boundRuntimeId !== null && this.registry.has(boundRuntimeId)
              ? this.registry.resolve(boundRuntimeId).instructionFilenames
              : []
          const repositoryInstructions = await readRepositoryInstructions(
            repositoryPath,
            instructionFilenames,
          )

          const compiled = compileContext({
            role,
            task,
            rules: effectivePolicy,
            lockedDecisions,
            files: [],
            previousAttempt: null,
            reviewFindings: [],
            answeredQuestions,
            repositoryInstructions,
          })
          return compiled.packet
        },
        onQuestion: (question: OpenQuestion) => {
          this.questions.ask(question, projectId, question.askedBy, question.askedAt)
          this.notifyEvent({
            workflowId,
            type: 'question.asked',
            state: 'AWAITING_USER',
            detail: question.question,
            at: question.askedAt,
          })
          try {
            this.workflows.apply(
              workflowId,
              'questionRaised',
              question.askedBy,
              question.askedAt,
              {
                reason: question.question,
                questionId: question.id,
              },
            )
          } catch {
            // Ignore if already transitioned
          }
        },
        onProcess: (agentProcess) => {
          const currentWf = this.workflows.find(workflowId)
          const stepIndex = currentWf ? currentWf.steps.length : 0
          const key = agentSessionKey(workflowId, stepIndex)
          this.options.sessions?.publish(key, agentProcess)
          liveSessions.push({ key, handle: agentProcess })
        },
        onEvent: (event: RuntimeEvent) => {
          if (event.type === 'tool') {
            const detail = event.detail === '' ? '' : ` ${event.detail}`
            this.logStep(workflowId, { stepIndex: 0, text: `[TOOL] ${event.name}${detail}` })
            return
          }

          if (event.type === 'usage') {
            const parts = [
              event.inputTokens === null ? null : `in ${String(event.inputTokens)}`,
              event.outputTokens === null ? null : `out ${String(event.outputTokens)}`,
              event.costUsd === null ? null : `$${event.costUsd.toFixed(4)}`,
            ].filter((part): part is string => part !== null)

            if (parts.length > 0) {
              this.logStep(workflowId, { stepIndex: 0, text: `[USAGE] ${parts.join(' · ')}` })
            }
          }
        },
        wrapLeafRunner: (defaultRunner) => {
          return async (ctx) => {
            const now = new Date().toISOString()
            const match = /^step-(\d+)-(.*)$/.exec(ctx.node.id)
            const stepIndex = match?.[1] !== undefined ? parseInt(match[1], 10) - 1 : 0
            const stepRole = (ctx.node.config.role ?? match?.[2] ?? 'implementer') as Role

            const currentWf = this.workflows.find(workflowId)
            if (currentWf?.state === 'DISCOVERY') {
              try {
                this.workflows.apply(workflowId, 'start', 'system', now)
              } catch {
                // Ignore
              }
            } else if (currentWf?.state === 'DECISIONS_LOCKED') {
              try {
                this.workflows.apply(workflowId, 'implementationStarted', 'system', now)
              } catch {
                // Ignore
              }
            }

            const boundRuntimeId = ctx.runtimeId ?? bindings.get(stepRole)?.runtimeId ?? null
            const stepId = stepIdSchema.parse(randomUUID())
            const stepState = this.workflows.find(workflowId)?.state ?? 'PLANNING'

            this.workflows.startStep(
              workflowId,
              {
                id: stepId,
                index: stepIndex,
                role: stepRole,
                runtimeId: boundRuntimeId,
                state: stepState,
                contextRef: null,
                reportStatus: null,
                verdict: null,
                changeSetId: null,
                startedAt: now,
                finishedAt: null,
              },
              'system',
              now,
            )

            this.logStep(workflowId, {
              stepIndex,
              text: `Starting step ${String(stepIndex + 1)}: ${ctx.node.title} (${stepRole})`,
              at: now,
            })

            const result = await defaultRunner(ctx)
            const finishTime = new Date().toISOString()

            if (result.status === 'completed') {
              this.workflows.finishStep(
                workflowId,
                stepId,
                {
                  verdict: stepRole === 'reviewer' ? 'pass' : null,
                  changeSetId: result.changeSet?.id ?? null,
                },
                'system',
                finishTime,
              )

              this.logStep(workflowId, {
                stepIndex,
                text: `Step ${String(stepIndex + 1)} completed successfully`,
                at: finishTime,
              })

              try {
                if (stepRole === 'planner') {
                  this.workflows.apply(workflowId, 'planProduced', 'agent:planner', finishTime)
                } else if (stepRole === 'user' || ctx.node.type === 'user_gate') {
                  this.workflows.apply(workflowId, 'userApproved', 'user', finishTime)
                } else if (stepRole === 'implementer') {
                  this.workflows.apply(
                    workflowId,
                    'implemented',
                    'agent:implementer',
                    finishTime,
                  )
                } else if (stepRole === 'system' || ctx.node.type === 'verification') {
                  this.workflows.apply(workflowId, 'verified', 'system', finishTime)
                } else if (stepRole === 'reviewer') {
                  this.workflows.apply(workflowId, 'reviewPassed', 'agent:reviewer', finishTime)
                }
              } catch {
                // Ignore illegal transition if already transitioned
              }
            } else if (result.status === 'blocked') {
              if (ctx.node.type === 'user_gate' || stepRole === 'user') {
                this.logStep(workflowId, {
                  stepIndex,
                  text: `Step ${String(stepIndex + 1)}: Awaiting human approval (Axiom A4)`,
                  at: finishTime,
                })
              } else {
                this.logStep(workflowId, {
                  stepIndex,
                  text: `Step ${String(stepIndex + 1)}: Awaiting user response to open question`,
                  at: finishTime,
                })
              }
            } else if (result.status === 'failed') {
              this.workflows.finishStep(
                workflowId,
                stepId,
                {
                  verdict: 'fail',
                  changeSetId: result.changeSet?.id ?? null,
                },
                'system',
                finishTime,
              )
              this.logStep(workflowId, {
                stepIndex,
                text: `Step ${String(stepIndex + 1)} failed: ${result.error ?? 'unknown error'}`,
                at: finishTime,
              })
              if (result.error?.includes('Policy violation')) {
                try {
                  this.workflows.apply(workflowId, 'policyViolated', 'system', finishTime, {
                    reason: result.error,
                  })
                } catch {
                  // Ignore
                }
              }
            } else {
              this.logStep(workflowId, {
                stepIndex,
                text: `Step ${String(stepIndex + 1)} cancelled: ${result.error ?? 'cancelled'}`,
                at: finishTime,
              })
            }

            return result
          }
        },
      })

      const graphResult = await composition.executor.run({
        workflowId,
        projectId,
        task,
        template: graphTemplate,
        forkSha: baseSha ?? '0000000000000000000000000000000000000000',
        initialContext: {
          task_objective: task.objective,
          user_prompt: task.objective,
        },
        bindings,
        signal: controller.signal,
      })

      const finishTime = new Date().toISOString()
      if (graphResult.status === 'completed') {
        const currentWf = this.workflows.find(workflowId)
        if (currentWf && !isTerminalWorkflowState(currentWf.state)) {
          try {
            this.workflows.apply(workflowId, 'reviewPassed', 'system', finishTime)
          } catch {
            // Already handled
          }
        }
      } else if (graphResult.status === 'failed') {
        const currentWf = this.workflows.find(workflowId)
        if (currentWf && !isTerminalWorkflowState(currentWf.state)) {
          try {
            this.workflows.apply(workflowId, 'policyViolated', 'system', finishTime, {
              reason: graphResult.error ?? 'Graph execution failed',
            })
          } catch {
            // Ignore
          }
        }
      }
    } catch (err) {
      if (!(err instanceof Error && err.message.includes('The database connection is not open'))) {
        console.error(`Workflow ${workflowId} failed execution:`, err)
      }
    } finally {
      this.running.delete(workflowId)
      for (const session of liveSessions) this.options.sessions?.retire(session.key, session.handle)
      try {
        const finished = this.workflows.find(workflowId)
        if (finished !== null) {
          this.notifyEvent({
            workflowId,
            type: 'workflow.finished',
            state: finished.state,
            at: new Date().toISOString(),
          })
        }
      } catch {
        // Ignore finished notification on teardown if store is closed
      }
    }
  }

  /**
   * The project's role bindings, falling back to a single runtime for every role.
   *
   * Reads what the user actually configured (#102). Until this existed, every role was
   * hardcoded to the same runtime, which made A6's role-to-runtime seam real in the
   * types and absent in practice — no arrangement of runtimes could be expressed.
   *
   * The fallback is not a silent default: a role with no stored binding still has to
   * come from somewhere for a workflow to run at all, and the Agents page shows which
   * roles are unbound.
   *
   * It prefers `forge-native-agent` because that runtime needs no external CLI
   * installed and no account enrolled, so a fresh install is runnable. It used
   * to prefer `mock:default`, which made a fresh install *appear* runnable while
   * every stage reported scripted success — the substitution of a claim for work
   * that A3 exists to prevent. The mock is no longer registered in the app.
   */
  private resolveBindings(projectId: ProjectId, workflowId?: WorkflowId): BindingSet {
    const stored = this.bindings.list(projectId)

    const fallbackRuntimeId = this.registry.has('forge-native-agent')
      ? 'forge-native-agent'
      : (this.registry.list().at(0)?.id ?? 'forge-native-agent')

    const forRole = (role: 'planner' | 'implementer' | 'reviewer'): AgentBinding => {
      const configured = stored.find((binding) => binding.role === role)
      if (configured !== undefined && this.registry.has(configured.runtimeId)) return configured

      if (configured !== undefined && !this.registry.has(configured.runtimeId)) {
        const now = new Date().toISOString()
        const substitutionMsg = `Runtime "${configured.runtimeId}" configured for role "${role}" is unavailable; substituted with "${fallbackRuntimeId}".`

        if (workflowId) {
          this.logStep(workflowId, {
            stepIndex: 0,
            text: `[BINDING] ${substitutionMsg}`,
            at: now,
          })
          this.notifyEvent({
            workflowId,
            type: 'workflow.binding_substituted',
            detail: substitutionMsg,
            at: now,
          })
        }
      }

      return bindRole(this.registry, { role, runtimeId: fallbackRuntimeId })
    }

    return new BindingSet([forRole('planner'), forRole('implementer'), forRole('reviewer')])
  }

  private notifyEvent(event: WorkflowEventPayload): void {
    this.options.emitEvent?.(event)
  }

  /**
   * Whether a step's runtime produces scripted output.
   *
   * Null rather than false for an unbound or unknown runtime: "no runtime yet" and
   * "confirmed to be a real one" are different claims, and collapsing them would let
   * the UI reassure the user about a step nothing has been bound to (#101). A runtime
   * that has since been unregistered is unknown for the same reason.
   */
  private isSimulated(runtimeId: string | null): boolean | null {
    if (runtimeId === null) return null
    if (!this.registry.has(runtimeId)) return null

    return this.registry.resolve(runtimeId).simulated
  }

  private toDetailView(wf: Workflow): WorkflowDetailView {
    return {
      id: wf.id,
      taskId: wf.taskId,
      templateId: wf.templateId,
      state: wf.state,
      iteration: wf.iteration,
      limits: {
        maxIterations: wf.limits.maxIterations,
        stepTimeoutMs: wf.limits.stepTimeoutMs,
        idleTimeoutMs: wf.limits.idleTimeoutMs,
        totalTimeoutMs: wf.limits.totalTimeoutMs,
      },
      steps: wf.steps.map((s) => ({
        id: s.id,
        index: s.index,
        role: s.role,
        runtimeId: s.runtimeId,
        simulated: this.isSimulated(s.runtimeId),
        state: s.state,
        contextRef: s.contextRef,
        reportStatus: s.reportStatus,
        verdict: s.verdict,
        changeSetId: s.changeSetId,
        startedAt: s.startedAt,
        finishedAt: s.finishedAt,
      })),
      checkpoint:
        wf.checkpoint === null
          ? null
          : {
              stepIndex: wf.checkpoint.stepIndex,
              state: wf.checkpoint.state,
              startedAt: wf.checkpoint.startedAt,
              lastOperation: wf.checkpoint.lastOperation,
              inputRef: wf.checkpoint.inputRef,
            },
      resumeState: wf.resumeState,
      blockedByQuestionId: wf.blockedByQuestionId,
      haltReason: wf.haltReason,
      startedAt: wf.startedAt,
      finishedAt: wf.finishedAt,
    }
  }
}
