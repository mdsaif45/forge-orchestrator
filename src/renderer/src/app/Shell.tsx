import { lazy, Suspense, useEffect, useState } from 'react'
import { Outlet } from 'react-router'
import { Dialog } from '../ui'
import { CreateProjectDialog } from './CreateProjectDialog'
import { useProjectStore } from './projectStore'
import { Sidebar } from './Sidebar'
import { StatusStrip, type WorkflowStatePlaceholder } from './StatusStrip'

/**
 * The kitchen sink is a development tool, and must not reach a released build.
 *
 * Loaded through a dynamic import rather than a static one so the bundler can drop
 * the chunk entirely: a static import stays in the graph even when the JSX using it
 * is unreachable, so gating the render alone would still ship the code (#103).
 * `import.meta.env.DEV` is statically replaced at build time, which is what lets the
 * whole branch — and everything under `dev/` — be eliminated.
 */
const KitchenSink = import.meta.env.DEV
  ? lazy(async () => ({ default: (await import('../dev/KitchenSink')).KitchenSink }))
  : null

/**
 * The application frame: status strip on top, sidebar beside routed content.
 *
 * Layout lives here so no page manages its own chrome. `min-h-0` on the flex
 * children is what lets an inner `ScrollArea` scroll instead of the page growing
 * — without it, a long agent log would stretch the window rather than scroll.
 */
export function Shell(): React.JSX.Element {
  const [sinkOpen, setSinkOpen] = useState(false)
  const [createOpen, setCreateOpen] = useState(false)

  const projects = useProjectStore((state) => state.projects)
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId)
  const select = useProjectStore((state) => state.select)
  const refresh = useProjectStore((state) => state.refresh)

  // One load for the whole shell: the switcher and every page read the same store,
  // so fetching per page would issue the same query several times per navigation.
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
        onNewProject={() => {
          setCreateOpen(true)
        }}
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

      <CreateProjectDialog
        open={createOpen}
        onClose={() => {
          setCreateOpen(false)
        }}
      />
    </div>
  )
}
