import React, { useEffect, useRef, useState } from 'react'
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
      className={`flex flex-col rounded-xl border border-(--color-border) bg-[#090b10] text-[#e2e8f0] shadow-md overflow-hidden ${
        className ?? ''
      }`}
    >
      {/* Terminal Title Bar */}
      <div className="flex items-center justify-between border-b border-slate-800 bg-[#0f131a] px-3.5 py-2">
        <div className="flex items-center gap-2.5">
          <div className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-full bg-rose-500/80" />
            <span className="size-2.5 rounded-full bg-amber-500/80" />
            <span className="size-2.5 rounded-full bg-emerald-500/80" />
          </div>

          <span className="ml-1 text-[11px] font-mono font-bold uppercase tracking-wider text-slate-300">
            {title}
          </span>

          {personaName && (
            <Badge tone="accent" size="sm" className="font-sans text-[10px] font-semibold">
              {personaName}
            </Badge>
          )}

          {runtimeId && (
            <Badge tone="neutral" size="sm" className="font-mono text-[10px] bg-slate-800 text-slate-300">
              {runtimeId}
            </Badge>
          )}

          {isRunning && (
            <span className="flex items-center gap-1.5 text-[10px] font-mono text-emerald-400">
              <span className="size-2 animate-ping rounded-full bg-emerald-400" />
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
              autoScroll ? 'bg-emerald-950/80 text-emerald-400 border border-emerald-800' : 'bg-slate-800 text-slate-400'
            }`}
          >
            {autoScroll ? 'Auto-scroll ON' : 'Auto-scroll OFF'}
          </button>

          <Button
            size="sm"
            variant="ghost"
            onClick={handleCopy}
            className="h-6 px-2 text-[10px] text-slate-400 hover:text-white"
          >
            Copy
          </Button>

          {onClear && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onClear}
              className="h-6 px-2 text-[10px] text-slate-400 hover:text-white"
            >
              Clear
            </Button>
          )}
        </div>
      </div>

      {/* Terminal Output Console */}
      <div
        ref={scrollRef}
        className="flex-1 p-4 font-mono text-[11px] leading-relaxed overflow-y-auto min-h-[180px] max-h-[360px] space-y-1 select-text"
      >
        {logs.length === 0 ? (
          <div className="text-slate-500 italic py-2">
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

            const isCommand = log.text.startsWith('$') || log.text.includes('[START]') || log.text.includes('[PLANNER]')

            return (
              <div key={log.id || `log-${String(index)}`} className="flex items-start gap-2.5">
                <span className="text-slate-600 shrink-0 select-none text-[10px]">{log.timestamp}</span>
                <span
                  className={
                    isError
                      ? 'text-rose-400 font-semibold'
                      : isSuccess
                        ? 'text-emerald-400'
                        : isCommand
                          ? 'text-cyan-300'
                          : 'text-slate-300'
                  }
                >
                  {log.text}
                </span>
              </div>
            )
          })
        )}

        {isRunning && (
          <div className="flex items-center gap-2 pt-1 text-emerald-400 font-mono">
            <span className="animate-pulse">▌</span>
            <span className="text-[10px] text-slate-500">Agent executing turn in worktree...</span>
          </div>
        )}
      </div>

      {/* Interactive Terminal Input Bar */}
      {onSendInput !== undefined && (
        <div className="flex items-center gap-2 border-t border-slate-800 bg-[#0d1017] p-2">
          <span className="pl-2 font-mono text-emerald-400 font-bold select-none">&gt;</span>
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
            placeholder="Send command or message to agent..."
            className="flex-1 bg-transparent font-mono text-[11px] text-slate-200 placeholder-slate-600 focus:outline-none"
          />
          <Button
            size="sm"
            variant="primary"
            onClick={handleSend}
            disabled={inputVal.trim() === ''}
            className="h-6 px-2.5 text-[10px] font-mono"
          >
            Send
          </Button>
        </div>
      )}
    </div>
  )
}
