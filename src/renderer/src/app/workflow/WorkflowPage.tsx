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
  CreateTemplateDialog,
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
      return 'Planning implementation blueprint'
    case 'AWAITING_APPROVAL':
    case 'AWAITING_USER':
      return 'Plan ready — Awaiting your approval'
    case 'DECISIONS_PENDING':
      return 'Reviewing proposed decisions'
    case 'IMPLEMENTING':
      return 'Implementing changes in sandbox'
    case 'VERIFYING':
      return 'Verifying tests & build suite'
    case 'REVIEWING':
      return 'Reviewing code quality & security'
    case 'CORRECTING':
      return 'Refining implementation'
    case 'DONE':
      return 'Workflow completed'
    case 'CANCELLED':
      return 'Workflow cancelled'
    case 'HALTED_POLICY':
      return 'Halted: Policy violation or agent exit'
    case 'HALTED_LIMIT':
      return 'Halted: Iteration limit reached'
    default:
      return workflow.state
  }
}

function getPersonaForRole(role: string): { readonly persona: string; readonly stageLabel: string } {
  switch (role) {
    case 'planner':
      return { persona: 'Alex (Planner)', stageLabel: 'Stage 1 • Planning' }
    case 'user':
      return { persona: 'You (Approval Gate)', stageLabel: 'Stage 2 • Review Gate' }
    case 'implementer':
      return { persona: 'Sam (Implementer)', stageLabel: 'Stage 3 • Sandbox Code' }
    case 'reviewer':
      return { persona: 'Morgan (Reviewer)', stageLabel: 'Stage 4 • Code Audit' }
    case 'system':
      return { persona: 'Forge Engine', stageLabel: 'Stage • Verification' }
    default:
      return { persona: role, stageLabel: `Stage • ${role}` }
  }
}

export function WorkflowPage(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const project = detail?.project ?? null

  const [workflow, setWorkflow] = useState<WorkflowDetailView | null>(null)
  const [activeTaskTitle, setActiveTaskTitle] = useState<string | null>(null)
  const [baseTemplates, setBaseTemplates] = useState<readonly WorkflowTemplateView[]>([])
  const [customTemplates, setCustomTemplates] = useState<readonly WorkflowTemplateView[]>(() => {
    const saved = localStorage.getItem('forge.custom_templates')
    if (saved) {
      try {
        return JSON.parse(saved) as WorkflowTemplateView[]
      } catch {
        // fallback
      }
    }
    return []
  })
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>('feature')
  const [bindings, setBindings] = useState<RoleBindingsView | null>(null)
  const [logs, setLogs] = useState<readonly LogEntry[]>([])
  const [selectedStep, setSelectedStep] = useState<WorkflowStepView | null>(null)
  const [actionInProgress, setActionInProgress] = useState<boolean>(false)
  const [startDialogOpen, setStartDialogOpen] = useState<boolean>(false)
  const [createTemplateOpen, setCreateTemplateOpen] = useState<boolean>(false)
  const { show } = useToast()

  const allTemplates = [...baseTemplates, ...customTemplates]

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
        setBaseTemplates(list)
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
        {
          id: `init-planner-${String(now.getTime())}`,
          timestamp: now.toLocaleTimeString(),
          text: `[PLANNER] Alex (Planner) starting architectural analysis and dependency scan...`,
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

  const handleSaveCustomTemplate = (template: WorkflowTemplateView): void => {
    const updated = [...customTemplates, template]
    setCustomTemplates(updated)
    localStorage.setItem('forge.custom_templates', JSON.stringify(updated))
    setSelectedTemplateId(template.id)
    show({ tone: 'success', title: `Template "${template.name}" created` })
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
        description: 'Decisions locked. Sam (Implementer) authorized to write changes in worktree.',
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
            <div className="flex items-center gap-2">
              {/* Dynamic Clean Status Pill */}
              <div
                className={`flex items-center gap-2 rounded-full border px-3 py-1 text-[12px] ${
                  status === 'failed'
                    ? 'border-(--color-danger)/30 bg-(--color-danger)/10 text-(--color-danger)'
                    : 'border-(--color-border) bg-(--color-surface-raised) text-(--color-text)'
                }`}
                title={workflow.state}
              >
                <StatusDot status={status} pulse={isRunning} />
                <span className="font-semibold">
                  {workflow.state.startsWith('HALTED')
                    ? `Halted: ${workflow.haltReason ?? 'Policy violation or agent exit'}`
                    : describeWorkflowState(workflow)}
                </span>
                <span className="text-(--color-text-muted) text-[11px]">
                  (iteration {String(workflow.iteration)} of {String(workflow.limits.maxIterations)})
                </span>
              </div>

              {/* Mode Badge - Only show when active, not when halted */}
              {!isTerminal && (
                <Badge
                  tone={isDiscussionMode ? 'warning' : 'accent'}
                  size="sm"
                  className="rounded-full"
                >
                  {isDiscussionMode
                    ? 'PLANNING MODE (Read-only Sandbox)'
                    : 'IMPLEMENTATION MODE (Decision Locked)'}
                </Badge>
              )}
            </div>
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
              + Start New Work
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

      {/* Interactive Plan Review Banner when awaiting approval */}
      {isAwaitingApproval && (
        <Card tone="raised" className="border-(--color-warning)/40 bg-(--color-warning)/5 p-3.5">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <span className="text-[18px]">📋</span>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-bold text-(--color-text)">
                    Plan Ready for Your Review
                  </span>
                  <Badge tone="warning" size="sm">
                    Human Gate
                  </Badge>
                </div>
                <p className="m-0 text-[11px] text-(--color-text-muted)">
                  Alex (Planner) has produced the architectural plan. Review proposed decisions in the inspector and approve to authorize Sam (Implementer) to write code.
                </p>
              </div>
            </div>

            <div className="flex items-center gap-2 shrink-0">
              <Button
                variant="primary"
                onClick={() => {
                  void handleApproveAndImplement()
                }}
                disabled={actionInProgress}
                className="h-7 text-[11px] font-semibold"
              >
                ✓ Approve & Start Implementation
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* Main Content Area */}
      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-3 overflow-hidden">
        {/* Left 2 Columns: Workflow Pipeline & Live Logs */}
        <div className="flex flex-col gap-4 lg:col-span-2 overflow-hidden">
          {/* Top Preflight Banner if no active workflow */}
          {workflow === null && (
            <WorkflowPreflight
              template={allTemplates.find((t: WorkflowTemplateView) => t.id === selectedTemplateId) ?? null}
              project={project}
              bindings={bindings}
              onlySimulated={false}
            />
          )}

          {/* Workflow Stage Nodes Graph */}
          {workflow !== null && (
            <Card tone="raised" className="p-4 overflow-x-auto">
              <div className="flex items-center gap-3">
                {workflow.steps.map((step: WorkflowStepView, idx: number) => {
                  const { persona, stageLabel } = getPersonaForRole(step.role)
                  return (
                    <React.Fragment key={step.id}>
                      <WorkflowNode
                        role={step.role}
                        label={persona}
                        stageLabel={stageLabel}
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
                  )
                })}
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
                  No execution logs recorded yet. Start new work to stream agent actions and verification steps.
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

      {/* Start New Work / Requirements Modal */}
      <StartWorkflowDialog
        open={startDialogOpen}
        templates={allTemplates}
        selectedTemplateId={selectedTemplateId}
        onSelectTemplate={setSelectedTemplateId}
        onCreateCustomTemplate={() => {
          setCreateTemplateOpen(true)
        }}
        onClose={() => {
          setStartDialogOpen(false)
        }}
        onStart={handleStartWorkflow}
      />

      {/* Create Custom Workflow Template Modal */}
      <CreateTemplateDialog
        open={createTemplateOpen}
        onClose={() => {
          setCreateTemplateOpen(false)
        }}
        onSave={handleSaveCustomTemplate}
      />
    </div>
  )
}
