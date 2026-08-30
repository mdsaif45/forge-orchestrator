import { useMemo, useRef, useState } from 'react'
import type { DiscrepancyView } from '@shared/ipc'
import { Badge } from './Badge'
import { Button } from './Button'
import { FileIcon } from './FileIcons'
import { Textarea } from './Input'
import {
  buildSplitDiff,
  highlightCode,
  parseDiffLines,
  type HighlightedLine,
  type ParsedDiffLine,
  type SplitDiffRow,
  type TokenType,
} from './syntaxHighlighter'
import { cn } from '../cn'

export interface CodeViewerProps {
  readonly filePath: string
  readonly content?: string | undefined
  readonly patch?: string | undefined
  readonly discrepancies?: readonly DiscrepancyView[] | undefined
  readonly isSaving?: boolean | undefined
  readonly onSaveFile?: ((path: string, content: string) => Promise<void> | void) | undefined
  readonly defaultMode?: 'code' | 'diff' | undefined
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

export function CodeViewer({
  filePath,
  content = '',
  patch = '',
  discrepancies = [],
  isSaving = false,
  onSaveFile,
  defaultMode = 'code',
  className,
}: CodeViewerProps): React.JSX.Element {
  const [mode, setMode] = useState<'code' | 'diff'>(patch ? defaultMode : 'code')
  const [diffLayout, setDiffLayout] = useState<'unified' | 'split'>('unified')
  const [wordWrap, setWordWrap] = useState(false)
  const [isEditMode, setIsEditMode] = useState(false)
  const [editedContent, setEditedContent] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)

  const contentContainerRef = useRef<HTMLDivElement>(null)

  const effectiveContent = editedContent ?? content
  const hasUnsavedChanges = editedContent !== null && editedContent !== content

  const fileDiscrepancies = discrepancies.filter((d) => d.path === filePath)
  const hasPatch = patch.trim().length > 0

  const isImage = useMemo(() => {
    const ext = filePath.toLowerCase().split('.').pop() ?? ''
    return ['png', 'jpg', 'jpeg', 'svg', 'gif', 'webp', 'ico', 'bmp'].includes(ext)
  }, [filePath])

  const highlightedCodeLines: readonly HighlightedLine[] = useMemo(() => {
    if (isImage) return []
    return highlightCode(effectiveContent, filePath)
  }, [effectiveContent, filePath, isImage])

  const parsedDiff: readonly ParsedDiffLine[] = useMemo(() => {
    if (!hasPatch || isImage) return []
    return parseDiffLines(patch, filePath)
  }, [hasPatch, isImage, patch, filePath])

  const splitDiffRows: readonly SplitDiffRow[] = useMemo(() => {
    if (!hasPatch || isImage || diffLayout !== 'split') return []
    return buildSplitDiff(parsedDiff)
  }, [hasPatch, isImage, diffLayout, parsedDiff])

  const hunkIndices = useMemo(() => {
    const indices: number[] = []
    parsedDiff.forEach((line, idx) => {
      if (line.type === 'hunk') indices.push(idx)
    })
    return indices
  }, [parsedDiff])

  const handleSave = async (): Promise<void> => {
    if (onSaveFile === undefined) return
    await onSaveFile(filePath, effectiveContent)
    setEditedContent(null)
  }

  const handleCopyPath = () => {
    void window.forge.clipboard.writeText(filePath)
    setCopied(true)
    setTimeout(() => {
      setCopied(false)
    }, 2000)
  }

  const scrollToHunk = (direction: 'next' | 'prev') => {
    if (hunkIndices.length === 0 || !contentContainerRef.current) return
    const container = contentContainerRef.current
    const hunkElements = container.querySelectorAll('[data-hunk-divider]')
    if (hunkElements.length === 0) return

    const containerTop = container.getBoundingClientRect().top
    let targetEl: Element | null = null

    if (direction === 'next') {
      for (const el of Array.from(hunkElements)) {
        const top = el.getBoundingClientRect().top
        if (top > containerTop + 50) {
          targetEl = el
          break
        }
      }
      targetEl ??= hunkElements[0] ?? null
    } else {
      const reversed = Array.from(hunkElements).reverse()
      for (const el of reversed) {
        const top = el.getBoundingClientRect().top
        if (top < containerTop - 20) {
          targetEl = el
          break
        }
      }
      targetEl ??= hunkElements[hunkElements.length - 1] ?? null
    }

    if (targetEl) {
      targetEl.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }
  }

  const segments = filePath.split('/')
  const fileName = segments.pop() ?? filePath
  const lineCount = effectiveContent ? effectiveContent.split('\n').length : 0

  return (
    <div className={cn('flex h-full flex-col overflow-hidden bg-(--color-canvas)', className)}>
      {/* Top Header / Breadcrumb Bar */}
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-(--color-border) bg-(--color-surface) px-4 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <FileIcon fileName={fileName} className="size-4.5 shrink-0" />

          {/* Breadcrumbs */}
          <nav aria-label="Breadcrumbs" className="flex min-w-0 items-center gap-1 text-(length:--text-xs)">
            {segments.map((seg, idx) => (
              <span key={idx} className="flex items-center gap-1 text-(--color-text-muted)">
                <span className="truncate max-w-[120px]">{seg}</span>
                <span className="text-(--color-text-subtle)">/</span>
              </span>
            ))}
            <span className="font-semibold text-(--color-text) truncate">{fileName}</span>
          </nav>

          {isEditMode && (
            <Badge tone="warning" size="sm">
              EDIT MODE
            </Badge>
          )}

          {hasUnsavedChanges && (
            <span className="flex items-center gap-1 text-(length:--text-2xs) font-medium text-(--color-warning)">
              <span className="size-1.5 rounded-full bg-(--color-warning)" />
              Unsaved
            </span>
          )}
        </div>

        {/* Action Controls */}
        <div className="flex items-center gap-2">
          {/* Mode Switcher (Code vs Diff) */}
          {hasPatch && !isEditMode && (
            <div className="flex rounded-(--radius-md) border border-(--color-border) bg-(--color-surface-inset) p-0.5 text-(length:--text-2xs)">
              <button
                type="button"
                onClick={() => {
                  setMode('code')
                }}
                className={cn(
                  'rounded-(--radius-sm) px-2.5 py-1 font-medium transition-colors',
                  mode === 'code'
                    ? 'bg-(--color-surface-raised) text-(--color-text) shadow-sm'
                    : 'text-(--color-text-muted) hover:text-(--color-text)',
                )}
              >
                Code
              </button>
              <button
                type="button"
                onClick={() => {
                  setMode('diff')
                }}
                className={cn(
                  'rounded-(--radius-sm) px-2.5 py-1 font-medium transition-colors',
                  mode === 'diff'
                    ? 'bg-(--color-surface-raised) text-(--color-text) shadow-sm'
                    : 'text-(--color-text-muted) hover:text-(--color-text)',
                )}
              >
                Diff
              </button>
            </div>
          )}

          {/* Diff Controls: Unified vs Side-by-Side, Hunk Navigation */}
          {mode === 'diff' && hasPatch && !isEditMode && (
            <div className="flex items-center gap-1 border-l border-(--color-border) pl-2">
              {/* Word Wrap Toggle */}
              <button
                type="button"
                onClick={() => {
                  setWordWrap((prev) => !prev)
                }}
                className={cn(
                  'rounded-(--radius-sm) p-1 text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text) transition-colors',
                  wordWrap ? 'bg-(--color-surface-raised) text-(--color-text)' : '',
                )}
                title="Word wrap"
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="size-3.5" aria-hidden="true">
                  <path d="M2.5 4h11a.5.5 0 0 1 .5.5v3a2.5 2.5 0 0 1-2.5 2.5H4.707l1.647 1.646a.5.5 0 0 1-.708.708l-2.5-2.5a.5.5 0 0 1 0-.708l2.5-2.5a.5.5 0 1 1 .708.708L4.707 9H11.5a1.5 1.5 0 0 0 1.5-1.5v-2.5H2.5a.5.5 0 0 1 0-1Z" />
                </svg>
              </button>

              {/* Previous Hunk Navigation */}
              <button
                type="button"
                onClick={() => {
                  scrollToHunk('prev')
                }}
                className="rounded-(--radius-sm) p-1 text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text) transition-colors"
                title="Previous hunk"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" className="size-3.5" aria-hidden="true">
                  <path d="m4 10 4-4 4 4" />
                </svg>
              </button>

              {/* Next Hunk Navigation */}
              <button
                type="button"
                onClick={() => {
                  scrollToHunk('next')
                }}
                className="rounded-(--radius-sm) p-1 text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text) transition-colors"
                title="Next hunk"
              >
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.75" className="size-3.5" aria-hidden="true">
                  <path d="m4 6 4 4 4-4" />
                </svg>
              </button>

              {/* Side by side diff toggle */}
              <button
                type="button"
                onClick={() => {
                  setDiffLayout((prev) => (prev === 'unified' ? 'split' : 'unified'))
                }}
                className={cn(
                  'flex items-center gap-1 rounded-(--radius-sm) px-2 py-1 text-(length:--text-2xs) font-medium text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text) transition-colors',
                  diffLayout === 'split' ? 'bg-(--color-surface-raised) text-(--color-text)' : '',
                )}
                title={diffLayout === 'split' ? 'Unified diff' : 'Side by side diff'}
              >
                <svg viewBox="0 0 16 16" fill="currentColor" className="size-3.5" aria-hidden="true">
                  <path d="M1.5 2.5A1.5 1.5 0 0 1 3 1h10a1.5 1.5 0 0 1 1.5 1.5v11a1.5 1.5 0 0 1-1.5 1.5H3a1.5 1.5 0 0 1-1.5-1.5v-11ZM7.5 2H3a.5.5 0 0 0-.5.5v11a.5.5 0 0 0 .5.5h4.5V2Zm1 12H13a.5.5 0 0 0 .5-.5v-11a.5.5 0 0 0-.5-.5H8.5v12Z" />
                </svg>
                <span>{diffLayout === 'split' ? 'Split' : 'Unified'}</span>
              </button>
            </div>
          )}

          <Button size="sm" variant="ghost" onClick={handleCopyPath} title="Copy file path">
            {copied ? 'Copied' : 'Copy Path'}
          </Button>

          {onSaveFile !== undefined && (
            !isEditMode ? (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setEditedContent(content)
                  setIsEditMode(true)
                  setMode('code')
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
                  Discard
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
            )
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

      {/* Main Content Area */}
      <div
        ref={contentContainerRef}
        className="flex-1 overflow-auto font-mono text-(length:--text-xs) leading-relaxed select-text"
      >
        {isImage ? (
          <div className="flex h-full flex-col items-center justify-center p-8 text-center text-(--color-text-muted)">
            <div className="rounded-(--radius-lg) border border-(--color-border) bg-(--color-surface-raised) p-6 shadow-md">
              <FileIcon fileName={fileName} className="mx-auto size-16 text-[#d38aea] mb-3" />
              <p className="font-sans text-(length:--text-sm) font-medium text-(--color-text)">
                {fileName}
              </p>
              <p className="font-sans text-(length:--text-xs) text-(--color-text-muted) mt-1">
                Binary image asset ({fileName.split('.').pop()?.toUpperCase()})
              </p>
            </div>
          </div>
        ) : isEditMode ? (
          <div className="h-full p-3">
            <Textarea
              className="h-full w-full resize-none font-mono text-(length:--text-xs) leading-relaxed p-3 bg-(--color-surface-inset)"
              value={effectiveContent}
              onChange={(e) => {
                setEditedContent(e.target.value)
              }}
              placeholder="Edit file contents..."
            />
          </div>
        ) : mode === 'diff' && hasPatch ? (
          diffLayout === 'split' ? (
            /* Zed-Style Side-by-Side (Split) Diff View */
            <div className="min-w-fit py-1">
              {splitDiffRows.length === 0 ? (
                <div className="p-8 text-center text-(--color-text-muted)">No diff content for this file.</div>
              ) : (
                splitDiffRows.map((row, idx) => {
                  if (row.isHunk) {
                    return (
                      <div
                        key={idx}
                        data-hunk-divider="true"
                        className="my-1.5 flex items-center justify-between border-y border-(--color-border) bg-(--color-surface-inset) px-4 py-1 font-mono text-[11px] text-(--color-accent)"
                      >
                        <span>{row.hunkText}</span>
                        {row.hunkInfo && (
                          <span className="text-(--color-text-muted) text-[10px]">{row.hunkInfo}</span>
                        )}
                      </div>
                    )
                  }

                  const oldLine = row.oldLine
                  const newLine = row.newLine

                  const isOldDel = oldLine?.type === 'del'
                  const isNewAdd = newLine?.type === 'add'

                  const oldBg = isOldDel
                    ? 'bg-[#f85149]/15 border-l-2 border-[#f85149]'
                    : oldLine?.type === 'empty'
                      ? 'bg-(--color-surface-inset)/30 border-l-2 border-transparent'
                      : 'border-l-2 border-transparent hover:bg-(--color-surface-raised)/30'

                  const newBg = isNewAdd
                    ? 'bg-[#2ea043]/15 border-l-2 border-[#2ea043]'
                    : newLine?.type === 'empty'
                      ? 'bg-(--color-surface-inset)/30 border-l-2 border-transparent'
                      : 'border-l-2 border-transparent hover:bg-(--color-surface-raised)/30'

                  return (
                    <div key={idx} className="flex border-b border-(--color-border)/20 text-[11px] leading-relaxed">
                      {/* Left Pane (Old / Deletions) */}
                      <div className={cn('flex w-1/2 items-start border-r border-(--color-border) px-2 py-[1px]', oldBg)}>
                        <span className="w-8 shrink-0 select-none text-right font-mono text-[10px] text-(--color-text-subtle) opacity-60 pr-2">
                          {oldLine?.lineNumber ?? ''}
                        </span>
                        <span className="w-4 shrink-0 select-none text-center font-mono font-bold text-(--color-danger)">
                          {isOldDel ? '-' : ''}
                        </span>
                        <div className={cn('flex-1 font-mono', wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>
                          {oldLine?.tokens.map((token, tIdx) => {
                            const colorClass = token.type ? TOKEN_COLOR_MAP[token.type] : 'text-(--color-text)'
                            return (
                              <span key={tIdx} className={colorClass}>
                                {token.text}
                              </span>
                            )
                          })}
                        </div>
                      </div>

                      {/* Right Pane (New / Additions) */}
                      <div className={cn('flex w-1/2 items-start px-2 py-[1px]', newBg)}>
                        <span className="w-8 shrink-0 select-none text-right font-mono text-[10px] text-(--color-text-subtle) opacity-60 pr-2">
                          {newLine?.lineNumber ?? ''}
                        </span>
                        <span className="w-4 shrink-0 select-none text-center font-mono font-bold text-(--color-success)">
                          {isNewAdd ? '+' : ''}
                        </span>
                        <div className={cn('flex-1 font-mono', wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre')}>
                          {newLine?.tokens.map((token, tIdx) => {
                            const colorClass = token.type ? TOKEN_COLOR_MAP[token.type] : 'text-(--color-text)'
                            return (
                              <span key={tIdx} className={colorClass}>
                                {token.text}
                              </span>
                            )
                          })}
                        </div>
                      </div>
                    </div>
                  )
                })
              )}
            </div>
          ) : (
            /* Zed-Style Unified Diff Rendering */
            <div className="min-w-fit py-1">
              {parsedDiff.length === 0 ? (
                <div className="p-8 text-center text-(--color-text-muted)">No diff content for this file.</div>
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
                        data-hunk-divider="true"
                        className="my-1.5 flex items-center justify-between border-y border-(--color-border) bg-(--color-surface-inset) px-4 py-1 font-mono text-[11px] text-(--color-accent)"
                      >
                        <span>{diffLine.text}</span>
                        {diffLine.hunkInfo && (
                          <span className="text-(--color-text-muted) text-[10px]">{diffLine.hunkInfo}</span>
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
                          isAdd ? 'text-(--color-success)' : isDel ? 'text-(--color-danger)' : 'text-(--color-text-subtle) opacity-30',
                        )}
                      >
                        {isAdd ? '+' : isDel ? '-' : ' '}
                      </span>

                      {/* Syntax Highlighted Code Content */}
                      <div className={cn('flex-1 font-mono', wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre break-words')}>
                        {diffLine.tokens.map((token, tokenIdx) => {
                          const colorClass = token.type ? TOKEN_COLOR_MAP[token.type] : 'text-(--color-text)'
                          return (
                            <span key={tokenIdx} className={colorClass}>
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
          )
        ) : (
          /* Zed-Style Standard Code Rendering */
          <div className="min-w-fit py-2">
            {highlightedCodeLines.length === 0 || (highlightedCodeLines.length === 1 && highlightedCodeLines[0]?.[0]?.text === '') ? (
              <div className="p-8 text-center text-(--color-text-muted)">File is empty.</div>
            ) : (
              highlightedCodeLines.map((tokens, idx) => {
                const lineNum = idx + 1
                return (
                  <div
                    key={idx}
                    className="group flex items-start px-2 py-[1px] leading-relaxed border-l-2 border-transparent transition-colors hover:bg-(--color-surface-raised)/40"
                  >
                    {/* Line number gutter */}
                    <span className="w-12 shrink-0 pr-4 text-right text-(--color-text-subtle) select-none opacity-50 group-hover:opacity-100 group-hover:text-(--color-text-muted) transition-opacity font-mono">
                      {lineNum}
                    </span>

                    {/* Syntax Highlighted Tokens */}
                    <div className={cn('flex-1 font-mono', wordWrap ? 'whitespace-pre-wrap break-words' : 'whitespace-pre break-words')}>
                      {tokens.map((token, tokenIdx) => {
                        const colorClass = token.type ? TOKEN_COLOR_MAP[token.type] : 'text-(--color-text)'
                        return (
                          <span key={tokenIdx} className={colorClass}>
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

      {/* Footer Status Bar */}
      <div className="flex shrink-0 items-center justify-between border-t border-(--color-border) bg-(--color-surface) px-4 py-1.5 text-(length:--text-2xs) text-(--color-text-muted)">
        <div className="flex items-center gap-3">
          <span>{lineCount} lines</span>
          <span>•</span>
          <span>{effectiveContent.length} chars</span>
        </div>
        <div className="flex items-center gap-2 font-mono">
          <span>UTF-8</span>
          <span>•</span>
          <span className="uppercase">{filePath.split('.').pop() ?? 'plain'}</span>
        </div>
      </div>
    </div>
  )
}
