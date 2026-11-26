import React, { useState } from 'react'
import type { ArtifactMetadataView, RoleBindingsView, WorkflowStepView } from '@shared/ipc'
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  Icon,
  IconButton,
  StatusDot,
  Tooltip,
  WorkflowEdge,
  WorkflowNode,
} from '@renderer/ui'
import { getPersonaMeta, type ThreadEntry } from './threadProjection'
import { ThreadComposer } from './ThreadComposer'
import { ThreadMessageList } from './ThreadMessageList'

export interface ThreadContainerProps {
  readonly projectId: string
  readonly repositoryPath: string
  readonly workflowId: string
  readonly templateId: string
  readonly iteration: number
  readonly maxIterations: number
  readonly status: 'idle' | 'running' | 'waiting' | 'passed' | 'failed'
  readonly statusLabel: string
  readonly isDiscussionMode: boolean
  readonly isTerminal: boolean
  readonly isAwaitingApproval: boolean
  readonly stageSteps: readonly WorkflowStepView[]
  readonly selectedStep: WorkflowStepView | null
  readonly entries: readonly ThreadEntry[]
  readonly bindings: RoleBindingsView | null
  readonly actionInProgress: boolean
  readonly onSelectStep: (step: WorkflowStepView) => void
  readonly onOpenArtifact: (artifact: ArtifactMetadataView) => void
  readonly onInterject: (stepIndex: number, text: string) => Promise<void>
  readonly onStartNextCycle: (objective: string) => Promise<void>
  readonly onSwitchRoleRuntime: (role: string, runtimeId: string) => Promise<void>
  readonly onApproveAndImplement: () => Promise<void>
}

/**
 * Primary thread-native execution workspace combining the stage status strip,
 * interactive collapsible pipeline graph, chronological agent/tool stream, and
 * continuous development loop composer.
 */
export function ThreadContainer({
  projectId,
  repositoryPath,
  workflowId,
  templateId,
  iteration,
  maxIterations,
  status,
  statusLabel,
  isDiscussionMode,
  isTerminal,
  isAwaitingApproval,
  stageSteps,
  selectedStep,
  entries,
  bindings,
  actionInProgress,
  onSelectStep,
  onOpenArtifact,
  onInterject,
  onStartNextCycle,
  onSwitchRoleRuntime,
  onApproveAndImplement,
}: ThreadContainerProps): React.JSX.Element {
  const [fullWidth, setFullWidth] = useState(false)
  const [pipelineExpanded, setPipelineExpanded] = useState(true)

  const activeStepIndex =
    stageSteps.find((s) => s.state === 'running')?.index ??
    stageSteps.find((s) => s.state === 'awaiting_user')?.index ??
    selectedStep?.index ??
    0

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-(--radius-xl) border border-(--color-edge) bg-(--color-surface)">
      {/* Compact Execution Header & Pipeline Strip */}
      <div className="border-b border-(--color-edge) bg-(--color-surface-raised)/65 px-4 py-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <StatusDot status={status} pulse={status === 'running'} />
            <span className="typography-meta font-semibold text-(--color-text)">{statusLabel}</span>
            <span className="typography-micro text-(--color-text-subtle)">
              Cycle {String(iteration + 1)}/{String(maxIterations)}
            </span>
            {!isTerminal ? (
              <Badge
                tone={isDiscussionMode ? 'warning' : 'accent'}
                size="sm"
                className="font-mono typography-micro"
              >
                {isDiscussionMode ? 'PLANNING MODE' : 'IMPLEMENTATION MODE'}
              </Badge>
            ) : null}
            <Badge tone="neutral" size="sm" className="font-mono typography-micro">
              {templateId}
            </Badge>
            <span className="sr-only">LIVE LOG</span>
          </div>

          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="xs"
              onClick={() => {
                setPipelineExpanded((cur) => !cur)
              }}
            >
              <Icon name="workflows" className="size-3.5" />
              <span>{pipelineExpanded ? 'Hide stages' : 'Show stages'}</span>
            </Button>

            <Tooltip content={fullWidth ? 'Use readable column width' : 'Expand to full width'}>
              <IconButton
                size="sm"
                variant="ghost"
                label={fullWidth ? 'Use readable column width' : 'Expand to full width'}
                aria-pressed={fullWidth}
                icon={<Icon name={fullWidth ? 'minimize' : 'maximize'} />}
                onClick={() => {
                  setFullWidth((cur) => !cur)
                }}
              />
            </Tooltip>
          </div>
        </div>

        <Collapsible open={pipelineExpanded} onOpenChange={setPipelineExpanded}>
          <CollapsibleTrigger className="sr-only">Toggle pipeline stages</CollapsibleTrigger>
          <CollapsibleContent className="pt-2">
            <div
              role="region"
              aria-label="Workflow stages"
              className="flex items-center gap-2 overflow-x-auto pb-1"
            >
              {stageSteps.map((step, idx) => {
                const { persona, stageLabel } = getPersonaMeta(step.role)
                const isSelected = selectedStep?.id === step.id
                return (
                  <React.Fragment key={step.id}>
                    <WorkflowNode
                      role={step.role}
                      label={persona}
                      stageLabel={stageLabel}
                      state={
                        step.state as
                          | 'pending'
                          | 'running'
                          | 'completed'
                          | 'failed'
                          | 'halted'
                          | 'awaiting_user'
                      }
                      verdict={step.verdict}
                      runtimeId={step.runtimeId}
                      selected={isSelected}
                      active={step.state === 'running'}
                      onClick={() => {
                        onSelectStep(step)
                      }}
                    />
                    {idx < stageSteps.length - 1 ? (
                      <WorkflowEdge
                        state={
                          stageSteps[idx + 1]?.state === 'running'
                            ? 'active'
                            : step.state === 'completed'
                              ? 'completed'
                              : 'pending'
                        }
                      />
                    ) : null}
                  </React.Fragment>
                )
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      </div>

      {/* Chronological Thread Timeline */}
      <ThreadMessageList
        entries={entries}
        projectId={projectId}
        workflowId={workflowId}
        repositoryPath={repositoryPath}
        fullWidth={fullWidth}
        onInspectStep={onSelectStep}
        onOpenArtifact={onOpenArtifact}
      />

      {/* Continuous Loop Composer */}
      <ThreadComposer
        isTerminal={isTerminal}
        isAwaitingApproval={isAwaitingApproval}
        activeStepIndex={activeStepIndex}
        bindings={bindings}
        actionInProgress={actionInProgress}
        onInterject={onInterject}
        onStartNextCycle={onStartNextCycle}
        onSwitchRoleRuntime={onSwitchRoleRuntime}
        onApproveAndImplement={onApproveAndImplement}
      />
    </div>
  )
}
