import { useEffect, useRef, useState } from 'react'
import type { ArtifactMetadataView, WorkflowStepView } from '@shared/ipc'
import { AlertBanner, Badge, Button, Card, Icon, cn } from '@renderer/ui'
import { AgentTurnRow } from './AgentTurnRow'
import { ThreadApprovalCard, ThreadDecisionCard, ThreadQuestionCard } from './ThreadGateCards'
import type { ThreadEntry } from './threadProjection'

export interface ThreadMessageListProps {
  readonly entries: readonly ThreadEntry[]
  readonly projectId: string
  readonly workflowId: string
  readonly repositoryPath: string
  readonly fullWidth: boolean
  readonly scrollRef?: React.RefObject<HTMLDivElement | null> | undefined
  readonly waitingTargetId?: string | null | undefined
  readonly submittingQuestionId?: string | null | undefined
  readonly actionInProgress?: boolean | undefined
  readonly onWaitingVisibilityChange?: ((visible: boolean) => void) | undefined
  readonly onInspectStep: (step: WorkflowStepView) => void
  readonly onOpenArtifact: (artifact: ArtifactMetadataView) => void
  readonly onAnswerQuestion?:
    ((questionId: string, answer: string, lockAsDecision: boolean) => Promise<void>) | undefined
  readonly onApproveDecision?: ((decisionId: string) => Promise<void>) | undefined
  readonly onLockDecision?: ((decisionId: string) => Promise<void>) | undefined
  readonly onSupersedeDecision?:
    | ((
        decisionId: string,
        replacementStatement: string,
        replacementRationale: string,
      ) => Promise<void>)
    | undefined
  readonly onProposeDecision?:
    ((statement: string, rationale: string, lockImmediately: boolean) => Promise<void>) | undefined
  readonly onApproveAndImplement?: (() => Promise<void>) | undefined
}

const NOOP_PROMISE = (): Promise<void> => Promise.resolve()

/**
 * Chronological continuous scroll stream uniting user prompts, active and
 * completed agent turns, inline Q&A/decision gates, interjections, and system transitions.
 */
export function ThreadMessageList({
  entries,
  projectId,
  workflowId,
  repositoryPath,
  fullWidth,
  scrollRef: externalScrollRef,
  waitingTargetId = null,
  submittingQuestionId = null,
  actionInProgress = false,
  onWaitingVisibilityChange,
  onInspectStep,
  onOpenArtifact,
  onAnswerQuestion,
  onApproveDecision,
  onLockDecision,
  onSupersedeDecision,
  onProposeDecision,
  onApproveAndImplement,
}: ThreadMessageListProps): React.JSX.Element {
  const internalScrollRef = useRef<HTMLDivElement | null>(null)
  const scrollRef = externalScrollRef ?? internalScrollRef
  const [pinnedToBottom, setPinnedToBottom] = useState(true)

  useEffect(() => {
    const el = scrollRef.current
    if (el !== null && pinnedToBottom) {
      el.scrollTop = el.scrollHeight
    }
  }, [entries, pinnedToBottom, scrollRef])

  useEffect(() => {
    if (onWaitingVisibilityChange === undefined) return
    if (waitingTargetId === null) {
      onWaitingVisibilityChange(true)
      return
    }
    const container = scrollRef.current
    if (container === null) return
    const targetEl = container.querySelector<HTMLElement>(`[data-waiting-id="${waitingTargetId}"]`)
    if (targetEl === null) return

    if (typeof IntersectionObserver === 'undefined') {
      onWaitingVisibilityChange(pinnedToBottom)
      return
    }

    const observer = new IntersectionObserver(
      (records) => {
        const entry = records[0]
        if (entry !== undefined) {
          onWaitingVisibilityChange(entry.isIntersecting)
        }
      },
      { root: container, threshold: 0.15 },
    )
    observer.observe(targetEl)
    return () => {
      observer.disconnect()
    }
  }, [waitingTargetId, pinnedToBottom, onWaitingVisibilityChange, scrollRef])

  const handleScroll = (): void => {
    const el = scrollRef.current
    if (el === null) return
    const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
    setPinnedToBottom(distanceFromBottom < 64)
  }

  const jumpToBottom = (): void => {
    const el = scrollRef.current
    if (el !== null) {
      el.scrollTop = el.scrollHeight
      setPinnedToBottom(true)
    }
  }

  return (
    <div className="relative min-h-0 flex-1 overflow-hidden">
      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className="h-full overflow-y-auto px-4 py-4 sm:px-6"
      >
        <div
          className={cn(
            'flex flex-col gap-3.5 transition-[max-width] duration-(--duration-base) ease-(--ease-out)',
            fullWidth ? 'w-full' : 'mx-auto max-w-(--reading-column-max)',
          )}
        >
          {entries.map((entry) => {
            if (entry.kind === 'user_prompt') {
              return (
                <Card
                  key={entry.id}
                  tone="raised"
                  className="border-(--color-edge-strong)/60 bg-(--color-surface-raised) p-4"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 pb-2">
                    <div className="flex items-center gap-2">
                      <Badge tone="accent" size="sm">
                        Prompt
                      </Badge>
                      <span className="typography-ui-label font-semibold text-(--color-text)">
                        {entry.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge tone="neutral" size="sm" className="font-mono">
                        {entry.templateId}
                      </Badge>
                      <span className="font-mono typography-micro text-(--color-text-subtle)">
                        Cycle {String(entry.iteration + 1)}
                      </span>
                    </div>
                  </div>
                  <p
                    className="m-0 typography-meta leading-relaxed text-(--color-text-muted)"
                    data-selectable
                  >
                    {entry.body}
                  </p>
                </Card>
              )
            }

            if (entry.kind === 'question_gate') {
              return (
                <ThreadQuestionCard
                  key={entry.id}
                  waitingId={entry.id}
                  question={entry.question}
                  blocking={entry.blocking}
                  isSubmitting={submittingQuestionId === entry.question.id}
                  onAnswer={onAnswerQuestion ?? NOOP_PROMISE}
                />
              )
            }

            if (entry.kind === 'decision_gate') {
              return (
                <ThreadDecisionCard
                  key={entry.id}
                  waitingId={entry.id}
                  decision={entry.decision}
                  isSubmitting={actionInProgress}
                  onApprove={onApproveDecision ?? NOOP_PROMISE}
                  onLock={onLockDecision ?? NOOP_PROMISE}
                  onSupersede={onSupersedeDecision ?? NOOP_PROMISE}
                />
              )
            }

            if (entry.kind === 'approval_gate') {
              return (
                <ThreadApprovalCard
                  key={entry.id}
                  waitingId={entry.id}
                  planBlueprint={entry.planBlueprint}
                  planArtifact={entry.planArtifact}
                  hasLockedDecision={entry.hasLockedDecision}
                  openQuestionCount={entry.openQuestionCount}
                  actionInProgress={actionInProgress}
                  onOpenArtifact={onOpenArtifact}
                  onApproveAndImplement={onApproveAndImplement ?? NOOP_PROMISE}
                  onProposeDecision={onProposeDecision ?? NOOP_PROMISE}
                />
              )
            }

            if (entry.kind === 'user_followup') {
              return (
                <div key={entry.id} className="flex justify-end">
                  <div className="max-w-xl rounded-(--radius-xl) border border-(--color-accent)/30 bg-(--color-accent-muted)/60 px-3.5 py-2.5 text-(--color-text)">
                    <div className="flex items-center gap-2 pb-1 typography-micro text-(--color-accent)">
                      <Icon name="send" className="size-3" />
                      <span className="font-semibold">
                        Operator Guidance (Stage {String(entry.stepIndex + 1)})
                      </span>
                    </div>
                    <p className="m-0 typography-meta whitespace-pre-wrap" data-selectable>
                      {entry.text}
                    </p>
                  </div>
                </div>
              )
            }

            if (entry.kind === 'system_event') {
              return (
                <AlertBanner
                  key={entry.id}
                  tone={entry.tone}
                  title={entry.title}
                  description={entry.detail}
                />
              )
            }

            return (
              <AgentTurnRow
                key={entry.id}
                entry={entry}
                projectId={projectId}
                workflowId={workflowId}
                repositoryPath={repositoryPath}
                onInspectStep={onInspectStep}
                onOpenArtifact={onOpenArtifact}
              />
            )
          })}
        </div>
      </div>

      {!pinnedToBottom ? (
        <div className="pointer-events-none absolute right-6 bottom-3 flex justify-end">
          <Button
            size="xs"
            variant="secondary"
            onClick={jumpToBottom}
            className="pointer-events-auto shadow-(--elevation-floating)"
          >
            <Icon name="chevron-down" className="size-3.5" />
            <span>Jump to latest</span>
          </Button>
        </div>
      ) : null}
    </div>
  )
}
