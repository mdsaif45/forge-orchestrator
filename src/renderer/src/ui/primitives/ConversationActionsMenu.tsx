import React, { useEffect, useRef, useState } from 'react'
import { cn } from '../cn'

export interface ConversationActionsMenuProps {
  readonly open: boolean
  readonly onClose: () => void
  readonly onOpenFiles?: () => void
  readonly onOpenBackgroundTasks?: () => void
  readonly onOpenIn?: (target: 'vscode' | 'cursor' | 'terminal' | 'explorer') => void
  readonly onRename?: () => void
  readonly onTranscriptView?: (view: 'markdown' | 'jsonl' | 'summary') => void
  readonly onOutputStyle?: (style: 'standard' | 'compact' | 'verbose') => void
  readonly onFork?: () => void
  readonly keepAwake?: boolean
  readonly onToggleKeepAwake?: (awake: boolean) => void
  readonly onArchive?: () => void
  readonly onDelete?: () => void
}

/**
 * The 3-dots conversation popover menu matching Image 5.
 *
 * Supports keyboard shortcuts, submenus, keep-awake toggle, and danger styling.
 */
export function ConversationActionsMenu({
  open,
  onClose,
  onOpenFiles,
  onOpenBackgroundTasks,
  onOpenIn,
  onRename,
  onTranscriptView,
  onOutputStyle,
  onFork,
  keepAwake = false,
  onToggleKeepAwake,
  onArchive,
  onDelete,
}: ConversationActionsMenuProps): React.JSX.Element | null {
  const menuRef = useRef<HTMLDivElement>(null)
  const [activeSubmenu, setActiveSubmenu] = useState<'openIn' | 'transcript' | 'output' | null>(
    null,
  )

  useEffect(() => {
    if (!open) return

    const handleClickOutside = (e: MouseEvent): void => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setActiveSubmenu(null)
        onClose()
      }
    }

    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        onClose()
      } else if (e.key === 'r' || e.key === 'R') {
        onRename?.()
        onClose()
      } else if (e.key === 'f' || e.key === 'F') {
        onFork?.()
        onClose()
      } else if (e.key === 'a' || e.key === 'A') {
        onArchive?.()
        onClose()
      } else if (e.key === 'd' || e.key === 'D') {
        onDelete?.()
        onClose()
      }
    }

    window.addEventListener('mousedown', handleClickOutside)
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('mousedown', handleClickOutside)
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose, onRename, onFork, onArchive, onDelete])

  if (!open) return null

  return (
    <div
      ref={menuRef}
      role="menu"
      aria-label="Conversation actions"
      className={cn(
        'absolute right-3 top-10 z-50 w-64 rounded-xl border border-(--color-border)',
        'bg-(--color-surface) py-1.5 text-[13px] text-(--color-text) shadow-(--shadow-lg)',
        'animate-in fade-in zoom-in-95 duration-100 select-none backdrop-blur-md',
      )}
    >
      {/* Files */}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onOpenFiles?.()
          onClose()
        }}
        className="flex w-full items-center justify-between px-3.5 py-1.5 text-left hover:bg-(--color-surface-raised) transition-colors cursor-pointer"
      >
        <span className="flex items-center gap-2.5">
          <svg
            className="size-4 text-(--color-text-muted)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
          </svg>
          <span>Files</span>
        </span>
        <span className="font-mono text-[11px] text-(--color-text-subtle)">Ctrl ⇧ F</span>
      </button>

      {/* Background tasks */}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onOpenBackgroundTasks?.()
          onClose()
        }}
        className="flex w-full items-center justify-between px-3.5 py-1.5 text-left hover:bg-(--color-surface-raised) transition-colors cursor-pointer"
      >
        <span className="flex items-center gap-2.5">
          <svg
            className="size-4 text-(--color-text-muted)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="12" cy="12" r="3" />
            <path d="M3 12h3m12 0h3M12 3v3m0 12v3" />
          </svg>
          <span>Background tasks</span>
        </span>
      </button>

      {/* Open in > */}
      <div
        className="relative"
        onMouseEnter={() => {
          setActiveSubmenu('openIn')
        }}
        onMouseLeave={() => {
          setActiveSubmenu(null)
        }}
      >
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center justify-between px-3.5 py-1.5 text-left hover:bg-(--color-surface-raised) transition-colors cursor-pointer"
        >
          <span>Open in</span>
          <svg
            className="size-3.5 text-(--color-text-subtle)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        {activeSubmenu === 'openIn' && (
          <div className="absolute right-full top-0 mr-1 w-44 rounded-xl border border-(--color-border) bg-(--color-surface) py-1 text-[12px] shadow-(--shadow-lg)">
            <button
              type="button"
              onClick={() => {
                onOpenIn?.('vscode')
                onClose()
              }}
              className="flex w-full px-3 py-1.5 text-left hover:bg-(--color-surface-raised) cursor-pointer"
            >
              VS Code
            </button>
            <button
              type="button"
              onClick={() => {
                onOpenIn?.('cursor')
                onClose()
              }}
              className="flex w-full px-3 py-1.5 text-left hover:bg-(--color-surface-raised) cursor-pointer"
            >
              Cursor
            </button>
            <button
              type="button"
              onClick={() => {
                onOpenIn?.('terminal')
                onClose()
              }}
              className="flex w-full px-3 py-1.5 text-left hover:bg-(--color-surface-raised) cursor-pointer"
            >
              External Terminal
            </button>
            <button
              type="button"
              onClick={() => {
                onOpenIn?.('explorer')
                onClose()
              }}
              className="flex w-full px-3 py-1.5 text-left hover:bg-(--color-surface-raised) cursor-pointer"
            >
              File Explorer
            </button>
          </div>
        )}
      </div>

      {/* Rename */}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onRename?.()
          onClose()
        }}
        className="flex w-full items-center justify-between px-3.5 py-1.5 text-left hover:bg-(--color-surface-raised) transition-colors cursor-pointer"
      >
        <span>Rename</span>
        <span className="font-mono text-[11px] text-(--color-text-subtle)">R</span>
      </button>

      {/* Transcript view > */}
      <div
        className="relative"
        onMouseEnter={() => {
          setActiveSubmenu('transcript')
        }}
        onMouseLeave={() => {
          setActiveSubmenu(null)
        }}
      >
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center justify-between px-3.5 py-1.5 text-left hover:bg-(--color-surface-raised) transition-colors cursor-pointer"
        >
          <span>Transcript view</span>
          <svg
            className="size-3.5 text-(--color-text-subtle)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        {activeSubmenu === 'transcript' && (
          <div className="absolute right-full top-0 mr-1 w-44 rounded-xl border border-(--color-border) bg-(--color-surface) py-1 text-[12px] shadow-(--shadow-lg)">
            <button
              type="button"
              onClick={() => {
                onTranscriptView?.('markdown')
                onClose()
              }}
              className="flex w-full px-3 py-1.5 text-left hover:bg-(--color-surface-raised) cursor-pointer"
            >
              Formatted Markdown
            </button>
            <button
              type="button"
              onClick={() => {
                onTranscriptView?.('jsonl')
                onClose()
              }}
              className="flex w-full px-3 py-1.5 text-left hover:bg-(--color-surface-raised) cursor-pointer"
            >
              Raw JSONL
            </button>
            <button
              type="button"
              onClick={() => {
                onTranscriptView?.('summary')
                onClose()
              }}
              className="flex w-full px-3 py-1.5 text-left hover:bg-(--color-surface-raised) cursor-pointer"
            >
              Summary
            </button>
          </div>
        )}
      </div>

      {/* Output style > */}
      <div
        className="relative"
        onMouseEnter={() => {
          setActiveSubmenu('output')
        }}
        onMouseLeave={() => {
          setActiveSubmenu(null)
        }}
      >
        <button
          type="button"
          role="menuitem"
          className="flex w-full items-center justify-between px-3.5 py-1.5 text-left hover:bg-(--color-surface-raised) transition-colors cursor-pointer"
        >
          <span>Output style</span>
          <svg
            className="size-3.5 text-(--color-text-subtle)"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <polyline points="9 18 15 12 9 6" />
          </svg>
        </button>
        {activeSubmenu === 'output' && (
          <div className="absolute right-full top-0 mr-1 w-36 rounded-xl border border-(--color-border) bg-(--color-surface) py-1 text-[12px] shadow-(--shadow-lg)">
            <button
              type="button"
              onClick={() => {
                onOutputStyle?.('standard')
                onClose()
              }}
              className="flex w-full px-3 py-1.5 text-left hover:bg-(--color-surface-raised) cursor-pointer"
            >
              Standard
            </button>
            <button
              type="button"
              onClick={() => {
                onOutputStyle?.('compact')
                onClose()
              }}
              className="flex w-full px-3 py-1.5 text-left hover:bg-(--color-surface-raised) cursor-pointer"
            >
              Compact
            </button>
            <button
              type="button"
              onClick={() => {
                onOutputStyle?.('verbose')
                onClose()
              }}
              className="flex w-full px-3 py-1.5 text-left hover:bg-(--color-surface-raised) cursor-pointer"
            >
              Verbose
            </button>
          </div>
        )}
      </div>

      {/* Fork */}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onFork?.()
          onClose()
        }}
        className="flex w-full items-center justify-between px-3.5 py-1.5 text-left hover:bg-(--color-surface-raised) transition-colors cursor-pointer"
      >
        <span>Fork</span>
        <span className="font-mono text-[11px] text-(--color-text-subtle)">F</span>
      </button>

      <div className="my-1.5 h-px bg-(--color-border)" />

      {/* Keep computer awake toggle */}
      <div className="flex items-center justify-between px-3.5 py-2">
        <div className="flex flex-col">
          <span className="font-medium text-[12.5px]">Keep computer awake</span>
          <span className="text-[10.5px] text-(--color-text-subtle)">Only for this session</span>
        </div>
        <button
          type="button"
          role="switch"
          aria-checked={keepAwake}
          onClick={() => onToggleKeepAwake?.(!keepAwake)}
          className={cn(
            'relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out',
            keepAwake
              ? 'bg-(--color-accent)'
              : 'bg-(--color-surface-raised) border-(--color-border)',
          )}
        >
          <span
            className={cn(
              'pointer-events-none inline-block size-4 transform rounded-full bg-white shadow ring-0 transition duration-200 ease-in-out',
              keepAwake ? 'translate-x-4' : 'translate-x-0',
            )}
          />
        </button>
      </div>

      <div className="my-1.5 h-px bg-(--color-border)" />

      {/* Archive */}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onArchive?.()
          onClose()
        }}
        className="flex w-full items-center justify-between px-3.5 py-1.5 text-left hover:bg-(--color-surface-raised) transition-colors cursor-pointer"
      >
        <span>Archive</span>
        <span className="font-mono text-[11px] text-(--color-text-subtle)">A</span>
      </button>

      {/* Delete */}
      <button
        type="button"
        role="menuitem"
        onClick={() => {
          onDelete?.()
          onClose()
        }}
        className="flex w-full items-center justify-between px-3.5 py-1.5 text-left text-(--color-danger) hover:bg-(--color-danger-muted) transition-colors font-medium cursor-pointer"
      >
        <span>Delete</span>
        <span className="font-mono text-[11px] text-(--color-danger)/70">D</span>
      </button>
    </div>
  )
}
