import React, { useState } from 'react'
import { MarkdownRenderer } from '../ui/primitives/MarkdownRenderer'
import { useProjectStore } from './projectStore'
import type { WorkspaceTab } from './overviewStore'
import { CheckIcon, ChevronRightIcon, CopyIcon, DocumentIcon } from './icons'

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
        <div className="flex items-center gap-1.5 min-w-0 font-mono text-[11.5px] text-(--color-text-muted)">
          <span className="font-semibold text-(--color-text)">{projectName}</span>
          <ChevronRightIcon className="size-2.5 text-(--color-text-subtle)" />
          <span>Artifacts</span>
          <ChevronRightIcon className="size-2.5 text-(--color-text-subtle)" />
          <div className="flex items-center gap-1.5 font-semibold text-(--color-text)">
            <DocumentIcon className="size-3.5 text-(--color-text-muted)" />
            <span>{tab.title}</span>
          </div>
        </div>

        {/* Right Tools: Copy Raw */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            title="Copy raw markdown"
            onClick={handleCopyRaw}
            className="flex items-center gap-1.5 rounded px-2.5 py-1 text-[11px] text-(--color-text-muted) hover:bg-(--color-surface-inset) hover:text-(--color-text) transition-colors cursor-pointer border border-(--color-border)"
          >
            {copied ? (
              <CheckIcon className="size-3 text-emerald-400" />
            ) : (
              <CopyIcon className="size-3" />
            )}
            <span>{copied ? 'Copied' : 'Copy Raw'}</span>
          </button>
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
