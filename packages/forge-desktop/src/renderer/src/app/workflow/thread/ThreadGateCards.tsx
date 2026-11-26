import { useState } from 'react'
import type { ArtifactMetadataView, DecisionView, OpenQuestionView } from '@shared/ipc'
import {
  Badge,
  Button,
  Card,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DecisionCard,
  Field,
  Icon,
  Input,
  MarkdownRenderer,
  QuestionCard,
  Textarea,
  cn,
} from '@renderer/ui'

export function ThreadQuestionCard({
  waitingId,
  question,
  blocking,
  isSubmitting,
  onAnswer,
}: {
  readonly waitingId: string
  readonly question: OpenQuestionView
  readonly blocking: boolean
  readonly isSubmitting: boolean
  readonly onAnswer: (questionId: string, answer: string, lockAsDecision: boolean) => Promise<void>
}): React.JSX.Element {
  const isAnswered = question.answer !== null
  const [open, setOpen] = useState(!isAnswered)

  if (!isAnswered) {
    return (
      <div
        data-waiting-id={waitingId}
        className={cn(
          'rounded-(--radius-xl)',
          blocking && 'ring-1 ring-(--color-warning)/50 shadow-(--elevation-raised)',
        )}
      >
        <QuestionCard
          question={question}
          isSubmitting={isSubmitting}
          onAnswer={(answer, lockAsDecision) => {
            void onAnswer(question.id, answer, lockAsDecision)
          }}
        />
      </div>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        data-waiting-id={waitingId}
        className="rounded-(--radius-lg) border border-(--color-edge) bg-(--color-surface-raised)"
      >
        <CollapsibleTrigger className="px-3.5 py-2 typography-meta text-(--color-text-muted) hover:text-(--color-text)">
          <span className="flex min-w-0 items-center gap-2">
            <Icon name="status-pass" className="size-3.5 text-(--color-success)" />
            <span className="truncate font-medium text-(--color-text)">{question.question}</span>
            <Badge tone="success" size="sm">
              Answered: {question.answer}
            </Badge>
          </span>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} className="ml-auto size-3.5" />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-(--color-edge-muted) p-3">
          <QuestionCard question={question} />
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export function ThreadDecisionCard({
  waitingId,
  decision,
  isSubmitting,
  onApprove,
  onLock,
  onSupersede,
}: {
  readonly waitingId: string
  readonly decision: DecisionView
  readonly isSubmitting: boolean
  readonly onApprove: (decisionId: string) => Promise<void>
  readonly onLock: (decisionId: string) => Promise<void>
  readonly onSupersede: (
    decisionId: string,
    replacementStatement: string,
    replacementRationale: string,
  ) => Promise<void>
}): React.JSX.Element {
  const isSettled = decision.status === 'locked' || decision.status === 'superseded'
  const [open, setOpen] = useState(!isSettled)

  if (!isSettled) {
    return (
      <div
        data-waiting-id={waitingId}
        className="rounded-(--radius-xl) ring-1 ring-(--color-warning)/40"
      >
        <DecisionCard
          decision={decision}
          isSubmitting={isSubmitting}
          onApprove={(id) => {
            void onApprove(id)
          }}
          onLock={(id) => {
            void onLock(id)
          }}
          onSupersede={(id, stmt, rat) => {
            void onSupersede(id, stmt, rat)
          }}
        />
      </div>
    )
  }

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div
        data-waiting-id={waitingId}
        className="rounded-(--radius-lg) border border-(--color-edge) bg-(--color-surface-raised)"
      >
        <CollapsibleTrigger className="px-3.5 py-2 typography-meta text-(--color-text-muted) hover:text-(--color-text)">
          <span className="flex min-w-0 items-center gap-2">
            <Icon
              name={decision.status === 'locked' ? 'lock' : 'decision'}
              className={cn(
                'size-3.5',
                decision.status === 'locked'
                  ? 'text-(--color-success)'
                  : 'text-(--color-text-subtle)',
              )}
            />
            <span className="truncate font-medium text-(--color-text)">{decision.statement}</span>
            <Badge tone={decision.status === 'locked' ? 'success' : 'neutral'} size="sm">
              {decision.status === 'locked' ? 'Locked (Axiom A4)' : 'Superseded'}
            </Badge>
          </span>
          <Icon name={open ? 'chevron-down' : 'chevron-right'} className="ml-auto size-3.5" />
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-(--color-edge-muted) p-3">
          <DecisionCard
            decision={decision}
            isSubmitting={isSubmitting}
            onSupersede={(id, stmt, rat) => {
              void onSupersede(id, stmt, rat)
            }}
          />
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export function ThreadApprovalCard({
  waitingId,
  planBlueprint,
  planArtifact,
  hasLockedDecision,
  openQuestionCount,
  actionInProgress,
  onOpenArtifact,
  onApproveAndImplement,
  onProposeDecision,
}: {
  readonly waitingId: string
  readonly planBlueprint: string | null
  readonly planArtifact: ArtifactMetadataView | null
  readonly hasLockedDecision: boolean
  readonly openQuestionCount: number
  readonly actionInProgress: boolean
  readonly onOpenArtifact: (artifact: ArtifactMetadataView) => void
  readonly onApproveAndImplement: () => Promise<void>
  readonly onProposeDecision: (
    statement: string,
    rationale: string,
    lockImmediately: boolean,
  ) => Promise<void>
}): React.JSX.Element {
  const [proposing, setProposing] = useState(false)
  const [statement, setStatement] = useState('')
  const [rationale, setRationale] = useState('')

  const handlePropose = async (lockImmediately: boolean): Promise<void> => {
    const stmt = statement.trim()
    const rat = rationale.trim()
    if (stmt.length === 0 || rat.length === 0) return
    await onProposeDecision(stmt, rat, lockImmediately)
    setStatement('')
    setRationale('')
    setProposing(false)
  }

  return (
    <Card
      data-waiting-id={waitingId}
      tone="raised"
      className="border-(--color-warning)/45 bg-(--color-warning-muted)/35 p-4"
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5">
            <span className="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-(--radius-lg) bg-(--color-warning-muted) text-(--color-warning)">
              <Icon name="decision" className="size-4" />
            </span>
            <div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="typography-ui-label font-semibold text-(--color-text)">
                  Human Review & Approval Gate
                </span>
                <Badge tone="warning" size="sm">
                  Action required
                </Badge>
                {hasLockedDecision ? (
                  <Badge tone="success" size="sm">
                    Axiom A4 locked
                  </Badge>
                ) : null}
                {openQuestionCount > 0 ? (
                  <Badge tone="danger" size="sm">
                    {String(openQuestionCount)} open question{openQuestionCount > 1 ? 's' : ''}
                  </Badge>
                ) : null}
              </div>
              <p className="m-0 typography-meta text-(--color-text-muted)">
                Review the planning blueprint and lock architectural decisions before authorizing
                sandbox implementation.
              </p>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2 shrink-0">
            {planArtifact !== null ? (
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  onOpenArtifact(planArtifact)
                }}
              >
                <Icon name="plan" className="size-3.5 text-(--color-accent)" />
                <span>View {planArtifact.name}</span>
              </Button>
            ) : null}

            <Button
              variant="secondary"
              size="sm"
              onClick={() => {
                setProposing((cur) => !cur)
              }}
            >
              <Icon name="plus" className="size-3.5" />
              <span>Propose Decision</span>
            </Button>

            <Button
              variant="primary"
              size="sm"
              disabled={actionInProgress || openQuestionCount > 0}
              onClick={() => {
                void onApproveAndImplement()
              }}
            >
              <Icon name="lock" className="size-3.5" />
              <span>Approve & Start Implementation</span>
            </Button>
          </div>
        </div>

        {planBlueprint !== null && planBlueprint.trim().length > 0 ? (
          <div
            className="max-h-56 overflow-y-auto rounded-(--radius-lg) border border-(--color-edge) bg-(--color-surface-inset) p-3"
            data-selectable
          >
            <MarkdownRenderer content={planBlueprint} />
          </div>
        ) : null}

        {proposing ? (
          <div className="flex flex-col gap-2.5 rounded-(--radius-lg) border border-(--color-edge) bg-(--color-surface) p-3">
            <Field label="Architectural Decision Statement" required>
              {(bind) => (
                <Input
                  {...bind}
                  value={statement}
                  placeholder="e.g. Store thread timeline projection derived strictly from SQLite events"
                  onChange={(e) => {
                    setStatement(e.target.value)
                  }}
                />
              )}
            </Field>
            <Field label="Rationale" required>
              {(bind) => (
                <Textarea
                  {...bind}
                  rows={2}
                  value={rationale}
                  placeholder="Why this boundary preserves determinism and Axiom A1..."
                  onChange={(e) => {
                    setRationale(e.target.value)
                  }}
                />
              )}
            </Field>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="xs"
                onClick={() => {
                  setProposing(false)
                }}
              >
                Cancel
              </Button>
              <Button
                variant="secondary"
                size="xs"
                disabled={
                  statement.trim().length === 0 || rationale.trim().length === 0 || actionInProgress
                }
                onClick={() => {
                  void handlePropose(false)
                }}
              >
                Propose Only
              </Button>
              <Button
                variant="primary"
                size="xs"
                disabled={
                  statement.trim().length === 0 || rationale.trim().length === 0 || actionInProgress
                }
                onClick={() => {
                  void handlePropose(true)
                }}
              >
                Propose & Lock (Axiom A4)
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Card>
  )
}
