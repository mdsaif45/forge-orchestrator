import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useDevConsoleStore } from './devConsoleStore'
import { cn } from '../ui'

function getString(val: unknown, fallback: string): string {
  return typeof val === 'string' && val.length > 0 ? val : fallback
}

function getNumber(val: unknown, fallback: number): number {
  return typeof val === 'number' && !Number.isNaN(val) ? val : fallback
}

function parseUsage(resp: Record<string, unknown> | undefined) {
  if (!resp || typeof resp !== 'object') return undefined
  const usageObj = resp.usage as Record<string, unknown> | undefined
  if (!usageObj || typeof usageObj !== 'object') return undefined
  return {
    inputTokens: typeof usageObj.inputTokens === 'number' ? usageObj.inputTokens : undefined,
    outputTokens: typeof usageObj.outputTokens === 'number' ? usageObj.outputTokens : undefined,
    totalTokens: typeof usageObj.totalTokens === 'number' ? usageObj.totalTokens : undefined,
    tokensPerSec: typeof usageObj.tokensPerSec === 'number' ? usageObj.tokensPerSec : undefined,
  }
}

export function DevConsole(): React.JSX.Element | null {
  const isOpen = useDevConsoleStore((state) => state.isOpen)
  const closeDevConsole = useDevConsoleStore((state) => state.closeDevConsole)
  const dockPosition = useDevConsoleStore((state) => state.dockPosition)
  const setDockPosition = useDevConsoleStore((state) => state.setDockPosition)
  const bottomHeightPct = useDevConsoleStore((state) => state.bottomHeightPct)
  const setBottomHeightPct = useDevConsoleStore((state) => state.setBottomHeightPct)
  const rightWidthPx = useDevConsoleStore((state) => state.rightWidthPx)
  const setRightWidthPx = useDevConsoleStore((state) => state.setRightWidthPx)
  const transactions = useDevConsoleStore((state) => state.transactions)
  const recordTransaction = useDevConsoleStore((state) => state.recordTransaction)
  const selectedTransactionId = useDevConsoleStore((state) => state.selectedTransactionId)
  const selectTransaction = useDevConsoleStore((state) => state.selectTransaction)
  const clearTransactions = useDevConsoleStore((state) => state.clearTransactions)
  const filterText = useDevConsoleStore((state) => state.filterText)
  const setFilterText = useDevConsoleStore((state) => state.setFilterText)

  const [activeTab, setActiveTab] = useState<'request' | 'response' | 'tools' | 'headers'>(
    'request',
  )
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const [isDragging, setIsDragging] = useState(false)
  const dragStartY = useRef<number>(0)
  const dragStartX = useRef<number>(0)
  const dragStartVal = useRef<number>(0)

  // Listen to low-level model calls from main process tracker
  useEffect(() => {
    // Initial fetch of recent calls
    if (window.forge.dev) {
      window.forge.dev
        .getModelCalls()
        .then((res) => {
          if (res.ok && Array.isArray(res.value.calls)) {
            for (const call of res.value.calls) {
              const raw = call as Record<string, unknown>
              const id = getString(raw.id, `call-${String(Date.now())}`)
              const req = (raw.request ?? {}) as Record<string, unknown>
              const resp = raw.response as Record<string, unknown> | undefined
              const toolExecs = raw.toolExecutions as unknown[] | undefined

              recordTransaction({
                id,
                timestamp: getNumber(raw.timestamp, Date.now()),
                timeFormatted: getString(raw.timeFormatted, new Date().toLocaleTimeString()),
                type: 'model_call',
                status: resp ? (resp.error ? 'error' : 'success') : 'pending',
                statusCode: getNumber(resp?.status, resp ? 200 : 0),
                durationMs: resp ? getNumber(resp.durationMs, 0) : undefined,
                model: getString(raw.model, 'unknown'),
                providerId: getString(raw.providerId, 'unknown'),
                endpointUrl: getString(raw.endpointUrl, ''),
                round: raw.round !== undefined ? getNumber(raw.round, 0) : undefined,
                request: {
                  method: getString(req.method, 'POST'),
                  url: getString(raw.endpointUrl, ''),
                  headers: (req.headers ?? {}) as Record<string, string>,
                  body: req.body,
                },
                response: resp
                  ? {
                      status: getNumber(resp.status, 200),
                      statusText: getString(resp.statusText, 'OK'),
                      durationMs: getNumber(resp.durationMs, 0),
                      content: typeof resp.content === 'string' ? resp.content : undefined,
                      reasoning: typeof resp.reasoning === 'string' ? resp.reasoning : undefined,
                      rawBody: resp.rawBody,
                      error: typeof resp.error === 'string' ? resp.error : null,
                      usage: parseUsage(resp),
                    }
                  : undefined,
                toolExecutions: Array.isArray(toolExecs)
                  ? toolExecs.map((e) => {
                      const rec = e as Record<string, unknown>
                      return {
                        name: getString(rec.name, 'tool'),
                        args: rec.args,
                        ok: Boolean(rec.ok),
                        output: getString(rec.output, ''),
                        durationMs:
                          rec.durationMs !== undefined ? getNumber(rec.durationMs, 0) : undefined,
                      }
                    })
                  : undefined,
              })
            }
          }
        })
        .catch(() => {
          // Dev endpoint only
        })
    }

    const unsubscribe = window.forge.onDevModelCall?.((newCall) => {
      const raw = newCall as Record<string, unknown>
      const id = getString(raw.id, `call-${String(Date.now())}`)
      const req = (raw.request ?? {}) as Record<string, unknown>
      const resp = raw.response as Record<string, unknown> | undefined
      const toolExecs = raw.toolExecutions as unknown[] | undefined

      recordTransaction({
        id,
        timestamp: getNumber(raw.timestamp, Date.now()),
        timeFormatted: getString(raw.timeFormatted, new Date().toLocaleTimeString()),
        type: 'model_call',
        status: resp ? (resp.error ? 'error' : 'success') : 'pending',
        statusCode: getNumber(resp?.status, resp ? 200 : 0),
        durationMs: resp ? getNumber(resp.durationMs, 0) : undefined,
        model: getString(raw.model, 'unknown'),
        providerId: getString(raw.providerId, 'unknown'),
        endpointUrl: getString(raw.endpointUrl, ''),
        round: raw.round !== undefined ? getNumber(raw.round, 0) : undefined,
        request: {
          method: getString(req.method, 'POST'),
          url: getString(raw.endpointUrl, ''),
          headers: (req.headers ?? {}) as Record<string, string>,
          body: req.body,
        },
        response: resp
          ? {
              status: getNumber(resp.status, 200),
              statusText: getString(resp.statusText, 'OK'),
              durationMs: getNumber(resp.durationMs, 0),
              content: typeof resp.content === 'string' ? resp.content : undefined,
              reasoning: typeof resp.reasoning === 'string' ? resp.reasoning : undefined,
              rawBody: resp.rawBody,
              error: typeof resp.error === 'string' ? resp.error : null,
              usage: parseUsage(resp),
            }
          : undefined,
        toolExecutions: Array.isArray(toolExecs)
          ? toolExecs.map((e) => {
              const rec = e as Record<string, unknown>
              return {
                name: getString(rec.name, 'tool'),
                args: rec.args,
                ok: Boolean(rec.ok),
                output: getString(rec.output, ''),
                durationMs: rec.durationMs !== undefined ? getNumber(rec.durationMs, 0) : undefined,
              }
            })
          : undefined,
      })
    })

    return () => {
      unsubscribe?.()
    }
  }, [recordTransaction])

  // Drag resizer handling
  useEffect(() => {
    if (!isDragging) return undefined

    const handleMouseMove = (e: MouseEvent): void => {
      if (dockPosition === 'bottom') {
        const deltaY = dragStartY.current - e.clientY
        const deltaPct = (deltaY / window.innerHeight) * 100
        setBottomHeightPct(dragStartVal.current + deltaPct)
      } else {
        const deltaX = dragStartX.current - e.clientX
        setRightWidthPx(dragStartVal.current + deltaX)
      }
    }

    const handleMouseUp = (): void => {
      setIsDragging(false)
    }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mouseup', handleMouseUp)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mouseup', handleMouseUp)
    }
  }, [isDragging, dockPosition, setBottomHeightPct, setRightWidthPx])

  const handleStartDrag = (e: React.MouseEvent): void => {
    e.preventDefault()
    setIsDragging(true)
    if (dockPosition === 'bottom') {
      dragStartY.current = e.clientY
      dragStartVal.current = bottomHeightPct
    } else {
      dragStartX.current = e.clientX
      dragStartVal.current = rightWidthPx
    }
  }

  const handleCopy = (text: string, id: string): void => {
    void navigator.clipboard.writeText(text)
    setCopiedId(id)
    setTimeout(() => {
      setCopiedId(null)
    }, 1500)
  }

  const filtered = useMemo(() => {
    if (filterText.trim() === '') return transactions
    const q = filterText.toLowerCase()
    return transactions.filter(
      (t) =>
        t.model.toLowerCase().includes(q) ||
        t.endpointUrl.toLowerCase().includes(q) ||
        t.providerId.toLowerCase().includes(q) ||
        t.request.method.toLowerCase().includes(q) ||
        (t.request.promptSummary?.toLowerCase().includes(q) ?? false) ||
        (t.response?.error?.toLowerCase().includes(q) ?? false) ||
        (t.toolExecutions?.some((te) => te.name.toLowerCase().includes(q)) ?? false),
    )
  }, [transactions, filterText])

  const selectedTx =
    transactions.find((t) => t.id === selectedTransactionId) ?? filtered[filtered.length - 1]

  if (!isOpen) return null

  return (
    <div
      style={
        dockPosition === 'bottom'
          ? { height: `${String(bottomHeightPct)}vh`, minHeight: '140px', maxHeight: '75vh' }
          : { width: `${String(rightWidthPx)}px`, minWidth: '280px', maxWidth: '80vw' }
      }
      className={cn(
        'z-30 flex flex-col border-(--color-border) bg-[#0e0e11] text-[#e0e0e6] shadow-2xl select-text font-mono text-[11.5px] shrink-0',
        dockPosition === 'bottom' ? 'w-full border-t relative' : 'h-full border-l relative',
      )}
    >
      {/* Drag handle */}
      <div
        onMouseDown={handleStartDrag}
        className={cn(
          'group flex items-center justify-center bg-[#18181d] hover:bg-(--color-accent)/30 transition-colors z-10',
          dockPosition === 'bottom'
            ? 'h-2 w-full cursor-row-resize border-b border-white/5'
            : 'w-2 h-full cursor-col-resize border-r border-white/5 absolute top-0 left-0 bottom-0',
        )}
      >
        <div
          className={cn(
            'rounded-full bg-neutral-600 group-hover:bg-(--color-accent)',
            dockPosition === 'bottom' ? 'h-0.5 w-12' : 'w-0.5 h-12',
          )}
        />
      </div>

      {/* Header bar */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-white/10 bg-[#131317] px-3">
        {/* Left: title & count */}
        <div className="flex items-center gap-2">
          <span className="flex h-2 w-2 rounded-full bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.6)]" />
          <span className="font-bold tracking-wide text-white text-[12px]">DEV CONSOLE</span>
          <span className="rounded bg-white/10 px-1.5 py-0.5 text-[9.5px] font-semibold text-neutral-300">
            NETWORK TRANSACTIONS
          </span>
          <span className="text-neutral-400 text-[11px]">({transactions.length})</span>
        </div>

        {/* Center: Search / Filter */}
        <div className="flex items-center gap-2 max-w-sm flex-1 mx-4">
          <input
            type="text"
            value={filterText}
            onChange={(e) => {
              setFilterText(e.target.value)
            }}
            placeholder="Filter by endpoint, model, tool, payload..."
            className="w-full rounded border border-white/10 bg-[#09090c] px-2 py-0.8 text-[11px] text-neutral-200 placeholder:text-neutral-500 focus:border-(--color-accent) focus:outline-none"
          />
        </div>

        {/* Right: Size Slider, Dock switcher, Clear, Close */}
        <div className="flex items-center gap-3">
          {/* Size slider */}
          <div className="flex items-center gap-1.5 text-[10px] text-neutral-400">
            <span>Size:</span>
            {dockPosition === 'bottom' ? (
              <input
                type="range"
                min={15}
                max={80}
                value={bottomHeightPct}
                onChange={(e) => {
                  setBottomHeightPct(Number(e.target.value))
                }}
                className="w-20 cursor-pointer accent-(--color-accent)"
                title={`Screen Height: ${String(bottomHeightPct)}%`}
              />
            ) : (
              <input
                type="range"
                min={300}
                max={900}
                value={rightWidthPx}
                onChange={(e) => {
                  setRightWidthPx(Number(e.target.value))
                }}
                className="w-20 cursor-pointer accent-(--color-accent)"
                title={`Screen Width: ${String(rightWidthPx)}px`}
              />
            )}
            <span className="w-8 text-right font-mono text-neutral-300">
              {dockPosition === 'bottom'
                ? `${String(bottomHeightPct)}%`
                : `${String(rightWidthPx)}px`}
            </span>
          </div>

          <div className="h-3.5 w-px bg-white/10" />

          {/* Dock position toggle button */}
          <button
            type="button"
            onClick={() => {
              setDockPosition(dockPosition === 'bottom' ? 'right' : 'bottom')
            }}
            title={
              dockPosition === 'bottom'
                ? 'Dock console to Right'
                : 'Dock console to Bottom (1/4 screen)'
            }
            className="flex items-center gap-1 rounded px-1.5 py-1 text-[11px] text-neutral-300 hover:bg-white/10 hover:text-white cursor-pointer"
          >
            {dockPosition === 'bottom' ? '⬰ Dock Right' : '⬱ Dock Bottom'}
          </button>

          {/* Clear button */}
          <button
            type="button"
            onClick={clearTransactions}
            title="Clear all transactions"
            className="rounded px-1.5 py-1 text-[11px] text-neutral-400 hover:bg-red-500/20 hover:text-red-300 cursor-pointer"
          >
            ⊘ Clear
          </button>

          {/* Close button */}
          <button
            type="button"
            onClick={closeDevConsole}
            title="Close Dev Console"
            className="rounded p-1 text-neutral-400 hover:bg-white/10 hover:text-white cursor-pointer"
          >
            ✕
          </button>
        </div>
      </div>

      {/* Main Content Area */}
      <div className="flex flex-1 min-h-0 overflow-hidden">
        {/* Left Column: Transaction List */}
        <div
          className={cn(
            'flex flex-col border-r border-white/10 overflow-hidden bg-[#09090c]',
            dockPosition === 'bottom' ? 'w-80 shrink-0' : 'w-72 shrink-0',
          )}
        >
          <div className="flex items-center justify-between border-b border-white/5 px-2.5 py-1 text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
            <span>Transaction / Model</span>
            <span>Status · Time</span>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-white/5">
            {filtered.length === 0 ? (
              <div className="p-4 text-center text-neutral-500 text-[11px]">
                No transactions recorded yet.
                <div className="mt-1 text-[10px] text-neutral-600">
                  Send a prompt in Ask mode to see real model API calls.
                </div>
              </div>
            ) : (
              filtered.map((tx) => {
                const isSelected = tx.id === selectedTx?.id
                const isErr = tx.status === 'error' || (tx.statusCode >= 400 && tx.statusCode > 0)
                const isPending = tx.status === 'pending'

                return (
                  <button
                    key={tx.id}
                    type="button"
                    onClick={() => {
                      selectTransaction(tx.id)
                    }}
                    className={cn(
                      'flex w-full flex-col gap-1 p-2 text-left transition-colors cursor-pointer',
                      isSelected
                        ? 'bg-(--color-accent)/15 border-l-2 border-(--color-accent)'
                        : 'hover:bg-white/5 border-l-2 border-transparent',
                    )}
                  >
                    <div className="flex items-center justify-between gap-1">
                      <div className="flex items-center gap-1.5 truncate">
                        <span
                          className={cn(
                            'rounded px-1 py-0.2 text-[9px] font-bold uppercase',
                            isErr
                              ? 'bg-red-500/20 text-red-400'
                              : isPending
                                ? 'bg-amber-500/20 text-amber-400 animate-pulse'
                                : 'bg-emerald-500/20 text-emerald-400',
                          )}
                        >
                          {isPending ? 'PENDING' : isErr ? 'ERR' : String(tx.statusCode || 200)}
                        </span>
                        <span className="font-semibold text-neutral-200 truncate">{tx.model}</span>
                      </div>

                      <span className="text-[10px] text-neutral-400 shrink-0 font-mono">
                        {tx.durationMs !== undefined ? `${String(tx.durationMs)}ms` : 'live...'}
                      </span>
                    </div>

                    <div className="flex items-center justify-between text-[10px] text-neutral-400">
                      <span className="truncate pr-1">
                        {tx.request.promptSummary
                          ? `"${tx.request.promptSummary}"`
                          : `${tx.request.method} ${tx.endpointUrl}`}
                      </span>
                      <span className="shrink-0">{tx.timeFormatted}</span>
                    </div>

                    {tx.toolExecutions && tx.toolExecutions.length > 0 && (
                      <div className="text-[9.5px] text-amber-300/80 truncate">
                        ⚡ {String(tx.toolExecutions.length)} tool{' '}
                        {tx.toolExecutions.length === 1 ? 'call' : 'calls'}
                      </div>
                    )}

                    {tx.response?.usage && (
                      <div className="flex items-center gap-1.5 text-[9.5px] text-cyan-300/90 font-mono truncate">
                        <span>
                          📊{' '}
                          {tx.response.usage.totalTokens !== undefined
                            ? `${String(tx.response.usage.totalTokens)} tok`
                            : tx.response.usage.outputTokens !== undefined
                              ? `${String(tx.response.usage.outputTokens)} out tok`
                              : ''}
                        </span>
                        {tx.response.usage.tokensPerSec !== undefined && (
                          <span>· {String(tx.response.usage.tokensPerSec)} t/s</span>
                        )}
                      </div>
                    )}
                  </button>
                )
              })
            )}
          </div>
        </div>

        {/* Right Column: Transaction Inspector Detail */}
        {selectedTx ? (
          <div className="flex flex-1 flex-col min-w-0 overflow-hidden bg-[#0d0d11]">
            {/* Detail Subheader / Tabs */}
            <div className="flex items-center justify-between border-b border-white/10 bg-[#141419] px-3 py-1">
              <div className="flex items-center gap-1">
                {(
                  [
                    { key: 'request', label: 'Request & Payload' },
                    { key: 'response', label: 'Response & Stream' },
                    {
                      key: 'tools',
                      label: `Tool Calls (${String(selectedTx.toolExecutions?.length ?? 0)})`,
                    },
                    { key: 'headers', label: 'Headers & Endpoint' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => {
                      setActiveTab(tab.key)
                    }}
                    className={cn(
                      'rounded px-2 py-1 text-[11px] font-medium transition-colors cursor-pointer',
                      activeTab === tab.key
                        ? 'bg-(--color-accent)/20 text-(--color-accent) font-semibold'
                        : 'text-neutral-400 hover:text-neutral-200 hover:bg-white/5',
                    )}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => {
                    handleCopy(JSON.stringify(selectedTx, null, 2), 'all')
                  }}
                  className="rounded border border-white/10 bg-[#09090c] px-2 py-0.5 text-[10px] text-neutral-300 hover:bg-white/10 cursor-pointer"
                >
                  {copiedId === 'all' ? '✓ Copied Full JSON' : 'Copy Transaction JSON'}
                </button>
              </div>
            </div>

            {/* Tab content area */}
            <div className="flex-1 overflow-y-auto p-3 text-[11px] font-mono leading-relaxed">
              {/* Token & Performance Metrics Strip */}
              {selectedTx.response?.usage ? (
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
                  <div className="rounded border border-white/10 bg-[#070709] p-2">
                    <div className="text-[9.5px] font-semibold text-neutral-400 uppercase tracking-wider">
                      Input Tokens
                    </div>
                    <div className="text-[14px] font-bold text-cyan-400 font-mono">
                      {selectedTx.response.usage.inputTokens !== undefined
                        ? selectedTx.response.usage.inputTokens.toLocaleString()
                        : '—'}
                    </div>
                  </div>
                  <div className="rounded border border-white/10 bg-[#070709] p-2">
                    <div className="text-[9.5px] font-semibold text-neutral-400 uppercase tracking-wider">
                      Output Tokens
                    </div>
                    <div className="text-[14px] font-bold text-emerald-400 font-mono">
                      {selectedTx.response.usage.outputTokens !== undefined
                        ? selectedTx.response.usage.outputTokens.toLocaleString()
                        : '—'}
                    </div>
                  </div>
                  <div className="rounded border border-white/10 bg-[#070709] p-2">
                    <div className="text-[9.5px] font-semibold text-neutral-400 uppercase tracking-wider">
                      Total Tokens
                    </div>
                    <div className="text-[14px] font-bold text-amber-400 font-mono">
                      {selectedTx.response.usage.totalTokens !== undefined
                        ? selectedTx.response.usage.totalTokens.toLocaleString()
                        : selectedTx.response.usage.inputTokens !== undefined ||
                            selectedTx.response.usage.outputTokens !== undefined
                          ? (
                              (selectedTx.response.usage.inputTokens ?? 0) +
                              (selectedTx.response.usage.outputTokens ?? 0)
                            ).toLocaleString()
                          : '—'}
                    </div>
                  </div>
                  <div className="rounded border border-white/10 bg-[#070709] p-2">
                    <div className="text-[9.5px] font-semibold text-neutral-400 uppercase tracking-wider">
                      Generation Speed
                    </div>
                    <div className="text-[14px] font-bold text-indigo-400 font-mono">
                      {selectedTx.response.usage.tokensPerSec !== undefined
                        ? `${String(selectedTx.response.usage.tokensPerSec)} t/s`
                        : selectedTx.response.usage.outputTokens !== undefined &&
                            selectedTx.durationMs &&
                            selectedTx.durationMs > 0
                          ? `${String(Math.round((selectedTx.response.usage.outputTokens / (selectedTx.durationMs / 1000)) * 10) / 10)} t/s`
                          : '—'}
                    </div>
                  </div>
                </div>
              ) : selectedTx.durationMs ? (
                <div className="flex items-center gap-3 rounded border border-white/5 bg-[#070709] px-3 py-2 mb-3 text-[11px] text-neutral-400">
                  <span>
                    ⏱️ Duration:{' '}
                    <strong className="text-neutral-200">{String(selectedTx.durationMs)}ms</strong>
                  </span>
                  <span>
                    ⚡ Status:{' '}
                    <strong className="text-emerald-400">
                      {String(selectedTx.statusCode || 200)} OK
                    </strong>
                  </span>
                  <span className="text-neutral-500">
                    · Token counts not reported by model endpoint
                  </span>
                </div>
              ) : null}
              {/* TAB 1: Request & Payload */}
              {activeTab === 'request' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between border-b border-white/5 pb-2">
                    <span className="font-semibold text-neutral-300">HTTP Request Payload</span>
                    <button
                      type="button"
                      onClick={() => {
                        handleCopy(JSON.stringify(selectedTx.request.body, null, 2), 'req-body')
                      }}
                      className="text-[10px] text-(--color-accent) hover:underline cursor-pointer"
                    >
                      {copiedId === 'req-body' ? '✓ Copied' : 'Copy Request Body'}
                    </button>
                  </div>

                  {selectedTx.request.systemPrompt && (
                    <div className="rounded border border-white/10 bg-[#070709] p-2.5">
                      <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider mb-1">
                        System Prompt
                      </div>
                      <pre className="whitespace-pre-wrap break-words text-neutral-300 text-[11px] max-h-48 overflow-y-auto">
                        {selectedTx.request.systemPrompt}
                      </pre>
                    </div>
                  )}

                  <div className="rounded border border-white/10 bg-[#070709] p-2.5">
                    <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider mb-1">
                      Full Wire JSON Payload
                    </div>
                    <pre className="whitespace-pre-wrap break-words text-neutral-300 text-[10.5px]">
                      {JSON.stringify(selectedTx.request.body, null, 2)}
                    </pre>
                  </div>
                </div>
              )}

              {/* TAB 2: Response & Stream */}
              {activeTab === 'response' && (
                <div className="space-y-3">
                  <div className="flex items-center justify-between border-b border-white/5 pb-2">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-neutral-300">Model Response</span>
                      <span
                        className={cn(
                          'rounded px-1.5 py-0.2 text-[9.5px] font-semibold',
                          selectedTx.status === 'error'
                            ? 'bg-red-500/20 text-red-300'
                            : selectedTx.status === 'pending'
                              ? 'bg-amber-500/20 text-amber-300'
                              : 'bg-emerald-500/20 text-emerald-300',
                        )}
                      >
                        {selectedTx.status.toUpperCase()} ({String(selectedTx.durationMs ?? 0)}ms)
                      </span>
                    </div>

                    <button
                      type="button"
                      onClick={() => {
                        handleCopy(
                          JSON.stringify(
                            selectedTx.response ?? selectedTx.streamTimeline ?? {},
                            null,
                            2,
                          ),
                          'resp-body',
                        )
                      }}
                      className="text-[10px] text-(--color-accent) hover:underline cursor-pointer"
                    >
                      {copiedId === 'resp-body' ? '✓ Copied' : 'Copy Response JSON'}
                    </button>
                  </div>

                  {selectedTx.response?.error && (
                    <div className="rounded border border-red-500/30 bg-red-950/20 p-2.5 text-red-300">
                      <div className="font-bold mb-0.5">Error:</div>
                      <pre className="whitespace-pre-wrap break-words text-[11px]">
                        {selectedTx.response.error}
                      </pre>
                    </div>
                  )}

                  {selectedTx.response?.reasoning && (
                    <div className="rounded border border-amber-500/20 bg-[#16120b] p-2.5">
                      <div className="text-[10px] font-semibold text-amber-400 uppercase tracking-wider mb-1">
                        Thinking / Reasoning Output
                      </div>
                      <pre className="whitespace-pre-wrap break-words text-amber-200/90 text-[11px] max-h-56 overflow-y-auto">
                        {selectedTx.response.reasoning}
                      </pre>
                    </div>
                  )}

                  {selectedTx.response?.content && (
                    <div className="rounded border border-white/10 bg-[#070709] p-2.5">
                      <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider mb-1">
                        Final Response Text
                      </div>
                      <pre className="whitespace-pre-wrap break-words text-neutral-200 text-[11px]">
                        {selectedTx.response.content}
                      </pre>
                    </div>
                  )}

                  {selectedTx.response?.rawBody !== undefined && (
                    <div className="rounded border border-white/10 bg-[#070709] p-2.5">
                      <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider mb-1">
                        Raw Provider Wire Response
                      </div>
                      <pre className="whitespace-pre-wrap break-words text-neutral-400 text-[10.5px]">
                        {JSON.stringify(selectedTx.response.rawBody, null, 2)}
                      </pre>
                    </div>
                  )}
                </div>
              )}

              {/* TAB 3: Tool Executions */}
              {activeTab === 'tools' && (
                <div className="space-y-3">
                  <div className="border-b border-white/5 pb-2 font-semibold text-neutral-300">
                    Agent Tool Executions ({String(selectedTx.toolExecutions?.length ?? 0)} rounds)
                  </div>

                  {!selectedTx.toolExecutions || selectedTx.toolExecutions.length === 0 ? (
                    <div className="p-4 text-center text-neutral-500">
                      No tool calls executed in this transaction.
                    </div>
                  ) : (
                    selectedTx.toolExecutions.map((tool, idx) => (
                      <div
                        key={idx}
                        className={cn(
                          'rounded border p-2.5 transition-colors',
                          tool.ok
                            ? 'border-emerald-500/20 bg-[#07130c]'
                            : 'border-red-500/20 bg-[#170a0a]',
                        )}
                      >
                        <div className="flex items-center justify-between mb-1">
                          <div className="flex items-center gap-1.5">
                            <span
                              className={
                                tool.ok ? 'text-emerald-400 font-bold' : 'text-red-400 font-bold'
                              }
                            >
                              {tool.ok ? '✓' : '✗'}
                            </span>
                            <span className="font-bold text-white text-[12px]">{tool.name}</span>
                            {tool.round !== undefined && (
                              <span className="text-[10px] text-neutral-400">
                                Round {String(tool.round)}
                              </span>
                            )}
                          </div>
                          {tool.durationMs !== undefined && (
                            <span className="text-[10px] text-neutral-400 font-mono">
                              {String(tool.durationMs)}ms
                            </span>
                          )}
                        </div>

                        <div className="mt-1 space-y-1">
                          <div className="text-[10px] text-neutral-400 font-semibold uppercase">
                            Arguments:
                          </div>
                          <pre className="rounded bg-black/40 p-1.5 text-[10.5px] text-neutral-300 whitespace-pre-wrap break-words">
                            {JSON.stringify(tool.args, null, 2)}
                          </pre>
                        </div>

                        <div className="mt-2 space-y-1">
                          <div className="text-[10px] text-neutral-400 font-semibold uppercase">
                            Output / Result:
                          </div>
                          <pre className="rounded bg-black/40 p-1.5 text-[10.5px] text-neutral-200 whitespace-pre-wrap break-words max-h-36 overflow-y-auto">
                            {tool.output}
                          </pre>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              )}

              {/* TAB 4: Headers & Endpoint */}
              {activeTab === 'headers' && (
                <div className="space-y-3">
                  <div className="border-b border-white/5 pb-2 font-semibold text-neutral-300">
                    Network & General Details
                  </div>

                  <div className="rounded border border-white/10 bg-[#070709] p-2.5 divide-y divide-white/5 text-[11px]">
                    <div className="flex py-1.5 justify-between">
                      <span className="text-neutral-400">Request URL:</span>
                      <span className="text-white font-mono">{selectedTx.endpointUrl}</span>
                    </div>
                    <div className="flex py-1.5 justify-between">
                      <span className="text-neutral-400">HTTP Method:</span>
                      <span className="text-emerald-400 font-bold">
                        {selectedTx.request.method}
                      </span>
                    </div>
                    <div className="flex py-1.5 justify-between">
                      <span className="text-neutral-400">Status Code:</span>
                      <span className="text-white font-bold">
                        {String(selectedTx.statusCode || 200)}
                      </span>
                    </div>
                    <div className="flex py-1.5 justify-between">
                      <span className="text-neutral-400">Model:</span>
                      <span className="text-(--color-accent) font-semibold">
                        {selectedTx.model}
                      </span>
                    </div>
                    <div className="flex py-1.5 justify-between">
                      <span className="text-neutral-400">Provider:</span>
                      <span className="text-neutral-300">{selectedTx.providerId}</span>
                    </div>
                    <div className="flex py-1.5 justify-between">
                      <span className="text-neutral-400">Timestamp:</span>
                      <span className="text-neutral-300">
                        {new Date(selectedTx.timestamp).toISOString()}
                      </span>
                    </div>
                    {selectedTx.durationMs !== undefined && (
                      <div className="flex py-1.5 justify-between">
                        <span className="text-neutral-400">Latency:</span>
                        <span className="text-white">{String(selectedTx.durationMs)}ms</span>
                      </div>
                    )}
                  </div>

                  <div className="rounded border border-white/10 bg-[#070709] p-2.5">
                    <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider mb-1">
                      Request Headers
                    </div>
                    <pre className="whitespace-pre-wrap break-words text-neutral-300 text-[10.5px]">
                      {JSON.stringify(selectedTx.request.headers, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center text-neutral-500">
            Select a network transaction on the left to inspect full request, response, and tool
            details.
          </div>
        )}
      </div>
    </div>
  )
}
