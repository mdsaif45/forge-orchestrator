import type { ToolCallEntry } from '@shared/domain'
import { filterToolTimelineByStep } from '@shared/domain'
import type {
  ArtifactMetadataView,
  ChangeSetView,
  WorkflowDetailView,
  WorkflowStepView,
} from '@shared/ipc'
import type { StepRuntimeStream, StepRuntimeUsage } from '../useWorkflowRuntimeEvents'

export interface ThreadLogLine {
  readonly id: string
  readonly stepIndex?: number | undefined
  readonly timestamp: string
  readonly text: string
}

export interface ThreadUserInterjection {
  readonly id: string
  readonly text: string
  readonly stepIndex: number
  readonly at: string
}

export interface PersonaMeta {
  readonly persona: string
  readonly stageLabel: string
  readonly badgeClass: string
}

export function getPersonaMeta(role: string): PersonaMeta {
  switch (role) {
    case 'planner':
      return {
        persona: 'Alex (Planner)',
        stageLabel: 'Planning & Architecture',
        badgeClass: 'text-(--color-role-planner) bg-(--color-role-planner)/12',
      }
    case 'user':
      return {
        persona: 'You (Approval Gate)',
        stageLabel: 'Decision & Review Gate',
        badgeClass: 'text-(--color-warning) bg-(--color-warning-muted)',
      }
    case 'implementer':
      return {
        persona: 'Sam (Implementer)',
        stageLabel: 'Sandbox Implementation',
        badgeClass: 'text-(--color-role-implementer) bg-(--color-role-implementer)/12',
      }
    case 'reviewer':
      return {
        persona: 'Morgan (Reviewer)',
        stageLabel: 'Quality & Diff Audit',
        badgeClass: 'text-(--color-role-reviewer) bg-(--color-role-reviewer)/12',
      }
    case 'tester':
      return {
        persona: 'Riley (Verification)',
        stageLabel: 'Test & Verification Suite',
        badgeClass: 'text-(--color-info) bg-(--color-info-muted)',
      }
    case 'system':
      return {
        persona: 'Forge Engine',
        stageLabel: 'Automated Verification',
        badgeClass: 'text-(--color-role-system) bg-(--color-surface-overlay)',
      }
    default:
      return {
        persona: role,
        stageLabel: role,
        badgeClass: 'text-(--color-text-muted) bg-(--color-surface-overlay)',
      }
  }
}

export function formatDurationMs(
  startedAt: string | null,
  finishedAt: string | null,
): string | null {
  if (startedAt === null || finishedAt === null) return null
  const start = new Date(startedAt).getTime()
  const finish = new Date(finishedAt).getTime()
  if (Number.isNaN(start) || Number.isNaN(finish) || finish < start) return null
  const diffMs = finish - start
  if (diffMs < 1000) return `${String(diffMs)}ms`
  if (diffMs < 60_000) return `${(diffMs / 1000).toFixed(1)}s`
  const mins = Math.floor(diffMs / 60_000)
  const secs = Math.round((diffMs % 60_000) / 1000)
  return `${String(mins)}m ${String(secs)}s`
}

export type ThreadEntry =
  | {
      readonly kind: 'user_prompt'
      readonly id: string
      readonly title: string
      readonly body: string
      readonly timestamp: string | null
      readonly templateId: string
      readonly iteration: number
    }
  | {
      readonly kind: 'agent_turn'
      readonly id: string
      readonly step: WorkflowStepView
      readonly iteration: number
      readonly persona: string
      readonly stageLabel: string
      readonly badgeClass: string
      readonly streamedText: string
      readonly usage: StepRuntimeUsage | null
      readonly errors: readonly string[]
      readonly tools: readonly ToolCallEntry[]
      readonly artifacts: readonly ArtifactMetadataView[]
      readonly changeSet: ChangeSetView | null
      readonly logs: readonly ThreadLogLine[]
      readonly isRunning: boolean
    }
  | {
      readonly kind: 'user_followup'
      readonly id: string
      readonly text: string
      readonly stepIndex: number
      readonly timestamp: string
    }
  | {
      readonly kind: 'system_event'
      readonly id: string
      readonly tone: 'info' | 'warning' | 'success' | 'danger'
      readonly title: string
      readonly detail: string
      readonly timestamp: string | null
    }

export interface BuildThreadEntriesInput {
  readonly workflow: WorkflowDetailView
  readonly stageSteps: readonly WorkflowStepView[]
  readonly taskTitle: string | null
  readonly promptObjective: string | null
  readonly toolTimeline: readonly ToolCallEntry[]
  readonly stepStreams: Readonly<Record<number, StepRuntimeStream>>
  readonly artifacts: readonly ArtifactMetadataView[]
  readonly changeSets: readonly ChangeSetView[]
  readonly logs: readonly ThreadLogLine[]
  readonly interjections: readonly ThreadUserInterjection[]
}

function logsForStep(logs: readonly ThreadLogLine[], stepIndex: number): readonly ThreadLogLine[] {
  const stepPrefix = `[STEP ${String(stepIndex)}]`
  return logs.filter((entry) => entry.stepIndex === stepIndex || entry.text.startsWith(stepPrefix))
}

function artifactsForStep(
  artifacts: readonly ArtifactMetadataView[],
  step: WorkflowStepView,
): readonly ArtifactMetadataView[] {
  return artifacts.filter((artifact) => {
    if (artifact.stepId !== null) {
      return artifact.stepId === step.id
    }
    if (step.role === 'planner') {
      return artifact.kind === 'plan' || artifact.name.toLowerCase().includes('plan')
    }
    if (step.role === 'reviewer') {
      return artifact.kind === 'review_report'
    }
    if (step.role === 'implementer') {
      return artifact.kind === 'diff' || artifact.kind === 'changeset'
    }
    return false
  })
}

/**
 * Projects authoritative Forge workflow state, runtime event streams, artifacts,
 * and repository change sets into a single chronological thread timeline.
 */
export function buildThreadEntries(input: BuildThreadEntriesInput): readonly ThreadEntry[] {
  const {
    workflow,
    stageSteps,
    taskTitle,
    promptObjective,
    toolTimeline,
    stepStreams,
    artifacts,
    changeSets,
    logs,
    interjections,
  } = input

  const entries: ThreadEntry[] = []

  entries.push({
    kind: 'user_prompt',
    id: `prompt-${workflow.id}`,
    title: taskTitle ?? `Workflow ${workflow.taskId}`,
    body:
      promptObjective ??
      `Execute "${workflow.templateId}" workflow across planning, implementation, verification, and review.`,
    timestamp: workflow.startedAt,
    templateId: workflow.templateId,
    iteration: workflow.iteration,
  })

  for (const step of stageSteps) {
    const meta = getPersonaMeta(step.role)
    const stream = stepStreams[step.index]
    const tools = filterToolTimelineByStep(toolTimeline, step.index)
    const matchedArtifacts = artifactsForStep(artifacts, step)
    const matchedChangeSet =
      changeSets.find((cs) => cs.id === step.changeSetId || cs.stepId === step.id) ?? null
    const stepLogs = logsForStep(logs, step.index)

    const hasActivity =
      step.state !== 'pending' ||
      step.reportStatus !== null ||
      (stream?.text.length ?? 0) > 0 ||
      tools.length > 0 ||
      matchedArtifacts.length > 0 ||
      matchedChangeSet !== null ||
      stepLogs.length > 0

    if (!hasActivity) {
      continue
    }

    entries.push({
      kind: 'agent_turn',
      id: `turn-${workflow.id}-${step.id}`,
      step,
      iteration: workflow.iteration,
      persona: meta.persona,
      stageLabel: meta.stageLabel,
      badgeClass: meta.badgeClass,
      streamedText: stream?.text ?? '',
      usage: stream?.usage ?? null,
      errors: stream?.errors ?? [],
      tools,
      artifacts: matchedArtifacts,
      changeSet: matchedChangeSet,
      logs: stepLogs,
      isRunning: step.state === 'running',
    })

    for (const msg of interjections) {
      if (msg.stepIndex === step.index) {
        entries.push({
          kind: 'user_followup',
          id: msg.id,
          text: msg.text,
          stepIndex: msg.stepIndex,
          timestamp: msg.at,
        })
      }
    }
  }

  if (workflow.state === 'DONE') {
    entries.push({
      kind: 'system_event',
      id: `sys-done-${workflow.id}`,
      tone: 'success',
      title: 'Workflow Completed',
      detail: 'All planned implementation, verification, and review stages finished cleanly.',
      timestamp: workflow.finishedAt,
    })
  } else if (workflow.state === 'CANCELLED') {
    entries.push({
      kind: 'system_event',
      id: `sys-cancel-${workflow.id}`,
      tone: 'warning',
      title: 'Workflow Cancelled',
      detail: 'Execution was stopped by operator request.',
      timestamp: workflow.finishedAt,
    })
  } else if (workflow.state.startsWith('HALTED')) {
    entries.push({
      kind: 'system_event',
      id: `sys-halt-${workflow.id}`,
      tone: 'danger',
      title: `Workflow Halted (${workflow.state})`,
      detail: workflow.haltReason ?? 'Execution halted due to policy or runtime error.',
      timestamp: workflow.finishedAt,
    })
  }

  return entries
}
