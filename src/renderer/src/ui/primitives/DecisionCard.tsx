import { useState } from 'react'
import type { DecisionView } from '@shared/ipc'
import { Badge } from './Badge'
import { Button } from './Button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './Card'
import { Code } from './Code'
import { Field } from './Field'
import { Input, Textarea } from './Input'

export interface DecisionCardProps {
  readonly decision: DecisionView
  readonly projectName?: string | undefined
  readonly isSubmitting?: boolean | undefined
  readonly className?: string | undefined
  readonly onApprove?: (decisionId: string) => void
  readonly onLock?: (decisionId: string) => void
  readonly onSupersede?: (
    decisionId: string,
    replacementStatement: string,
    replacementRationale: string,
  ) => void
}

export function DecisionCard({
  decision,
  projectName,
  isSubmitting = false,
  className,
  onApprove,
  onLock,
  onSupersede,
}: DecisionCardProps): React.JSX.Element {
  const [isSuperseding, setIsSuperseding] = useState(false)
  const [repStatement, setRepStatement] = useState('')
  const [repRationale, setRepRationale] = useState('')

  const statusTone =
    decision.status === 'locked'
      ? 'success'
      : decision.status === 'approved'
        ? 'accent'
        : decision.status === 'superseded'
          ? 'neutral'
          : 'warning'

  const statusLabel =
    decision.status === 'locked'
      ? 'Locked (Axiom A4)'
      : decision.status === 'approved'
        ? 'Approved'
        : decision.status === 'superseded'
          ? 'Superseded'
          : 'Proposed'

  const handleSupersedeSubmit = (): void => {
    if (!repStatement.trim() || !repRationale.trim()) return
    onSupersede?.(decision.id, repStatement.trim(), repRationale.trim())
    setIsSuperseding(false)
    setRepStatement('')
    setRepRationale('')
  }

  return (
    <Card tone="default" padding="md" className={className}>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-1.5">
          <div className="flex flex-wrap items-center gap-2">
            <Badge tone={statusTone} size="sm">
              {statusLabel}
            </Badge>
            {projectName !== undefined ? (
              <Badge tone="neutral" size="sm">
                {projectName}
              </Badge>
            ) : null}
            <span className="text-(length:--text-xs) text-(--color-text-muted)">
              proposed by <strong className="text-(--color-text)">{decision.proposedBy}</strong>
            </span>
          </div>
          <CardTitle className="text-(length:--text-base) font-semibold text-(--color-text)">
            {decision.statement}
          </CardTitle>
        </div>
      </CardHeader>

      <CardContent className="flex flex-col gap-3">
        {/* Rationale */}
        <div className="rounded-(--radius-md) border border-(--color-border) bg-(--color-surface-raised) p-3">
          <div className="mb-1 text-(length:--text-xs) font-semibold uppercase tracking-wider text-(--color-text-muted)">
            Rationale & Justification
          </div>
          <p className="text-(length:--text-sm) text-(--color-text)">{decision.rationale}</p>
        </div>

        {/* Lineage Details */}
        <div className="flex flex-wrap items-center gap-4 text-(length:--text-xs) text-(--color-text-muted)">
          {decision.lockedAt !== null && (
            <span>
              Locked on{' '}
              <strong className="text-(--color-text)">
                {new Date(decision.lockedAt).toLocaleString()}
              </strong>{' '}
              by {decision.lockedBy ?? 'user'}
            </span>
          )}
          {decision.originQuestionId !== null && (
            <span>
              Promoted from question: <Code>{decision.originQuestionId}</Code>
            </span>
          )}
          {decision.supersededBy !== null && (
            <span className="text-(--color-warning)">
              Replaced by decision: <Code>{decision.supersededBy}</Code>
            </span>
          )}
        </div>

        {/* Inline Supersede Form */}
        {isSuperseding && (
          <div className="mt-2 flex flex-col gap-3 rounded-(--radius-md) border border-(--color-warning)/40 bg-(--color-warning-muted)/20 p-4">
            <div className="text-(length:--text-xs) font-bold text-(--color-warning)">
              Architecture Change Request (Supersede Locked Decision)
            </div>
            <p className="text-(length:--text-xs) text-(--color-text-muted)">
              Filing a change request requires user approval and will lock the replacement decision.
            </p>
            <Field label="Replacement Statement" required>
              {(bind) => (
                <Input
                  {...bind}
                  placeholder="e.g. Use Memcached instead of Redis"
                  value={repStatement}
                  onChange={(e) => {
                    setRepStatement(e.target.value)
                  }}
                />
              )}
            </Field>
            <Field label="Replacement Rationale & Why Changing" required>
              {(bind) => (
                <Textarea
                  {...bind}
                  rows={2}
                  placeholder="Why the prior locked decision is no longer suitable..."
                  value={repRationale}
                  onChange={(e) => {
                    setRepRationale(e.target.value)
                  }}
                />
              )}
            </Field>
            <div className="flex items-center justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => {
                  setIsSuperseding(false)
                }}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={!repStatement.trim() || !repRationale.trim() || isSubmitting}
                onClick={handleSupersedeSubmit}
              >
                Submit Change Request
              </Button>
            </div>
          </div>
        )}
      </CardContent>

      <CardFooter className="flex flex-wrap items-center justify-between gap-3 border-t border-(--color-border) pt-3">
        <span className="text-(length:--text-xs) text-(--color-text-muted)">
          ID: <Code>{decision.id}</Code>
        </span>

        <div className="flex flex-wrap items-center gap-2">
          {decision.status === 'proposed' && (
            <>
              {onApprove !== undefined && (
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={isSubmitting}
                  onClick={() => {
                    onApprove(decision.id)
                  }}
                >
                  Approve
                </Button>
              )}
              {onLock !== undefined && (
                <Button
                  size="sm"
                  variant="primary"
                  disabled={isSubmitting}
                  onClick={() => {
                    onLock(decision.id)
                  }}
                >
                  Lock Decision
                </Button>
              )}
            </>
          )}

          {decision.status === 'approved' && onLock !== undefined && (
            <Button
              size="sm"
              variant="primary"
              disabled={isSubmitting}
              onClick={() => {
                onLock(decision.id)
              }}
            >
              Lock Decision
            </Button>
          )}

          {decision.status === 'locked' && onSupersede !== undefined && !isSuperseding && (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setIsSuperseding(true)
              }}
            >
              Change Request (Supersede)
            </Button>
          )}
        </div>
      </CardFooter>
    </Card>
  )
}
