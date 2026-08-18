import { useState } from 'react'
import { Outlet } from 'react-router'
import { KitchenSink } from '../dev/KitchenSink'
import { Dialog } from '../ui'
import { Sidebar } from './Sidebar'
import { StatusStrip } from './StatusStrip'

/**
 * The application frame: status strip on top, sidebar beside routed content.
 *
 * Layout lives here so no page manages its own chrome. `min-h-0` on the flex
 * children is what lets an inner `ScrollArea` scroll instead of the page growing
 * — without it, a long agent log would stretch the window rather than scroll.
 */
export function Shell(): React.JSX.Element {
  const [sinkOpen, setSinkOpen] = useState(false)

  return (
    <div className="flex h-full flex-col bg-(--color-canvas)">
      <StatusStrip
        projectName={null}
        workflowState="idle"
        onOpenKitchenSink={() => setSinkOpen(true)}
      />

      <div className="flex min-h-0 flex-1">
        <Sidebar />

        {/* The routed region is the live area, so it is the landmark that matters. */}
        <main className="min-w-0 flex-1">
          <Outlet />
        </main>
      </div>

      <Dialog
        open={sinkOpen}
        onClose={() => setSinkOpen(false)}
        title="Kitchen sink"
        description="Every primitive in every variant — the design system's regression surface."
        size="xl"
        className="h-[85vh]"
      >
        <div className="h-[calc(85vh-9rem)]">
          <KitchenSink />
        </div>
      </Dialog>
    </div>
  )
}
