import { useState } from 'react'
import type { ProjectView } from '@shared/ipc'
import { Button, ConversationActionsMenu, IconButton, Select, Separator } from '../ui'
import { CollapseIcon, ExpandIcon } from './icons'
import { useUiStore } from './uiStore'

/**
 * The always-visible frameless title bar / status strip matching Claude Code desktop (Image 1, 2, 5).
 *
 * Provides window drag region, session breadcrumbs, project badge, and quick utility buttons.
 */
export interface StatusStripProps {
  readonly projects: readonly ProjectView[]
  readonly selectedProjectId: string | null
  readonly onSelectProject: (projectId: string) => void
  readonly onNewProject: () => void
  readonly workflowState?: WorkflowStatePlaceholder | undefined
  readonly onOpenKitchenSink: () => void
}

export type WorkflowStatePlaceholder = 'idle' | 'running' | 'waiting' | 'passed' | 'failed'

export function StatusStrip({
  projects,
  selectedProjectId,
  onSelectProject,
  onNewProject,
  onOpenKitchenSink,
}: StatusStripProps): React.JSX.Element {
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const activeThreadTitle = useUiStore((state) => state.activeThreadTitle)
  const setActiveThreadTitle = useUiStore((state) => state.setActiveThreadTitle)
  const toggleTerminalDrawer = useUiStore((state) => state.toggleTerminalDrawer)
  const toggleArtifactsDrawer = useUiStore((state) => state.toggleArtifactsDrawer)
  const toggleFilesDrawer = useUiStore((state) => state.toggleFilesDrawer)
  const keepComputerAwake = useUiStore((state) => state.keepComputerAwake)
  const setKeepComputerAwake = useUiStore((state) => state.setKeepComputerAwake)

  const [menuOpen, setMenuOpen] = useState(false)
  const [editingTitle, setEditingTitle] = useState(false)
  const [tempTitle, setTempTitle] = useState(activeThreadTitle)

  const handleTitleSubmit = (): void => {
    if (tempTitle.trim().length > 0) {
      setActiveThreadTitle(tempTitle.trim())
    }
    setEditingTitle(false)
  }

  return (
    <header className="app-drag-region relative flex h-[40px] shrink-0 select-none items-center gap-2 border-b border-(--color-border) bg-(--color-surface) px-3 pr-36 text-(--color-text) transition-colors duration-(--duration-fast)">
      {/* Sidebar toggle button */}
      <div className="app-no-drag flex items-center">
        <IconButton
          size="sm"
          variant="ghost"
          label={sidebarCollapsed ? 'Show sidebar navigation' : 'Hide sidebar navigation'}
          onClick={toggleSidebar}
          icon={sidebarCollapsed ? <ExpandIcon /> : <CollapseIcon />}
          className="size-7 rounded-md text-(--color-text-muted) hover:text-(--color-text)"
        />
      </div>

      <Separator orientation="vertical" className="h-4 opacity-50" />

      {/* Breadcrumbs: [Doc Icon] [Session Title] [Project Badge] */}
      <div className="app-no-drag flex items-center gap-2">
        <svg
          className="size-4 text-(--color-text-muted) shrink-0"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
          <polyline points="14 2 14 8 20 8" />
        </svg>

        {editingTitle ? (
          <input
            type="text"
            value={tempTitle}
            onChange={(e) => {
              setTempTitle(e.target.value)
            }}
            onBlur={handleTitleSubmit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleTitleSubmit()
              if (e.key === 'Escape') setEditingTitle(false)
            }}
            autoFocus
            className="h-6 rounded border border-(--color-border-focus) bg-(--color-surface-raised) px-1.5 text-[13px] font-medium text-(--color-text) outline-none"
          />
        ) : (
          <span
            onDoubleClick={() => {
              setTempTitle(activeThreadTitle)
              setEditingTitle(true)
            }}
            title="Double-click to rename"
            className="cursor-pointer text-[13px] font-medium tracking-tight text-(--color-text) hover:underline"
          >
            {activeThreadTitle}
          </span>
        )}

        {/* Project Selector Pill with Claude Code styling */}
        {projects.length > 0 ? (
          <div className="flex items-center gap-1.5">
            <Select
              aria-label="Active project"
              className="h-6 w-auto min-w-[90px] rounded-full border border-(--color-border) bg-(--color-surface-raised) pr-6 pl-2 text-[11px] font-medium text-(--color-text-muted) hover:text-(--color-text)"
              options={projects.map((project) => ({ value: project.id, label: project.name }))}
              value={selectedProjectId ?? ''}
              onChange={(event) => {
                onSelectProject(event.target.value)
              }}
            />
            <Button
              size="sm"
              variant="ghost"
              onClick={onNewProject}
              aria-label="New project"
              className="h-5.5 rounded-full px-2 text-[11px] font-medium text-(--color-text-muted)"
            >
              + New project
            </Button>
          </div>
        ) : (
          <Button
            size="sm"
            variant="ghost"
            onClick={onNewProject}
            aria-label="New project"
            className="h-5.5 rounded-full px-2 text-[11px] font-medium text-(--color-text-muted)"
          >
            + New project
          </Button>
        )}
      </div>

      <div className="ml-auto" />

      {/* Action Icons matching Image 1, 2, 5 */}
      <div className="app-no-drag flex items-center gap-1">
        {/* Terminal button >_ */}
        <IconButton
          size="sm"
          variant="ghost"
          label="Open terminal"
          onClick={toggleTerminalDrawer}
          icon={
            <svg
              className="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="4 17 10 11 4 5" />
              <line x1="12" y1="19" x2="20" y2="19" />
            </svg>
          }
          className="size-7 rounded-md text-(--color-text-muted) hover:text-(--color-text) hover:bg-(--color-surface-raised)"
        />

        {/* Artifacts / Export button [↓] */}
        <IconButton
          size="sm"
          variant="ghost"
          label="Deliverables and artifacts"
          onClick={toggleArtifactsDrawer}
          icon={
            <svg
              className="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="7 10 12 15 17 10" />
              <line x1="12" y1="15" x2="12" y2="3" />
            </svg>
          }
          className="size-7 rounded-md text-(--color-text-muted) hover:text-(--color-text) hover:bg-(--color-surface-raised)"
        />

        {/* Browser preview icon 🌐 */}
        <IconButton
          size="sm"
          variant="ghost"
          label="Browser preview"
          onClick={() => {
            window.open('http://localhost:5173', '_blank')
          }}
          icon={
            <svg
              className="size-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" />
              <line x1="2" y1="12" x2="22" y2="12" />
              <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
            </svg>
          }
          className="size-7 rounded-md text-(--color-text-muted) hover:text-(--color-text) hover:bg-(--color-surface-raised)"
        />

        {/* 3-dots popover button ⁝ */}
        <div className="relative">
          <IconButton
            size="sm"
            variant="ghost"
            label="More conversation options"
            onClick={() => {
              setMenuOpen(!menuOpen)
            }}
            icon={
              <svg className="size-4" viewBox="0 0 24 24" fill="currentColor">
                <circle cx="12" cy="5" r="1.75" />
                <circle cx="12" cy="12" r="1.75" />
                <circle cx="12" cy="19" r="1.75" />
              </svg>
            }
            className="size-7 rounded-md text-(--color-text-muted) hover:text-(--color-text) hover:bg-(--color-surface-raised)"
          />

          <ConversationActionsMenu
            open={menuOpen}
            onClose={() => {
              setMenuOpen(false)
            }}
            onOpenFiles={toggleFilesDrawer}
            onOpenBackgroundTasks={toggleTerminalDrawer}
            onRename={() => {
              setTempTitle(activeThreadTitle)
              setEditingTitle(true)
            }}
            keepAwake={keepComputerAwake}
            onToggleKeepAwake={setKeepComputerAwake}
            onArchive={() => {
              // Handled by conversation store
            }}
            onDelete={() => {
              // Handled by conversation store
            }}
          />
        </div>

        {/* Dev Kitchen Sink */}
        {import.meta.env.DEV && (
          <Button
            size="sm"
            variant="ghost"
            onClick={onOpenKitchenSink}
            className="h-6 rounded px-2 text-[11px] font-mono text-(--color-text-subtle) hover:text-(--color-text)"
          >
            Kitchen sink
          </Button>
        )}
      </div>
    </header>
  )
}
