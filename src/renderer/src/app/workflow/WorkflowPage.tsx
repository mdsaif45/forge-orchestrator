import React, { useEffect, useState } from 'react'
import type {
  RoleBindingsView,
  WorkflowDetailView,
  WorkflowEventPayload,
  WorkflowLogPayload,
  WorkflowStepView,
  WorkflowTemplateView,
} from '@shared/ipc'
import {
  Badge,
  Button,
  Card,
  ScrollArea,
  StartWorkflowDialog,
  StatusDot,
  useToast,
  WorkflowEdge,
  WorkflowNode,
} from '@renderer/ui'
import { unwrap } from '@renderer/ipc'
import { useProjectStore } from '../projectStore'
import { StepInspector } from './StepInspector'
import { WorkflowPreflight } from './WorkflowPreflight'

interface LogEntry {
  readonly id: string
  readonly timestamp: string
  readonly text: string
}

function describeWorkflowState(workflow: WorkflowDetailView): string {
  switch (workflow.state) {
    case 'DISCUSSING':
      return 'Discussing requirements'
    case 'PLANNING':
      return 'Planning implementation'
    case 'AWAITING_APPROVAL':
    case 'AWAITING_USER':
      return 'Awaiting your approval'
    case 'DECISIONS_PENDING':
      return 'Reviewing decisions'
    case 'IMPLEMENTING':
      return 'Implementing in worktree'
    case 'VERIFYING':
      return 'Verifying changes'
    case 'REVIEWING':
      return 'Reviewing code quality'
    case 'CORRECTING':
      return 'Refining implementation'
    case 'DONE':
      return 'Workflow completed'
    case 'CANCELLED':
      return 'Workflow cancelled'
    case 'HALTED_POLICY':
      return 'Halted (Policy violation or agent exit)'
    case 'HALTED_LIMIT':
      return 'Halted (Limit reached)'
    default:
      return workflow.state
  }
}

export function WorkflowPage(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const project = detail?.project ?? null

  const [workflow, setWorkflow] = useState<WorkflowDetailView | null>(null)
  const [activeTaskTitle, setActiveTaskTitle] = useState<string | null>(null)
  const [templates, setTemplates] = useState<readonly WorkflowTemplateView[]>([])
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('feature')
  const [bindings, setBindings] = useState<RoleBindingsView | null>(null)
  const [logs, setLogs] = useState<readonly LogEntry[]>([])
  const [selectedStep, setSelectedStep] = useState<WorkflowStepView | null>(null)
  const [actionInProgress, setActionInProgress] = useState<boolean>(false)
  const [startDialogOpen, setStartDialogOpen] = useState<boolean>(false)
  const { show } = useToast()

  // Load active workflow on project change
  useEffect(() => {
    if (project === null) return
    const pId = project.id

    let cancelled = false
    window.forge.workflow
      .getActive(pId)
      .then((res) => {
        if (cancelled) return
        const active = unwrap(res)
        setWorkflow(active)
        if (active !== null && active.steps.length > 0) {
          const currentRunning = active.steps.find((s: WorkflowStepView) => s.state === 'running')
          if (currentRunning !== undefined) {
            setSelectedStep(currentRunning)
          } else {
            setSelectedStep(active.steps[active.steps.length - 1] ?? null)
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
        window.forge.workflow
          .get(payload.workflowId)
          .then((res) => {
            const updated = unwrap(res)
            if (updated !== null) {
              setWorkflow(updated)
              if (selectedStep !== null) {
                const refreshed = updated.steps.find((s: WorkflowStepView) => s.id === selectedStep.id)
                if (refreshed !== undefined) setSelectedStep(refreshed)
              }
            }
          })
          .catch((err: unknown) => {
            console.error('Failed to update workflow:', err)
          })
      }

      const evtTime = new Date(payload.at)
      setLogs((prev) => [
        ...prev,
        {
          id: `evt-${String(evtTime.getTime())}-${String(Math.random())}`,
          timestamp: evtTime.toLocaleTimeString(),
          text: `[EVENT] ${payload.type} -> ${payload.state ?? ''} ${payload.detail !== undefined ? `(${payload.detail})` : ''}`,
        },
      ])
    })

    const unsubLog = window.forge.onWorkflowLog((payload: WorkflowLogPayload) => {
      const logTime = new Date(payload.at)
      setLogs((prev) => [
        ...prev,
        {
          id: `log-${String(logTime.getTime())}-${String(Math.random())}`,
          timestamp: logTime.toLocaleTimeString(),
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
        if (list.length > 0 && !list.some((t: WorkflowTemplateView) => t.id === selectedTemplateId)) {
          setSelectedTemplateId(list[0]?.id ?? 'feature')
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to load templates:', err)
      })
  }, [selectedTemplateId])

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

  const handleStartWorkflow = async (data: {
    readonly templateId: string
    readonly title: string
    readonly objective: string
    readonly scopePaths?: readonly string[] | undefined
  }): Promise<void> => {
    if (project === null) return
    const pId = project.id
    setActionInProgress(true)
    try {
      const res = await window.forge.workflow.start({
        projectId: pId,
        templateId: data.templateId,
        objective: data.objective,
      })
      const started = unwrap(res)
      setWorkflow(started)
      setActiveTaskTitle(data.title)
      const now = new Date()
      setLogs([
        {
          id: `init-${String(now.getTime())}`,
          timestamp: now.toLocaleTimeString(),
          text: `[START] Task "${data.title}" initiated (${started.templateId})`,
        },
      ])
      show({
        tone: 'success',
        title: 'Workflow Initiated',
        description: `Planning started for "${data.title}" in sandbox worktree.`,
      })
    } catch (err: unknown) {
      console.error('Failed to start workflow:', err)
      show({
        tone: 'danger',
        title: 'Could Not Start Workflow',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setActionInProgress(false)
    }
  }

  const handleApproveAndImplement = async (): Promise<void> => {
    if (workflow === null || project === null) return
    setActionInProgress(true)
    try {
      const res = await window.forge.workflow.approveAndStartImplementation(workflow.id)
      const updated = unwrap(res)
      setWorkflow(updated)
      show({
        tone: 'success',
        title: 'Entered Implementation Mode',
        description: 'Decisions locked. Agent authorized to implement changes in sandbox.',
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
    setActionInProgress(true)
    try {
      const res = await window.forge.workflow.cancel(workflow.id)
      const cancelled = unwrap(res)
      if (cancelled !== null) setWorkflow(cancelled)
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
      const result = unwrap(await window.forge.workflow.saveReport(workflow.id))
      if (result.savedPath === null) return

      show({
        tone: 'success',
        title: 'Audit Report Saved',
        description: result.savedPath,
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
    workflow === null
      ? true
      : workflow.finishedAt !== null ||
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

  return (
    <div className="flex h-full flex-col gap-4 p-6 overflow-hidden">
      {/* Workflow Top Header */}
      <div className="flex items-center justify-between border-b border-(--color-border) pb-4">
        <div className="flex items-center gap-3">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-[18px] font-bold text-(--color-text)">Workflows</h1>
              {activeTaskTitle && (
                <span className="text-[14px] font-medium text-(--color-text-muted) truncate max-w-md">
                  — {activeTaskTitle}
                </span>
              )}
            </div>
            <p className="text-[12px] text-(--color-text-muted)">
              Project: <span className="font-semibold text-(--color-text)">{project.name}</span>
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
                  (iteration {String(workflow.iteration)} of {String(workflow.limits.maxIterations)})
                </span>
              </div>

              <Badge
                tone={isDiscussionMode ? 'warning' : 'accent'}
                size="sm"
                className="rounded-full"
              >
                {isDiscussionMode
                  ? 'PLANNING MODE (Read-only Sandbox)'
                  : 'IMPLEMENTATION MODE (Decision Locked)'}
              </Badge>
            </>
          )}
        </div>

        {/* Top Action Controls */}
        <div className="flex items-center gap-2">
          {isTerminal ? (
            <Button
              variant="primary"
              onClick={() => {
                setStartDialogOpen(true)
              }}
              disabled={actionInProgress}
              className="h-8 rounded-lg text-[12px]"
            >
              + Start New Feature
            </Button>
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
                Approve & Start Implementation
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  void handleCancelWorkflow()
                }}
                disabled={actionInProgress}
                className="h-8 rounded-lg text-[12px] text-(--color-danger)"
              >
                Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="ghost"
              onClick={() => {
                void handleCancelWorkflow()
              }}
              disabled={actionInProgress}
              className="h-8 rounded-lg text-[12px] text-(--color-danger)"
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
              className="h-8 rounded-lg text-[12px]"
            >
              Export Report
            </Button>
          )}
        </div>
      </div>

      {/* Main Content Area */}
      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-3 overflow-hidden">
        {/* Left 2 Columns: Workflow Pipeline & Live Logs */}
        <div className="flex flex-col gap-4 lg:col-span-2 overflow-hidden">
          {/* Top Preflight Banner if no active workflow */}
          {workflow === null && (
            <WorkflowPreflight
              template={templates.find((t: WorkflowTemplateView) => t.id === selectedTemplateId) ?? null}
              project={project}
              bindings={bindings}
              onlySimulated={false}
            />
          )}

          {/* Workflow Stage Nodes Graph */}
          {workflow !== null && (
            <Card tone="raised" className="p-4 overflow-x-auto">
              <div className="flex items-center gap-3">
                {workflow.steps.map((step: WorkflowStepView, idx: number) => (
                  <React.Fragment key={step.id}>
                    <WorkflowNode
                      role={step.role}
                      label={step.role.toUpperCase()}
                      state={step.state as 'pending' | 'running' | 'completed' | 'failed' | 'halted' | 'awaiting_user'}
                      verdict={step.verdict}
                      runtimeId={step.runtimeId}
                      selected={selectedStep?.id === step.id}
                      active={step.state === 'running'}
                      onClick={() => {
                        setSelectedStep(step)
                      }}
                    />
                    {idx < workflow.steps.length - 1 && (
                      <WorkflowEdge
                        state={
                          workflow.steps[idx + 1]?.state === 'running'
                            ? 'active'
                            : step.state === 'completed'
                              ? 'completed'
                              : 'pending'
                        }
                      />
                    )}
                  </React.Fragment>
                ))}
              </div>
            </Card>
          )}

          {/* Live Execution Logs */}
          <Card tone="raised" className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between border-b border-(--color-border) px-4 py-2 bg-(--color-surface)">
              <div className="flex items-center gap-2">
                <span className="font-mono text-[11px] font-semibold uppercase tracking-wider text-(--color-text-subtle)">
                  Live Execution Log
                </span>
                <Badge tone="neutral" size="sm" className="font-mono text-[10px]">
                  {logs.length} events
                </Badge>
              </div>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    void navigator.clipboard.writeText(logs.map((l) => `${l.timestamp} ${l.text}`).join('\n'))
                    show({ tone: 'neutral', title: 'Logs copied to clipboard' })
                  }}
                  className="h-6 text-[11px]"
                >
                  Copy
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setLogs([])
                  }}
                  className="h-6 text-[11px]"
                >
                  Clear
                </Button>
              </div>
            </div>

            <ScrollArea className="flex-1 bg-(--color-surface-inset) p-4">
              {logs.length === 0 ? (
                <p className="text-[12px] text-(--color-text-muted) italic">
                  No execution logs recorded yet. Start a workflow to stream agent actions and verification steps.
                </p>
              ) : (
                <div className="space-y-1 font-mono text-[12px]">
                  {logs.map((log) => {
                    const isError = log.text.includes('FAIL') || log.text.includes('HALTED') || log.text.includes('error')
                    const isSuccess = log.text.includes('PASS') || log.text.includes('DONE') || log.text.includes('verified')
                    return (
                      <div key={log.id} className="flex items-start gap-2 leading-relaxed">
                        <span className="shrink-0 text-(--color-text-subtle)">{log.timestamp}</span>
                        <span
                          className={
                            isError
                              ? 'text-(--color-danger)'
                              : isSuccess
                                ? 'text-(--color-success)'
                                : 'text-(--color-text)'
                          }
                        >
                          {log.text}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
            </ScrollArea>
          </Card>
        </div>

        {/* Right Column: Step Inspector Panel */}
        <Card tone="raised" className="flex flex-col overflow-hidden">
          <StepInspector
            step={selectedStep}
            onClose={() => {
              setSelectedStep(null)
            }}
          />
        </Card>
      </div>

      {/* Start New Workflow / Feature Requirements Modal */}
      <StartWorkflowDialog
        open={startDialogOpen}
        templates={templates}
        selectedTemplateId={selectedTemplateId}
        onSelectTemplate={setSelectedTemplateId}
        onClose={() => {
          setStartDialogOpen(false)
        }}
        onStart={handleStartWorkflow}
      />
    </div>
  )
}
