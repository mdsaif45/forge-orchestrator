import React from 'react'
import type { WorkflowArtifactView } from '@shared/ipc'
import { Badge, Button, Card, MarkdownRenderer, useToast } from '@renderer/ui'

export interface WorkflowArtifactViewerProps {
  readonly artifact: WorkflowArtifactView | null
  readonly onClose: () => void
}

export function WorkflowArtifactViewer({
  artifact,
  onClose,
}: WorkflowArtifactViewerProps): React.JSX.Element | null {
  const { show } = useToast()

  if (artifact === null) return null

  const handleCopy = () => {
    window.forge.clipboard
      .writeText(artifact.content)
      .then(() => {
        show({ title: 'Copied to clipboard', tone: 'neutral' })
      })
      .catch(() => {
        show({ title: 'Failed to copy', tone: 'danger' })
      })
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-xs">
      <Card className="flex h-[85vh] w-[90vw] max-w-5xl flex-col overflow-hidden border-(--color-border) bg-(--color-surface)">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-(--color-border) px-5 py-3">
          <div className="flex items-center gap-3">
            <h2 className="text-[16px] font-bold text-(--color-text)">{artifact.title}</h2>
            <Badge tone="accent">{artifact.kind}</Badge>
            <Badge tone="neutral">{artifact.format.toUpperCase()}</Badge>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={handleCopy}>
              Copy Raw
            </Button>
            <Button variant="secondary" size="sm" onClick={onClose}>
              Close
            </Button>
          </div>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-auto p-6">
          {artifact.format === 'markdown' ? (
            <div className="prose prose-invert max-w-none text-[13px] leading-relaxed text-(--color-text)">
              <MarkdownRenderer content={artifact.content} />
            </div>
          ) : artifact.format === 'diff' ? (
            <pre className="overflow-x-auto rounded-lg bg-(--color-surface-raised) p-4 font-mono text-[12px] text-(--color-text)">
              {artifact.content}
            </pre>
          ) : artifact.format === 'json' ? (
            <pre className="overflow-x-auto rounded-lg bg-(--color-surface-raised) p-4 font-mono text-[12px] text-(--color-text)">
              {(() => {
                try {
                  return JSON.stringify(JSON.parse(artifact.content), null, 2)
                } catch {
                  return artifact.content
                }
              })()}
            </pre>
          ) : (
            <pre className="whitespace-pre-wrap font-mono text-[12px] text-(--color-text)">
              {artifact.content}
            </pre>
          )}
        </div>
      </Card>
    </div>
  )
}
