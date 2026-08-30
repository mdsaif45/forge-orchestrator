import React, { useEffect, useState } from 'react'
import type {
  RoleBindingsView,
  WorkflowDetailView,
  WorkflowEventPayload,
  WorkflowLogPayload,
  WorkflowStepView,
  WorkflowTemplateView,
} from '@shared/ipc'
import { Badge, Button, Select, Spinner, StatusDot, useToast } from '@renderer/ui'
import { unwrap } from '@renderer/ipc'
import { useProjectStore } from '../projectStore'
import { LiveLogViewer, type LogLine } from './LiveLogViewer'
import { StepInspector } from './StepInspector'
import { WorkflowGraph } from './WorkflowGraph'
import { WorkflowPreflight } from './WorkflowPreflight'

function describeWorkflowState(workflow: WorkflowDetailView): string {
  switch (workflow.state) {
    case 'DISCOVERY':
      return 'Discovering codebase'
    case 'PLANNING':
      return 'Planning change'
    case 'PLAN_READY':
      return 'Plan ready for review'
    case 'DECISIONS_LOCKED':
      return 'Decisions locked'
    case 'IMPLEMENTING':
      return 'Implementing changes'
    case 'VERIFYING':
      return 'Verifying tests'
    case 'REVIEWING':
      return 'Reviewing diff'
    case 'CORRECTION_REQUIRED':
      return 'Correction required'
    case 'AWAITING_USER':
      return 'Awaiting your answer'
    case 'DONE':
      return 'Workflow completed'
    case 'HALTED_LIMIT':
      return 'Halted (limit reached)'
    case 'HALTED_POLICY':
      return 'Halted (policy violation)'
    case 'CANCELLED':
      return 'Cancelled'
    default:
      return workflow.state
  }
}

export function WorkflowPage(): React.JSX.Element {
  const { show } = useToast()
  const projectDetail = useProjectStore((state) => state.detail)
  const project = projectDetail?.project ?? null

  const [workflowState, setWorkflowState] = useState<{
    projectId: string
    workflow: WorkflowDetailView | null
  } | null>(null)
  const [selectedStep, setSelectedStep] = useState<WorkflowStepView | null>(null)
  const [logs, setLogs] = useState<readonly LogLine[]>([])
  const [templates, setTemplates] = useState<readonly WorkflowTemplateView[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('feature')
  const [bindings, setBindings] = useState<RoleBindingsView | null>(null)
  const [onlySimulated, setOnlySimulated] = useState<boolean>(false)
  const [actionInProgress, setActionInProgress] = useState<boolean>(false)

  const workflow =
    project !== null && workflowState?.projectId === project.id ? workflowState.workflow : null

  const loading = project !== null && workflowState?.projectId !== project.id

  // Load active workflow on project change
  useEffect(() => {
    if (project === null) {
      return
    }

    const pId = project.id
    let cancelled = false

    window.forge.workflow
      .getActive(pId)
      .then((res) => {
        if (!cancelled) {
          const wf = unwrap(res)
          setWorkflowState({ projectId: pId, workflow: wf })
          if (wf !== null && wf.steps.length > 0) {
            setSelectedStep(wf.steps[wf.steps.length - 1] ?? null)
          }
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to load active workflow:', err)
      })

    return () => {
      cancelled = true
    }
  }, [project])

  // Subscribe to push events & logs via IPC
  useEffect(() => {
    const unsubEvent = window.forge.onWorkflowEvent((payload: WorkflowEventPayload) => {
      if (project !== null) {
        const pId = project.id
        window.forge.workflow
          .get(payload.workflowId)
          .then((res) => {
            const updated = unwrap(res)
            if (updated !== null) {
              setWorkflowState({ projectId: pId, workflow: updated })
              if (selectedStep !== null) {
                const refreshed = updated.steps.find((s) => s.id === selectedStep.id)
                if (refreshed !== undefined) setSelectedStep(refreshed)
              }
            }
          })
          .catch((err: unknown) => {
            console.error('Failed to update workflow:', err)
          })
      }

      setLogs((prev) => [
        ...prev,
        {
          id: `evt-${String(Date.now())}-${String(Math.random())}`,
          timestamp: new Date(payload.at).toLocaleTimeString(),
          text: `[EVENT] ${payload.type} -> ${payload.state ?? ''} ${payload.detail !== undefined ? `(${payload.detail})` : ''}`,
        },
      ])
    })

    const unsubLog = window.forge.onWorkflowLog((payload: WorkflowLogPayload) => {
      setLogs((prev) => [
        ...prev,
        {
          id: `log-${String(Date.now())}-${String(Math.random())}`,
          timestamp: new Date(payload.at).toLocaleTimeString(),
          text: `[STEP ${String(payload.stepIndex)}] ${payload.text}`,
        },
      ])
    })

    return () => {
      unsubEvent()
      unsubLog()
    }
  }, [project, selectedStep])

  // Load available templates
  useEffect(() => {
    window.forge.template
      .list()
      .then((res) => {
        const list = unwrap(res).templates
        setTemplates(list)
        if (list.length > 0 && !list.some((t) => t.id === selectedTemplateId)) {
          setSelectedTemplateId(list[0]?.id ?? 'feature')
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to load templates:', err)
      })
  }, [selectedTemplateId])

  // Check runtime list
  useEffect(() => {
    window.forge.runtime
      .list()
      .then((res) => {
        const runtimes = unwrap(res).runtimes
        setOnlySimulated(runtimes.length > 0 && runtimes.every((runtime) => runtime.simulated))
      })
      .catch((err: unknown) => {
        console.error('Failed to load runtimes:', err)
      })
  }, [])

  // Check role bindings
  useEffect(() => {
    if (project === null) return

    window.forge.binding
      .list(project.id)
      .then((res) => {
        setBindings(unwrap(res))
      })
      .catch((err: unknown) => {
        console.error('Failed to load bindings:', err)
      })
  }, [project])

  const handleStartWorkflow = async (): Promise<void> => {
    if (project === null) return
    const pId = project.id
    setActionInProgress(true)
    try {
      const template = templates.find((t) => t.id === selectedTemplateId)
      const res = await window.forge.workflow.start({
        projectId: pId,
        templateId: selectedTemplateId,
        objective: `${template ? template.name : 'Workflow'} in ${project.name}`,
      })
      const started = unwrap(res)
      setWorkflowState({ projectId: pId, workflow: started })
      setLogs([
        {
          id: `init-${String(Date.now())}`,
          timestamp: new Date().toLocaleTimeString(),
          text: `[START] Workflow ${started.id} (${started.templateId}) initiated`,
        },
      ])
    } catch (err: unknown) {
      console.error('Failed to start workflow:', err)
    } finally {
      setActionInProgress(false)
    }
  }

  const handleApproveAndImplement = async (): Promise<void> => {
    if (workflow === null || project === null) return
    const pId = project.id
    setActionInProgress(true)
    try {
      const res = await window.forge.workflow.approveAndStartImplementation(workflow.id)
      const updated = unwrap(res)
      setWorkflowState({ projectId: pId, workflow: updated })
      show({
        tone: 'success',
        title: 'Entered Implementation Mode',
        description: 'Decisions locked. Agents now authorized to write changes in worktree.',
      })
    } catch (err: unknown) {
      show({
        tone: 'danger',
        title: 'Transition Blocked',
        description:
          err instanceof Error
            ? err.message
            : 'At least one locked decision is required before entering implementation.',
      })
    } finally {
      setActionInProgress(false)
    }
  }

  const handleCancelWorkflow = async (): Promise<void> => {
    if (workflow === null || project === null) return
    const pId = project.id
    setActionInProgress(true)
    try {
      const res = await window.forge.workflow.cancel(workflow.id)
      const cancelled = unwrap(res)
      if (cancelled !== null) setWorkflowState({ projectId: pId, workflow: cancelled })
      show({
        tone: 'neutral',
        title: 'Workflow Cancelled',
        description: 'The workflow has been stopped.',
      })
    } catch (err: unknown) {
      console.error('Failed to cancel workflow:', err)
      show({
        tone: 'danger',
        title: 'Could not cancel workflow',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setActionInProgress(false)
    }
  }

  const handleExportReport = async (): Promise<void> => {
    if (workflow === null) return
    try {
      const { savedPath } = unwrap(await window.forge.workflow.saveReport(workflow.id))
      if (savedPath === null) return

      show({
        tone: 'success',
        title: 'Audit Report Saved',
        description: savedPath,
      })
    } catch (err: unknown) {
      show({
        tone: 'danger',
        title: 'Export Failed',
        description: err instanceof Error ? err.message : 'Could not export audit report',
      })
    }
  }

  const isTerminal =
    workflow?.finishedAt !== null ||
    workflow.state === 'DONE' ||
    workflow.state === 'CANCELLED' ||
    workflow.state.startsWith('HALTED')

  const isRunning = workflow !== null && !isTerminal

  const isAwaitingApproval =
    workflow !== null &&
    !isTerminal &&
    (workflow.state === 'AWAITING_APPROVAL' ||
      workflow.state === 'AWAITING_USER' ||
      workflow.state === 'PLANNING')

  const isDiscussionMode =
    workflow !== null &&
    (workflow.state === 'PLANNING' ||
      workflow.state === 'AWAITING_APPROVAL' ||
      workflow.state === 'AWAITING_USER')

  const status: 'idle' | 'running' | 'waiting' | 'passed' | 'failed' | 'halted' =
    workflow === null
      ? 'idle'
      : workflow.state === 'DONE'
        ? 'passed'
        : workflow.state === 'CANCELLED' || workflow.state.startsWith('HALTED')
          ? 'failed'
          : workflow.state === 'AWAITING_USER' || workflow.state === 'AWAITING_APPROVAL'
            ? 'waiting'
            : 'running'

  if (project === null) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-(--color-border) px-6 py-4">
          <h1 className="text-[16px] font-semibold text-(--color-text)">Workflows</h1>
        </div>
        <div className="grid flex-1 place-content-center p-8 text-center text-[13px] text-(--color-text-muted)">
          Please select or create a project from the top bar to view and run workflows.
        </div>
      </div>
    )
  }

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6 overflow-hidden">
      {/* Workflow Header */}
      <div className="flex items-center justify-between border-b border-(--color-border) pb-4">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-[18px] font-bold text-(--color-text)">Workflows</h1>
            <p className="text-[12px] text-(--color-text-muted)">
              {workflow !== null
                ? `Project: ${project.name} · Task: ${workflow.taskId}`
                : `Project: ${project.name}`}
            </p>
          </div>

          {workflow !== null && (
            <>
              <div
                className="flex items-center gap-2 rounded-full border border-(--color-border) bg-(--color-surface-raised) px-3 py-1 text-[12px]"
                title={workflow.state}
              >
                <StatusDot status={status} pulse={isRunning} />
                <span className="font-semibold text-(--color-text)">
                  {describeWorkflowState(workflow)}
                </span>
                <span className="text-(--color-text-muted)">
                  (iteration {String(workflow.iteration)} of {String(workflow.limits.maxIterations)}
                  )
                </span>
              </div>

              <Badge tone={isDiscussionMode ? 'warning' : 'accent'} size="sm" className="rounded-full">
                {isDiscussionMode
                  ? 'DISCUSSION MODE (Read-only)'
                  : 'IMPLEMENTATION MODE (Decision Locked)'}
              </Badge>
            </>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {isTerminal ? (
            <div className="flex items-center gap-2">
              {templates.length > 0 && (
                <Select
                  options={templates.map((t) => ({ value: t.id, label: t.name }))}
                  value={selectedTemplateId}
                  onChange={(e) => {
                    setSelectedTemplateId(e.target.value)
                  }}
                  disabled={actionInProgress}
                  className="h-8 rounded-lg text-[12px]"
                />
              )}
              <Button
                variant="primary"
                onClick={() => {
                  void handleStartWorkflow()
                }}
                disabled={actionInProgress}
                className="h-8 rounded-lg text-[12px]"
              >
                Start Workflow
              </Button>
            </div>
          ) : isAwaitingApproval ? (
            <div className="flex items-center gap-2">
              <Button
                variant="primary"
                onClick={() => {
                  void handleApproveAndImplement()
                }}
                disabled={actionInProgress}
                className="h-8 rounded-lg text-[12px]"
              >
                Continue to Implementation
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  void handleCancelWorkflow()
                }}
                disabled={actionInProgress}
                className="h-8 rounded-lg text-[12px]"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="danger"
              onClick={() => {
                void handleCancelWorkflow()
              }}
              disabled={actionInProgress}
              className="h-8 rounded-lg text-[12px]"
            >
              Cancel Workflow
            </Button>
          )}
          {workflow !== null && (
            <Button
              variant="ghost"
              onClick={() => {
                void handleExportReport()
              }}
              disabled={actionInProgress}
              className="h-8 rounded-lg text-[12px] text-(--color-text-muted) hover:text-(--color-text)"
            >
              Export Report
            </Button>
          )}
        </div>
      </div>

      {workflow === null ? (
        <WorkflowPreflight
          template={templates.find((candidate) => candidate.id === selectedTemplateId) ?? null}
          project={project}
          bindings={bindings}
          onlySimulated={onlySimulated}
        />
      ) : (
        <>
          {/* Workflow Graph View */}
          <div className="rounded-xl border border-(--color-border) bg-(--color-surface-raised)/60 p-1 shadow-xs">
            <WorkflowGraph
              workflow={workflow}
              selectedStepId={selectedStep?.id ?? null}
              onSelectStep={(step) => {
                setSelectedStep(step)
              }}
            />
          </div>

          {/* Main split view: Live Log & Step Inspector */}
          <div className="grid flex-1 grid-cols-1 gap-4 overflow-hidden lg:grid-cols-2">
            <div className="h-full overflow-hidden">
              <LiveLogViewer
                logs={logs}
                onClear={() => {
                  setLogs([])
                }}
              />
            </div>

            <div className="h-full overflow-hidden">
              <StepInspector
                step={selectedStep}
                onClose={() => {
                  setSelectedStep(null)
                }}
              />
            </div>
          </div>
        </>
      )}
    </div>
  )
}
