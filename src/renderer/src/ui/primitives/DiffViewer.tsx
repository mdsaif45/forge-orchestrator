import { useState } from 'react'
import type { DiscrepancyView } from '@shared/ipc'
import { Badge } from './Badge'
import { Button } from './Button'
import { Textarea } from './Input'
import { cn } from '../cn'

export interface DiffViewerProps {
  readonly filePath: string
  readonly patch?: string | undefined
  readonly fileContent?: string | undefined
  readonly discrepancies?: readonly DiscrepancyView[] | undefined
  readonly isSaving?: boolean | undefined
  readonly onSaveFile?: (path: string, content: string) => Promise<void> | void
  readonly className?: string | undefined
}

export function DiffViewer({
  filePath,
  patch = '',
  fileContent = '',
  discrepancies = [],
  isSaving = false,
  onSaveFile,
  className,
}: DiffViewerProps): React.JSX.Element {
  const [isEditMode, setIsEditMode] = useState(false)
  const [editedContent, setEditedContent] = useState<string | null>(null)

  const effectiveContent = editedContent ?? fileContent
  const hasUnsavedChanges = editedContent !== null && editedContent !== fileContent

  const handleContentChange = (newVal: string): void => {
    setEditedContent(newVal)
  }

  const handleSave = async (): Promise<void> => {
    if (onSaveFile === undefined) return
    await onSaveFile(filePath, effectiveContent)
    setEditedContent(null)
  }

  const fileDiscrepancies = discrepancies.filter((d) => d.path === filePath)

  // Parse patch lines into structured rows
  const lines = patch.split('\n')

  return (
    <div className={cn('flex h-full flex-col overflow-hidden bg-(--color-canvas)', className)}>
      {/* File Diff Header */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-(--color-border) bg-(--color-surface) px-4 py-2.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-(length:--text-sm) font-semibold text-(--color-text)">
            {filePath}
          </span>
          <Badge tone={isEditMode ? 'warning' : 'neutral'} size="sm">
            {isEditMode ? 'EDIT MODE (User-Authored)' : 'READ-ONLY'}
          </Badge>
          {hasUnsavedChanges && (
            <span className="text-(length:--text-xs) font-medium text-(--color-warning)">
              ● Unsaved changes
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {onSaveFile === undefined ? (
            // No save handler means this file cannot be written — browsing for context
            // in the Explorer view, or a workflow holding the worktree (#107). Offering
            // "Edit File" here would let the user type into a buffer that `handleSave`
            // then silently discards, which is worse than not offering it.
            <span className="text-(length:--text-xs) text-(--color-text-muted)">read-only</span>
          ) : !isEditMode ? (
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setEditedContent(fileContent)
                setIsEditMode(true)
              }}
            >
              Edit File
            </Button>
          ) : (
            <>
              <Button
                size="sm"
                variant="ghost"
                disabled={isSaving}
                onClick={() => {
                  setEditedContent(null)
                  setIsEditMode(false)
                }}
              >
                Discard & View Diff
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!hasUnsavedChanges || isSaving}
                onClick={() => {
                  void handleSave()
                }}
              >
                {isSaving ? 'Saving…' : 'Save Changes'}
              </Button>
            </>
          )}
        </div>
      </div>

      {/* Discrepancy Warnings for Current File */}
      {fileDiscrepancies.length > 0 && (
        <div className="flex flex-col gap-1 border-b border-(--color-danger)/30 bg-(--color-danger-muted)/20 px-4 py-2 text-(length:--text-xs)">
          {fileDiscrepancies.map((d, i) => (
            <div key={i} className="flex items-center gap-2 text-(--color-danger)">
              <span className="font-bold">⚠️ Discrepancy ({d.kind}):</span>
              <span>{d.detail}</span>
            </div>
          ))}
        </div>
      )}

      {/* Diff / Edit Content View */}
      <div className="flex-1 overflow-auto font-mono text-(length:--text-xs)">
        {isEditMode ? (
          <div className="h-full p-2">
            <Textarea
              className="h-full w-full resize-none font-mono text-(length:--text-xs) leading-relaxed"
              value={effectiveContent}
              onChange={(e) => {
                handleContentChange(e.target.value)
              }}
              placeholder="Edit file contents..."
            />
          </div>
        ) : (
          <div className="divide-y divide-(--color-border)/30">
            {lines.length === 0 || (lines.length === 1 && lines[0] === '') ? (
              <div className="p-8 text-center text-(--color-text-muted)">
                No diff content for this file.
              </div>
            ) : (
              lines.map((line, idx) => {
                const isHeader =
                  line.startsWith('diff --git') ||
                  line.startsWith('index ') ||
                  line.startsWith('--- ') ||
                  line.startsWith('+++ ')
                const isHunkHeader = line.startsWith('@@')
                const isAddition = line.startsWith('+') && !isHeader
                const isDeletion = line.startsWith('-') && !isHeader

                const rowBg = isAddition
                  ? 'bg-(--color-success-muted)/30 text-(--color-success)'
                  : isDeletion
                    ? 'bg-(--color-danger-muted)/30 text-(--color-danger)'
                    : isHunkHeader
                      ? 'bg-(--color-surface-raised) text-(--color-accent) font-semibold'
                      : isHeader
                        ? 'bg-(--color-surface-raised) text-(--color-text-muted)'
                        : 'text-(--color-text)'

                return (
                  <div
                    key={idx}
                    className={cn(
                      'flex items-start px-3 py-0.5 leading-relaxed font-mono whitespace-pre select-text',
                      rowBg,
                    )}
                  >
                    <span className="w-10 shrink-0 select-none text-right text-(--color-text-subtle) pr-3 opacity-60">
                      {idx + 1}
                    </span>
                    <span className="flex-1">{line || ' '}</span>
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>
    </div>
  )
}
