import React, { useState } from 'react'
import { Button, Icon, MarkdownRenderer } from '../ui'
import { useProjectStore } from './projectStore'
import type { WorkspaceTab } from './overviewStore'

export interface ArtifactTabViewerProps {
  readonly tab: WorkspaceTab
}

export function ArtifactTabViewer({ tab }: ArtifactTabViewerProps): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const [copied, setCopied] = useState(false)

  const projectName = detail?.project.name ?? 'Forge'
  const markdownText = tab.content ?? `# ${tab.title}\n\nNo content available for this artifact.`

  const handleCopyRaw = () => {
    navigator.clipboard
      .writeText(markdownText)
      .then(() => {
        setCopied(true)
        setTimeout(() => {
          setCopied(false)
        }, 1500)
      })
      .catch(() => {
        // ignore
      })
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-(--color-canvas)">
      {/* ── Breadcrumb & Action Bar (Matching Antigravity Image 5) ── */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-(--color-border) bg-(--color-surface-raised)/30 px-4 select-none text-[12px]">
        {/* Breadcrumb Navigation */}
        <div className="flex min-w-0 items-center gap-1.5 font-mono typography-micro text-(--color-text-muted)">
          <span className="font-semibold text-(--color-text)">{projectName}</span>
          <Icon name="chevron-right" className="size-3 text-(--color-text-subtle)" />
          <span>Artifacts</span>
          <Icon name="chevron-right" className="size-3 text-(--color-text-subtle)" />
          <div className="flex items-center gap-1.5 font-semibold text-(--color-text)">
            <Icon name="file" className="size-3.5 text-(--color-text-muted)" />
            <span>{tab.title}</span>
          </div>
        </div>

        {/* Right Tools: Copy Raw */}
        <div className="flex shrink-0 items-center gap-2">
          <Button size="xs" variant="outline" title="Copy raw markdown" onClick={handleCopyRaw}>
            {copied ? (
              <Icon name="check" className="size-3 text-(--color-success)" />
            ) : (
              <Icon name="copy" className="size-3" />
            )}
            <span>{copied ? 'Copied' : 'Copy Raw'}</span>
          </Button>
        </div>
      </div>

      {/* ── Rendered Markdown Document ── */}
      <div className="flex-1 overflow-y-auto px-6 py-8">
        <div className="mx-auto max-w-4xl rounded-xl border border-(--color-border)/60 bg-(--color-surface) p-6 sm:p-10 shadow-xs">
          <MarkdownRenderer content={markdownText} className="leading-relaxed" />
        </div>
      </div>
    </div>
  )
}
