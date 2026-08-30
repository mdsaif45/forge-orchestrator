import React, { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { unwrap } from '@renderer/ipc'
import { useTheme } from '../theme'
import { Badge } from './Badge'
import { Button } from './Button'

export interface RealTerminalProps {
  readonly projectId: string
  readonly command?: string | undefined
  readonly args?: readonly string[] | undefined
  readonly cwd?: string | undefined
  readonly title?: string | undefined
  readonly personaName?: string | undefined
  readonly runtimeId?: string | null | undefined
  readonly className?: string | undefined
  readonly onExit?: ((exitCode: number | null) => void) | undefined
}

export function RealTerminal({
  projectId,
  command,
  args,
  cwd,
  title = 'Interactive Agent Terminal',
  personaName,
  runtimeId,
  className,
  onExit,
}: RealTerminalProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalInstanceRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState<boolean>(true)
  const { theme } = useTheme()

  const isLight =
    theme === 'light' ||
    theme === 'azure' ||
    (theme === 'system' &&
      typeof window !== 'undefined' &&
      !window.matchMedia('(prefers-color-scheme: dark)').matches)

  const terminalIdRef = useRef<string | null>(null)
  const onExitRef = useRef(onExit)

  useEffect(() => {
    onExitRef.current = onExit
  }, [onExit])

  // Initialize Terminal & FitAddon
  useEffect(() => {
    if (containerRef.current === null) return

    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', 'Fira Code', 'Cascadia Code', Menlo, monospace",
      fontSize: 12,
      lineHeight: 1.35,
      theme: isLight
        ? {
            background: '#f4f4f0',
            foreground: '#1f1f1e',
            cursor: '#c2410c',
            selectionBackground: '#fed7aa',
            black: '#1f1f1e',
            red: '#b91c1c',
            green: '#15803d',
            yellow: '#b45309',
            blue: '#1d4ed8',
            magenta: '#7e22ce',
            cyan: '#0369a1',
            white: '#6b6b66',
            brightBlack: '#94948d',
            brightRed: '#dc2626',
            brightGreen: '#16a34a',
            brightYellow: '#d97706',
            brightBlue: '#2563eb',
            brightMagenta: '#9333ea',
            brightCyan: '#0284c7',
            brightWhite: '#18181b',
          }
        : {
            background: '#0e0e10',
            foreground: '#f4f4f5',
            cursor: '#f97316',
            selectionBackground: '#332014',
            black: '#18181b',
            red: '#f87171',
            green: '#34d399',
            yellow: '#fbbf24',
            blue: '#60a5fa',
            magenta: '#c084fc',
            cyan: '#38bdf8',
            white: '#e4e4e7',
            brightBlack: '#71717a',
            brightRed: '#ef4444',
            brightGreen: '#10b981',
            brightYellow: '#f59e0b',
            brightBlue: '#3b82f6',
            brightMagenta: '#a855f7',
            brightCyan: '#06b6d4',
            brightWhite: '#ffffff',
          },
      allowTransparency: false,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.open(containerRef.current)

    terminalInstanceRef.current = term
    fitAddonRef.current = fitAddon

    // Initial fit
    setTimeout(() => {
      try {
        fitAddon.fit()
      } catch {
        // ignore initial fit error before render
      }
    }, 50)

    // Resize observer
    const resizeObserver = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        if (terminalIdRef.current !== null) {
          void window.forge.terminal.resize(terminalIdRef.current, term.cols, term.rows)
        }
      } catch {
        // ignore fit resize error
      }
    })
    resizeObserver.observe(containerRef.current)

    return () => {
      resizeObserver.disconnect()
      term.dispose()
      terminalInstanceRef.current = null
      fitAddonRef.current = null
    }
  }, [isLight])

  // Spawn Terminal Session
  useEffect(() => {
    let cancelled = false
    let activeTermId: string | null = null

    const term = terminalInstanceRef.current
    if (term === null) return

    window.forge.terminal
      .spawn({
        projectId,
        ...(runtimeId !== null && runtimeId !== undefined ? { runtimeId } : {}),
        ...(command !== undefined ? { command } : {}),
        ...(args !== undefined ? { args } : {}),
        ...(cwd !== undefined ? { cwd } : {}),
        cols: term.cols,
        rows: term.rows,
      })
      .then((res) => {
        if (cancelled) return
        const spawned = unwrap(res)
        activeTermId = spawned.terminalId
        terminalIdRef.current = spawned.terminalId
        setTerminalId(spawned.terminalId)
        setIsRunning(true)

        // Send keystrokes directly to the PTY
        const dataListener = term.onData((data) => {
          if (activeTermId !== null) {
            void window.forge.terminal.write(activeTermId, data)
          }
        })

        // Listen for output streaming from PTY
        const unsubData = window.forge.onTerminalData((payload) => {
          if (payload.terminalId === activeTermId) {
            term.write(payload.chunk)
          }
        })

        // Listen for process exit
        const unsubExit = window.forge.onTerminalExit((payload) => {
          if (payload.terminalId === activeTermId) {
            setIsRunning(false)
            onExitRef.current?.(payload.exitCode)
          }
        })

        return () => {
          dataListener.dispose()
          unsubData()
          unsubExit()
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return
        term.writeln(
          `\r\n\x1b[31m[Error] Failed to spawn terminal: ${err instanceof Error ? err.message : String(err)}\x1b[0m`,
        )
        setIsRunning(false)
      })

    return () => {
      cancelled = true
      if (activeTermId !== null) {
        void window.forge.terminal.kill(activeTermId)
      }
    }
  }, [projectId, runtimeId, command, cwd, args])

  const handleClear = (): void => {
    terminalInstanceRef.current?.clear()
  }

  const handleRestart = (): void => {
    terminalInstanceRef.current?.reset()
    if (terminalId !== null) {
      void window.forge.terminal.kill(terminalId)
    }
    // Re-trigger spawn
    setTerminalId(null)
  }

  return (
    <div
      className={`flex flex-col rounded-xl border border-(--color-border) bg-(--color-surface-inset) shadow-sm overflow-hidden ${
        className ?? ''
      }`}
    >
      {/* Terminal Title Bar */}
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

          {isRunning ? (
            <span className="flex items-center gap-1.5 text-[10px] font-mono text-(--color-success) font-semibold">
              <span className="size-2 animate-ping rounded-full bg-(--color-success)" />
              LIVE PTY
            </span>
          ) : (
            <Badge tone="neutral" size="sm" className="text-[10px]">
              Exited
            </Badge>
          )}
        </div>

        <div className="flex items-center gap-1.5 text-[11px]">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleClear}
            className="h-6 px-2 text-[10px] text-(--color-text-muted) hover:text-(--color-text)"
          >
            Clear
          </Button>

          <Button
            size="sm"
            variant="ghost"
            onClick={handleRestart}
            className="h-6 px-2 text-[10px] text-(--color-text-muted) hover:text-(--color-text)"
          >
            Restart
          </Button>
        </div>
      </div>

      {/* Real XTerm Canvas Container */}
      <div
        ref={containerRef}
        className="flex-1 p-2 min-h-[300px] overflow-hidden bg-(--color-surface-inset)"
      />
    </div>
  )
}
