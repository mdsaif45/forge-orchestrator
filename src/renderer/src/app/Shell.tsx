import { lazy, Suspense, useEffect, useState } from 'react'
import { Outlet } from 'react-router'
import { Dialog } from '../ui'
import { CreateProjectDialog } from './CreateProjectDialog'
import { useProjectStore } from './projectStore'
import { SettingsDialog } from './Settings'
import { Sidebar } from './Sidebar'
import { StatusStrip, type WorkflowStatePlaceholder } from './StatusStrip'
import { useUiStore } from './uiStore'

const KitchenSink = import.meta.env.DEV
  ? lazy(async () => ({ default: (await import('../dev/KitchenSink')).KitchenSink }))
  : null

/**
 * The application frame: status strip on top, sidebar beside routed content.
 * Centralized container for modals and shell navigation.
 */
export function Shell(): React.JSX.Element {
  const [sinkOpen, setSinkOpen] = useState(false)

  const settingsOpen = useUiStore((state) => state.settingsOpen)
  const closeSettings = useUiStore((state) => state.closeSettings)
  const toggleSettings = useUiStore((state) => state.toggleSettings)

  const createProjectOpen = useUiStore((state) => state.createProjectOpen)
  const openCreateProject = useUiStore((state) => state.openCreateProject)
  const closeCreateProject = useUiStore((state) => state.closeCreateProject)

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
  }, [selectedProjectId])

  const workflowState: WorkflowStatePlaceholder =
    selectedProjectId === null ? 'idle' : activeWorkflowState

  return (
    <div className="flex h-full flex-col bg-(--color-canvas)">
      <StatusStrip
        projects={projects}
        selectedProjectId={selectedProjectId}
        onSelectProject={(projectId) => {
          void select(projectId)
        }}
        onNewProject={openCreateProject}
        workflowState={workflowState}
        onOpenKitchenSink={() => {
          setSinkOpen(true)
        }}
      />

      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="min-h-0 min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

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
