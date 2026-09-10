import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { DevModelCallView } from '@shared/ipc'
import { Badge, Button, Input } from '../ui'

export interface DevTerminalModalProps {
  readonly open: boolean
  readonly onClose: () => void
}

export function DevTerminalModal({ open, onClose }: DevTerminalModalProps): React.JSX.Element | null {
  const [calls, setCalls] = useState<readonly DevModelCallView[]>([])
  const [search, setSearch] = useState('')
  const [autoScroll, setAutoScroll] = useState(true)
  const [expandedCallId, setExpandedCallId] = useState<string | null>(null)
  const [activeTab, setActiveTab] = useState<'request' | 'response' | 'tools'>('response')
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  // Load call history on mount and subscribe to live calls
  useEffect(() => {
    if (!open) return undefined

    // Initial fetch of recent calls
    window.forge.dev
      ?.getModelCalls()
      .then((res) => {
        if (res.ok) {
          setCalls(res.value.calls)
          if (res.value.calls.length > 0) {
            const last = res.value.calls[res.value.calls.length - 1]
            if (last) setExpandedCallId(last.id)
          }
        }
      })
      .catch(() => {
        // Dev endpoint only
      })

    // Listen for real-time model calls
    const unsubscribe = window.forge.onDevModelCall?.((newCall) => {
      setCalls((prev) => {
        const index = prev.findIndex((c) => c.id === newCall.id)
        if (index >= 0) {
          const updated = [...prev]
          updated[index] = newCall
          return updated
        }
        return [...prev, newCall]
      })
    })

    return () => {
      unsubscribe?.()
    }
  }, [open])

  // Auto-scroll when new calls land
  useEffect(() => {
    if (autoScroll && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [calls, autoScroll])

  // Close on Escape key
  useEffect(() => {
    if (!open) return undefined
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  const handleClear = async (): Promise<void> => {
    await window.forge.dev?.clearModelCalls()
    setCalls([])
    setExpandedCallId(null)
  }

  const handleCopyJson = (data: unknown, id: string): void => {
    void navigator.clipboard.writeText(JSON.stringify(data, null, 2))
    setCopiedId(id)
    setTimeout(() => {
      setCopiedId(null)
    }, 1500)
  }

  const filteredCalls = useMemo(() => {
    if (search.trim() === '') return calls
    const q = search.toLowerCase()
    return calls.filter(
      (c) =>
        c.model.toLowerCase().includes(q) ||
        c.providerId.toLowerCase().includes(q) ||
        c.endpointUrl.toLowerCase().includes(q) ||
        c.type.toLowerCase().includes(q) ||
        (c.response?.error?.toLowerCase().includes(q) ?? false) ||
        (c.toolExecutions?.some(
          (t) => t.name.toLowerCase().includes(q) || t.output.toLowerCase().includes(q),
        ) ?? false),
    )
  }, [calls, search])

  if (!open) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 sm:p-6 animate-in fade-in duration-150">
      <div className="flex h-[88vh] w-full max-w-6xl flex-col rounded-xl border border-(--color-border) bg-(--color-surface) shadow-2xl overflow-hidden">
        {/* Terminal Header Bar */}
        <div className="flex items-center justify-between border-b border-(--color-border) bg-(--color-surface-raised) px-4 py-2.5 select-none">
          <div className="flex items-center gap-2.5">
            <div className="flex items-center gap-1.5">
              <span className="size-3 rounded-full bg-red-500/80 cursor-pointer" onClick={onClose} />
              <span className="size-3 rounded-full bg-yellow-500/80" />
              <span className="size-3 rounded-full bg-green-500/80" />
            </div>

            <span className="font-mono text-[12px] font-bold tracking-tight text-(--color-text) ml-1.5">
              ⚡ FORGE DEV TERMINAL • REAL MODEL & API CALL INSPECTOR
            </span>

            <Badge tone="warning" size="sm" className="font-mono text-[9px] uppercase">
              Dev Mode Only
            </Badge>

            <Badge tone="neutral" size="sm" className="font-mono text-[10px]">
              {calls.length} {calls.length === 1 ? 'call' : 'calls'}
            </Badge>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => {
                setAutoScroll((prev) => !prev)
              }}
              className={`rounded px-2 py-0.5 text-[10.5px] font-mono transition-colors cursor-pointer ${
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
              onClick={() => {
                void handleClear()
              }}
              className="h-6 px-2 text-[11px] text-(--color-text-muted) hover:text-(--color-text)"
            >
              Clear
            </Button>

            <Button
              size="sm"
              variant="ghost"
              onClick={onClose}
              className="h-6 w-6 p-0 text-[14px] text-(--color-text-muted) hover:text-(--color-text)"
              title="Close (Esc)"
            >
              ✕
            </Button>
          </div>
        </div>

        {/* Toolbar: Search filter */}
        <div className="flex items-center justify-between border-b border-(--color-border)/60 bg-(--color-surface-inset) px-4 py-2">
          <Input
            placeholder="Filter by model, provider, tool name, or error..."
            value={search}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setSearch(e.target.value)
            }}
            className="h-7 text-[11.5px] max-w-sm bg-(--color-surface)"
          />

          <span className="text-[11px] font-mono text-(--color-text-subtle)">
            Tracking live HTTP requests & responses • Zero synthetic data
          </span>
        </div>

        {/* Main Terminal Viewport (Split: Left call list, Right inspection panel) */}
        <div className="flex flex-1 min-h-0 overflow-hidden font-mono text-[11.5px]">
          {/* Left Column: Call List */}
          <div
            ref={scrollRef}
            className="w-1/2 border-r border-(--color-border) overflow-y-auto p-2 space-y-1.5 bg-(--color-canvas)"
          >
            {filteredCalls.length === 0 ? (
              <div className="flex flex-col items-center justify-center h-full text-center text-(--color-text-subtle) p-6">
                <span className="text-2xl mb-2">📡</span>
                <span className="font-semibold text-(--color-text-muted)">No model calls recorded yet</span>
                <p className="text-[11px] mt-1 max-w-xs">
                  Send a prompt in Ask mode to inspect authentic API calls, payloads, reasoning, and tool executions.
                </p>
              </div>
            ) : (
              filteredCalls.map((call, idx) => {
                const isSelected = expandedCallId === call.id
                const isSuccess = call.response && call.response.status >= 200 && call.response.status < 300
                const isPending = !call.response
                const duration = call.response?.durationMs

                return (
                  <button
                    key={call.id}
                    type="button"
                    onClick={() => {
                      setExpandedCallId(call.id)
                    }}
                    className={`flex flex-col w-full text-left rounded-lg p-2.5 transition-colors border cursor-pointer ${
                      isSelected
                        ? 'border-(--color-accent) bg-(--color-accent)/10 shadow-xs'
                        : 'border-(--color-border)/40 bg-(--color-surface) hover:bg-(--color-surface-raised)'
                    }`}
                  >
                    <div className="flex items-center justify-between w-full">
                      <div className="flex items-center gap-2">
                        <span className="text-[10px] text-(--color-text-subtle)">#{idx + 1}</span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[10px] font-bold ${
                            isPending
                              ? 'bg-amber-500/20 text-amber-400 animate-pulse'
                              : isSuccess
                                ? 'bg-emerald-500/20 text-emerald-400'
                                : 'bg-rose-500/20 text-rose-400'
                          }`}
                        >
                          {isPending
                            ? 'PENDING...'
                            : `${String(call.response?.status)} ${call.response?.statusText ?? 'OK'}`}
                        </span>

                        {duration !== undefined && (
                          <span className="text-[10.5px] text-(--color-text-subtle)">{duration}ms</span>
                        )}

                        {call.round !== undefined && (
                          <span className="rounded bg-(--color-surface-raised) px-1.5 py-0.5 text-[9.5px] text-(--color-text-muted)">
                            Round {call.round}
                          </span>
                        )}
                      </div>

                      <span className="text-[10px] text-(--color-text-subtle)">{call.timeFormatted}</span>
                    </div>

                    <div className="mt-1.5 flex items-center justify-between text-[11.5px] text-(--color-text)">
                      <span className="truncate font-semibold max-w-[320px]" title={call.model}>
                        {call.model}
                      </span>
                      <span className="text-[10px] text-(--color-text-subtle) uppercase tracking-wider">
                        {call.providerId}
                      </span>
                    </div>

                    <div className="mt-1 text-[10.5px] text-(--color-text-subtle) truncate" title={call.endpointUrl}>
                      {call.request.method} {call.endpointUrl}
                    </div>

                    {/* Summary Badges: tool calls or error */}
                    {call.response?.toolCalls && call.response.toolCalls.length > 0 && (
                      <div className="mt-1.5 flex flex-wrap gap-1">
                        {call.response.toolCalls.map((t) => (
                          <span
                            key={t.id}
                            className="rounded bg-amber-500/10 border border-amber-500/30 px-1 py-0.2 text-[9.5px] text-amber-400"
                          >
                            🛠️ {t.name}
                          </span>
                        ))}
                      </div>
                    )}

                    {call.response?.error && (
                      <div className="mt-1.5 rounded bg-rose-500/10 p-1 text-[10.5px] text-rose-400 truncate">
                        ⚠️ {call.response.error}
                      </div>
                    )}
                  </button>
                )
              })
            )}
          </div>

          {/* Right Column: Detailed Inspector Panel */}
          <div className="w-1/2 flex flex-col bg-(--color-surface-inset) overflow-hidden">
            {expandedCallId === null ? (
              <div className="flex flex-col items-center justify-center h-full text-center text-(--color-text-subtle) p-6">
                <span>Select a call from the left to inspect raw headers, payloads, and tool outputs.</span>
              </div>
            ) : (() => {
              const activeCall = calls.find((c) => c.id === expandedCallId)
              if (!activeCall) return null

              return (
                <div className="flex flex-1 flex-col overflow-hidden">
                  {/* Tabs Header */}
                  <div className="flex items-center justify-between border-b border-(--color-border) bg-(--color-surface-raised) px-3 py-1.5">
                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          setActiveTab('response')
                        }}
                        className={`rounded px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                          activeTab === 'response'
                            ? 'bg-(--color-accent) text-white'
                            : 'text-(--color-text-muted) hover:text-(--color-text)'
                        }`}
                      >
                        Response & Output
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveTab('request')
                        }}
                        className={`rounded px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                          activeTab === 'request'
                            ? 'bg-(--color-accent) text-white'
                            : 'text-(--color-text-muted) hover:text-(--color-text)'
                        }`}
                      >
                        Request Payload
                      </button>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveTab('tools')
                        }}
                        className={`rounded px-2.5 py-1 text-[11px] font-semibold transition-colors cursor-pointer ${
                          activeTab === 'tools'
                            ? 'bg-(--color-accent) text-white'
                            : 'text-(--color-text-muted) hover:text-(--color-text)'
                        }`}
                      >
                        Tools Executed ({activeCall.toolExecutions?.length ?? 0})
                      </button>
                    </div>

                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        handleCopyJson(
                          activeTab === 'request'
                            ? activeCall.request
                            : activeTab === 'tools'
                              ? activeCall.toolExecutions
                              : activeCall.response,
                          activeCall.id,
                        )
                      }}
                      className="h-6 text-[10.5px]"
                    >
                      {copiedId === activeCall.id ? '✓ Copied' : 'Copy JSON'}
                    </Button>
                  </div>

                  {/* Tab Content Viewport */}
                  <div className="flex-1 overflow-y-auto p-3.5 space-y-3">
                    {/* Response Tab */}
                    {activeTab === 'response' && (
                      <div className="space-y-3">
                        <div className="rounded-lg border border-(--color-border)/60 bg-(--color-surface) p-3 space-y-2">
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-semibold text-(--color-text-muted)">HTTP Status</span>
                            <span className="font-bold text-(--color-text)">
                              {activeCall.response ? `${String(activeCall.response.status)} ${activeCall.response.statusText}` : 'In Flight...'}
                            </span>
                          </div>
                          <div className="flex items-center justify-between">
                            <span className="text-[11px] font-semibold text-(--color-text-muted)">Roundtrip Latency</span>
                            <span className="font-bold text-(--color-text)">
                              {activeCall.response ? `${String(activeCall.response.durationMs)} ms` : 'Measuring...'}
                            </span>
                          </div>
                        </div>

                        {activeCall.response?.reasoning && (
                          <div className="space-y-1">
                            <span className="text-[11px] font-bold text-amber-400">💭 Model Reasoning / Thinking:</span>
                            <pre className="max-h-56 overflow-y-auto rounded-lg border border-(--color-border)/60 bg-(--color-surface) p-3 text-[11px] text-(--color-text) whitespace-pre-wrap leading-relaxed select-text">
                              {activeCall.response.reasoning}
                            </pre>
                          </div>
                        )}

                        {activeCall.response?.content && (
                          <div className="space-y-1">
                            <span className="text-[11px] font-bold text-emerald-400">💬 Model Answer Content:</span>
                            <pre className="max-h-56 overflow-y-auto rounded-lg border border-(--color-border)/60 bg-(--color-surface) p-3 text-[11px] text-(--color-text) whitespace-pre-wrap leading-relaxed select-text">
                              {activeCall.response.content}
                            </pre>
                          </div>
                        )}

                        {activeCall.response?.toolCalls && activeCall.response.toolCalls.length > 0 && (
                          <div className="space-y-1">
                            <span className="text-[11px] font-bold text-sky-400">🛠️ Requested Tool Calls:</span>
                            <pre className="overflow-y-auto rounded-lg border border-(--color-border)/60 bg-(--color-surface) p-3 text-[10.5px] text-(--color-text) select-text">
                              {JSON.stringify(activeCall.response.toolCalls, null, 2)}
                            </pre>
                          </div>
                        )}

                        {activeCall.response?.error && (
                          <div className="space-y-1">
                            <span className="text-[11px] font-bold text-rose-400">❌ Error Details:</span>
                            <pre className="rounded-lg border border-rose-500/40 bg-rose-500/10 p-3 text-[11px] text-rose-300 whitespace-pre-wrap leading-relaxed select-text">
                              {activeCall.response.error}
                            </pre>
                          </div>
                        )}

                        {activeCall.response?.rawBody !== undefined && (
                          <div className="space-y-1">
                            <span className="text-[11px] font-semibold text-(--color-text-subtle)">Raw Provider JSON:</span>
                            <pre className="max-h-64 overflow-y-auto rounded-lg border border-(--color-border)/60 bg-(--color-surface) p-3 text-[10px] text-(--color-text-muted) select-text">
                              {JSON.stringify(activeCall.response.rawBody, null, 2)}
                            </pre>
                          </div>
                        )}
                      </div>
                    )}

                    {/* Request Tab */}
                    {activeTab === 'request' && (
                      <div className="space-y-3">
                        <div className="rounded-lg border border-(--color-border)/60 bg-(--color-surface) p-3 space-y-1.5">
                          <div className="text-[11px] font-semibold text-(--color-text-muted)">Request Target:</div>
                          <div className="text-[11px] text-(--color-text) font-mono">
                            {activeCall.request.method} {activeCall.endpointUrl}
                          </div>
                          <div className="text-[11px] font-semibold text-(--color-text-muted) pt-1">Headers:</div>
                          <pre className="text-[10.5px] text-(--color-text-subtle)">
                            {JSON.stringify(activeCall.request.headers, null, 2)}
                          </pre>
                        </div>

                        <div className="space-y-1">
                          <span className="text-[11px] font-bold text-(--color-accent)">Full Request Body Sent to Model:</span>
                          <pre className="max-h-96 overflow-y-auto rounded-lg border border-(--color-border)/60 bg-(--color-surface) p-3 text-[10.5px] text-(--color-text) select-text">
                            {JSON.stringify(activeCall.request.body, null, 2)}
                          </pre>
                        </div>
                      </div>
                    )}

                    {/* Tools Tab */}
                    {activeTab === 'tools' && (
                      <div className="space-y-3">
                        {!activeCall.toolExecutions || activeCall.toolExecutions.length === 0 ? (
                          <div className="text-center p-8 text-(--color-text-subtle)">
                            No local tools executed for this model round.
                          </div>
                        ) : (
                          activeCall.toolExecutions.map((t, tIdx) => (
                            <div
                              key={`${t.name}-${String(tIdx)}`}
                              className="rounded-lg border border-(--color-border)/60 bg-(--color-surface) p-3 space-y-2"
                            >
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2">
                                  <span className="font-bold text-(--color-accent)">#{tIdx + 1}</span>
                                  <span className="font-bold text-(--color-text)">{t.name}</span>
                                  <span
                                    className={`rounded px-1.5 py-0.2 text-[9.5px] font-bold ${
                                      t.ok
                                        ? 'bg-emerald-500/20 text-emerald-400'
                                        : 'bg-rose-500/20 text-rose-400'
                                    }`}
                                  >
                                    {t.ok ? '✓ Succeeded' : '✗ Failed'}
                                  </span>
                                </div>
                                <span className="text-[10px] text-(--color-text-subtle)">{t.durationMs}ms</span>
                              </div>

                              <div>
                                <span className="text-[10px] font-semibold text-(--color-text-subtle)">Arguments:</span>
                                <pre className="mt-0.5 rounded bg-(--color-surface-inset) p-2 text-[10px] text-(--color-text) select-text">
                                  {JSON.stringify(t.args, null, 2)}
                                </pre>
                              </div>

                              <div>
                                <span className="text-[10px] font-semibold text-(--color-text-subtle)">Real Output Returned:</span>
                                <pre className="mt-0.5 max-h-48 overflow-y-auto rounded bg-(--color-surface-inset) p-2 text-[10px] text-(--color-text) whitespace-pre-wrap select-text">
                                  {t.output}
                                </pre>
                              </div>
                            </div>
                          ))
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )
            })()}
          </div>
        </div>
      </div>
    </div>
  )
}
