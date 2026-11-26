import React, { useCallback, useEffect, useState } from 'react'
import type {
  ArtifactMetadataView,
  ChangeSetView,
  RoleBindingsView,
  WorkflowArtifactView,
  WorkflowDetailView,
  WorkflowEventPayload,
  WorkflowLogPayload,
  WorkflowStepView,
  WorkflowTemplateV2View,
  WorkflowTemplateView,
} from '@shared/ipc'
import { WorkflowCatalogView } from './WorkflowCatalogView'
import { WorkflowCanvas } from './WorkflowCanvas'
import { WorkflowArtifactViewer } from './WorkflowArtifactViewer'
import { filterToolTimelineByStep } from '@shared/domain'
import { useWorkflowRuntimeEvents } from './useWorkflowRuntimeEvents'
import { Button, CreateTemplateDialog, Icon, StartWorkflowDialog, useToast } from '@renderer/ui'
import { unwrap } from '@renderer/ipc'
import { useProjectStore } from '../projectStore'
import { StepInspector } from './StepInspector'
import { ThreadContainer } from './thread/ThreadContainer'
import { buildThreadEntries, type ThreadUserInterjection } from './thread/threadProjection'

interface LogEntry {
  readonly id: string
  readonly stepIndex?: number | undefined
  readonly timestamp: string
  readonly text: string
}

function describeWorkflowState(workflow: WorkflowDetailView): string {
  switch (workflow.state) {
    case 'DISCOVERY':
    case 'DISCUSSING':
      return 'Discovering repository & analyzing task'
    case 'PLANNING':
      return 'Planning implementation blueprint'
    case 'PLAN_READY':
    case 'AWAITING_APPROVAL':
    case 'AWAITING_USER':
      return 'Plan ready — Awaiting your review & approval'
    case 'DECISIONS_LOCKED':
      return 'Decisions locked — Transitioning to sandbox'
    case 'IMPLEMENTING':
      return 'Implementing changes in sandbox worktree'
    case 'VERIFYING':
      return 'Verifying tests & build suite'
    case 'REVIEWING':
      return 'Reviewing code quality & security'
    case 'CORRECTION_REQUIRED':
      return 'Correction required — Refining implementation'
    case 'DONE':
      return 'Workflow completed successfully'
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

export function WorkflowPage(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const project = detail?.project ?? null

  const [workflow, setWorkflow] = useState<WorkflowDetailView | null>(null)
  const { toolTimeline, stepStreams, clearEvents } = useWorkflowRuntimeEvents(workflow?.id ?? null)
  const [activeTaskTitle, setActiveTaskTitle] = useState<string | null>(null)
  const [activePromptObjective, setActivePromptObjective] = useState<string | null>(null)
  const [artifacts, setArtifacts] = useState<readonly ArtifactMetadataView[]>([])
  const [changeSets, setChangeSets] = useState<readonly ChangeSetView[]>([])
  const [interjections, setInterjections] = useState<readonly ThreadUserInterjection[]>([])
  const [inspectorOpen, setInspectorOpen] = useState<boolean>(false)
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

  const [templatesV2, setTemplatesV2] = useState<readonly WorkflowTemplateV2View[]>([])
  const [editingTemplate, setEditingTemplate] = useState<WorkflowTemplateV2View | null>(null)
  const [viewingArtifact, setViewingArtifact] = useState<WorkflowArtifactView | null>(null)
  const [studioMode, setStudioMode] = useState<'catalog' | 'canvas' | 'player'>('catalog')

  const loadTemplatesV2 = useCallback(() => {
    window.forge.template
      .listV2()
      .then((res) => {
        if (res.ok) {
          setTemplatesV2(res.value.templates)
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to load V2 templates:', err)
      })
  }, [])

  useEffect(() => {
    loadTemplatesV2()
  }, [loadTemplatesV2])

  const handleRunV2Workflow = (tmpl: WorkflowTemplateV2View) => {
    setSelectedTemplateId(tmpl.id)
    void handleStartWorkflow({
      title: tmpl.name,
      objective: tmpl.description,
      templateId: tmpl.id,
    })
    setStudioMode('player')
  }

  const handleSaveTemplateV2 = (tmpl: WorkflowTemplateV2View) => {
    window.forge.template
      .saveV2(tmpl)
      .then((res) => {
        if (res.ok) {
          loadTemplatesV2()
          setEditingTemplate(res.value)
          show({ title: `Saved "${tmpl.name}"`, tone: 'neutral' })
        }
      })
      .catch(() => {
        show({ title: 'Failed to save template', tone: 'danger' })
      })
  }

  const handleDeleteTemplateV2 = (templateId: string) => {
    window.forge.template
      .deleteV2(templateId)
      .then((res) => {
        if (res.ok) {
          loadTemplatesV2()
          show({ title: 'Template deleted', tone: 'neutral' })
        }
      })
      .catch(() => {
        show({ title: 'Failed to delete template', tone: 'danger' })
      })
  }

  const handleCloneTemplateV2 = (tmpl: WorkflowTemplateV2View) => {
    const clone: WorkflowTemplateV2View = {
      ...tmpl,
      id: `tmpl-${Date.now().toString(36)}`,
      name: `${tmpl.name} (Copy)`,
      status: 'draft',
      version: 1,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    handleSaveTemplateV2(clone)
  }

  const handleTogglePublishV2 = (tmpl: WorkflowTemplateV2View) => {
    const nextStatus = tmpl.status === 'published' ? 'draft' : 'published'
    handleSaveTemplateV2({ ...tmpl, status: nextStatus, updatedAt: new Date().toISOString() })
  }

  const handleCreateNewWorkflow = () => {
    const newTmpl: WorkflowTemplateV2View = {
      id: `custom-${Date.now().toString(36)}`,
      name: 'Custom Workflow',
      description: 'A modular multi-agent workflow assembled from Lego pieces.',
      version: 1,
      status: 'draft',
      category: 'General',
      nodes: [
        {
          id: 'agent-1',
          title: 'Requirements Analyst',
          type: 'agent',
          runtimeType: 'forge-native',
          config: {
            skills: ['requirements-analysis'],
            permissionMode: 'read-only',
          },
          inputs: [{ name: 'goal', kind: 'user_prompt', required: true }],
          outputs: [
            {
              name: 'spec',
              kind: 'final_specification',
              format: 'markdown',
              requiredSections: [],
            },
          ],
          position: { x: 100, y: 150 },
        },
      ],
      edges: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }
    setEditingTemplate(newTmpl)
    setStudioMode('canvas')
  }

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
        if (active !== null) {
          if (active.steps.length > 0) {
            const currentRunning = active.steps.find((s: WorkflowStepView) => s.state === 'running')
            if (currentRunning !== undefined) {
              setSelectedStep(currentRunning)
            } else {
              setSelectedStep(active.steps[0] ?? null)
            }
          }

          window.forge.workflow
            .getLogs({ workflowId: active.id })
            .then((logRes) => {
              if (cancelled) return
              const histLogs = unwrap(logRes).logs
              if (histLogs.length > 0) {
                setLogs(
                  histLogs.map((l) => {
                    const logTime = new Date(l.at)
                    return {
                      id: `hist-${String(logTime.getTime())}-${String(Math.random())}`,
                      stepIndex: l.stepIndex,
                      timestamp: logTime.toLocaleTimeString(),
                      text: `[STEP ${String(l.stepIndex)}] ${l.text}`,
                    }
                  }),
                )
              }
            })
            .catch((err: unknown) => {
              console.error('Failed to get historical workflow logs:', err)
            })
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to load active workflow:', err)
      })

    return () => {
      cancelled = true
    }
  }, [project])

  // Periodic heartbeat polling to guarantee real-time UI updates
  useEffect(() => {
    if (project === null) return
    const pId = project.id

    const timer = setInterval(() => {
      window.forge.workflow
        .getActive(pId)
        .then((res) => {
          const active = unwrap(res)
          if (active !== null) {
            setWorkflow((prev) => {
              if (prev === null) return active
              if (
                prev.id !== active.id ||
                prev.state !== active.state ||
                prev.steps.length !== active.steps.length ||
                prev.steps.some((s, idx) => s.state !== active.steps[idx]?.state)
              ) {
                return active
              }
              return prev
            })
          }
        })
        .catch((err: unknown) => {
          console.error('Failed to poll active workflow:', err)
        })
    }, 1500)

    return () => {
      clearInterval(timer)
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
                const refreshed = updated.steps.find(
                  (s: WorkflowStepView) => s.id === selectedStep.id,
                )
                if (refreshed !== undefined) setSelectedStep(refreshed)
              }
            }
          })
          .catch((err: unknown) => {
            console.error('Failed to update workflow:', err)
          })

        window.forge.workflow
          .getLogs({ workflowId: payload.workflowId })
          .then((logRes) => {
            const histLogs = unwrap(logRes).logs
            if (histLogs.length > 0) {
              setLogs(
                histLogs.map((l) => {
                  const logTime = new Date(l.at)
                  return {
                    id: `hist-${String(logTime.getTime())}-${String(Math.random())}`,
                    stepIndex: l.stepIndex,
                    timestamp: logTime.toLocaleTimeString(),
                    text: `[STEP ${String(l.stepIndex)}] ${l.text}`,
                  }
                }),
              )
            }
          })
          .catch((err: unknown) => {
            console.error('Failed to get logs on event:', err)
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
          stepIndex: payload.stepIndex,
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
        if (
          list.length > 0 &&
          !list.some((t: WorkflowTemplateView) => t.id === selectedTemplateId)
        ) {
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

  // Sync workflow artifacts & repository changesets for inline thread blocks
  useEffect(() => {
    if (project === null || workflow === null) {
      return
    }
    let cancelled = false
    const wfId = workflow.id
    const projId = project.id

    Promise.all([
      window.forge.artifacts.listForRun(wfId).then((res) => (res.ok ? res.value.artifacts : [])),
      window.forge.changeset.list(projId).then((res) => (res.ok ? res.value.changeSets : [])),
    ])
      .then(([arts, css]) => {
        if (!cancelled) {
          setArtifacts(arts)
          setChangeSets(css)
        }
      })
      .catch(() => {
        // Non-fatal; thread continues without supplementary artifacts
      })

    return () => {
      cancelled = true
    }
  }, [project, workflow])

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
      clearEvents()
      setInterjections([])
      setWorkflow(started)
      setActiveTaskTitle(data.title)
      setActivePromptObjective(data.objective)
      const now = new Date()
      setLogs([
        {
          id: `init-${String(now.getTime())}`,
          stepIndex: 0,
          timestamp: now.toLocaleTimeString(),
          text: `[START] Task "${data.title}" initiated (${started.templateId})`,
        },
        {
          id: `init-planner-${String(now.getTime())}`,
          stepIndex: 0,
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

  const handleInterject = async (stepIndex: number, text: string): Promise<void> => {
    if (workflow === null) return
    try {
      await window.forge.workflow.interject(workflow.id, stepIndex, text).then(unwrap)
      setInterjections((prev) => [
        ...prev,
        {
          id: `interj-${String(Date.now())}-${String(prev.length)}`,
          text,
          stepIndex,
          at: new Date().toISOString(),
        },
      ])
      show({
        tone: 'neutral',
        title: 'Guidance Sent',
        description: `Delivered inline instruction to Stage ${String(stepIndex + 1)}.`,
      })
    } catch (err: unknown) {
      show({
        tone: 'danger',
        title: 'Could Not Send Guidance',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  const handleOpenArtifact = async (meta: ArtifactMetadataView): Promise<void> => {
    try {
      const lengthBytes = Math.min(Math.max(meta.sizeBytes, 1), 262_144)
      const win = await window.forge.artifacts
        .readWindow({ artifactId: meta.id, offsetBytes: 0, lengthBytes })
        .then(unwrap)
      const bytes = Uint8Array.from(atob(win.data), (c) => c.charCodeAt(0))
      const decoded = new TextDecoder().decode(bytes)
      const format =
        meta.mimeType.includes('markdown') || meta.name.endsWith('.md')
          ? 'markdown'
          : meta.kind === 'diff' || meta.name.endsWith('.diff') || meta.name.endsWith('.patch')
            ? 'diff'
            : meta.mimeType.includes('json') || meta.name.endsWith('.json')
              ? 'json'
              : 'text'
      setViewingArtifact({
        id: meta.id,
        workflowId: meta.runId,
        nodeId: meta.stepId ?? 'workflow',
        kind: meta.kind,
        format,
        title: meta.name,
        content: decoded,
        metadata: {
          relativePath: meta.relativePath,
          sha256: meta.sha256,
          sizeBytes: meta.sizeBytes,
        },
        createdAt: meta.createdAt,
      })
    } catch (err: unknown) {
      show({
        tone: 'danger',
        title: 'Could Not Open Artifact',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    }
  }

  const handleStartNextCycle = async (objective: string): Promise<void> => {
    await handleStartWorkflow({
      templateId: workflow?.templateId ?? selectedTemplateId,
      title: activeTaskTitle ?? 'Follow-up Iteration',
      objective,
    })
  }

  const handleSwitchRoleRuntime = async (role: string, runtimeId: string): Promise<void> => {
    if (project === null) return
    try {
      await window.forge.binding.set(project.id, role, runtimeId).then(unwrap)
      const updated = await window.forge.binding.list(project.id).then(unwrap)
      setBindings(updated)
      show({
        tone: 'success',
        title: 'Agent Binding Updated',
        description: `Assigned ${runtimeId} to ${role} for this project.`,
      })
    } catch (err: unknown) {
      show({
        tone: 'danger',
        title: 'Could Not Update Binding',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
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
      // Satisfy Axiom A4 by ensuring at least one approved/locked decision exists
      const existingDecisionsRes = await window.forge.decision.list(project.id)
      const existingDecisions = unwrap(existingDecisionsRes)
      const hasLocked = existingDecisions.decisions.some(
        (d) => d.status === 'locked' || d.status === 'approved',
      )
      if (!hasLocked) {
        const proposedRes = await window.forge.decision.propose({
          projectId: project.id,
          statement: `Execute architectural blueprint for task ${workflow.taskId}`,
          rationale: 'User approved planning blueprint in Stage 2 Human Review Gate.',
        })
        const proposed = unwrap(proposedRes)
        await window.forge.decision.approve(proposed.id)
        await window.forge.decision.lock(proposed.id)
      }

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

  const isAwaitingApproval =
    workflow !== null &&
    !isTerminal &&
    (workflow.state === 'PLAN_READY' ||
      workflow.state === 'AWAITING_APPROVAL' ||
      workflow.state === 'AWAITING_USER')

  const isDiscussionMode =
    workflow !== null &&
    (workflow.state === 'DISCOVERY' ||
      workflow.state === 'PLANNING' ||
      workflow.state === 'PLAN_READY' ||
      workflow.state === 'AWAITING_APPROVAL' ||
      workflow.state === 'AWAITING_USER')

  const status: 'idle' | 'running' | 'waiting' | 'passed' | 'failed' =
    workflow === null
      ? 'idle'
      : workflow.state === 'DONE'
        ? 'passed'
        : workflow.state === 'CANCELLED' || workflow.state.startsWith('HALTED')
          ? 'failed'
          : workflow.state === 'AWAITING_USER' ||
              workflow.state === 'AWAITING_APPROVAL' ||
              workflow.state === 'PLAN_READY'
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
      if (existing !== undefined) {
        let dynamicState = existing.state
        if (existing.finishedAt === null) {
          if (
            (workflow.state === 'PLANNING' && existing.role === 'planner') ||
            (workflow.state === 'IMPLEMENTING' && existing.role === 'implementer') ||
            (workflow.state === 'VERIFYING' && existing.role === 'system') ||
            (workflow.state === 'REVIEWING' && existing.role === 'reviewer')
          ) {
            dynamicState = 'running'
          } else if (
            (workflow.state === 'PLAN_READY' ||
              workflow.state === 'AWAITING_APPROVAL' ||
              workflow.state === 'AWAITING_USER') &&
            existing.role === 'user'
          ) {
            dynamicState = 'awaiting_user'
          }
        }
        return { ...existing, state: dynamicState }
      }

      // Bound runtime fallback for pending steps
      const boundRuntime =
        bindings?.roles.find((r) => r.role === tmplStep.role)?.binding?.runtimeId ?? null

      let dynamicState: 'pending' | 'running' | 'awaiting_user' = 'pending'
      if (
        (workflow.state === 'PLANNING' && tmplStep.role === 'planner') ||
        (workflow.state === 'IMPLEMENTING' && tmplStep.role === 'implementer') ||
        (workflow.state === 'VERIFYING' && tmplStep.role === 'system') ||
        (workflow.state === 'REVIEWING' && tmplStep.role === 'reviewer')
      ) {
        dynamicState = 'running'
      } else if (
        (workflow.state === 'PLAN_READY' ||
          workflow.state === 'AWAITING_APPROVAL' ||
          workflow.state === 'AWAITING_USER') &&
        tmplStep.role === 'user'
      ) {
        dynamicState = 'awaiting_user'
      }

      return {
        id: `pending-step-${String(idx)}`,
        index: idx,
        role: tmplStep.role,
        runtimeId: boundRuntime,
        simulated: false,
        state: dynamicState,
        contextRef: null,
        reportStatus: null,
        verdict: null,
        changeSetId: null,
        startedAt: null,
        finishedAt: null,
      }
    })
  })()

  const effectiveSelectedStep =
    selectedStep ??
    stageSteps.find((s) => s.state === 'running') ??
    stageSteps.find((s) => s.state === 'awaiting_user') ??
    stageSteps[0] ??
    null

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

  // When no active workflow is executing: Render Visual Studio (Catalog or Canvas)
  if (workflow === null) {
    if (studioMode === 'canvas' && editingTemplate !== null) {
      return (
        <>
          <WorkflowCanvas
            template={editingTemplate}
            onBack={() => {
              setStudioMode('catalog')
            }}
            onSave={handleSaveTemplateV2}
            onRun={handleRunV2Workflow}
            onSelectArtifact={(art) => {
              setViewingArtifact(art)
            }}
          />
          {viewingArtifact && (
            <WorkflowArtifactViewer
              artifact={viewingArtifact}
              onClose={() => {
                setViewingArtifact(null)
              }}
            />
          )}
        </>
      )
    }

    return (
      <div className="flex h-full flex-col overflow-hidden">
        <WorkflowCatalogView
          templates={templatesV2}
          onOpenInCanvas={(tmpl) => {
            setEditingTemplate(tmpl)
            setStudioMode('canvas')
          }}
          onRunWorkflow={handleRunV2Workflow}
          onCreateNewWorkflow={handleCreateNewWorkflow}
          onCloneWorkflow={handleCloneTemplateV2}
          onDeleteWorkflow={handleDeleteTemplateV2}
          onTogglePublish={handleTogglePublishV2}
          onStartWorkflow={() => {
            void handleStartWorkflow({
              title: 'Automated Task',
              objective: 'Execute end-to-end SDLC workflow with multi-agent orchestration.',
              templateId: selectedTemplateId,
            })
          }}
        />

        {/* Start New Work / Requirements Modal */}
        <StartWorkflowDialog
          open={startDialogOpen}
          templates={allTemplates}
          selectedTemplateId={selectedTemplateId}
          onSelectTemplate={setSelectedTemplateId}
          onCreateCustomTemplate={() => {
            handleCreateNewWorkflow()
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

        {viewingArtifact && (
          <WorkflowArtifactViewer
            artifact={viewingArtifact}
            onClose={() => {
              setViewingArtifact(null)
            }}
          />
        )}
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
            Repository: <span className="font-semibold text-(--color-text)">{project.name}</span>
          </p>
        </div>

        {/* Action Buttons with clear borders and styling */}
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setStudioMode('catalog')
              setWorkflow(null)
            }}
            className="h-8 text-[12px] text-(--color-text-muted) hover:text-(--color-text)"
          >
            ← Catalog
          </Button>
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
            size="sm"
            onClick={() => {
              void handleExportReport()
            }}
          >
            <Icon name="download" className="size-3.5" />
            <span>Export Report</span>
          </Button>

          <Button
            variant={inspectorOpen ? 'secondary' : 'ghost'}
            size="sm"
            onClick={() => {
              setInspectorOpen((cur) => !cur)
            }}
          >
            <Icon name="panel-right" className="size-3.5" />
            <span>{inspectorOpen ? 'Hide inspector' : 'Inspector'}</span>
          </Button>
        </div>
      </div>

      {/* 2. CONTINUOUS THREAD-NATIVE EXECUTION WORKSPACE + TOGGLEABLE STAGE INSPECTOR */}
      <div className="flex min-h-0 flex-1 gap-3 overflow-hidden">
        <ThreadContainer
          projectId={project.id}
          repositoryPath={project.repository.absolutePath}
          workflowId={workflow.id}
          templateId={workflow.templateId}
          iteration={workflow.iteration}
          maxIterations={workflow.limits.maxIterations}
          status={status}
          statusLabel={
            workflow.state.startsWith('HALTED')
              ? `Halted: ${workflow.haltReason ?? 'Policy violation or agent exit'}`
              : describeWorkflowState(workflow)
          }
          isDiscussionMode={isDiscussionMode}
          isTerminal={isTerminal}
          isAwaitingApproval={isAwaitingApproval}
          stageSteps={stageSteps}
          selectedStep={effectiveSelectedStep}
          entries={buildThreadEntries({
            workflow,
            stageSteps,
            taskTitle: activeTaskTitle,
            promptObjective: activePromptObjective,
            toolTimeline,
            stepStreams,
            artifacts,
            changeSets,
            logs,
            interjections,
          })}
          bindings={bindings}
          actionInProgress={actionInProgress}
          onSelectStep={(step) => {
            setSelectedStep(step)
            setInspectorOpen(true)
          }}
          onOpenArtifact={(artifact) => {
            void handleOpenArtifact(artifact)
          }}
          onInterject={handleInterject}
          onStartNextCycle={handleStartNextCycle}
          onSwitchRoleRuntime={handleSwitchRoleRuntime}
          onApproveAndImplement={handleApproveAndImplement}
        />

        {inspectorOpen && effectiveSelectedStep !== null ? (
          <div className="hidden w-96 shrink-0 flex-col overflow-hidden lg:flex">
            <StepInspector
              step={effectiveSelectedStep}
              tools={filterToolTimelineByStep(toolTimeline, effectiveSelectedStep.index)}
              onClose={() => {
                setInspectorOpen(false)
              }}
            />
          </div>
        ) : null}
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

      {viewingArtifact && (
        <WorkflowArtifactViewer
          artifact={viewingArtifact}
          onClose={() => {
            setViewingArtifact(null)
          }}
        />
      )}
    </div>
  )
}
