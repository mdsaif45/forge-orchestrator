import { useEffect, useState } from 'react'
import type { DecisionView } from '@shared/ipc'
import { unwrap } from '../ipc'
import {
  Button,
  DecisionCard,
  Dialog,
  EmptyState,
  Field,
  Input,
  ScrollArea,
  Tabs,
  Textarea,
  useToast,
} from '../ui'
import { DecisionsIcon } from './icons'
import { useProjectStore } from './projectStore'

export function DecisionsPage(): React.JSX.Element {
  const { show } = useToast()
  const projects = useProjectStore((state) => state.projects)
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId)

  const [decisions, setDecisions] = useState<readonly DecisionView[]>([])
  const [tab, setTab] = useState<'all' | 'locked' | 'proposed' | 'superseded'>('all')
  const [reloadTrigger, setReloadTrigger] = useState(0)
  const [isProposeOpen, setIsProposeOpen] = useState(false)
  const [newStatement, setNewStatement] = useState('')
  const [newRationale, setNewRationale] = useState('')
  const [isSubmitting, setIsSubmitting] = useState(false)

  useEffect(() => {
    let cancelled = false

    if (selectedProjectId !== null) {
      window.forge.decision
        .list(selectedProjectId)
        .then((res) => {
          if (!cancelled) {
            setDecisions(unwrap(res).decisions)
          }
        })
        .catch((err: unknown) => {
          console.error('Failed to load decisions:', err)
        })
    } else {
      Promise.all(projects.map((p) => window.forge.decision.list(p.id).then(unwrap)))
        .then((results) => {
          if (!cancelled) {
            const all: DecisionView[] = []
            for (const res of results) {
              all.push(...res.decisions)
            }
            setDecisions(all)
          }
        })
        .catch((err: unknown) => {
          console.error('Failed to load decisions:', err)
        })
    }

    const unsubscribe = window.forge.onWorkflowEvent(() => {
      setReloadTrigger((prev) => prev + 1)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [projects, selectedProjectId, reloadTrigger])

  const handleApprove = async (decisionId: string): Promise<void> => {
    setIsSubmitting(true)
    try {
      await window.forge.decision.approve(decisionId).then(unwrap)
      show({
        tone: 'success',
        title: 'Decision Approved',
        description: 'The decision is approved and ready to be locked.',
      })
      setReloadTrigger((prev) => prev + 1)
    } catch (err) {
      show({
        tone: 'danger',
        title: 'Failed to approve decision',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleLock = async (decisionId: string): Promise<void> => {
    setIsSubmitting(true)
    try {
      await window.forge.decision.lock(decisionId).then(unwrap)
      show({
        tone: 'success',
        title: 'Decision Locked (Axiom A4)',
        description:
          'This decision is now binding and will be injected into all future agent prompts.',
      })
      setReloadTrigger((prev) => prev + 1)
    } catch (err) {
      show({
        tone: 'danger',
        title: 'Failed to lock decision',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleSupersede = async (
    decisionId: string,
    replacementStatement: string,
    replacementRationale: string,
  ): Promise<void> => {
    setIsSubmitting(true)
    try {
      await window.forge.decision
        .supersede({
          decisionId,
          replacementStatement,
          replacementRationale,
        })
        .then(unwrap)
      show({
        tone: 'success',
        title: 'Architecture Change Request Approved',
        description: 'Prior decision superseded. Replacement decision is now locked.',
      })
      setReloadTrigger((prev) => prev + 1)
    } catch (err) {
      show({
        tone: 'danger',
        title: 'Failed to supersede decision',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const handleProposeSubmit = async (): Promise<void> => {
    if (!newStatement.trim() || !newRationale.trim()) return

    const targetProjectId = selectedProjectId ?? projects.at(0)?.id
    if (targetProjectId === undefined) {
      show({
        tone: 'danger',
        title: 'No Project Selected',
        description: 'Create or select a project before proposing decisions.',
      })
      return
    }

    setIsSubmitting(true)
    try {
      await window.forge.decision
        .propose({
          projectId: targetProjectId,
          statement: newStatement.trim(),
          rationale: newRationale.trim(),
        })
        .then(unwrap)
      show({
        tone: 'success',
        title: 'Decision Proposed',
        description: 'Your proposed architectural decision has been recorded.',
      })
      setIsProposeOpen(false)
      setNewStatement('')
      setNewRationale('')
      setReloadTrigger((prev) => prev + 1)
    } catch (err) {
      show({
        tone: 'danger',
        title: 'Failed to propose decision',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsSubmitting(false)
    }
  }

  const locked = decisions.filter((d) => d.status === 'locked')
  const proposed = decisions.filter((d) => d.status === 'proposed')
  const superseded = decisions.filter((d) => d.status === 'superseded')

  const displayed =
    tab === 'locked'
      ? locked
      : tab === 'proposed'
        ? proposed
        : tab === 'superseded'
          ? superseded
          : decisions

  const projectMap = new Map(projects.map((p) => [p.id, p.name]))

  return (
    <div className="flex h-full flex-col overflow-hidden bg-(--color-canvas)">
      {/* Header */}
      <header className="flex shrink-0 flex-col gap-3 border-b border-(--color-border) bg-(--color-surface) p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-(length:--text-xl) font-bold text-(--color-text)">Decisions</h1>
          <p className="text-(length:--text-xs) text-(--color-text-muted)">
            Decisions you approve become locked. An agent cannot change a locked decision without
            asking you first.
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Tabs<'all' | 'locked' | 'proposed' | 'superseded'>
            aria-label="Decision filter tabs"
            items={[
              { value: 'all', label: `All (${String(decisions.length)})` },
              { value: 'locked', label: `Locked (${String(locked.length)})` },
              { value: 'proposed', label: `Proposed (${String(proposed.length)})` },
              { value: 'superseded', label: `Superseded (${String(superseded.length)})` },
            ]}
            value={tab}
            onChange={(val) => {
              setTab(val)
            }}
          />

          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setIsProposeOpen(true)
            }}
          >
            + Propose Decision
          </Button>
        </div>
      </header>

      {/* Main Content List */}
      <ScrollArea className="flex-1 p-4">
        {displayed.length === 0 ? (
          <EmptyState
            icon={<DecisionsIcon />}
            title={tab === 'locked' ? 'No locked decisions' : 'No decisions recorded'}
            description={
              tab === 'locked'
                ? 'No architectural choices have been locked yet. When approved, locked decisions become binding constraints for agents.'
                : 'Decisions you approve become locked. An agent cannot change a locked decision without asking you first.'
            }
          />
        ) : (
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            {displayed.map((d) => (
              <DecisionCard
                key={d.id}
                decision={d}
                projectName={d.projectId !== undefined ? projectMap.get(d.projectId) : undefined}
                isSubmitting={isSubmitting}
                onApprove={(id) => {
                  void handleApprove(id)
                }}
                onLock={(id) => {
                  void handleLock(id)
                }}
                onSupersede={(id, stmt, rat) => {
                  void handleSupersede(id, stmt, rat)
                }}
              />
            ))}
          </div>
        )}
      </ScrollArea>

      {/* Propose Decision Dialog */}
      <Dialog
        open={isProposeOpen}
        onClose={() => {
          setIsProposeOpen(false)
        }}
        title="Propose Architectural Decision"
        description="Record an architectural choice and its justification. You can lock it to make it binding on all agents."
      >
        <div className="flex flex-col gap-4 p-4">
          <Field label="Decision Statement" required>
            {(bind) => (
              <Input
                {...bind}
                placeholder="e.g. Use SQLite in WAL mode for persistent local storage"
                value={newStatement}
                onChange={(e) => {
                  setNewStatement(e.target.value)
                }}
              />
            )}
          </Field>
          <Field label="Rationale & Justification" required>
            {(bind) => (
              <Textarea
                {...bind}
                rows={3}
                placeholder="Why this choice was selected over alternatives..."
                value={newRationale}
                onChange={(e) => {
                  setNewRationale(e.target.value)
                }}
              />
            )}
          </Field>
          <div className="flex items-center justify-end gap-2 pt-2">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setIsProposeOpen(false)
              }}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              disabled={!newStatement.trim() || !newRationale.trim() || isSubmitting}
              onClick={() => {
                void handleProposeSubmit()
              }}
            >
              Record Proposal
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  )
}
