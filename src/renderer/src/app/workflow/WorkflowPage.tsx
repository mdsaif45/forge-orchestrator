import React, { useEffect, useState } from 'react'
import type {
  ProjectView,
  WorkflowDetailView,
  WorkflowEventPayload,
  WorkflowLogPayload,
  WorkflowStepView,
} from '@shared/ipc'
import { Button, Spinner, StatusDot } from '@renderer/ui'
import { unwrap } from '@renderer/ipc'
import { useProjectStore } from '../projectStore'
import { LiveLogViewer, type LogLine } from './LiveLogViewer'
import { StepInspector } from './StepInspector'
import { WorkflowGraph } from './WorkflowGraph'

export function WorkflowPage(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const project: ProjectView | null = detail?.project ?? null

  const [workflowState, setWorkflowState] = useState<{
    projectId: string
    workflow: WorkflowDetailView | null
  } | null>(null)
  const [selectedStep, setSelectedStep] = useState<WorkflowStepView | null>(null)
  const [logs, setLogs] = useState<readonly LogLine[]>([])
  const [actionInProgress, setActionInProgress] = useState(false)

  const loading = project !== null && workflowState?.projectId !== project.id

  const workflow =
    project !== null && workflowState?.projectId === project.id ? workflowState.workflow : null

  // Fetch active workflow on mount or project switch
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
      // Re-fetch workflow state on event
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
          text: payload.text,
        },
      ])
    })

    return () => {
      unsubEvent()
      unsubLog()
    }
  }, [project, selectedStep])

  const handleStartWorkflow = async () => {
    if (project === null) return
    const pId = project.id
    setActionInProgress(true)
    try {
      const res = await window.forge.workflow.start({
        projectId: pId,
        objective: `Feature build in ${project.name}`,
      })
      const started = unwrap(res)
      setWorkflowState({ projectId: pId, workflow: started })
      setLogs([
        {
          id: `init-${String(Date.now())}`,
          timestamp: new Date().toLocaleTimeString(),
          text: `[START] Workflow ${started.id} initiated for project ${project.name}`,
        },
      ])
    } catch (err: unknown) {
      console.error('Failed to start workflow:', err)
    } finally {
      setActionInProgress(false)
    }
  }

  const handleCancelWorkflow = async () => {
    if (workflow === null || project === null) return
    const pId = project.id
    setActionInProgress(true)
    try {
      const res = await window.forge.workflow.cancel(workflow.id)
      const cancelled = unwrap(res)
      if (cancelled !== null) setWorkflowState({ projectId: pId, workflow: cancelled })
    } catch (err: unknown) {
      console.error('Failed to cancel workflow:', err)
    } finally {
      setActionInProgress(false)
    }
  }

  const isRunning =
    workflow !== null &&
    workflow.finishedAt === null &&
    workflow.state !== 'DONE' &&
    workflow.state !== 'CANCELLED' &&
    !workflow.state.startsWith('HALTED')

  const status: 'idle' | 'running' | 'waiting' | 'passed' | 'failed' | 'halted' =
    workflow === null
      ? 'idle'
      : workflow.state === 'DONE'
        ? 'passed'
        : workflow.state === 'CANCELLED' || workflow.state.startsWith('HALTED')
          ? 'failed'
          : workflow.state === 'AWAITING_USER'
            ? 'waiting'
            : 'running'

  if (project === null) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-neutral-800 px-6 py-4">
          <h1 className="text-lg font-semibold text-neutral-100">Workflows</h1>
        </div>
        <div className="grid flex-1 place-content-center p-8 text-center text-sm text-neutral-400">
          Please select or create a project from the sidebar to view and run workflows.
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
      <div className="flex items-center justify-between border-b border-neutral-800 pb-4">
        <div className="flex items-center gap-3">
          <div>
            <h1 className="text-xl font-bold text-neutral-100">Workflows</h1>
            <p className="text-xs text-neutral-400">
              {workflow !== null
                ? `Project: ${project.name} · Task: ${workflow.taskId}`
                : `Project: ${project.name}`}
            </p>
          </div>

          {workflow !== null && (
            <div className="flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900 px-3 py-1 text-xs">
              <StatusDot status={status} pulse={isRunning} />
              <span className="font-semibold text-neutral-200">{workflow.state}</span>
              <span className="text-neutral-500">
                ({String(workflow.iteration)}/{String(workflow.limits.maxIterations)})
              </span>
            </div>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {!isRunning ? (
            <Button
              variant="primary"
              onClick={() => {
                void handleStartWorkflow()
              }}
              disabled={actionInProgress}
            >
              Start Workflow
            </Button>
          ) : (
            <Button
              variant="danger"
              onClick={() => {
                void handleCancelWorkflow()
              }}
              disabled={actionInProgress}
            >
              Cancel Workflow
            </Button>
          )}
        </div>
      </div>

      {/* Workflow Graph View */}
      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40">
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
    </div>
  )
}
