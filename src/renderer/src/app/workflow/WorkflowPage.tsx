import React, { useEffect, useState } from 'react'
import type {
  ProjectView,
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

/**
 * The workflow's state as a sentence rather than an enum.
 *
 * `HALTED_LIMIT (1/5)` is precise and unreadable to anyone who has not read
 * `guards.ts` (#101). The guards already write a specific reason into `haltReason`
 * — "Reached the maximum of 5 review iterations" — and the UI simply never showed
 * it, so the most useful sentence available was being discarded in favour of the
 * least useful one.
 */
function describeWorkflowState(workflow: WorkflowDetailView): string {
  if (workflow.state.startsWith('HALTED')) {
    // The guard's own words when it has them; the distinction between a budget and a
    // policy stop still matters when it does not.
    if (workflow.haltReason !== null && workflow.haltReason !== '') return workflow.haltReason

    return workflow.state === 'HALTED_POLICY'
      ? 'Stopped: a policy rule was violated'
      : 'Stopped: a limit was reached'
  }

  const PHRASES: Record<string, string> = {
    DISCOVERY: 'Exploring the repository',
    PLANNING: 'Planning',
    PLAN_READY: 'Plan ready for approval',
    AWAITING_APPROVAL: 'Waiting for your approval',
    AWAITING_USER: 'Waiting for your answer',
    DECISIONS_LOCKED: 'Decisions locked',
    IMPLEMENTING: 'Implementing',
    VERIFYING: 'Running build and tests',
    REVIEWING: 'Reviewing the changes',
    CORRECTION_REQUIRED: 'Corrections needed',
    DONE: 'Finished',
    CANCELLED: 'Cancelled',
  }

  return PHRASES[workflow.state] ?? workflow.state
}

export function WorkflowPage(): React.JSX.Element {
  const { show } = useToast()
  const detail = useProjectStore((state) => state.detail)
  const project: ProjectView | null = detail?.project ?? null

  const [workflowState, setWorkflowState] = useState<{
    projectId: string
    workflow: WorkflowDetailView | null
  } | null>(null)
  const [selectedStep, setSelectedStep] = useState<WorkflowStepView | null>(null)
  const [logs, setLogs] = useState<readonly LogLine[]>([])
  const [actionInProgress, setActionInProgress] = useState(false)
  const [templates, setTemplates] = useState<readonly WorkflowTemplateView[]>([])
  const [onlySimulated, setOnlySimulated] = useState(false)
  const [selectedTemplateId, setSelectedTemplateId] = useState('feature')

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
          text: `[STEP ${String(payload.stepIndex)}] ${payload.text}`,
        },
      ])
    })

    return () => {
      unsubEvent()
      unsubLog()
    }
  }, [project, selectedStep])

  // Load available templates (#45)
  useEffect(() => {
    window.forge.template
      .list()
      .then((res) => {
        const data = unwrap(res)
        setTemplates(data.templates)
      })
      .catch((err: unknown) => {
        console.error('Failed to load templates:', err)
      })
  }, [])

  // Whether any real runtime is registered, so the user is told before starting
  // rather than after (#101).
  useEffect(() => {
    window.forge.runtime
      .list()
      .then((res) => {
        const { runtimes } = unwrap(res)
        // `every` on an empty array is true, which would claim "simulated" when the
        // real situation is "nothing registered at all" — a different problem with a
        // different remedy.
        setOnlySimulated(runtimes.length > 0 && runtimes.every((runtime) => runtime.simulated))
      })
      .catch((err: unknown) => {
        console.error('Failed to load runtimes:', err)
      })
  }, [])

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
    } catch (err: unknown) {
      console.error('Failed to cancel workflow:', err)
    } finally {
      setActionInProgress(false)
    }
  }

  const handleExportReport = async (): Promise<void> => {
    if (workflow === null) return
    try {
      // Saved through main rather than copied to the clipboard: a packaged renderer
      // loads from `file://`, which is not a secure context, so
      // `navigator.clipboard.writeText` rejects there (#104). An audit report is also
      // a document — a file is the more useful delivery than a paste buffer.
      const { savedPath } = unwrap(await window.forge.workflow.saveReport(workflow.id))

      // Cancelling the dialog is an ordinary outcome, not a failure to report.
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

  const isRunning =
    workflow !== null &&
    workflow.finishedAt === null &&
    workflow.state !== 'DONE' &&
    workflow.state !== 'CANCELLED' &&
    !workflow.state.startsWith('HALTED')

  const isAwaitingApproval =
    workflow !== null &&
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
            <>
              <div
                className="flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900 px-3 py-1 text-xs"
                // The raw enum stays available, because it is what the docs and the
                // event log use — but it is no longer the only thing on offer.
                title={workflow.state}
              >
                <StatusDot status={status} pulse={isRunning} />
                <span className="font-semibold text-neutral-200">
                  {describeWorkflowState(workflow)}
                </span>
                <span className="text-neutral-500">
                  (iteration {String(workflow.iteration)} of {String(workflow.limits.maxIterations)}
                  )
                </span>
              </div>

              <Badge tone={isDiscussionMode ? 'warning' : 'accent'} size="sm">
                {isDiscussionMode
                  ? 'DISCUSSION MODE (Read-only)'
                  : 'IMPLEMENTATION MODE (Decision Locked)'}
              </Badge>
            </>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {workflow === null || (!isRunning && workflow.finishedAt !== null) ? (
            <div className="flex items-center gap-2">
              {templates.length > 0 && (
                <Select
                  options={templates.map((t) => ({ value: t.id, label: t.name }))}
                  value={selectedTemplateId}
                  onChange={(e) => {
                    setSelectedTemplateId(e.target.value)
                  }}
                  disabled={actionInProgress}
                />
              )}
              <Button
                variant="primary"
                onClick={() => {
                  void handleStartWorkflow()
                }}
                disabled={actionInProgress}
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
              >
                Continue to Implementation
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  void handleCancelWorkflow()
                }}
                disabled={actionInProgress}
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
            >
              Export Report
            </Button>
          )}
        </div>
      </div>

      {onlySimulated && (
        // Shown before the run, not discovered from its results. The whole point of
        // #101 is that a scripted PASS must never be mistaken for verified work, and
        // the honest moment to say so is while the user is deciding to press Start.
        <div className="rounded-lg border border-(--color-warning) bg-(--color-warning-muted) px-4 py-2 text-xs text-(--color-warning)">
          <span className="font-semibold">Simulated runtime only.</span> No real agent is
          configured, so a workflow started here replays a scripted scenario. Its results are not
          evidence of any work being done.
        </div>
      )}

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
