import { useEffect, useMemo, useState } from 'react'
import type { WorkflowDetailView } from '@shared/ipc'
import { unwrap } from '../ipc'
import {
  ActionToolbar,
  Badge,
  Button,
  EmptyState,
  Icon,
  MarkdownRenderer,
  ScrollArea,
  Textarea,
  useToast,
  type ToolbarAction,
} from '../ui'
import { useOverviewStore } from './overviewStore'
import { useProjectStore } from './projectStore'

interface ResolvedPlan {
  readonly title: string
  readonly sourceLabel: string
  readonly content: string
  readonly workflow: WorkflowDetailView | null
}

function extractHeadings(markdown: string): readonly string[] {
  const headings: string[] = []
  for (const line of markdown.split('\n')) {
    const match = /^#{1,3}\s+(.+)$/.exec(line.trim())
    if (match?.[1] !== undefined) {
      headings.push(match[1].trim())
    }
  }
  return headings
}

/**
 * Execution Drawer Plan Viewer (`planning.md`):
 * automatically surfaces generated planning artifacts and planner step blueprints
 * with ActionToolbar controls for copy, approval, and inline revision.
 */
export function DrawerPlanView(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const projectId = detail?.project.id ?? null
  const sessionArtifacts = useOverviewStore((state) => state.artifacts)
  const setHasUnreadPlan = useOverviewStore((state) => state.setHasUnreadPlan)
  const { show } = useToast()

  const [resolvedPlan, setResolvedPlan] = useState<ResolvedPlan | null>(null)
  const [copied, setCopied] = useState(false)
  const [revising, setRevising] = useState(false)
  const [revisionNote, setRevisionNote] = useState('')
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (projectId === null) return
    let cancelled = false

    const loadPlan = async (): Promise<void> => {
      try {
        const activeWf = await window.forge.workflow.getActive(projectId).then(unwrap)
        if (activeWf !== null) {
          const artsRes = await window.forge.artifacts.listForRun(activeWf.id).then(unwrap)
          const planArtifact =
            artsRes.artifacts.find(
              (a) => a.kind === 'plan' || a.name.toLowerCase().includes('planning'),
            ) ?? null

          if (planArtifact !== null) {
            const win = await window.forge.artifacts
              .readWindow({
                artifactId: planArtifact.id,
                offsetBytes: 0,
                lengthBytes: Math.min(Math.max(planArtifact.sizeBytes, 1), 262_144),
              })
              .then(unwrap)
            const bytes = Uint8Array.from(atob(win.data), (c) => c.charCodeAt(0))
            const decoded = new TextDecoder().decode(bytes)
            if (!cancelled) {
              setResolvedPlan({
                title: planArtifact.name,
                sourceLabel: `Workflow ${activeWf.templateId}`,
                content: decoded,
                workflow: activeWf,
              })
              setHasUnreadPlan(false)
            }
            return
          }

          const plannerStep = activeWf.steps.find((s) => s.role === 'planner')
          if (plannerStep?.reportStatus !== null && plannerStep?.reportStatus !== undefined) {
            if (!cancelled) {
              setResolvedPlan({
                title: 'planning.md',
                sourceLabel: 'Planner Blueprint',
                content: plannerStep.reportStatus,
                workflow: activeWf,
              })
              setHasUnreadPlan(false)
            }
            return
          }
        }
      } catch {
        // Fall back to session artifacts below
      }

      const sessionPlan =
        sessionArtifacts.find((a) => a.type === 'plan' || a.name.toLowerCase().includes('plan')) ??
        null
      if (!cancelled) {
        setResolvedPlan(
          sessionPlan === null
            ? null
            : {
                title: sessionPlan.name,
                sourceLabel: 'Session Artifact',
                content: sessionPlan.content ?? sessionPlan.summary ?? `# ${sessionPlan.name}`,
                workflow: null,
              },
        )
      }
    }

    void loadPlan()
    const unsub = window.forge.onWorkflowEvent(() => {
      void loadPlan()
    })
    return () => {
      cancelled = true
      unsub()
    }
  }, [projectId, sessionArtifacts, setHasUnreadPlan])

  const headings = useMemo(
    () => (resolvedPlan === null ? [] : extractHeadings(resolvedPlan.content)),
    [resolvedPlan],
  )

  const handleCopy = (): void => {
    if (resolvedPlan === null) return
    void window.forge.clipboard
      .writeText(resolvedPlan.content)
      .then(() => {
        setCopied(true)
        setTimeout(() => {
          setCopied(false)
        }, 1500)
      })
      .catch(() => {
        show({ tone: 'danger', title: 'Failed to copy plan' })
      })
  }

  const handleApproveAndImplement = async (): Promise<void> => {
    const wf = resolvedPlan?.workflow
    if (wf === null || wf === undefined || projectId === null) return
    setSubmitting(true)
    try {
      const existing = await window.forge.decision.list(projectId).then(unwrap)
      const hasLocked = existing.decisions.some(
        (d) => d.status === 'locked' || d.status === 'approved',
      )
      if (!hasLocked) {
        const proposed = await window.forge.decision
          .propose({
            projectId,
            statement: `Execute approved planning blueprint (${wf.taskId})`,
            rationale: 'Approved directly from execution drawer planning.md view.',
          })
          .then(unwrap)
        await window.forge.decision.approve(proposed.id).then(unwrap)
        await window.forge.decision.lock(proposed.id).then(unwrap)
      }
      await window.forge.workflow.approveAndStartImplementation(wf.id).then(unwrap)
      show({
        tone: 'success',
        title: 'Entered Implementation Mode',
        description: 'Plan approved and decisions locked per Axiom A4.',
      })
    } catch (err: unknown) {
      show({
        tone: 'danger',
        title: 'Approval Blocked',
        description: err instanceof Error ? err.message : 'Unable to approve plan',
      })
    } finally {
      setSubmitting(false)
    }
  }

  const handleSubmitRevision = async (): Promise<void> => {
    const wf = resolvedPlan?.workflow
    const note = revisionNote.trim()
    if (wf === null || wf === undefined || note.length === 0) return
    setSubmitting(true)
    try {
      const activeIdx = wf.steps.find((s) => s.state === 'running')?.index ?? 0
      await window.forge.workflow.interject(wf.id, activeIdx, note).then(unwrap)
      setRevisionNote('')
      setRevising(false)
      show({ tone: 'success', title: 'Revision instruction sent to planner thread' })
    } catch (err: unknown) {
      show({
        tone: 'danger',
        title: 'Failed to send revision',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setSubmitting(false)
    }
  }

  if (resolvedPlan === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          icon={<Icon name="plan" className="size-6 text-(--color-text-subtle)" />}
          title="No planning.md generated yet"
          description="Start a planning workflow to stream and review architectural blueprints directly here."
        />
      </div>
    )
  }

  const canApprove =
    resolvedPlan.workflow !== null &&
    (resolvedPlan.workflow.state === 'PLAN_READY' ||
      resolvedPlan.workflow.state === 'AWAITING_APPROVAL' ||
      resolvedPlan.workflow.state === 'AWAITING_USER')

  const toolbarActions: readonly ToolbarAction[] = [
    {
      id: 'copy-plan',
      label: copied ? 'Copied' : 'Copy',
      icon: 'copy',
      done: copied,
      onSelect: handleCopy,
    },
    ...(resolvedPlan.workflow !== null
      ? [
          {
            id: 'revise-plan',
            label: 'Iterate on Plan',
            icon: 'sparkles' as const,
            pressed: revising,
            onSelect: () => {
              setRevising((cur) => !cur)
            },
          },
        ]
      : []),
    ...(canApprove
      ? [
          {
            id: 'approve-plan',
            label: 'Approve & Implement',
            icon: 'lock' as const,
            disabled: submitting,
            onSelect: () => {
              void handleApproveAndImplement()
            },
          },
        ]
      : []),
  ]

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-(--color-edge-muted) bg-(--color-surface-raised)/50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="plan" className="size-3.5 text-(--color-accent)" />
          <span className="truncate font-mono typography-meta font-semibold text-(--color-text)">
            {resolvedPlan.title}
          </span>
          <Badge tone="neutral" size="sm">
            {resolvedPlan.sourceLabel}
          </Badge>
        </div>

        <ActionToolbar actions={toolbarActions} showLabels />
      </div>

      {revising ? (
        <div className="border-b border-(--color-edge-muted) bg-(--color-surface-inset) p-3 space-y-2">
          <Textarea
            aria-label="Plan revision instructions"
            rows={2}
            value={revisionNote}
            onChange={(e) => {
              setRevisionNote(e.target.value)
            }}
            placeholder="Describe adjustments needed in this plan..."
          />
          <div className="flex justify-end gap-2">
            <Button
              size="xs"
              variant="ghost"
              onClick={() => {
                setRevising(false)
              }}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              variant="primary"
              disabled={revisionNote.trim().length === 0 || submitting}
              onClick={() => {
                void handleSubmitRevision()
              }}
            >
              Send revision
            </Button>
          </div>
        </div>
      ) : null}

      {headings.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1 border-b border-(--color-edge-muted) px-3 py-1.5">
          {headings.slice(0, 6).map((heading, idx) => (
            <Badge key={`${heading}-${String(idx)}`} tone="neutral" size="sm">
              {heading}
            </Badge>
          ))}
        </div>
      ) : null}

      <ScrollArea className="flex-1 p-4">
        <div className="prose prose-invert max-w-none" data-selectable>
          <MarkdownRenderer content={resolvedPlan.content} />
        </div>
      </ScrollArea>
    </div>
  )
}
