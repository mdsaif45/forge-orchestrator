import { useState } from 'react'
import type { EvidenceRefView, OpenQuestionView } from '@shared/ipc'
import { Badge } from './Badge'
import { Button } from './Button'
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from './Card'
import { Code } from './Code'
import { Input } from './Input'
import { StatusDot } from './StatusDot'

export interface QuestionCardProps {
  readonly question: OpenQuestionView
  readonly projectName?: string | undefined
  readonly onAnswer?: (answer: string, lockAsDecision: boolean) => Promise<void> | void
  readonly onOpenEvidence?: (ref: EvidenceRefView) => void
  readonly onViewStep?: () => void
  readonly isSubmitting?: boolean | undefined
  readonly className?: string | undefined
}

export function QuestionCard({
  question,
  projectName,
  onAnswer,
  onOpenEvidence,
  onViewStep,
  isSubmitting = false,
  className,
}: QuestionCardProps): React.JSX.Element {
  const isAnswered = question.answer !== null
  const [selectedOption, setSelectedOption] = useState<string | null>(
    question.recommendation ?? question.options[0] ?? null,
  )
  const [customAnswer, setCustomAnswer] = useState('')
  const [useCustom, setUseCustom] = useState(false)

  const effectiveAnswer = useCustom ? customAnswer.trim() : (selectedOption ?? '')
  const canSubmit = effectiveAnswer.length > 0 && !isSubmitting

  const handleAnswer = (lockDecision: boolean): void => {
    if (!canSubmit || onAnswer === undefined) return
    void onAnswer(effectiveAnswer, lockDecision)
  }

  return (
    <Card tone="default" padding="md" className={className}>
      <CardHeader className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <StatusDot
              status={isAnswered ? 'passed' : 'waiting'}
              pulse={!isAnswered}
              label={isAnswered ? 'Answered' : 'Action required'}
            />
            {projectName !== undefined ? (
              <span className="text-(length:--text-xs) font-medium text-(--color-text-muted)">
                {projectName}
              </span>
            ) : null}
            <span className="text-(length:--text-2xs) text-(--color-text-subtle)">
              {new Date(question.askedAt).toLocaleTimeString()}
            </span>
          </div>
          <CardTitle className="text-(length:--text-sm) font-semibold sm:text-(length:--text-base)">
            {question.question}
          </CardTitle>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          <Badge tone={isAnswered ? 'success' : 'warning'} size="sm">
            {isAnswered ? 'Answered' : 'Decision needed'}
          </Badge>
          <Badge tone="neutral" size="sm">
            {formatAskedBy(question.askedBy)}
          </Badge>
        </div>
      </CardHeader>

      <CardContent className="mt-3 flex flex-col gap-4">
        {/* Why Undetermined Explanation */}
        <div className="rounded-(--radius-md) bg-(--color-surface-inset) p-3 text-(length:--text-xs) text-(--color-text-muted)">
          <span className="font-semibold text-(--color-text)">Why undetermined: </span>
          {question.whyUndetermined}
        </div>

        {/* Evidence Inspected Trail */}
        {question.evidence.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className="text-(length:--text-2xs) font-semibold uppercase tracking-wider text-(--color-text-subtle)">
              Evidence Inspected ({String(question.evidence.length)})
            </span>
            <div className="flex flex-col gap-1">
              {question.evidence.map((ref, idx) => (
                <div
                  key={`${ref.path}:${String(ref.line ?? 0)}:${String(idx)}`}
                  onClick={() => {
                    onOpenEvidence?.(ref)
                  }}
                  className={`flex flex-wrap items-center justify-between gap-2 rounded-(--radius-sm) border border-(--color-border) bg-(--color-surface-raised) px-2.5 py-1.5 text-(length:--text-xs) ${
                    onOpenEvidence !== undefined
                      ? 'cursor-pointer hover:border-(--color-accent)'
                      : ''
                  }`}
                >
                  <div className="flex items-center gap-2 font-mono text-(--color-text)">
                    <span className="text-(--color-success)">✓</span>
                    <Code>
                      {ref.path}
                      {ref.line !== null ? `:${String(ref.line)}` : ''}
                    </Code>
                  </div>
                  {ref.note.length > 0 ? (
                    <span className="text-(length:--text-2xs) text-(--color-text-muted)">
                      {ref.note}
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ) : null}

        {/* Answer Selection or Answer Display */}
        {isAnswered ? (
          <div className="flex flex-col gap-1 rounded-(--radius-md) border border-(--color-success)/30 bg-(--color-success-muted) p-3 text-(length:--text-sm)">
            <span className="text-(length:--text-2xs) font-semibold uppercase tracking-wider text-(--color-success)">
              Recorded Answer
            </span>
            <div className="font-medium text-(--color-text)">{question.answer}</div>
            <div className="text-(length:--text-2xs) text-(--color-text-muted)">
              Answered by {question.answeredBy ?? 'user'} at{' '}
              {question.answeredAt !== null
                ? new Date(question.answeredAt).toLocaleString()
                : 'unknown time'}
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            <div className="flex items-center justify-between">
              <span className="text-(length:--text-2xs) font-semibold uppercase tracking-wider text-(--color-text-subtle)">
                Select Option or Specify Answer
              </span>
              {question.recommendation !== null ? (
                <span className="text-(length:--text-2xs) font-medium text-(--color-accent)">
                  Recommended: <Code>{question.recommendation}</Code>
                </span>
              ) : null}
            </div>

            {/* Standard Options */}
            {question.options.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {question.options.map((opt) => {
                  const isSelected = !useCustom && selectedOption === opt
                  const isRecommended = question.recommendation === opt
                  return (
                    <button
                      key={opt}
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => {
                        setSelectedOption(opt)
                        setUseCustom(false)
                      }}
                      className={`inline-flex items-center gap-1.5 rounded-(--radius-md) border px-3 py-1.5 text-(length:--text-xs) font-medium transition-all ${
                        isSelected
                          ? 'border-(--color-accent) bg-(--color-accent-muted) text-(--color-accent)'
                          : 'border-(--color-border) bg-(--color-surface-raised) text-(--color-text-muted) hover:border-(--color-border-strong) hover:text-(--color-text)'
                      }`}
                    >
                      <span
                        className={`size-2 rounded-(--radius-full) ${isSelected ? 'bg-(--color-accent)' : 'bg-(--color-border)'}`}
                      />
                      <span>{opt}</span>
                      {isRecommended ? (
                        <Badge tone="accent" size="sm" className="ml-1 text-(length:--text-2xs)">
                          rec
                        </Badge>
                      ) : null}
                    </button>
                  )
                })}

                <button
                  type="button"
                  disabled={isSubmitting}
                  onClick={() => {
                    setUseCustom(true)
                  }}
                  className={`inline-flex items-center gap-1.5 rounded-(--radius-md) border px-3 py-1.5 text-(length:--text-xs) font-medium transition-all ${
                    useCustom
                      ? 'border-(--color-accent) bg-(--color-accent-muted) text-(--color-accent)'
                      : 'border-(--color-border) bg-(--color-surface-raised) text-(--color-text-muted) hover:border-(--color-border-strong) hover:text-(--color-text)'
                  }`}
                >
                  <span
                    className={`size-2 rounded-(--radius-full) ${useCustom ? 'bg-(--color-accent)' : 'bg-(--color-border)'}`}
                  />
                  <span>Other / Custom…</span>
                </button>
              </div>
            ) : null}

            {/* Custom Input */}
            {useCustom || question.options.length === 0 ? (
              <Input
                placeholder="Type your answer / instruction..."
                value={customAnswer}
                onChange={(e) => {
                  setCustomAnswer(e.target.value)
                  setUseCustom(true)
                }}
                disabled={isSubmitting}
                className="w-full text-(length:--text-xs)"
              />
            ) : null}
          </div>
        )}
      </CardContent>

      {!isAnswered ? (
        <CardFooter className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t border-(--color-border) pt-3">
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="primary"
              disabled={!canSubmit}
              onClick={() => {
                handleAnswer(false)
              }}
            >
              {isSubmitting ? 'Submitting…' : 'Answer'}
            </Button>
            <Button
              size="sm"
              variant="secondary"
              disabled={!canSubmit}
              onClick={() => {
                handleAnswer(true)
              }}
            >
              Answer + Lock as Decision
            </Button>
          </div>

          {onViewStep !== undefined ? (
            <Button size="sm" variant="ghost" onClick={onViewStep}>
              View Workflow
            </Button>
          ) : null}
        </CardFooter>
      ) : null}
    </Card>
  )
}

function formatAskedBy(actor: string): string {
  if (actor.startsWith('agent:')) {
    return `asked by ${actor.replace('agent:', '')}`
  }
  return `asked by ${actor}`
}
