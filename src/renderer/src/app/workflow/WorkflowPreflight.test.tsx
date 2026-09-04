import { render, screen } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { ProjectView, RoleBindingsView, WorkflowTemplateView } from '@shared/ipc'
import { WorkflowPreflight } from './WorkflowPreflight'

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
    expect(screen.getByText('Forge runs this')).toBeInTheDocument()
    expect(screen.getByText('waits for your review')).toBeInTheDocument()
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

    expect(screen.getByText(/Ready to start/)).toBeInTheDocument()
  })

  it('provides a friendly non-blocking note when test command is missing', () => {
    render(
      <WorkflowPreflight
        template={TEMPLATE}
        project={project({ testCommand: null })}
        bindings={ALL_BOUND}
        onlySimulated={false}
      />,
    )

    expect(
      screen.getByText(/verify code changes using build checks and Git diff/),
    ).toBeInTheDocument()
    expect(screen.queryByText('blocked')).not.toBeInTheDocument()
  })

  it('informs when running in simulated mode without blocking the user', () => {
    render(
      <WorkflowPreflight
        template={TEMPLATE}
        project={project()}
        bindings={ALL_BOUND}
        onlySimulated={true}
      />,
    )

    expect(screen.getByText(/Running in simulated sandbox mode/)).toBeInTheDocument()
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

    expect(screen.getByText(/reviewer/)).toBeInTheDocument()
    expect(screen.getByText('info')).toBeInTheDocument()
    expect(screen.queryByText('blocked')).not.toBeInTheDocument()
  })
})
