import React, { useEffect, useRef } from 'react'

export interface ConversationMenuProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onRename: () => void
  readonly onFork: () => void
  readonly onTranscriptView?: (format: 'markdown' | 'jsonl') => void
  readonly onArchive: () => void
  readonly onDelete: () => void
}

export function ConversationMenu({
  open,
  onClose,
  onRename,
  onFork,
  onTranscriptView,
  onArchive,
  onDelete,
}: ConversationMenuProps): React.JSX.Element | null {
  const menuRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return undefined

    const handleClickOutside = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'r' || e.key === 'R') {
        onRename()
        onClose()
      } else if (e.key === 'f' || e.key === 'F') {
        onFork()
        onClose()
      } else if (e.key === 'a' || e.key === 'A') {
        onArchive()
        onClose()
      } else if (e.key === 'd' || e.key === 'D') {
        onDelete()
        onClose()
      }
    }

    window.addEventListener('mousedown', handleClickOutside, { capture: true })
    window.addEventListener('keydown', handleKeyDown)

    return () => {
      window.removeEventListener('mousedown', handleClickOutside, { capture: true })
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose, onRename, onFork, onArchive, onDelete])

  if (!open) return null

  return (
    <div
      ref={menuRef}
      className="absolute right-0 top-10 z-50 w-56 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-1 shadow-xl text-[12px] text-(--color-text) animate-in fade-in-50 zoom-in-95 duration-100"
    >
      <button
        type="button"
        onClick={() => {
          onRename()
          onClose()
        }}
        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 hover:bg-(--color-surface-inset) transition-colors cursor-pointer"
      >
        <span className="flex items-center gap-2">
          <svg
            className="size-3.5 text-(--color-text-muted)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          <span>Rename</span>
        </span>
        <kbd className="font-mono text-[10px] text-(--color-text-subtle)">R</kbd>
      </button>

      <button
        type="button"
        onClick={() => {
          onFork()
          onClose()
        }}
        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 hover:bg-(--color-surface-inset) transition-colors cursor-pointer"
      >
        <span className="flex items-center gap-2">
          <svg
            className="size-3.5 text-(--color-text-muted)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <line x1="6" y1="3" x2="6" y2="15" />
            <circle cx="18" cy="6" r="3" />
            <circle cx="6" cy="18" r="3" />
            <path d="M18 9a9 9 0 0 1-9 9" />
          </svg>
          <span>Fork conversation</span>
        </span>
        <kbd className="font-mono text-[10px] text-(--color-text-subtle)">F</kbd>
      </button>

      {onTranscriptView && (
        <button
          type="button"
          onClick={() => {
            onTranscriptView('markdown')
            onClose()
          }}
          className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 hover:bg-(--color-surface-inset) transition-colors cursor-pointer"
        >
          <span className="flex items-center gap-2">
            <svg
              className="size-3.5 text-(--color-text-muted)"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
              <polyline points="10 9 9 9 8 9" />
            </svg>
            <span>Export Markdown</span>
          </span>
        </button>
      )}

      <div className="my-1 h-px bg-(--color-border)" />

      <button
        type="button"
        onClick={() => {
          onArchive()
          onClose()
        }}
        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 hover:bg-(--color-surface-inset) transition-colors cursor-pointer"
      >
        <span className="flex items-center gap-2">
          <svg
            className="size-3.5 text-(--color-text-muted)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="21 8 21 21 3 21 3 8" />
            <rect x="1" y="3" width="22" height="5" />
            <line x1="10" y1="12" x2="14" y2="12" />
          </svg>
          <span>Archive</span>
        </span>
        <kbd className="font-mono text-[10px] text-(--color-text-subtle)">A</kbd>
      </button>

      <button
        type="button"
        onClick={() => {
          onDelete()
          onClose()
        }}
        className="flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-(--color-danger) hover:bg-(--color-danger-muted) transition-colors cursor-pointer"
      >
        <span className="flex items-center gap-2">
          <svg
            className="size-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="3 6 5 6 21 6" />
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
          </svg>
          <span>Delete conversation</span>
        </span>
        <kbd className="font-mono text-[10px] opacity-70">D</kbd>
      </button>
    </div>
  )
}
