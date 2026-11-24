import React, { useEffect, useRef, useState } from 'react'
import { Button, Input } from '@renderer/ui'

export interface LogLine {
  readonly id: string
  readonly timestamp: string
  readonly text: string
}

export interface LiveLogViewerProps {
  readonly logs: readonly LogLine[]
  readonly onClear?: () => void
}

export function LiveLogViewer({ logs, onClear }: LiveLogViewerProps): React.JSX.Element {
  const [autoscroll, setAutoscroll] = useState(true)
  const [isPaused, setIsPaused] = useState(false)
  const [frozenLogs, setFrozenLogs] = useState<readonly LogLine[] | null>(null)
  const [search, setSearch] = useState('')
  const scrollRef = useRef<HTMLDivElement>(null)

  const displayedLogs = isPaused && frozenLogs !== null ? frozenLogs : logs

  useEffect(() => {
    if (autoscroll && scrollRef.current !== null) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [displayedLogs, autoscroll])

  const filteredLogs = search.trim()
    ? displayedLogs.filter((l) => l.text.toLowerCase().includes(search.toLowerCase()))
    : displayedLogs

  const handleCopy = () => {
    const content = filteredLogs.map((l) => `[${l.timestamp}] ${l.text}`).join('\n')
    window.forge.clipboard.writeText(content).catch((cause: unknown) => {
      console.error('Could not copy the log to the clipboard', cause)
    })
  }

  const handleTogglePause = () => {
    if (isPaused) {
      setIsPaused(false)
      setFrozenLogs(null)
    } else {
      setIsPaused(true)
      setFrozenLogs(logs)
    }
  }

  return (
    <div className="flex h-full flex-col rounded-xl border border-(--color-border) bg-(--color-surface-inset) font-mono text-[12px] shadow-xs">
      {/* Header controls */}
      <div className="flex items-center justify-between border-b border-(--color-border) bg-(--color-surface-raised)/80 px-3 py-1.5 backdrop-blur-xs">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-(--color-text)">LIVE LOG</span>
          <span className="text-[10px] text-(--color-text-muted)">
            ({String(filteredLogs.length)} lines)
          </span>
        </div>

        <div className="flex items-center gap-1.5">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
            }}
            placeholder="Search log..."
            className="h-6 w-36 rounded-md text-[11px]"
          />

          <Button
            size="sm"
            variant={autoscroll ? 'primary' : 'secondary'}
            onClick={() => {
              setAutoscroll(!autoscroll)
            }}
            className="h-6 rounded-md px-2 text-[11px]"
          >
            {autoscroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
          </Button>

          <Button
            size="sm"
            variant={isPaused ? 'danger' : 'secondary'}
            onClick={handleTogglePause}
            className="h-6 rounded-md px-2 text-[11px]"
          >
            {isPaused ? 'Resume' : 'Pause'}
          </Button>

          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              handleCopy()
            }}
            className="h-6 rounded-md px-2 text-[11px]"
          >
            Copy
          </Button>

          {onClear !== undefined && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onClear()
              }}
              className="h-6 rounded-md px-2 text-[11px] text-(--color-text-muted)"
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Log content */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 leading-relaxed text-(--color-text) select-text"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-(--color-text-subtle)">
            No log output available.
          </div>
        ) : (
          filteredLogs.map((log) => (
            <div
              key={log.id}
              className="flex gap-2 py-0.5 hover:bg-(--color-surface-raised)/40 rounded-sm"
            >
              <span className="text-(--color-text-subtle) select-none">[{log.timestamp}]</span>
              <span className="break-all whitespace-pre-wrap">{log.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
