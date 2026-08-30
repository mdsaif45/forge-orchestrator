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
  AgentTerminal,
  Badge,
  Button,
  Card,
  CreateTemplateDialog,
  RealTerminal,
  StartWorkflowDialog,
  StatusDot,
  useToast,
  WorkflowEdge,
  WorkflowLaunchpad,
  WorkflowNode,
} from '@renderer/ui'
import { unwrap } from '@renderer/ipc'
import { useProjectStore } from '../projectStore'
import { StepInspector } from './StepInspector'

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
  const [terminalMode, setTerminalMode] = useState<'real-pty' | 'protocol'>('real-pty')
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

  const status: 'idle' | 'running' | 'waiting' | 'passed' | 'failed' =
    workflow === null
      ? 'idle'
      : workflow.state === 'DONE'
        ? 'passed'
        : workflow.state === 'CANCELLED' || workflow.state.startsWith('HALTED')
          ? 'failed'
          : workflow.state === 'AWAITING_USER' || workflow.state === 'AWAITING_APPROVAL'
            ? 'waiting'
            : 'running'

  // Derive all stages from active template so that graph nodes are ALWAYS rendered on start
  const activeTemplate =
    allTemplates.find((t) => t.id === (workflow?.templateId ?? selectedTemplateId)) ??
    allTemplates[0]

  const stageSteps: readonly WorkflowStepView[] = (() => {
    if (workflow === null) return []
    if (activeTemplate === undefined || activeTemplate.steps.length === 0) {
      return workflow.steps
    }

    return activeTemplate.steps.map((tmplStep, idx) => {
      const existing = workflow.steps[idx]
      if (existing !== undefined) return existing

      // Bound runtime fallback for pending steps
      const boundRuntime =
        bindings?.roles.find((r) => r.role === tmplStep.role)?.binding?.runtimeId ?? null

      return {
        id: `pending-step-${String(idx)}`,
        index: idx,
        role: tmplStep.role,
        runtimeId: boundRuntime,
        simulated: false,
        state: 'pending',
        contextRef: null,
        reportStatus: null,
        verdict: null,
        changeSetId: null,
        startedAt: null,
        finishedAt: null,
      }
    })
  })()

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

  // When no active workflow is executing: Render the clean Launchpad
  if (workflow === null) {
    return (
      <div className="flex h-full flex-col gap-3 p-6 overflow-hidden">
        <WorkflowLaunchpad
          projectName={project.name}
          repositoryPath={project.repository.absolutePath}
          templates={allTemplates}
          selectedTemplateId={selectedTemplateId}
          onSelectTemplate={setSelectedTemplateId}
          onStartWork={(tmplId) => {
            if (tmplId) setSelectedTemplateId(tmplId)
            setStartDialogOpen(true)
          }}
          onCreateTemplate={() => {
            setCreateTemplateOpen(true)
          }}
          bindings={bindings}
        />

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

  // Active Workflow Running / Inspecting Mode
  return (
    <div className="flex h-full flex-col gap-3 p-6 overflow-hidden">
      {/* 1. TOP HEADER & PRIMARY ACTIONS */}
      <div className="flex items-center justify-between border-b border-(--color-border) pb-3">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[20px] font-bold text-(--color-text)">Workflows</h1>
            {activeTaskTitle && (
              <span className="text-[14px] font-semibold text-(--color-text-muted) truncate max-w-lg">
                — {activeTaskTitle}
              </span>
            )}
          </div>
          <p className="text-[12px] text-(--color-text-muted)">
            Repository:{' '}
            <span className="font-semibold text-(--color-text)">{project.name}</span>
          </p>
        </div>

        {/* Action Buttons with clear borders and styling */}
        <div className="flex items-center gap-2">
          {isTerminal ? (
            <Button
              variant="primary"
              onClick={() => {
                setStartDialogOpen(true)
              }}
              disabled={actionInProgress}
              className="h-8 rounded-lg px-3.5 text-[12px] font-bold shadow-xs"
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
                className="h-8 rounded-lg px-3 text-[12px] font-semibold"
              >
                ✓ Approve & Start Implementation
              </Button>
              <Button
                variant="secondary"
                onClick={() => {
                  void handleCancelWorkflow()
                }}
                disabled={actionInProgress}
                className="h-8 rounded-lg border border-(--color-danger)/40 bg-(--color-danger)/10 px-3 text-[12px] font-medium text-(--color-danger) hover:bg-(--color-danger)/20"
              >
                ✕ Cancel
              </Button>
            </div>
          ) : (
            <Button
              variant="secondary"
              onClick={() => {
                void handleCancelWorkflow()
              }}
              disabled={actionInProgress}
              className="h-8 rounded-lg border border-(--color-danger)/40 bg-(--color-danger)/10 px-3 text-[12px] font-medium text-(--color-danger) hover:bg-(--color-danger)/20"
            >
              ✕ Cancel Workflow
            </Button>
          )}

          <Button
            variant="secondary"
            onClick={() => {
              void handleExportReport()
            }}
            className="h-8 rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 text-[12px] font-medium text-(--color-text) hover:bg-(--color-surface)"
          >
            📥 Export Report
          </Button>
        </div>
      </div>

      {/* 2. DEDICATED WORKFLOW STATUS STRIP */}
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-(--color-border) bg-(--color-surface-raised) px-4 py-2 text-[12px]">
        <div className="flex items-center gap-2.5">
          <StatusDot status={status} pulse={isRunning} />
          <span
            className={`font-bold ${
              status === 'failed'
                ? 'text-(--color-danger)'
                : status === 'passed'
                  ? 'text-(--color-success)'
                  : 'text-(--color-text)'
            }`}
          >
            {workflow.state.startsWith('HALTED')
              ? `Halted: ${workflow.haltReason ?? 'Policy violation or agent exit'}`
              : describeWorkflowState(workflow)}
          </span>
          <span className="text-(--color-text-subtle)">
            (iteration {String(workflow.iteration)} of {String(workflow.limits.maxIterations)})
          </span>
        </div>

        <div className="flex items-center gap-2">
          {!isTerminal && (
            <Badge
              tone={isDiscussionMode ? 'warning' : 'accent'}
              size="sm"
              className="rounded-md font-mono text-[10px]"
            >
              {isDiscussionMode
                ? 'PLANNING MODE (Read-only Sandbox)'
                : 'IMPLEMENTATION MODE (Decision Locked)'}
            </Badge>
          )}
          <Badge tone="neutral" size="sm" className="font-mono text-[10px]">
            Template: {workflow.templateId}
          </Badge>
        </div>
      </div>

      {/* 3. INTERACTIVE PLAN REVIEW BANNER WHEN AWAITING USER APPROVAL */}
      {isAwaitingApproval && (
        <Card tone="raised" className="border-(--color-warning)/50 bg-(--color-warning)/10 p-3.5 shadow-xs">
          <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-2.5">
              <span className="text-[20px]">📋</span>
              <div>
                <div className="flex items-center gap-2">
                  <span className="text-[13px] font-bold text-(--color-text)">
                    Architectural Plan Ready for Your Review
                  </span>
                  <Badge tone="warning" size="sm">
                    Human Gate
                  </Badge>
                </div>
                <p className="m-0 text-[11px] text-(--color-text-muted)">
                  Alex (Planner) has produced the plan. Inspect the findings and click below to authorize Sam (Implementer) to execute changes in the worktree.
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
                className="h-7 px-3 text-[11px] font-semibold"
              >
                ✓ Approve & Start Implementation
              </Button>
            </div>
          </div>
        </Card>
      )}

      {/* 4. MAIN WORKFLOW WORKSPACE: Pipeline Graph, Live Logs & Inspector */}
      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-3 overflow-hidden">
        {/* Left 2 Columns: Pipeline Nodes & Live Logs */}
        <div className="flex flex-col gap-3 lg:col-span-2 overflow-hidden">
          {/* Workflow Stage Pipeline Graph (ALWAYS rendered) */}
          <Card tone="raised" className="p-3.5 overflow-x-auto">
            <div className="flex items-center gap-3">
              {stageSteps.map((step: WorkflowStepView, idx: number) => {
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
                    {idx < stageSteps.length - 1 && (
                      <WorkflowEdge
                        state={
                          stageSteps[idx + 1]?.state === 'running'
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

          {/* Live Agent Terminal / Console with Switcher */}
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="flex items-center justify-between pb-2">
              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => {
                    setTerminalMode('real-pty')
                  }}
                  className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold cursor-pointer transition-colors ${
                    terminalMode === 'real-pty'
                      ? 'bg-(--color-surface-raised) text-(--color-text) border border-(--color-border) shadow-xs'
                      : 'text-(--color-text-muted) hover:text-(--color-text)'
                  }`}
                >
                  💻 Live CLI Terminal (node-pty / xterm)
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setTerminalMode('protocol')
                  }}
                  className={`rounded-lg px-2.5 py-1 text-[11px] font-semibold cursor-pointer transition-colors ${
                    terminalMode === 'protocol'
                      ? 'bg-(--color-surface-raised) text-(--color-text) border border-(--color-border) shadow-xs'
                      : 'text-(--color-text-muted) hover:text-(--color-text)'
                  }`}
                >
                  📋 Protocol Log Stream
                </button>
              </div>
            </div>

            {terminalMode === 'real-pty' ? (
              <RealTerminal
                key={`${project.id}-${selectedStep?.runtimeId ?? 'default'}-${selectedStep?.id ?? 'main'}`}
                projectId={project.id}
                runtimeId={selectedStep?.runtimeId}
                personaName={selectedStep !== null ? getPersonaForRole(selectedStep.role).persona : undefined}
                title={`${selectedStep !== null ? getPersonaForRole(selectedStep.role).persona : 'Agent'} Terminal`}
                className="flex-1 min-h-[300px]"
              />
            ) : (
              <AgentTerminal
                logs={logs}
                title="Live Workflow & Agent Protocol"
                personaName={selectedStep !== null ? getPersonaForRole(selectedStep.role).persona : undefined}
                runtimeId={selectedStep?.runtimeId}
                repositoryPath={project.repository.absolutePath}
                isRunning={isRunning}
                onClear={() => {
                  setLogs([])
                }}
                onSendInput={(input) => {
                  const now = new Date()
                  setLogs((prev) => [
                    ...prev,
                    {
                      id: `input-${String(now.getTime())}`,
                      timestamp: now.toLocaleTimeString(),
                      text: `> ${input}`,
                    },
                  ])
                  show({ tone: 'neutral', title: 'Input submitted to agent console' })
                }}
                className="flex-1 min-h-[300px]"
              />
            )}
          </div>
        </div>

        {/* Right Column: Step Inspector Panel with Live Console Tab */}
        <Card tone="raised" className="flex flex-col overflow-hidden">
          <StepInspector
            step={selectedStep}
            stepLogs={logs}
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
