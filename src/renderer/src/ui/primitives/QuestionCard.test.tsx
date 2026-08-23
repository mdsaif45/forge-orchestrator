import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { OpenQuestionView } from '@shared/ipc'
import { QuestionCard } from './QuestionCard'

const mockQuestion: OpenQuestionView = {
  id: 'q-1',
  projectId: 'p-1',
  question: 'Should endpoint return 404 or 403?',
  whyUndetermined: 'Both patterns exist in the repository codebase',
  evidence: [
    { path: 'src/auth.ts', line: 42, note: 'uses 403' },
    { path: 'src/user.ts', line: 88, note: 'uses 404' },
  ],
  options: ['404', '403'],
  recommendation: '403',
  askedBy: 'agent:planner',
  askedAt: '2026-08-23T12:00:00.000Z',
  answer: null,
  answeredAt: null,
  answeredBy: null,
}

describe('QuestionCard', () => {
  it('renders question, why undetermined, and evidence list', () => {
    render(<QuestionCard question={mockQuestion} projectName="Auth Service" />)

    expect(screen.getByText('Should endpoint return 404 or 403?')).toBeInTheDocument()
    expect(
      screen.getByText('Both patterns exist in the repository codebase', { exact: false }),
    ).toBeInTheDocument()
    expect(screen.getByText('src/auth.ts:42')).toBeInTheDocument()
    expect(screen.getByText('uses 403')).toBeInTheDocument()
    expect(screen.getByText('asked by planner')).toBeInTheDocument()
  })

  it('selects option and calls onAnswer with lockDecision = false', () => {
    const handleAnswer = vi.fn()
    render(<QuestionCard question={mockQuestion} onAnswer={handleAnswer} />)

    // Option '403' is recommended and selected by default
    const answerBtn = screen.getByRole('button', { name: 'Answer' })
    fireEvent.click(answerBtn)

    expect(handleAnswer).toHaveBeenCalledWith('403', false)
  })

  it('submits with lockDecision = true when requested', () => {
    const handleAnswer = vi.fn()
    render(<QuestionCard question={mockQuestion} onAnswer={handleAnswer} />)

    const lockBtn = screen.getByRole('button', { name: /Answer \+ Lock as Decision/i })
    fireEvent.click(lockBtn)

    expect(handleAnswer).toHaveBeenCalledWith('403', true)
  })

  it('supports entering a custom answer', () => {
    const handleAnswer = vi.fn()
    render(<QuestionCard question={mockQuestion} onAnswer={handleAnswer} />)

    const customOptBtn = screen.getByRole('button', { name: /Other \/ Custom/i })
    fireEvent.click(customOptBtn)

    const input = screen.getByPlaceholderText(/Type your answer/i)
    fireEvent.change(input, { target: { value: 'Return 400 Bad Request' } })

    const answerBtn = screen.getByRole('button', { name: 'Answer' })
    fireEvent.click(answerBtn)

    expect(handleAnswer).toHaveBeenCalledWith('Return 400 Bad Request', false)
  })

  it('renders recorded answer when already answered', () => {
    const answeredQuestion: OpenQuestionView = {
      ...mockQuestion,
      answer: 'Use 403',
      answeredAt: '2026-08-23T12:05:00.000Z',
      answeredBy: 'user',
    }

    render(<QuestionCard question={answeredQuestion} />)

    expect(screen.getByText('Recorded Answer')).toBeInTheDocument()
    expect(screen.getByText('Use 403')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Answer' })).not.toBeInTheDocument()
  })
})
