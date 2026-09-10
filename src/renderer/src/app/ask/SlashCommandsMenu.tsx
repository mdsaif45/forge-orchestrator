import React, { useEffect, useRef } from 'react'
import { cn } from '../../ui'

export interface SlashCommandItem {
  readonly command: string
  readonly label: string
  readonly description: string
  readonly icon: string
}

export const SLASH_COMMANDS: readonly SlashCommandItem[] = [
  {
    command: '/goal',
    label: 'Goal Mode',
    description: 'Run a thorough, non-stopping autonomous task to completion',
    icon: '🎯',
  },
  {
    command: '/schedule',
    label: 'Schedule',
    description: 'Schedule a recurring instruction or timer notification',
    icon: '⏱️',
  },
  {
    command: '/browser',
    label: 'Browser',
    description: 'Research documentation and search the live web',
    icon: '🌐',
  },
  {
    command: '/grill-me',
    label: 'Grill Me',
    description: 'Interactive interview to align and resolve ambiguous design decisions',
    icon: '🔥',
  },
  {
    command: '/boost',
    label: 'Boost Thinking',
    description: 'Multi-perspective deep reasoning, planning, and rigorous verification',
    icon: '⚡',
  },
  {
    command: '/learn',
    label: 'Learn Pattern',
    description: 'Persist architectural rules and corrections for future tasks',
    icon: '📚',
  },
  {
    command: '/teamwork-preview',
    label: 'Teamwork',
    description: 'Coordinate multiple autonomous agents in parallel',
    icon: '👥',
  },
]

export interface SlashCommandsMenuProps {
  readonly open: boolean
  readonly query: string
  readonly selectedIndex: number
  readonly onSelect: (command: string) => void
  readonly onClose: () => void
}

export function SlashCommandsMenu({
  open,
  query,
  selectedIndex,
  onSelect,
  onClose,
}: SlashCommandsMenuProps): React.JSX.Element | null {
  const containerRef = useRef<HTMLDivElement>(null)

  const filterText = query.startsWith('/') ? query.slice(1).toLowerCase() : query.toLowerCase()
  const filtered = SLASH_COMMANDS.filter(
    (c) =>
      c.command.toLowerCase().includes(filterText) ||
      c.label.toLowerCase().includes(filterText) ||
      c.description.toLowerCase().includes(filterText),
  )

  useEffect(() => {
    if (!open) return undefined

    const handleClickOutside = (e: MouseEvent): void => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    window.addEventListener('mousedown', handleClickOutside, { capture: true })
    return () => {
      window.removeEventListener('mousedown', handleClickOutside, { capture: true })
    }
  }, [open, onClose])

  if (!open || filtered.length === 0) return null

  return (
    <div
      ref={containerRef}
      className="absolute bottom-full left-0 mb-2 w-80 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-1.5 shadow-2xl z-50 text-[12px] animate-in fade-in-50 slide-in-from-bottom-2 duration-100"
    >
      <div className="px-2 py-1 text-[10px] font-bold uppercase tracking-wider text-(--color-text-subtle)">
        Slash Commands
      </div>
      <div className="max-h-60 overflow-y-auto space-y-0.5">
        {filtered.map((item, index) => {
          const isSelected = index === selectedIndex
          return (
            <button
              key={item.command}
              type="button"
              onClick={() => {
                onSelect(item.command)
              }}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left transition-colors cursor-pointer',
                isSelected
                  ? 'bg-(--color-accent) text-white'
                  : 'text-(--color-text) hover:bg-(--color-surface-inset)',
              )}
            >
              <span className="text-base shrink-0">{item.icon}</span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5">
                  <span className="font-semibold">{item.command}</span>
                  <span
                    className={cn(
                      'text-[11px]',
                      isSelected ? 'text-white/80' : 'text-(--color-text-muted)',
                    )}
                  >
                    · {item.label}
                  </span>
                </div>
                <div
                  className={cn(
                    'text-[11px] truncate',
                    isSelected ? 'text-white/90' : 'text-(--color-text-subtle)',
                  )}
                >
                  {item.description}
                </div>
              </div>
            </button>
          )
        })}
      </div>
    </div>
  )
}
