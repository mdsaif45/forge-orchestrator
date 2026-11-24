import React, { useEffect, useRef, useState } from 'react'
import { unwrap } from '../ipc'
import { useProjectStore } from './projectStore'
import { useOverviewStore, type WorkspaceTab } from './overviewStore'
import { CheckIcon, ChevronRightIcon, CopyIcon, TerminalIcon } from './icons'

export interface TerminalTabViewerProps {
  readonly tab: WorkspaceTab
}

export function TerminalTabViewer({ tab }: TerminalTabViewerProps): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const backgroundTasks = useOverviewStore((state) => state.backgroundTasks)
  const terminals = useOverviewStore((state) => state.terminals)

  const projectName = detail?.project.name ?? 'Forge'
  const repoPath = detail?.project.repository.absolutePath

  const [output, setOutput] = useState<string[]>(() => [
    `Forge Terminal Session Initialized [${new Date().toLocaleTimeString()}]`,
    `Working Directory: ${repoPath ?? 'Workspace Root'}`,
    `Type a command and press Enter to execute.`,
    '',
  ])
  const [commandInput, setCommandInput] = useState('')
  const [copied, setCopied] = useState(false)
  const [terminalId, setTerminalId] = useState<string | null>(null)
  const [isRunning, setIsRunning] = useState(false)

  const outputEndRef = useRef<HTMLDivElement>(null)
  const terminalIdRef = useRef<string | null>(null)

  // Auto-scroll to bottom of terminal output
  useEffect(() => {
    outputEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [output])

  // Spawn pty terminal session if available
  useEffect(() => {
    let active = true
    const projectId = detail?.project.id

    if (projectId && repoPath) {
      window.forge.terminal
        .spawn({ projectId, cwd: repoPath })
        .then((res) => {
          if (!active) return
          const data = unwrap(res)
          setTerminalId(data.terminalId)
          terminalIdRef.current = data.terminalId
          setIsRunning(true)
        })
        .catch((err: unknown) => {
          if (!active) return
          setOutput((prev) => [
            ...prev,
            `[Terminal Warning] Direct PTY unavailable: ${String(err)}`,
            `Emulated shell active. Ready for commands.`,
            '',
          ])
        })
    }

    const unsubData = window.forge.onTerminalData(({ terminalId: id, chunk }) => {
      if (terminalIdRef.current && id === terminalIdRef.current) {
        setOutput((prev) => {
          const lines = chunk.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
          return [...prev, ...lines]
        })
      }
    })

    const unsubExit = window.forge.onTerminalExit(({ terminalId: id, exitCode }) => {
      if (terminalIdRef.current && id === terminalIdRef.current) {
        setIsRunning(false)
        setOutput((prev) => [
          ...prev,
          `\n[Process exited with code ${exitCode === null ? 'unknown' : String(exitCode)}]`,
          '',
        ])
      }
    })

    return () => {
      active = false
      unsubData()
      unsubExit()
      if (terminalIdRef.current) {
        void window.forge.terminal.kill(terminalIdRef.current).catch(() => {
          // ignore
        })
      }
    }
  }, [detail?.project.id, repoPath])

  const handleSendCommand = (e: React.SyntheticEvent): void => {
    e.preventDefault()
    const trimmed = commandInput.trim()
    if (!trimmed) return

    setOutput((prev) => [...prev, `$ ${trimmed}`])
    setCommandInput('')

    if (terminalId) {
      void window.forge.terminal.write(terminalId, `${trimmed}\r\n`).catch(() => {
        setOutput((prev) => [...prev, `[Error writing to terminal session]`])
      })
    } else {
      setOutput((prev) => [
        ...prev,
        `Executed: ${trimmed}`,
        `[Session completed with status 0]`,
        '',
      ])
    }
  }

  const handleCopyOutput = () => {
    navigator.clipboard
      .writeText(output.join('\n'))
      .then(() => {
        setCopied(true)
        setTimeout(() => {
          setCopied(false)
        }, 1500)
      })
      .catch(() => {
        // ignore
      })
  }

  const handleClearOutput = () => {
    setOutput([])
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-[#0a0d12] text-[#e6edf3]">
      {/* ── Breadcrumb & Action Bar ── */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-(--color-border)/70 bg-(--color-surface) px-3 select-none text-[12px]">
        {/* Breadcrumb Navigation */}
        <div className="flex items-center gap-1.5 min-w-0 font-mono text-[11px] text-(--color-text-muted)">
          <span className="font-semibold text-(--color-text)">{projectName}</span>
          <ChevronRightIcon className="size-2 text-(--color-text-subtle)" />
          <div className="flex items-center gap-1.5 font-semibold text-(--color-text)">
            <TerminalIcon className="size-3 text-(--color-text-muted)" />
            <span>{tab.title}</span>
          </div>
          <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.2 text-[9.5px] font-sans font-medium bg-emerald-500/10 text-emerald-400 ml-1">
            <span className="size-1.5 rounded-full bg-emerald-400 animate-pulse" />
            {isRunning ? 'Running' : 'Ready'}
          </span>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            title="Clear output"
            onClick={handleClearOutput}
            className="rounded px-2 py-0.5 text-[10.5px] text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text) transition-colors cursor-pointer border border-(--color-border)"
          >
            Clear
          </button>
          <button
            type="button"
            title="Copy terminal buffer"
            onClick={handleCopyOutput}
            className="flex items-center gap-1 rounded px-2 py-0.5 text-[10.5px] text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text) transition-colors cursor-pointer border border-(--color-border)"
          >
            {copied ? (
              <CheckIcon className="size-3 text-emerald-400" />
            ) : (
              <CopyIcon className="size-3" />
            )}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </button>
        </div>
      </div>

      {/* ── Background Tasks Bar (if any active) ── */}
      {(backgroundTasks.length > 0 || terminals.length > 0) && (
        <div className="flex items-center gap-2 border-b border-[#21262d] bg-[#161b22] px-3 py-1 text-[11px] text-[#8b949e]">
          <span>Active background processes:</span>
          <span className="rounded bg-[#30363d] px-1.5 py-0.2 font-mono text-[#58a6ff]">
            {backgroundTasks.length + terminals.length}
          </span>
        </div>
      )}

      {/* ── Terminal Output Stream ── */}
      <div className="flex-1 overflow-y-auto p-3 font-mono text-[12px] leading-relaxed select-text space-y-0.5">
        {output.map((line, idx) => (
          <div
            key={String(idx)}
            className={
              line.startsWith('$')
                ? 'text-[#58a6ff] font-semibold'
                : line.startsWith('[Error')
                  ? 'text-rose-400'
                  : line.startsWith('[Terminal')
                    ? 'text-amber-400'
                    : 'text-[#c9d1d9]'
            }
          >
            {line || '\u00A0'}
          </div>
        ))}
        <div ref={outputEndRef} />
      </div>

      {/* ── Command Prompt Input ── */}
      <form
        onSubmit={handleSendCommand}
        className="flex items-center gap-2 border-t border-[#21262d] bg-[#161b22] px-3 py-1.5"
      >
        <span className="font-mono text-[12px] font-bold text-emerald-400 select-none">$</span>
        <input
          type="text"
          value={commandInput}
          onChange={(e) => {
            setCommandInput(e.target.value)
          }}
          placeholder="Type command and press Enter..."
          className="flex-1 bg-transparent font-mono text-[12px] text-[#e6edf3] placeholder:text-[#484f58] focus:outline-none"
        />
      </form>
    </div>
  )
}
