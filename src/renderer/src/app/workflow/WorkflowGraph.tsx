import React from 'react'
import type { WorkflowDetailView, WorkflowStepView } from '@shared/ipc'
import { WorkflowEdge, WorkflowNode, type WorkflowNodeState } from '@renderer/ui'

export interface WorkflowGraphProps {
  readonly workflow: WorkflowDetailView | null
  readonly selectedStepId: string | null
  readonly onSelectStep: (step: WorkflowStepView) => void
}

const DEFAULT_STAGES = [
  { role: 'planner', label: 'Plan' },
  { role: 'user', label: 'Approve' },
  { role: 'implementer', label: 'Implement' },
  { role: 'system', label: 'Verify' },
  { role: 'reviewer', label: 'Review' },
]

export function WorkflowGraph({
  workflow,
  selectedStepId,
  onSelectStep,
}: WorkflowGraphProps): React.JSX.Element {
  if (workflow === null) {
    return (
      <div className="flex items-center justify-center p-8 text-sm text-neutral-500">
        No active workflow selected. Click &quot;Start Workflow&quot; to begin.
      </div>
    )
  }

  const steps = workflow.steps
  const activeStep = steps.find((s) => s.finishedAt === null)

  // Map template stages to steps or display placeholder stages
  const items = DEFAULT_STAGES.map((stage, idx) => {
    const matchingStep = steps.find((s) => s.role === stage.role && s.index === idx) ?? steps[idx]
    const state: WorkflowNodeState =
      matchingStep !== undefined
        ? (matchingStep.state as WorkflowNodeState)
        : idx === steps.length && workflow.state !== 'DONE' && workflow.state !== 'CANCELLED'
          ? 'running'
          : 'pending'

    return {
      id: matchingStep?.id ?? `stage-${stage.role}-${String(idx)}`,
      role: stage.role,
      label: stage.label,
      state,
      runtimeId: matchingStep?.runtimeId ?? null,
      simulated: matchingStep?.simulated ?? null,
      verdict: matchingStep?.verdict ?? null,
      step: matchingStep,
      active: activeStep?.id === matchingStep?.id,
    }
  })

  return (
    <div className="flex w-full items-center gap-2 overflow-x-auto p-4">
      {items.map((item, idx) => {
        const isSelected = item.step !== undefined ? selectedStepId === item.step.id : false
        return (
          <React.Fragment key={item.id}>
            <WorkflowNode
              role={item.role}
              label={item.label}
              state={item.state}
              runtimeId={item.runtimeId}
              simulated={item.simulated}
              verdict={item.verdict}
              selected={isSelected}
              active={item.active}
              onClick={() => {
                onSelectStep(
                  item.step ?? {
                    id: item.id,
                    index: idx,
                    role: item.role,
                    runtimeId: item.runtimeId,
                    simulated: item.simulated,
                    state: item.state,
                    contextRef: null,
                    reportStatus: null,
                    verdict: null,
                    changeSetId: null,
                    startedAt: null,
                    finishedAt: null,
                  },
                )
              }}
            />
            {idx < items.length - 1 && (
              <WorkflowEdge
                state={
                  item.state === 'completed'
                    ? 'completed'
                    : item.state === 'running'
                      ? 'active'
                      : 'pending'
                }
              />
            )}
          </React.Fragment>
        )
      })}
    </div>
  )
}
