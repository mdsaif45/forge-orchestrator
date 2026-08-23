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
    void navigator.clipboard.writeText(content)
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
    <div className="flex h-full flex-col rounded-lg border border-neutral-800 bg-neutral-950 font-mono text-xs">
      {/* Header controls */}
      <div className="flex items-center justify-between border-b border-neutral-800 bg-neutral-900/60 px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-neutral-300">LIVE LOG</span>
          <span className="text-[10px] text-neutral-500">
            ({String(filteredLogs.length)} lines)
          </span>
        </div>

        <div className="flex items-center gap-2">
          <Input
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
            }}
            placeholder="Search log..."
            className="h-7 w-40 text-xs"
          />

          <Button
            size="sm"
            variant={autoscroll ? 'primary' : 'secondary'}
            onClick={() => {
              setAutoscroll(!autoscroll)
            }}
            className="h-7 text-xs"
          >
            {autoscroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
          </Button>

          <Button
            size="sm"
            variant={isPaused ? 'danger' : 'secondary'}
            onClick={handleTogglePause}
            className="h-7 text-xs"
          >
            {isPaused ? 'Resume' : 'Pause'}
          </Button>

          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              handleCopy()
            }}
            className="h-7 text-xs"
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
              className="h-7 text-xs text-neutral-400"
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Log content */}
      <div
        ref={scrollRef}
        className="flex-1 overflow-y-auto p-3 leading-relaxed text-neutral-300 select-text"
      >
        {filteredLogs.length === 0 ? (
          <div className="flex h-full items-center justify-center text-neutral-600">
            No log output available.
          </div>
        ) : (
          filteredLogs.map((log) => (
            <div key={log.id} className="flex gap-2 py-0.5 hover:bg-neutral-900/40">
              <span className="text-neutral-600 select-none">[{log.timestamp}]</span>
              <span className="break-all whitespace-pre-wrap">{log.text}</span>
            </div>
          ))
        )}
      </div>
    </div>
  )
}
