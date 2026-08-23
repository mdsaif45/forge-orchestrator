import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { WorkflowNode } from './WorkflowNode'

describe('WorkflowNode', () => {
  it('renders role, label, and state', () => {
    render(
      <WorkflowNode
        role="planner"
        label="Generate Plan"
        state="running"
        runtimeId="mock:default"
      />,
    )

    expect(screen.getByText('planner')).toBeInTheDocument()
    expect(screen.getByText('Generate Plan')).toBeInTheDocument()
    expect(screen.getByText('mock:default')).toBeInTheDocument()
  })

  it('renders verdict badge when supplied', () => {
    render(<WorkflowNode role="system" label="Verify Tests" state="completed" verdict="pass" />)

    expect(screen.getByText('pass')).toBeInTheDocument()
  })

  it('handles click events and marks selection', async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()

    render(
      <WorkflowNode
        role="implementer"
        label="Apply Fix"
        state="completed"
        selected={true}
        onClick={onClick}
      />,
    )

    const btn = screen.getByRole('button')
    expect(btn).toHaveAttribute('aria-pressed', 'true')

    await user.click(btn)
    expect(onClick).toHaveBeenCalledTimes(1)
  })
})
