import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ProjectView, RoleBindingsView, WorkflowTemplateView } from '@shared/ipc'
import { WorkflowPreflight } from './WorkflowPreflight'

/**
 * What the page promises before a workflow runs.
 *
 * The point of #105 is that a first-time reader could not tell what pressing Start
 * would cause. These assert the two things that answer that: the stages that will
 * run, and the preconditions that are not met.
 */

// Built to the real type rather than cast into it: an `as ProjectView` here hid two
// mistakes in this fixture — `tech` at the wrong level and a missing `updatedAt` —
// which is precisely the contract drift a cast stops the compiler reporting.
function project(overrides: Partial<ProjectView['repository']> = {}): ProjectView {
  return {
    id: 'p1',
    name: 'ClinicPilot',
    createdAt: '2026-08-24T00:00:00.000Z',
    updatedAt: '2026-08-24T00:00:00.000Z',
    repository: {
      id: 'r1',
      absolutePath: 'D:/code/clinicpilot',
      defaultBranch: 'main',
      buildCommand: 'dotnet build',
      testCommand: 'dotnet test',
      tech: [],
      ...overrides,
    },
  }
}

const TEMPLATE: WorkflowTemplateView = {
  id: 'feature',
  name: 'Feature Implementation',
  description: 'Plan, approve, implement, verify, review.',
  steps: [
    { role: 'planner', label: 'Plan', advanceTrigger: 'planProduced', performedByForge: false },
    { role: 'user', label: 'Approve', advanceTrigger: 'approved', performedByForge: false },
    { role: 'system', label: 'Verify', advanceTrigger: 'verified', performedByForge: true },
  ],
}

const ALL_BOUND: RoleBindingsView = {
  roles: [
    {
      role: 'planner',
      binding: {
        id: 'b1',
        role: 'planner',
        runtimeId: 'claude-cli',
        accountId: null,
        simulated: false,
      },
      eligibleRuntimes: [],
    },
  ],
}

describe('WorkflowPreflight', () => {
  it('names the stages that will run, and who runs each', () => {
    render(
      <WorkflowPreflight
        template={TEMPLATE}
        project={project()}
        bindings={ALL_BOUND}
        onlySimulated={false}
      />,
    )

    expect(screen.getByText('Feature Implementation')).toBeInTheDocument()
    expect(screen.getByText('Plan')).toBeInTheDocument()
    // "Who does this step" is the part the role name alone does not answer.
    expect(screen.getByText('Forge runs this')).toBeInTheDocument()
    expect(screen.getByText('waits for you')).toBeInTheDocument()
    expect(screen.getByText('agent as planner')).toBeInTheDocument()
  })

  it('says so plainly when every precondition is met', () => {
    render(
      <WorkflowPreflight
        template={TEMPLATE}
        project={project()}
        bindings={ALL_BOUND}
        onlySimulated={false}
      />,
    )

    expect(screen.getByText(/Everything this workflow needs is configured/)).toBeInTheDocument()
  })

  it('blocks on a missing test command, because evidence is impossible without one', () => {
    render(
      <WorkflowPreflight
        template={TEMPLATE}
        project={project({ testCommand: null })}
        bindings={ALL_BOUND}
        onlySimulated={false}
      />,
    )

    // A3: with no command to run, "the tests pass" can only ever be the agent's claim.
    expect(screen.getByText(/cannot verify a claim that the tests pass/)).toBeInTheDocument()
    expect(screen.getAllByText('blocked').length).toBeGreaterThan(0)
  })

  it('warns that a simulated-only run is not evidence', () => {
    render(
      <WorkflowPreflight
        template={TEMPLATE}
        project={project()}
        bindings={ALL_BOUND}
        onlySimulated={true}
      />,
    )

    expect(screen.getByText(/replays a scripted scenario/)).toBeInTheDocument()
  })

  it('treats an unbound role as advisory, not blocking', () => {
    const unbound: RoleBindingsView = {
      roles: [{ role: 'reviewer', binding: null, eligibleRuntimes: [] }],
    }

    render(
      <WorkflowPreflight
        template={TEMPLATE}
        project={project()}
        bindings={unbound}
        onlySimulated={false}
      />,
    )

    // It falls back to a default rather than failing, so flagging it as "blocked"
    // alongside a genuinely fatal gap would train the reader to ignore both.
    expect(screen.getByText(/reviewer/)).toBeInTheDocument()
    expect(screen.getByText('note')).toBeInTheDocument()
    expect(screen.queryByText('blocked')).not.toBeInTheDocument()
  })
})
