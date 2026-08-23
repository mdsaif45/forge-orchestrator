import { randomUUID } from 'node:crypto'
import {
  assessReview,
  changeSetIdSchema,
  compileContext,
  FEATURE_IMPLEMENTATION,
  FORGE_DEFAULT_RULES,
  projectIdSchema,
  questionIdSchema,
  repositoryIdSchema,
  resolveEffectivePolicy,
  stepIdSchema,
  taskIdSchema,
  workflowIdSchema,
  type OpenQuestion,
  type ProjectId,
  type PromptPacket,
  type ResolvableRule,
  type RuleScope,
  type Task,
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
} from '@shared/ipc'
import type { ForgeDatabase } from '../db/connection'
import { EventStore } from '../db/eventStore'
import { applyEvent } from '../db/projections'
import { WorkflowStore } from '../db/workflowStore'
import { QuestionStore } from '../db/questionStore'
import { PacketStore } from '../context/packetStore'
import { GitService } from '../git'
import { buildChangeSet } from '../evidence/changeSetBuilder'
import { verifyStep } from '../evidence/verifier'
import { bindRole, BindingSet } from '../runtimes/bindings'
import { Orchestrator } from '../runtimes/orchestrator'
import type { RuntimeRegistry } from '../runtimes/registry'
import type { ProjectService } from '../projects/projectService'

export interface WorkflowServiceOptions {
  readonly db: ForgeDatabase
  readonly projects: ProjectService
  readonly packetDir: string
  readonly registry: RuntimeRegistry
  readonly emitEvent?: (event: WorkflowEventPayload) => void
  readonly emitLog?: (log: WorkflowLogPayload) => void
}

export class WorkflowService {
  private readonly workflows: WorkflowStore
  private readonly questions: QuestionStore
  private readonly packets: PacketStore
  private readonly events: EventStore
  private readonly registry: RuntimeRegistry
  private readonly running = new Map<string, AbortController>()

  constructor(private readonly options: WorkflowServiceOptions) {
    this.workflows = new WorkflowStore(options.db)
    this.events = new EventStore(options.db)
    this.questions = new QuestionStore(options.db, this.events)
    this.packets = new PacketStore({ directory: options.packetDir })
    this.registry = options.registry
  }

  getQuestionStore(): QuestionStore {
    return this.questions
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

  getActive(projectId: string): WorkflowDetailView | null {
    const list = this.workflows.listForProject(projectIdSchema.parse(projectId))
    const active = list.find((wf) => wf.finishedAt === null)
    return active === undefined ? null : this.toDetailView(active)
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

    // Create default task if not present
    const task: Task = {
      id: tId,
      objective: input.objective ?? `Implement feature in ${projectDetail.project.name}`,
      constraints: [],
      completionCriteria: [{ kind: 'tests', description: 'Test suite passes', params: {} }],
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
      void this.executeWorkflow(pId, wId, task, projectDetail.project.repository.absolutePath)
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

  answerQuestion(
    questionId: string,
    answer: string,
    _promoteToDecision?: boolean,
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

          void this.options.projects.get(pId).then((projectDetail) => {
            if (projectDetail !== null) {
              const task: Task = {
                id: waiting.taskId,
                objective: `Continue task ${waiting.taskId}`,
                constraints: [],
                completionCriteria: [
                  { kind: 'tests', description: 'Test suite passes', params: {} },
                ],
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
              )
            }
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
    const controller = new AbortController()
    this.running.set(workflowId, controller)

    const gitService = new GitService({ repositoryPath })
    const baseSha = await gitService.headSha()

    // Ensure runtimes are bound for the template
    const bindings = this.resolveBindings()

    const orchestrator = new Orchestrator({
      registry: this.registry,
      workflows: this.workflows,
      packets: this.packets,
      compilePacket: async (ctx) => {
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

        const compiled = compileContext({
          role: ctx.role,
          task,
          rules: effectivePolicy,
          lockedDecisions: [],
          files: [],
          previousAttempt: ctx.previousAttempt,
          reviewFindings: ctx.reviewFindings,
          answeredQuestions,
        })
        return compiled.packet
      },
      measureChange: async () => {
        try {
          const diff = await gitService.diffWorktree(baseSha ?? 'HEAD')
          return { files: [...diff.files], patch: diff.patch }
        } catch {
          return null
        }
      },
      reconcileStep: async (report) => {
        try {
          const built = await buildChangeSet(gitService, {
            baseSha: baseSha ?? 'HEAD',
            report,
            scope: task.scope,
            authorActor: 'system',
            stepId: stepIdSchema.parse(randomUUID()),
            taskId: task.id,
            capturedAt: new Date().toISOString(),
          })
          return built.reconciliation
        } catch {
          return null
        }
      },
    })

    try {
      await orchestrator.run({
        workflowId,
        template: FEATURE_IMPLEMENTATION,
        bindings,
        repositoryPath,
        limits: this.workflows.find(workflowId)?.limits ?? {
          maxIterations: 5,
          stepTimeoutMs: 30 * 60 * 1000,
          idleTimeoutMs: 10 * 60 * 1000,
          totalTimeoutMs: 4 * 60 * 60 * 1000,
          maxRetries: 3,
          retryDelayMs: 5000,
          stopOn: {
            buildFailure: false,
            testFailure: false,
            openQuestion: false,
            permissionViolation: true,
            unexpectedFileModification: true,
          },
        },
        approve: () => Promise.resolve(true),
        verify: async (step) => {
          const projectDetail = await this.options.projects.get(projectId)
          const project = projectDetail?.project
          if (project === undefined) return { passed: true, detail: 'verification skipped' }
          const result = await verifyStep({
            repository: {
              id: repositoryIdSchema.parse(project.repository.id),
              absolutePath: project.repository.absolutePath,
              defaultBranch: project.repository.defaultBranch,
              buildCommand: project.repository.buildCommand,
              testCommand: project.repository.testCommand,
              tech: project.repository.tech,
            },
            workflowId,
            stepId: step.id,
            report: null,
            task,
          })
          return {
            passed: result.passed,
            detail: result.detail,
            criteria: result.criteria,
          }
        },
        reviewStep: (_step, _report, criteria) => {
          const outcome = assessReview(
            {
              changeSetId: changeSetIdSchema.parse(randomUUID()),
              stepId: stepIdSchema.parse(randomUUID()),
              claimedVerdict: 'pass',
              findings: [],
              summary: 'Review passed',
              reviewedAt: new Date().toISOString(),
            },
            criteria,
          )
          return Promise.resolve(outcome)
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
        },
        signal: controller.signal,
      })
    } catch (err) {
      console.error(`Workflow ${workflowId} failed execution:`, err)
    } finally {
      this.running.delete(workflowId)
      const finished = this.workflows.find(workflowId)
      if (finished !== null) {
        this.notifyEvent({
          workflowId,
          type: 'workflow.finished',
          state: finished.state,
          at: new Date().toISOString(),
        })
      }
    }
  }

  private resolveBindings(): BindingSet {
    const runtimeId = this.registry.has('mock:default')
      ? 'mock:default'
      : (this.registry.list().at(0)?.id ?? 'mock:default')

    return new BindingSet([
      bindRole(this.registry, { role: 'planner', runtimeId }),
      bindRole(this.registry, { role: 'implementer', runtimeId }),
      bindRole(this.registry, { role: 'reviewer', runtimeId }),
    ])
  }

  private notifyEvent(event: WorkflowEventPayload): void {
    this.options.emitEvent?.(event)
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
