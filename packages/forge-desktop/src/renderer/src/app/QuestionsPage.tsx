import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router'
import type { OpenQuestionView } from '@shared/ipc'
import { unwrap } from '../ipc'
import { EmptyState, QuestionCard, ScrollArea, Tabs, useToast } from '../ui'
import { QuestionsIcon } from './icons'
import { useProjectStore } from './projectStore'

export function QuestionsPage(): React.JSX.Element {
  const navigate = useNavigate()
  const { show } = useToast()
  const projects = useProjectStore((state) => state.projects)
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId)

  const [questions, setQuestions] = useState<readonly OpenQuestionView[]>([])
  const [submittingId, setSubmittingId] = useState<string | null>(null)
  const [tab, setTab] = useState<'unanswered' | 'all'>('unanswered')
  const [reloadTrigger, setReloadTrigger] = useState(0)

  useEffect(() => {
    let cancelled = false

    if (selectedProjectId !== null) {
      window.forge.question
        .list(selectedProjectId)
        .then((res) => {
          if (!cancelled) {
            setQuestions(unwrap(res).questions)
          }
        })
        .catch((err: unknown) => {
          console.error('Failed to load questions:', err)
        })
    } else {
      Promise.all(projects.map((p) => window.forge.question.list(p.id).then(unwrap)))
        .then((results) => {
          if (!cancelled) {
            const all: OpenQuestionView[] = []
            for (const res of results) {
              all.push(...res.questions)
            }
            setQuestions(all)
          }
        })
        .catch((err: unknown) => {
          console.error('Failed to load questions:', err)
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

  const handleAnswer = async (
    questionId: string,
    answerText: string,
    lockDecision: boolean,
  ): Promise<void> => {
    setSubmittingId(questionId)
    try {
      await window.forge.question.answer(questionId, answerText, lockDecision).then(unwrap)
      show({
        tone: 'success',
        title: lockDecision ? 'Answered & Locked as Decision' : 'Answer Recorded',
        description: 'The paused workflow has been notified and is resuming execution.',
      })
      setReloadTrigger((prev) => prev + 1)
    } catch (err) {
      show({
        tone: 'danger',
        title: 'Failed to record answer',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setSubmittingId(null)
    }
  }

  const unanswered = questions.filter((q) => q.answer === null)
  const displayed = tab === 'unanswered' ? unanswered : questions

  const projectMap = new Map(projects.map((p) => [p.id, p.name]))

  return (
    <div className="flex h-full flex-col overflow-hidden bg-(--color-canvas)">
      {/* Header */}
      <header className="flex shrink-0 flex-col gap-3 border-b border-(--color-border) bg-(--color-surface) p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-(length:--text-xl) font-bold text-(--color-text)">Questions</h1>
          <p className="text-(length:--text-xs) text-(--color-text-muted)">
            One place for every interruption, so agent questions stop being chaos.
          </p>
        </div>

        <Tabs<'unanswered' | 'all'>
          aria-label="Question filter tabs"
          items={[
            { value: 'unanswered', label: `Unanswered (${String(unanswered.length)})` },
            { value: 'all', label: `All Questions (${String(questions.length)})` },
          ]}
          value={tab}
          onChange={(val) => {
            setTab(val)
          }}
        />
      </header>

      {/* Action Banner for Unanswered Questions */}
      {unanswered.length > 0 ? (
        <div className="flex items-center gap-2 border-b border-(--color-warning)/30 bg-(--color-warning-muted) px-4 py-2 text-(length:--text-xs) font-medium text-(--color-warning)">
          <span className="size-2 rounded-(--radius-full) bg-(--color-warning) animate-pulse" />
          <span>
            {unanswered.length} question{unanswered.length > 1 ? 's' : ''} require
            {unanswered.length === 1 ? 's' : ''} your decision to unblock workflow execution.
          </span>
        </div>
      ) : null}

      {/* Main Content List */}
      <ScrollArea className="flex-1 p-4">
        {displayed.length === 0 ? (
          <EmptyState
            icon={<QuestionsIcon />}
            title={tab === 'unanswered' ? 'No questions waiting' : 'No questions recorded'}
            // "Nothing has happened yet" and "everything has been dealt with" are
            // different states, and saying the second when the first is true claims a
            // history that does not exist (#108). On a fresh install the old copy read
            // "All agent inquiries have been answered" when none had ever been asked.
            description={
              tab !== 'unanswered' || questions.length === 0
                ? 'When an agent cannot resolve something from the repository, it asks here with its evidence — and the workflow waits for your answer.'
                : 'Every question raised so far has been answered.'
            }
          />
        ) : (
          <div className="mx-auto flex max-w-4xl flex-col gap-4">
            {displayed.map((q) => (
              <QuestionCard
                key={q.id}
                question={q}
                projectName={q.projectId !== undefined ? projectMap.get(q.projectId) : undefined}
                isSubmitting={submittingId === q.id}
                onAnswer={(answer, lock) => {
                  void handleAnswer(q.id, answer, lock)
                }}
                onViewStep={() => {
                  void navigate('/workflows')
                }}
              />
            ))}
          </div>
        )}
      </ScrollArea>
    </div>
  )
}
