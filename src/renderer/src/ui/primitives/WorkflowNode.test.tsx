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

  it('marks a simulated step, and refuses to dress its verdict as a real one', () => {
    // The #101 regression. A mock replaying a scripted "pass" was rendered
    // identically to a verdict Forge reached by running the build, which is the
    // substitution of a claim for a verified fact that A3 exists to prevent.
    render(
      <WorkflowNode
        role="planner"
        label="Plan"
        state="completed"
        runtimeId="mock:default"
        verdict="pass"
        simulated={true}
      />,
    )

    expect(screen.getByText(/simulated/i)).toBeInTheDocument()
    // The outcome stays legible, but prefixed — never a bare "pass".
    expect(screen.getByText('sim pass')).toBeInTheDocument()
    expect(screen.queryByText('pass')).not.toBeInTheDocument()
  })

  it('leaves a real verdict alone', () => {
    render(
      <WorkflowNode
        role="system"
        label="Verify"
        state="completed"
        runtimeId="claude-cli"
        verdict="pass"
        simulated={false}
      />,
    )

    expect(screen.getByText('pass')).toBeInTheDocument()
    expect(screen.queryByText('simulated')).not.toBeInTheDocument()
  })

  it('does not claim a step is real when no runtime is bound', () => {
    // Null is "unknown", not "verified". Rendering the reassuring case here would be
    // the same class of unearned confidence in a different disguise.
    render(<WorkflowNode role="reviewer" label="Review" state="pending" simulated={null} />)

    expect(screen.queryByText('simulated')).not.toBeInTheDocument()
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
