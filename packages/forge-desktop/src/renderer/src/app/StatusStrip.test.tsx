import type { ProjectView } from '@shared/ipc'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { StatusStrip } from './StatusStrip'

const PROJECTS: readonly ProjectView[] = [
  {
    id: 'proj-1',
    name: 'Forge',
    repository: {
      id: 'repo-1',
      absolutePath: 'd:/repos/Forge',
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: [],
    },
    createdAt: '2026-11-26T00:00:00Z',
    updatedAt: '2026-11-26T00:00:00Z',
  },
  {
    id: 'proj-2',
    name: 'FolderVault',
    repository: {
      id: 'repo-2',
      absolutePath: 'd:/repos/FolderVault',
      defaultBranch: 'main',
      buildCommand: null,
      testCommand: null,
      tech: [],
    },
    createdAt: '2026-11-26T00:00:00Z',
    updatedAt: '2026-11-26T00:00:00Z',
  },
]

describe('StatusStrip', () => {
  it('switches projects and triggers + New project and Project settings from the unified dropdown', async () => {
    const user = userEvent.setup()
    const onSelectProject = vi.fn()
    const onNewProject = vi.fn()
    const onProjectSettings = vi.fn()

    render(
      <StatusStrip
        projects={PROJECTS}
        selectedProjectId="proj-1"
        onSelectProject={onSelectProject}
        onNewProject={onNewProject}
        onProjectSettings={onProjectSettings}
        onOpenKitchenSink={vi.fn()}
      />,
    )

    const trigger = screen.getByRole('button', { name: 'Active project' })
    expect(trigger).toHaveTextContent('Forge')

    await user.click(trigger)
    expect(await screen.findByRole('menu')).toBeInTheDocument()
    expect(screen.getByText('d:/repos/FolderVault')).toBeInTheDocument()

    await user.click(screen.getByRole('menuitem', { name: /FolderVault/i }))
    expect(onSelectProject).toHaveBeenCalledWith('proj-2')

    await user.click(trigger)
    await user.click(await screen.findByRole('menuitem', { name: '+ New project' }))
    expect(onNewProject).toHaveBeenCalledTimes(1)

    await user.click(trigger)
    await user.click(await screen.findByRole('menuitem', { name: 'Project settings' }))
    expect(onProjectSettings).toHaveBeenCalledTimes(1)
  })

  it('shows active workflow status indicator and toggles the right context panel', async () => {
    const user = userEvent.setup()
    const onToggleContextPanel = vi.fn()

    render(
      <StatusStrip
        projects={[]}
        selectedProjectId={null}
        onSelectProject={vi.fn()}
        onNewProject={vi.fn()}
        workflowState="running"
        contextPanelOpen={false}
        onToggleContextPanel={onToggleContextPanel}
        onOpenKitchenSink={vi.fn()}
      />,
    )

    expect(screen.getByRole('button', { name: 'Active project' })).toHaveTextContent(
      'Select project',
    )
    expect(screen.getByText('Running')).toBeVisible()

    const panelToggle = screen.getByRole('button', { name: 'Show context panel' })
    expect(panelToggle).toHaveAttribute('aria-pressed', 'false')
    await user.click(panelToggle)
    expect(onToggleContextPanel).toHaveBeenCalledTimes(1)
  })
})
