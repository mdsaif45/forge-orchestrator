import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { DecisionView } from '@shared/ipc'
import { DecisionCard } from './DecisionCard'

describe('DecisionCard', () => {
  const proposedDecision: DecisionView = {
    id: 'd-test-1',
    statement: 'Use SQLite in WAL mode for ACID local storage',
    rationale: 'High throughput, zero setup overhead for single-user desktop app',
    status: 'proposed',
    proposedBy: 'agent:planner',
    proposedAt: '2026-08-23T12:00:00.000Z',
    lockedAt: null,
    lockedBy: null,
    supersededBy: null,
    originQuestionId: null,
  }

  const lockedDecision: DecisionView = {
    id: 'd-test-2',
    statement: 'Render shell with React 19 + Tailwind 4',
    rationale: 'Modern tokens and zero runtime overhead',
    status: 'locked',
    proposedBy: 'user',
    proposedAt: '2026-08-23T12:00:00.000Z',
    lockedAt: '2026-08-23T12:00:00.000Z',
    lockedBy: 'user',
    supersededBy: null,
    originQuestionId: 'q-101',
  }

  it('renders proposed decision statement and buttons', () => {
    const onApprove = vi.fn()
    const onLock = vi.fn()

    render(
      <DecisionCard
        decision={proposedDecision}
        projectName="Forge Orchestrator"
        onApprove={onApprove}
        onLock={onLock}
      />,
    )

    expect(screen.getByText('Use SQLite in WAL mode for ACID local storage')).toBeInTheDocument()
    expect(screen.getByText(/High throughput/)).toBeInTheDocument()
    expect(screen.getByText('Proposed')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(onApprove).toHaveBeenCalledWith('d-test-1')

    fireEvent.click(screen.getByRole('button', { name: 'Lock Decision' }))
    expect(onLock).toHaveBeenCalledWith('d-test-1')
  })

  it('renders locked decision badge and lineage', () => {
    render(<DecisionCard decision={lockedDecision} />)

    expect(screen.getByText('Locked (Axiom A4)')).toBeInTheDocument()
    expect(screen.getByText(/Promoted from question:/)).toBeInTheDocument()
    expect(screen.getByText('q-101')).toBeInTheDocument()
  })

  it('allows opening change request form to supersede locked decision', () => {
    const onSupersede = vi.fn()
    render(<DecisionCard decision={lockedDecision} onSupersede={onSupersede} />)

    const changeReqBtn = screen.getByRole('button', { name: 'Change Request (Supersede)' })
    fireEvent.click(changeReqBtn)

    expect(
      screen.getByText('Architecture Change Request (Supersede Locked Decision)'),
    ).toBeInTheDocument()

    fireEvent.change(screen.getByPlaceholderText(/e\.g\. Use Memcached/), {
      target: { value: 'Switch to styled-components' },
    })
    fireEvent.change(screen.getByPlaceholderText(/Why the prior locked decision/), {
      target: { value: 'Team preference' },
    })

    fireEvent.click(screen.getByRole('button', { name: 'Submit Change Request' }))
    expect(onSupersede).toHaveBeenCalledWith(
      'd-test-2',
      'Switch to styled-components',
      'Team preference',
    )
  })
})
