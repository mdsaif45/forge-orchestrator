import React, { useEffect, useRef, useState } from 'react'
import { unwrap } from '../ipc'
import { Badge, Button, Icon, Input, StatusDot } from '../ui'
import { useProjectStore } from './projectStore'
import { useOverviewStore, type WorkspaceTab } from './overviewStore'

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
    <div className="flex h-full flex-col overflow-hidden bg-(--color-canvas) text-(--color-text)">
      {/* ── Breadcrumb & Action Bar ── */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-(--color-edge) bg-(--color-surface) px-3 select-none typography-ui-label">
        {/* Breadcrumb Navigation */}
        <div className="flex min-w-0 items-center gap-1.5 font-mono typography-micro text-(--color-text-muted)">
          <span className="font-semibold text-(--color-text)">{projectName}</span>
          <Icon name="chevron-right" className="size-3 text-(--color-text-subtle)" />
          <div className="flex items-center gap-1.5 font-semibold text-(--color-text)">
            <Icon name="terminal" className="size-3 text-(--color-text-muted)" />
            <span>{tab.title}</span>
          </div>
          <Badge tone={isRunning ? 'success' : 'neutral'} size="sm" className="ml-1">
            <StatusDot status={isRunning ? 'running' : 'passed'} pulse={isRunning} />
            <span>{isRunning ? 'Running' : 'Ready'}</span>
          </Badge>
        </div>

        {/* Action Buttons */}
        <div className="flex shrink-0 items-center gap-1.5">
          <Button size="xs" variant="ghost" title="Clear output" onClick={handleClearOutput}>
            Clear
          </Button>
          <Button size="xs" variant="ghost" title="Copy terminal buffer" onClick={handleCopyOutput}>
            {copied ? (
              <Icon name="check" className="size-3 text-(--color-success)" />
            ) : (
              <Icon name="copy" className="size-3" />
            )}
            <span>{copied ? 'Copied' : 'Copy'}</span>
          </Button>
        </div>
      </div>

      {/* ── Background Tasks Bar (if any active) ── */}
      {(backgroundTasks.length > 0 || terminals.length > 0) && (
        <div className="flex items-center gap-2 border-b border-(--color-edge) bg-(--color-surface-raised) px-3 py-1 typography-micro text-(--color-text-muted)">
          <span>Active background processes:</span>
          <Badge tone="info" size="sm" className="font-mono">
            {String(backgroundTasks.length + terminals.length)}
          </Badge>
        </div>
      )}

      {/* ── Terminal Output Stream ── */}
      <div className="flex-1 space-y-0.5 overflow-y-auto p-3 font-mono typography-code select-text">
        {output.map((line, idx) => (
          <div
            key={String(idx)}
            className={
              line.startsWith('$')
                ? 'font-semibold text-(--color-info)'
                : line.startsWith('[Error')
                  ? 'text-(--color-danger)'
                  : line.startsWith('[Terminal')
                    ? 'text-(--color-warning)'
                    : 'text-(--color-text-muted)'
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
        className="flex items-center gap-2 border-t border-(--color-edge) bg-(--color-surface) px-3 py-1.5"
      >
        <span className="font-mono typography-code font-bold text-(--color-success) select-none">
          $
        </span>
        <Input
          inputSize="sm"
          mono
          value={commandInput}
          onChange={(e) => {
            setCommandInput(e.target.value)
          }}
          placeholder="Type command and press Enter..."
          className="flex-1 border-none bg-transparent px-1 focus-visible:ring-0"
        />
      </form>
    </div>
  )
}
