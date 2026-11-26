import { lazy, Suspense, useEffect, useRef, useState } from 'react'
import { Outlet } from 'react-router'
import { cn, Dialog } from '../ui'
import { CreateProjectDialog } from './CreateProjectDialog'
import { useProjectStore } from './projectStore'
import { RightOverviewPanel } from './RightOverviewPanel'
import { SettingsDialog } from './Settings'
import { Sidebar } from './Sidebar'
import { StatusStrip, type WorkflowStatePlaceholder } from './StatusStrip'
import { useOverviewStore } from './overviewStore'
import { useUiStore } from './uiStore'
import { useDevConsoleStore } from './devConsoleStore'

const KitchenSink = import.meta.env.DEV
  ? lazy(async () => ({ default: (await import('../dev/KitchenSink')).KitchenSink }))
  : null

const DevConsole = import.meta.env.DEV
  ? lazy(async () => ({ default: (await import('./DevConsole')).DevConsole }))
  : null

const DevConsoleLauncher = import.meta.env.DEV
  ? lazy(async () => ({ default: (await import('./DevConsoleLauncher')).DevConsoleLauncher }))
  : null

/**
 * The application frame: status strip on top, sidebar beside routed content.
 * Centralized container for modals and shell navigation.
 */
export function Shell(): React.JSX.Element {
  const [sinkOpen, setSinkOpen] = useState(false)

  const settingsOpen = useUiStore((state) => state.settingsOpen)
  const openSettings = useUiStore((state) => state.openSettings)
  const closeSettings = useUiStore((state) => state.closeSettings)
  const toggleSettings = useUiStore((state) => state.toggleSettings)

  const isOverviewOpen = useOverviewStore((state) => state.isOpen)
  const isOverviewExpanded = useOverviewStore((state) => state.isExpanded)
  const toggleOverviewOpen = useOverviewStore((state) => state.toggleOpen)
  const panelWidth = useOverviewStore((state) => state.panelWidth)
  const setPanelWidth = useOverviewStore((state) => state.setPanelWidth)
  const isDraggingSplitter = useOverviewStore((state) => state.isDraggingSplitter)
  const setIsDraggingSplitter = useOverviewStore((state) => state.setIsDraggingSplitter)
  const hasUnreadPlan = useOverviewStore((state) => state.hasUnreadPlan)
  const setHasUnreadPlan = useOverviewStore((state) => state.setHasUnreadPlan)
  const filesChangedCount = useOverviewStore((state) => state.filesChanged.length)

  const dragStartX = useRef(0)
  const dragStartWidth = useRef(0)

  useEffect(() => {
    if (!isDraggingSplitter) return undefined
    const handleMouseMove = (e: MouseEvent): void => {
      const deltaX = dragStartX.current - e.clientX
      const newWidth = Math.max(
        280,
        Math.min(window.innerWidth - 450, dragStartWidth.current + deltaX),
      )
      setPanelWidth(newWidth)
    }
    const handleMouseUp = (): void => {
      setIsDraggingSplitter(false)
    }
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDraggingSplitter, setIsDraggingSplitter, setPanelWidth])

  const createProjectOpen = useUiStore((state) => state.createProjectOpen)
  const openCreateProject = useUiStore((state) => state.openCreateProject)
  const closeCreateProject = useUiStore((state) => state.closeCreateProject)

  const isDevConsoleOpen = useDevConsoleStore((state) => state.isOpen)
  const devConsoleDock = useDevConsoleStore((state) => state.dockPosition)

  const projects = useProjectStore((state) => state.projects)
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId)
  const select = useProjectStore((state) => state.select)
  const refresh = useProjectStore((state) => state.refresh)

  // Global Settings keyboard shortcut (Cmd+, or Ctrl+,)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault()
        toggleSettings()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [toggleSettings])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const [activeWorkflowState, setActiveWorkflowState] = useState<WorkflowStatePlaceholder>('idle')

  // Listen to live workflow updates for the status pill
  useEffect(() => {
    if (selectedProjectId === null) return

    const checkActive = () => {
      window.forge.workflow
        .getActive(selectedProjectId)
        .then((res) => {
          const wf = res.ok ? res.value : null
          if (wf?.finishedAt !== null) {
            if (wf?.state === 'DONE') setActiveWorkflowState('passed')
            else if (wf?.state === 'CANCELLED' || (wf?.state.startsWith('HALTED') ?? false))
              setActiveWorkflowState('failed')
            else setActiveWorkflowState('idle')
          } else if (wf.state === 'AWAITING_USER') {
            setActiveWorkflowState('waiting')
          } else {
            if (wf.state === 'PLAN_READY' || wf.state === 'AWAITING_APPROVAL') {
              setHasUnreadPlan(true)
            }
            setActiveWorkflowState('running')
          }
        })
        .catch(() => {
          setActiveWorkflowState('idle')
        })
    }

    checkActive()
    const unsub = window.forge.onWorkflowEvent(() => {
      checkActive()
    })
    return () => {
      unsub()
    }
  }, [selectedProjectId, setHasUnreadPlan])

  const workflowState: WorkflowStatePlaceholder =
    selectedProjectId === null ? 'idle' : activeWorkflowState

  return (
    <div className="flex h-full flex-col bg-(--color-canvas)">
      {isDraggingSplitter ? (
        <div className="fixed inset-0 z-50 cursor-col-resize select-none" />
      ) : null}

      <StatusStrip
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={(projectId) => {
          void select(projectId)
        }}
        onNewProject={openCreateProject}
        onProjectSettings={openSettings}
        workflowState={workflowState}
        contextPanelOpen={isOverviewOpen}
        hasUnreadPlan={hasUnreadPlan}
        drawerBadgeCount={filesChangedCount}
        onToggleContextPanel={toggleOverviewOpen}
        onOpenKitchenSink={() => {
          setSinkOpen(true)
        }}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <main
          className={cn(
            'min-h-0 min-w-0',
            isOverviewOpen && isOverviewExpanded
              ? 'pointer-events-none w-0 flex-none overflow-hidden opacity-0'
              : 'flex-1 opacity-100',
          )}
        >
          <Outlet />
        </main>

        {isOverviewOpen && !isOverviewExpanded ? (
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize right panel"
            onMouseDown={(e) => {
              e.preventDefault()
              setIsDraggingSplitter(true)
              dragStartX.current = e.clientX
              dragStartWidth.current = panelWidth
            }}
            onDoubleClick={() => {
              setPanelWidth(440)
            }}
            title="Drag to resize panel, double-click to reset"
            className="group relative z-20 -mr-1 flex w-1.5 shrink-0 cursor-col-resize items-center justify-center select-none"
          >
            <div
              className={cn(
                'h-full w-0.5 transition-colors duration-(--duration-fast)',
                isDraggingSplitter
                  ? 'bg-(--color-accent)'
                  : 'bg-transparent group-hover:bg-(--color-accent)',
              )}
            />
          </div>
        ) : null}

        <RightOverviewPanel />

        {isDevConsoleOpen && devConsoleDock === 'right' && DevConsole !== null && (
          <Suspense fallback={null}>
            <DevConsole />
          </Suspense>
        )}
      </div>

      {isDevConsoleOpen && devConsoleDock === 'bottom' && DevConsole !== null && (
        <Suspense fallback={null}>
          <DevConsole />
        </Suspense>
      )}

      {DevConsoleLauncher !== null && (
        <Suspense fallback={null}>
          <DevConsoleLauncher />
        </Suspense>
      )}

      {KitchenSink !== null && (
        <Dialog
          open={sinkOpen}
          onClose={() => {
            setSinkOpen(false)
          }}
          title="Kitchen Sink"
          size="xl"
        >
          <Suspense fallback={null}>
            <KitchenSink />
          </Suspense>
        </Dialog>
      )}

      <CreateProjectDialog open={createProjectOpen} onClose={closeCreateProject} />

      <SettingsDialog open={settingsOpen} onClose={closeSettings} />
    </div>
  )
}
