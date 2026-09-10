import React from 'react'
import { Drawer, EmptyState } from '../../ui'

export interface AskArtifactsDrawerProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly projectName: string
}

export function AskArtifactsDrawer({
  open,
  onClose,
  projectName,
}: AskArtifactsDrawerProps): React.JSX.Element {
  return (
    <Drawer
      open={open}
      onClose={onClose}
      title={`Artifacts & Deliverables · ${projectName}`}
      size="md"
    >
      <div className="flex h-full flex-col p-4 text-[13px] text-(--color-text)">
        <div className="mb-4 rounded-lg bg-(--color-surface-raised) p-3 text-[12px] text-(--color-text-muted) border border-(--color-border)">
          Deliverables, architecture reports, plans, and diffs generated during sessions for{' '}
          <span className="font-semibold text-(--color-text)">{projectName}</span>.
        </div>

        <div className="flex-1 overflow-y-auto space-y-3">
          <div className="rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-3 transition-colors hover:border-(--color-border-focus)">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[13px] text-(--color-text)">
                implementation_plan.md
              </span>
              <span className="text-[10px] font-mono text-(--color-text-subtle)">Current plan</span>
            </div>
            <p className="mt-1 text-[11px] text-(--color-text-muted) line-clamp-2">
              Architecture and detailed task plan for Forge Ask mode interface redesign.
            </p>
          </div>

          <div className="rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-3 transition-colors hover:border-(--color-border-focus)">
            <div className="flex items-center justify-between">
              <span className="font-semibold text-[13px] text-(--color-text)">walkthrough.md</span>
              <span className="text-[10px] font-mono text-(--color-text-subtle)">
                Session review
              </span>
            </div>
            <p className="mt-1 text-[11px] text-(--color-text-muted) line-clamp-2">
              Comprehensive report of changes made, tests passed, and verification metrics.
            </p>
          </div>

          <EmptyState
            title="All deliverables synced"
            description="Artifacts created by agents or workflows will automatically be tracked and versioned here."
            className="py-8"
          />
        </div>
      </div>
    </Drawer>
  )
}
