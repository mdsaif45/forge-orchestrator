import React, { useEffect, useRef, useState } from 'react'
import { AnsiRenderer } from './AnsiRenderer'
import { Badge } from './Badge'
import { Button } from './Button'

export interface TerminalLogEntry {
  readonly id: string
  readonly timestamp: string
  readonly text: string
}

export interface AgentTerminalProps {
  readonly logs: readonly TerminalLogEntry[]
  readonly title?: string | undefined
  readonly personaName?: string | undefined
  readonly runtimeId?: string | null | undefined
  readonly repositoryPath?: string | undefined
  readonly isRunning?: boolean | undefined
  readonly onSendInput?: ((text: string) => void) | undefined
  readonly onClear?: (() => void) | undefined
  readonly className?: string | undefined
}

export function AgentTerminal({
  logs,
  title = 'Live Agent Terminal',
  personaName,
  runtimeId,
  repositoryPath,
  isRunning = false,
  onSendInput,
  onClear,
  className,
}: AgentTerminalProps): React.JSX.Element {
  const [autoScroll, setAutoScroll] = useState<boolean>(true)
  const [inputVal, setInputVal] = useState<string>('')
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (autoScroll && scrollRef.current !== null) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [logs, autoScroll])

  const handleSend = (): void => {
    if (inputVal.trim() === '') return
    onSendInput?.(inputVal)
    setInputVal('')
  }

  const handleCopy = (): void => {
    const text = logs.map((l) => `${l.timestamp} ${l.text}`).join('\n')
    void navigator.clipboard.writeText(text)
  }

  return (
    <div
      className={`flex flex-col rounded-xl border border-(--color-border) bg-(--color-surface-inset) text-(--color-text) shadow-sm overflow-hidden transition-colors duration-(--duration-fast) ${
        className ?? ''
      }`}
    >
      {/* Terminal Title Bar with Window Controls & Status */}
      <div className="flex items-center justify-between border-b border-(--color-border) bg-(--color-surface-raised) px-3.5 py-2 select-none">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-(--color-danger)/80" />
            <span className="size-2.5 rounded-full bg-(--color-warning)/80" />
            <span className="size-2.5 rounded-full bg-(--color-success)/80" />
          </div>

          <span className="ml-1 text-[11px] font-mono font-bold uppercase tracking-wider text-(--color-text-subtle)">
            {title}
          </span>

          {personaName && (
            <Badge tone="accent" size="sm" className="font-sans text-[10px] font-semibold">
              {personaName}
            </Badge>
          )}

          {runtimeId && (
            <Badge tone="neutral" size="sm" className="font-mono text-[10px]">
              {runtimeId}
            </Badge>
          )}

          {isRunning && (
            <span className="flex items-center gap-1.5 text-[10px] font-mono text-(--color-success) font-semibold">
              <span className="size-2 animate-ping rounded-full bg-(--color-success)" />
              RUNNING
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-[11px]">
          <button
            type="button"
            onClick={() => {
              setAutoScroll(!autoScroll)
            }}
            className={`rounded px-2 py-0.5 text-[10px] font-mono transition-colors cursor-pointer ${
              autoScroll
                ? 'bg-(--color-success-muted) text-(--color-success) border border-(--color-success)/30'
                : 'bg-(--color-surface) text-(--color-text-muted) border border-(--color-border)'
            }`}
          >
            {autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
          </button>

          <Button
            size="sm"
            variant="ghost"
            onClick={handleCopy}
            className="h-6 px-2 text-[10px] text-(--color-text-muted) hover:text-(--color-text)"
          >
            Copy
          </Button>

          {onClear && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onClear}
              className="h-6 px-2 text-[10px] text-(--color-text-muted) hover:text-(--color-text)"
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Terminal Output Stream */}
      <div
        ref={scrollRef}
        className="flex-1 p-4 font-mono text-[11px] leading-relaxed overflow-y-auto min-h-[220px] max-h-[420px] space-y-1.5 select-text bg-(--color-surface-inset)"
      >
        {/* Authentic CLI Header Banner */}
        <div className="mb-3 rounded border border-(--color-border)/60 bg-(--color-surface)/40 p-2.5 text-[10px] font-mono text-(--color-text-muted) space-y-1">
          <div className="flex items-center justify-between text-(--color-accent)">
            <span className="font-bold">⚡ Forge Agent Runtime • Interactive Session</span>
            <span>{runtimeId ?? 'primary-engine'}</span>
          </div>
          {repositoryPath && (
            <div className="truncate text-(--color-text-subtle)">
              Workspace: <span className="text-(--color-text)">{repositoryPath}</span>
            </div>
          )}
          {personaName && (
            <div>
              Active Persona: <span className="font-semibold text-(--color-text)">{personaName}</span>
            </div>
          )}
        </div>

        {logs.length === 0 ? (
          <div className="text-(--color-text-subtle) italic py-2">
            No console output yet. Agent terminal session will stream live output here.
          </div>
        ) : (
          logs.map((log, index) => {
            const isError =
              log.text.includes('FAIL') ||
              log.text.includes('HALTED') ||
              log.text.includes('Halted') ||
              log.text.includes('error') ||
              log.text.includes('Error')

            const isSuccess =
              log.text.includes('PASS') ||
              log.text.includes('DONE') ||
              log.text.includes('verified') ||
              log.text.includes('SUCCESS')

            const isCommand =
              log.text.startsWith('$') ||
              log.text.includes('[START]') ||
              log.text.includes('[PLANNER]') ||
              log.text.startsWith('>')

            const isThinking =
              log.text.startsWith('* ') ||
              log.text.includes('Cooked for') ||
              log.text.includes('Churned for') ||
              log.text.includes('thinking')

            return (
              <div key={log.id || `log-${String(index)}`} className="flex items-start gap-2.5">
                <span className="text-(--color-text-subtle) shrink-0 select-none text-[10px] pt-0.5">
                  {log.timestamp}
                </span>
                <span
                  className={
                    isError
                      ? 'text-(--color-danger) font-semibold'
                      : isSuccess
                        ? 'text-(--color-success) font-medium'
                        : isThinking
                          ? 'text-(--color-text-muted) italic'
                          : isCommand
                            ? 'text-(--color-accent) font-semibold'
                            : 'text-(--color-text)'
                  }
                >
                  <AnsiRenderer text={log.text} />
                </span>
              </div>
            )
          })
        )}

        {isRunning && (
          <div className="flex items-center gap-2 pt-1 text-(--color-accent) font-mono">
            <span className="animate-pulse">▌</span>
            <span className="text-[10px] text-(--color-text-subtle)">Agent executing turn in worktree...</span>
          </div>
        )}
      </div>

      {/* Interactive Terminal Prompt & Input Bar */}
      {onSendInput !== undefined && (
        <div className="flex items-center gap-2 border-t border-(--color-border) bg-(--color-surface) p-2">
          <span className="pl-2 font-mono text-(--color-accent) font-bold select-none">&gt;</span>
          <input
            type="text"
            value={inputVal}
            onChange={(e) => {
              setInputVal(e.target.value)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleSend()
              }
            }}
            placeholder="Type prompt or command for agent session (e.g. 'tell me about the architecture')..."
            className="flex-1 bg-transparent font-mono text-[11px] text-(--color-text) placeholder-(--color-text-subtle) focus:outline-none"
          />
          <Button
            size="sm"
            variant="primary"
            onClick={handleSend}
            disabled={inputVal.trim() === ''}
            className="h-6 px-2.5 text-[10px] font-mono font-semibold"
          >
            Send
          </Button>
        </div>
      )}
    </div>
  )
}
