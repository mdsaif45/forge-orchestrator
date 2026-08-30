import { useMemo, useState } from 'react'
import type { DiscrepancyView } from '@shared/ipc'
import { Badge } from './Badge'
import { Button } from './Button'
import { FileIcon } from './FileIcons'
import { Textarea } from './Input'
import { parseDiffLines, type ParsedDiffLine, type TokenType } from './syntaxHighlighter'
import { cn } from '../cn'

export interface DiffViewerProps {
  readonly filePath: string
  readonly patch?: string | undefined
  readonly fileContent?: string | undefined
  readonly discrepancies?: readonly DiscrepancyView[] | undefined
  readonly isSaving?: boolean | undefined
  readonly onSaveFile?: ((path: string, content: string) => Promise<void> | void) | undefined
  readonly className?: string | undefined
}

const TOKEN_COLOR_MAP: Record<TokenType, string> = {
  keyword: 'text-(--color-syntax-keyword) font-medium',
  function: 'text-(--color-syntax-function)',
  type: 'text-(--color-syntax-type)',
  string: 'text-(--color-syntax-string)',
  number: 'text-(--color-syntax-number)',
  comment: 'text-(--color-syntax-comment) italic',
  operator: 'text-(--color-syntax-operator)',
  tag: 'text-(--color-syntax-tag) font-medium',
  attr: 'text-(--color-syntax-property)',
  property: 'text-(--color-syntax-property)',
  punct: 'text-(--color-syntax-punct)',
  constant: 'text-(--color-syntax-constant)',
  plain: 'text-(--color-text)',
  'diff-add': 'text-(--color-success)',
  'diff-del': 'text-(--color-danger)',
  'diff-hunk': 'text-(--color-accent) font-semibold',
  'diff-header': 'text-(--color-text-muted)',
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

  const parsedDiff: readonly ParsedDiffLine[] = useMemo(() => {
    if (!patch.trim()) return []
    return parseDiffLines(patch, filePath)
  }, [patch, filePath])

  const segments = filePath.split('/')
  const fileName = segments.pop() ?? filePath

  return (
    <div className={cn('flex h-full flex-col overflow-hidden bg-(--color-canvas)', className)}>
      {/* File Diff Header */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-(--color-border) bg-(--color-surface) px-4 py-2.5">
        <div className="flex items-center gap-2">
          <FileIcon fileName={fileName} className="size-4.5 shrink-0" />
          <span className="font-mono text-(length:--text-sm) font-semibold text-(--color-text)">
            {filePath}
          </span>
          {isEditMode && (
            <Badge tone="warning" size="sm">
              EDIT MODE (User-Authored)
            </Badge>
          )}
          {hasUnsavedChanges && (
            <span className="text-(length:--text-xs) font-medium text-(--color-warning)">
              ● Unsaved changes
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          {onSaveFile !== undefined &&
            (!isEditMode ? (
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
            ))}
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
      <div className="flex-1 overflow-auto font-mono text-(length:--text-xs) select-text">
        {isEditMode ? (
          <div className="h-full p-2">
            <Textarea
              className="h-full w-full resize-none font-mono text-(length:--text-xs) leading-relaxed p-3 bg-(--color-surface-inset)"
              value={effectiveContent}
              onChange={(e) => {
                handleContentChange(e.target.value)
              }}
              placeholder="Edit file contents..."
            />
          </div>
        ) : (
          <div className="min-w-fit py-2">
            {parsedDiff.length === 0 ? (
              <div className="p-8 text-center text-(--color-text-muted)">
                No diff content for this file.
              </div>
            ) : (
              parsedDiff.map((diffLine, idx) => {
                if (diffLine.type === 'header') {
                  return (
                    <div
                      key={idx}
                      className="flex items-center px-4 py-0.5 text-[11px] text-(--color-text-subtle) opacity-60 font-mono"
                    >
                      <span className="truncate">{diffLine.text}</span>
                    </div>
                  )
                }

                if (diffLine.type === 'hunk') {
                  return (
                    <div
                      key={idx}
                      className="my-1 flex items-center justify-between border-y border-(--color-border) bg-(--color-surface-inset) px-4 py-1 font-mono text-[11px] text-(--color-accent)"
                    >
                      <span>{diffLine.text}</span>
                      {diffLine.hunkInfo && (
                        <span className="text-(--color-text-muted) text-[10px]">
                          {diffLine.hunkInfo}
                        </span>
                      )}
                    </div>
                  )
                }

                const isAdd = diffLine.type === 'add'
                const isDel = diffLine.type === 'del'

                const rowBg = isAdd
                  ? 'bg-[#2ea043]/20 border-l-2 border-[#2ea043]'
                  : isDel
                    ? 'bg-[#f85149]/20 border-l-2 border-[#f85149]'
                    : 'border-l-2 border-transparent hover:bg-(--color-surface-raised)/40'

                return (
                  <div
                    key={idx}
                    className={cn(
                      'group flex items-start px-2 py-[1px] leading-relaxed font-mono transition-colors',
                      rowBg,
                    )}
                  >
                    {/* Old line number column */}
                    <span className="w-10 shrink-0 select-none text-right font-mono text-[11px] text-(--color-text-subtle) opacity-50 pr-2 group-hover:opacity-100">
                      {diffLine.oldLineNumber ?? ''}
                    </span>

                    {/* New line number column */}
                    <span className="w-10 shrink-0 select-none text-right font-mono text-[11px] text-(--color-text-subtle) opacity-50 pr-2 group-hover:opacity-100">
                      {diffLine.newLineNumber ?? ''}
                    </span>

                    {/* Change symbol (+ / -) */}
                    <span
                      className={cn(
                        'w-5 shrink-0 select-none text-center font-mono font-bold',
                        isAdd
                          ? 'text-(--color-success)'
                          : isDel
                            ? 'text-(--color-danger)'
                            : 'text-(--color-text-subtle) opacity-30',
                      )}
                    >
                      {isAdd ? '+' : isDel ? '-' : ' '}
                    </span>

                    {/* Syntax Highlighted Code Content */}
                    <div className="flex-1 whitespace-pre break-words font-mono">
                      {diffLine.tokens.map((token, tIdx) => {
                        const colorClass = token.type
                          ? TOKEN_COLOR_MAP[token.type]
                          : 'text-(--color-text)'
                        return (
                          <span key={tIdx} className={colorClass}>
                            {token.text}
                          </span>
                        )
                      })}
                    </div>
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
