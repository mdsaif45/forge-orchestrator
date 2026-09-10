import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Button,
  Input,
  MarkdownRenderer,
  ScrollArea,
  useToast,
} from '../ui'
import { cn } from '../ui'
import { useProjectStore } from './projectStore'
import { useUiStore } from './uiStore'
import { unwrap } from '@renderer/ipc'
import { DEFAULT_PROVIDERS, type StoredProviderConfig } from './Settings'

export interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly timestamp: string
  readonly personaName?: string | undefined
  readonly personaIcon?: string | undefined
  readonly engineId?: string | undefined
  readonly modelName?: string | undefined
  /** Elapsed time label for the response (e.g. "Taken 60s ago") */
  readonly elapsed?: string | undefined
  /**
   * The model's visible reasoning, kept apart from the answer.
   *
   * Stored separately rather than left inline: a model that emits `<think>`
   * blocks would otherwise bake them into the saved message, where the answer
   * and the working-out can no longer be told apart.
   */
  readonly reasoning?: string | undefined
}

export interface ChatThread {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly messages: readonly ChatMessage[]
  /** Pinned threads sort above everything else, whatever the sort order. */
  readonly pinned?: boolean | undefined
  /** Archived threads are hidden from the list without being destroyed. */
  readonly archived?: boolean | undefined
  readonly personaId?: string | undefined
}

/**
 * The tool trail to append to an agent turn's reply, or null for a chat turn.
 *
 * A separate typed helper because the two send paths return different shapes,
 * and narrowing a union with `'toolsUsed' in value` types the array as unknown —
 * which the strict lint rules then reject rather than silently accept.
 */
function toolSummary(value: object): string | null {
  const { toolsUsed, rounds } = value as {
    readonly toolsUsed?: readonly { readonly name: string; readonly ok: boolean }[]
    readonly rounds?: number
  }
  const used = toolsUsed ?? []
  if (used.length === 0) return null

  const listed = used.map((tool) => `${tool.ok ? '✓' : '✗'} \`${tool.name}\``).join(' · ')
  return `*Tools used (${String(rounds ?? 0)} rounds): ${listed}*`
}

/** One row of the per-thread action menu. */
function ThreadMenuItem({
  label,
  onSelect,
  danger = false,
}: {
  readonly label: string
  readonly onSelect: (event: React.MouseEvent) => void
  readonly danger?: boolean
}): React.JSX.Element {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'block w-full cursor-pointer px-3 py-1.5 text-left text-[11px] hover:bg-(--color-surface-inset)',
        danger ? 'text-(--color-danger)' : 'text-(--color-text)',
      )}
    >
      {label}
    </button>
  )
}

/**
 * A model's visible reasoning, collapsed by default once the reply has landed.
 *
 * Open while streaming so the working-out can be watched live, then closed so
 * the transcript stays readable — the reasoning is usually far longer than the
 * answer, and leaving it expanded buries the part that was asked for.
 */
function ThinkingBlock({
  text,
  streaming = false,
}: {
  readonly text: string
  readonly streaming?: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(streaming)

  return (
    <div className="rounded-lg border border-(--color-border) bg-(--color-surface-inset)">
      <button
        type="button"
        onClick={() => {
          setOpen((current) => !current)
        }}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-left text-[11px] text-(--color-text-muted) hover:text-(--color-text)"
      >
        <span className={streaming ? 'animate-pulse' : ''}>💭</span>
        <span className="font-semibold">Thinking</span>
        {streaming && <span className="italic">…</span>}
        <span className="ml-auto font-mono text-[10px] text-(--color-text-subtle)">
          {open ? 'hide' : `${String(text.length)} chars`}
        </span>
      </button>
      {open && (
        <div
          className="max-h-64 overflow-y-auto border-t border-(--color-border) px-3 py-2 text-[11px] leading-relaxed whitespace-pre-wrap text-(--color-text-muted)"
          data-selectable
        >
          {text}
        </div>
      )}
    </div>
  )
}

/**
 * Copies one message's markdown source.
 *
 * Alongside making the text selectable rather than instead of it: a drag-select
 * across a long reply is awkward, and the source is what pastes usefully into an
 * editor or an issue — the rendered table becomes pipes again.
 */
function CopyTextButton({ text }: { readonly text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      aria-label="Copy message"
      onClick={() => {
        navigator.clipboard
          .writeText(text)
          .then(() => {
            setCopied(true)
            setTimeout(() => {
              setCopied(false)
            }, 1200)
          })
          .catch(() => {
            // A denied clipboard is a user setting, not a failure to report. The
            // message is selectable, so copying is still possible by hand.
          })
      }}
      className="cursor-pointer text-[10px] text-(--color-text-subtle) hover:text-(--color-text)"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

/** Formats relative time (e.g. "6 days ago", "just now", "15m ago"). */
function formatRelativeTime(timestamp: string, id?: string): string {
  let timeMs: number | null = null
  if (id !== undefined) {
    const match = /^(?:user|ai)-(\d{10,16})$/.exec(id)
    if (match?.[1]) {
      timeMs = Number(match[1])
    }
  }
  if (timeMs === null) {
    const parsed = Date.parse(timestamp)
    if (!Number.isNaN(parsed)) {
      timeMs = parsed
    }
  }
  if (timeMs === null) {
    return timestamp || 'just now'
  }

  const diffMs = Date.now() - timeMs
  if (diffMs < 0 || diffMs < 45_000) return 'just now'
  const diffSec = Math.floor(diffMs / 1000)
  const diffMin = Math.floor(diffSec / 60)
  if (diffMin < 60) return `${String(diffMin)}m ago`
  const diffHours = Math.floor(diffMin / 60)
  if (diffHours < 24) return `${String(diffHours)}h ago`
  const diffDays = Math.floor(diffHours / 24)
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 30) return `${String(diffDays)} days ago`
  const diffMonths = Math.floor(diffDays / 30)
  if (diffMonths < 12) return `${String(diffMonths)}mo ago`
  return `${String(Math.floor(diffDays / 365))}y ago`
}

function PromptCopyIcon({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'size-3.5'}
      aria-hidden="true"
    >
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M3.5 10.5h-1a1 1 0 0 1-1-1v-7a1 1 0 0 1 1-1h7a1 1 0 0 1 1 1v1" />
    </svg>
  )
}

function PromptCheckIcon({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'size-3.5'}
      aria-hidden="true"
    >
      <path d="M3.5 8.5 6.5 11.5 12.5 4.5" />
    </svg>
  )
}

function PromptRetryIcon({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'size-3.5'}
      aria-hidden="true"
    >
      <path d="M2.5 3v4h4" />
      <path d="M3.5 9.5a5 5 0 1 0 1.2-5.3L2.5 7" />
    </svg>
  )
}

function PromptForkIcon({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'size-3.5'}
      aria-hidden="true"
    >
      <circle cx="4.5" cy="4.5" r="1.75" />
      <circle cx="4.5" cy="11.5" r="1.75" />
      <circle cx="11.5" cy="4.5" r="1.75" />
      <path d="M4.5 6.25v3.5" />
      <path d="M11.5 6.25a3.5 3.5 0 0 1-3.5 3.5H4.5" />
    </svg>
  )
}

function SendArrowIcon({ className }: { readonly className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className ?? 'size-4'}
      aria-hidden="true"
    >
      <path d="M3 8h10M9 4l4 4-4 4" />
    </svg>
  )
}

function EngineSelectDropdown({
  value,
  onChange,
  options,
}: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly options: readonly { readonly id: string; readonly label: string }[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const dropdownRef = useRef<HTMLDivElement>(null)

  const selected = options.find((opt) => opt.id === value) ?? options[0]

  useEffect(() => {
    if (!open) return undefined
    const handleOutsideClick = (e: MouseEvent): void => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false)
      }
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((prev) => !prev)
        }}
        aria-expanded={open}
        aria-label="Select Engine"
        className="flex items-center gap-1.5 rounded-lg border border-(--color-border) bg-(--color-surface-inset) px-2.5 py-1 text-[11.5px] font-medium text-(--color-text-muted) hover:text-(--color-text) hover:border-(--color-border-strong) transition-colors cursor-pointer"
      >
        <span className="truncate max-w-[150px] sm:max-w-[200px]">{selected?.label ?? value}</span>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={cn(
            'size-3 shrink-0 text-(--color-text-subtle) transition-transform duration-150',
            open ? 'rotate-180' : '',
          )}
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 z-30 w-60 max-h-64 overflow-y-auto rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-1 shadow-xl">
          <div className="px-2.5 py-1 text-[10px] font-semibold text-(--color-text-subtle) uppercase tracking-wider">
            Agent Engine
          </div>
          <div className="space-y-0.5">
            {options.map((opt) => {
              const isSelected = opt.id === value
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    onChange(opt.id)
                    setOpen(false)
                  }}
                  className={cn(
                    'flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12px] transition-colors cursor-pointer',
                    isSelected
                      ? 'bg-(--color-accent)/10 font-semibold text-(--color-accent)'
                      : 'text-(--color-text) hover:bg-(--color-surface-overlay)',
                  )}
                >
                  <span className="truncate pr-2">{opt.label}</span>
                  {isSelected && <span className="text-[11px] font-bold">✓</span>}
                </button>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}

export interface CategorizedModelOption {
  readonly id: string
  readonly label: string
  readonly category?: string | undefined
}

function ModelSelectDropdown({
  value,
  onChange,
  options,
}: {
  readonly value: string
  readonly onChange: (value: string) => void
  readonly options: readonly CategorizedModelOption[]
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [search, setSearch] = useState('')
  const dropdownRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)

  const closeDropdown = (): void => {
    setOpen(false)
    setSearch('')
  }

  const selected =
    options.find((opt) => opt.id === value || opt.label === value) ?? options[0]

  useEffect(() => {
    if (!open) return undefined

    const timer = setTimeout(() => {
      searchInputRef.current?.focus()
    }, 50)

    const handleOutsideClick = (e: MouseEvent): void => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        closeDropdown()
      }
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') closeDropdown()
    }
    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      clearTimeout(timer)
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [open])

  // Filter options based on search query
  const filteredOptions = useMemo(() => {
    if (!search.trim()) return options
    const query = search.toLowerCase()
    return options.filter(
      (opt) =>
        opt.label.toLowerCase().includes(query) ||
        Boolean(opt.category?.toLowerCase().includes(query)),
    )
  }, [options, search])

  // Group options by category
  const groups = useMemo(() => {
    const map = new Map<string, CategorizedModelOption[]>()
    for (const opt of filteredOptions) {
      const cat = opt.category ?? 'General'
      const list = map.get(cat) ?? []
      list.push(opt)
      map.set(cat, list)
    }
    return Array.from(map.entries()).map(([category, items]) => ({
      category,
      items,
    }))
  }, [filteredOptions])

  return (
    <div ref={dropdownRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setOpen((prev) => {
            if (prev) setSearch('')
            return !prev
          })
        }}
        aria-expanded={open}
        aria-label="Select Model"
        className="flex items-center gap-1.5 rounded-lg border border-(--color-border) bg-(--color-surface-inset) px-2.5 py-1 text-[11.5px] font-medium text-(--color-text-muted) hover:text-(--color-text) hover:border-(--color-border-strong) transition-colors cursor-pointer"
      >
        <span className="truncate max-w-[130px] sm:max-w-[180px]">
          {(selected?.label ?? value) || 'Select Model'}
        </span>
        <svg
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          className={cn(
            'size-3 shrink-0 text-(--color-text-subtle) transition-transform duration-150',
            open ? 'rotate-180' : '',
          )}
          aria-hidden="true"
        >
          <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <div className="absolute bottom-full left-0 mb-1.5 z-30 w-72 max-h-80 overflow-y-auto rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-1.5 shadow-xl flex flex-col">
          {/* Search box when 5 or more models */}
          {options.length >= 5 && (
            <div className="sticky top-0 z-10 -mx-1.5 -mt-1.5 mb-1.5 bg-(--color-surface-raised) p-1.5 border-b border-(--color-border)/60">
              <input
                ref={searchInputRef}
                type="text"
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value)
                }}
                placeholder="Search models..."
                className="w-full rounded-md border border-(--color-border) bg-(--color-surface-inset) px-2.5 py-1 text-[11px] text-(--color-text) placeholder:text-(--color-text-subtle) focus:border-(--color-accent) focus:outline-none"
              />
            </div>
          )}

          {groups.length === 0 ? (
            <div className="px-3 py-4 text-center text-[11px] text-(--color-text-subtle)">
              No matching models found
            </div>
          ) : (
            <div className="space-y-2">
              {groups.map((group, groupIdx) => (
                <div key={group.category} className="space-y-0.5">
                  <div className="flex items-center justify-between px-2 py-1 text-[10px] font-semibold text-(--color-text-subtle) uppercase tracking-wider">
                    <span className="truncate">{group.category}</span>
                    <span className="rounded-full bg-(--color-surface-overlay) px-1.5 py-0.2 text-[9px] font-normal text-(--color-text-muted)">
                      {group.items.length}
                    </span>
                  </div>

                  {group.items.map((opt) => {
                    const isSelected = opt.id === value || opt.label === value
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => {
                          onChange(opt.id)
                          closeDropdown()
                        }}
                        className={cn(
                          'flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[11.5px] transition-colors cursor-pointer',
                          isSelected
                            ? 'bg-(--color-accent)/10 font-semibold text-(--color-accent)'
                            : 'text-(--color-text) hover:bg-(--color-surface-overlay)',
                        )}
                      >
                        <span className="truncate pr-2">{opt.label}</span>
                        {isSelected && <span className="text-[11px] font-bold">✓</span>}
                      </button>
                    )
                  })}

                  {groupIdx < groups.length - 1 && (
                    <div className="my-1 border-t border-(--color-border)/40" />
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export function AskPage(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const project = detail?.project ?? null
  const probe = detail?.probe ?? null
  const rules = detail?.rules ?? []
  const { show } = useToast()

  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Providers & Active Model from localStorage
  const [providers, setProviders] = useState<readonly StoredProviderConfig[]>(() => {
    const saved = localStorage.getItem('forge.providers')
    let baseList: readonly StoredProviderConfig[] = DEFAULT_PROVIDERS
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as StoredProviderConfig[]
        if (Array.isArray(parsed) && parsed.length > 0) {
          const merged = [...parsed]
          for (const def of DEFAULT_PROVIDERS) {
            if (!merged.some((p) => p.id === def.id)) {
              merged.push(def)
            }
          }
          baseList = merged
        }
      } catch {
        // fallback
      }
    }
    return baseList.map((p) => {
      if (
        p.id === 'ollama' &&
        p.models?.includes('llama3') &&
        !p.models.some((m) => m.includes(':'))
      ) {
        return { ...p, models: [], activeModel: '' }
      }
      if (p.id === 'lmstudio' && p.models?.includes('local-model')) {
        return { ...p, models: [], activeModel: '' }
      }
      return p
    })
  })

  // Auto-scan Ollama and LM Studio on mount
  useEffect(() => {
    // Scan Ollama
    window.forge.provider
      .scanModels('ollama', 'http://localhost:11434')
      .then((res) => {
        if (res.ok && res.value.ok && res.value.models.length > 0) {
          const detected = res.value.models
          setProviders((prev) => {
            const updated = prev.map((p) =>
              p.id === 'ollama'
                ? {
                    ...p,
                    models: detected,
                    activeModel:
                      p.activeModel && detected.includes(p.activeModel)
                        ? p.activeModel
                        : (detected[0] ?? ''),
                  }
                : p,
            )
            localStorage.setItem('forge.providers', JSON.stringify(updated))
            return updated
          })
        }
      })
      .catch(() => {
        // ignore
      })

    // Scan LM Studio
    window.forge.provider
      .scanModels('lmstudio', 'http://localhost:1234/v1')
      .then((res) => {
        if (res.ok && res.value.ok && res.value.models.length > 0) {
          const detected = res.value.models
          setProviders((prev) => {
            const updated = prev.map((p) =>
              p.id === 'lmstudio'
                ? {
                    ...p,
                    models: detected,
                    activeModel:
                      p.activeModel && detected.includes(p.activeModel)
                        ? p.activeModel
                        : (detected[0] ?? ''),
                  }
                : p,
            )
            localStorage.setItem('forge.providers', JSON.stringify(updated))
            return updated
          })
        }
      })
      .catch(() => {
        // ignore
      })
  }, [])

  const [activeProviderId, setActiveProviderId] = useState<string>(() => {
    return localStorage.getItem('forge.active_provider_id') ?? 'ollama'
  })

  const currentProvider = providers.find((p) => p.id === activeProviderId) ?? providers[0]
  const currentModel =
    currentProvider?.activeModel && currentProvider.activeModel.length > 0
      ? currentProvider.activeModel
      : (currentProvider?.models?.[0] ?? '')

  /**
   * Publishes the chosen model to main, where a workflow can read it.
   *
   * Ask mode sends the model with every turn, so this changes nothing here. A
   * workflow runs entirely in main and cannot see this component's
   * `localStorage`, so without this it has no model to call.
   *
   * Keyed on the derived values rather than fired from the select handler:
   * the model also settles on first load and again when detection replaces a
   * stale name, and a handler would miss both.
   */
  useEffect(() => {
    if (currentProvider === undefined || currentModel === '') return

    void window.forge.provider.setActiveModel({
      providerId: currentProvider.id,
      model: currentModel,
      ...(currentProvider.localUrl === undefined ? {} : { endpointUrl: currentProvider.localUrl }),
      ...(currentProvider.apiKey === undefined ? {} : { apiKey: currentProvider.apiKey }),
    })
  }, [currentProvider, currentModel])

  const handleSelectModel = (model: string): void => {
    if (!currentProvider) return
    const updated = providers.map((p) =>
      p.id === currentProvider.id ? { ...p, activeModel: model } : p,
    )
    setProviders(updated)
    localStorage.setItem('forge.providers', JSON.stringify(updated))
    show({
      tone: 'success',
      title: 'Model Selected',
      description: `Active model set to ${model} (${currentProvider.name})`,
    })
  }

  const [selectedEngineId, setSelectedEngineId] = useState<string>('forge-native-agent')
  const [availableEngines, setAvailableEngines] = useState<
    readonly { id: string; label: string }[]
  >([
    { id: 'forge-native-agent', label: 'Forge Agent' },
    { id: 'primary-engine', label: 'Primary Engine' },
    { id: 'secondary-engine', label: 'Secondary Engine' },
    { id: 'mock:default', label: 'mock:default (Simulated)' },
  ])

  // Sort state for sidebar
  const [sortOrder, setSortOrder] = useState<'newest' | 'oldest'>('newest')
  // Search state for sidebar
  const [searchQuery, setSearchQuery] = useState('')

  // Load project bindings to populate real engine list
  useEffect(() => {
    if (project === null) return
    window.forge.binding
      .list(project.id)
      .then((res) => {
        const data = unwrap(res)
        const list: { id: string; label: string }[] = [
          { id: 'forge-native-agent', label: 'Forge Agent' },
        ]
        for (const role of data.roles) {
          for (const er of role.eligibleRuntimes) {
            if (!list.some((e) => e.id === er.id)) {
              list.push({
                id: er.id,
                label: er.simulated ? `${er.id} (simulated)` : er.id,
              })
            }
          }
        }
        if (list.length > 0) {
          setAvailableEngines(list)
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to load bindings:', err)
      })
  }, [project])

  // Load detected CLIs and their supported models
  const [detectedClis, setDetectedClis] = useState<
    readonly {
      readonly id: string
      readonly name: string
      readonly defaultModel?: string | undefined
      readonly models?:
        | readonly {
            readonly id: string
            readonly label: string
            readonly category?: string | undefined
          }[]
        | undefined
    }[]
  >([])

  useEffect(() => {
    window.forge.runtime
      .detectClis()
      .then((res) => {
        const data = unwrap(res)
        setDetectedClis(data.clis)
      })
      .catch((err: unknown) => {
        console.error('Failed to detect CLIs in AskPage:', err)
      })
  }, [])

  // User selected model per engine, persisted across sessions
  const [selectedEngineModels, setSelectedEngineModels] = useState<Record<string, string>>(() => {
    try {
      const saved = localStorage.getItem('forge.engine_selected_models')
      if (saved) return JSON.parse(saved) as Record<string, string>
    } catch {
      // ignore
    }
    return {}
  })

  const saveEngineModel = (engineId: string, modelId: string): void => {
    setSelectedEngineModels((prev) => {
      const updated = { ...prev, [engineId]: modelId }
      localStorage.setItem('forge.engine_selected_models', JSON.stringify(updated))
      return updated
    })
  }

  // Available models for currently selected engine, organized category-wise
  const currentEngineModels: readonly CategorizedModelOption[] = useMemo(() => {
    if (selectedEngineId === 'forge-native-agent') {
      const list: CategorizedModelOption[] = []
      // Gather models across all configured providers
      for (const p of providers) {
        if (p.models && p.models.length > 0) {
          for (const m of p.models) {
            list.push({
              id: `${p.id}:::${m}`,
              label: m,
              category: p.name,
            })
          }
        }
      }
      if (list.length === 0) {
        if (currentModel) {
          list.push({
            id: `${currentProvider?.id ?? 'ollama'}:::${currentModel}`,
            label: currentModel,
            category: currentProvider?.name ?? 'Ollama (Local)',
          })
        } else {
          list.push({
            id: 'ollama:::llama3:latest',
            label: 'llama3:latest (Default)',
            category: 'Ollama (Local)',
          })
        }
      }
      return list
    }
    const cli = detectedClis.find((c) => c.id === selectedEngineId)
    if (cli?.models && cli.models.length > 0) {
      return cli.models
    }
    if (cli?.defaultModel) {
      return [{ id: cli.defaultModel, label: cli.defaultModel, category: cli.name }]
    }
    return []
  }, [selectedEngineId, providers, currentProvider, currentModel, detectedClis])

  // Combine available engines from project bindings and detected CLIs
  const engineOptions = useMemo(() => {
    const list: { id: string; label: string }[] = [...availableEngines]
    for (const cli of detectedClis) {
      if (!list.some((e) => e.id === cli.id)) {
        list.push({ id: cli.id, label: cli.name })
      }
    }
    return list
  }, [availableEngines, detectedClis])

  // Active model ID for currently selected engine
  const activeEngineModelId = useMemo(() => {
    if (selectedEngineId === 'forge-native-agent') {
      const currentCombinedId = `${currentProvider?.id ?? 'ollama'}:::${currentModel}`
      const matchExact = currentEngineModels.find((m) => m.id === currentCombinedId)
      if (matchExact) return matchExact.id
      const matchLabel = currentEngineModels.find((m) => m.label === currentModel)
      if (matchLabel) return matchLabel.id
      return currentEngineModels[0]?.id ?? ''
    }
    const cli = detectedClis.find((c) => c.id === selectedEngineId)
    const saved = selectedEngineModels[selectedEngineId]
    if (saved && currentEngineModels.some((m) => m.id === saved || m.label === saved)) {
      return saved
    }
    return (
      (cli?.defaultModel && currentEngineModels.some((m) => m.id === cli.defaultModel)
        ? cli.defaultModel
        : currentEngineModels[0]?.id) ?? ''
    )
  }, [
    selectedEngineId,
    currentProvider,
    currentModel,
    detectedClis,
    selectedEngineModels,
    currentEngineModels,
  ])

  // Active model human-readable label
  const activeEngineModelLabel = useMemo(() => {
    if (selectedEngineId === 'forge-native-agent') {
      return `${currentModel || 'Default'} (${currentProvider?.name ?? 'Forge Agent'})`
    }
    const matched = currentEngineModels.find((m) => m.id === activeEngineModelId)
    if (matched) return matched.label
    if (activeEngineModelId) return activeEngineModelId
    return 'Default'
  }, [selectedEngineId, currentProvider, currentModel, currentEngineModels, activeEngineModelId])

  const handleSelectEngineModel = (newModel: string): void => {
    if (selectedEngineId === 'forge-native-agent') {
      if (newModel.includes(':::')) {
        const [providerId, modelName] = newModel.split(':::')
        const targetProvider = providers.find((p) => p.id === providerId)
        if (targetProvider && modelName) {
          setActiveProviderId(targetProvider.id)
          localStorage.setItem('forge.active_provider_id', targetProvider.id)
          const updated = providers.map((p) =>
            p.id === targetProvider.id ? { ...p, activeModel: modelName } : p,
          )
          setProviders(updated)
          localStorage.setItem('forge.providers', JSON.stringify(updated))
          void window.forge.provider.setActiveModel({
            providerId: targetProvider.id,
            model: modelName,
            ...(targetProvider.localUrl === undefined
              ? {}
              : { endpointUrl: targetProvider.localUrl }),
            ...(targetProvider.apiKey === undefined ? {} : { apiKey: targetProvider.apiKey }),
          })
          show({
            tone: 'success',
            title: 'Model Selected',
            description: `Active model set to ${modelName} (${targetProvider.name})`,
          })
          return
        }
      }
      handleSelectModel(newModel)
    } else {
      saveEngineModel(selectedEngineId, newModel)
      const found = currentEngineModels.find((m) => m.id === newModel)
      show({
        tone: 'neutral',
        title: 'Model Selected',
        description: `Active model set to ${found?.label ?? newModel}`,
      })
    }
  }

  // Chat Threads
  const [threads, setThreads] = useState<readonly ChatThread[]>(() => {
    const saved = localStorage.getItem('forge.ask_threads')
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as ChatThread[]
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed
        }
      } catch {
        // fallback
      }
    }
    const initThreadId = 'thread-init'
    return [
      {
        id: initThreadId,
        title: '',
        createdAt: 'Today',
        messages: [],
      },
    ]
  })

  const [activeThreadId, setActiveThreadId] = useState<string>(threads[0]?.id ?? 'thread-1')
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [copiedPromptId, setCopiedPromptId] = useState<string | null>(null)
  /**
   * The reply currently arriving, before it becomes a saved message.
   *
   * Held outside the thread so a partial answer is never persisted: an
   * interrupted stream leaves the transcript unchanged rather than storing half
   * a message that reads as complete.
   */
  /**
   * What the selected model was found to support, once a turn has asked.
   *
   * Null until the first turn. Never a toggle: capability belongs to the model,
   * and asking the user to declare it meant they could enable tools on a model
   * that has none and get a broken turn instead of a refusal.
   */
  const openDevTerminal = useUiStore((state) => state.openDevTerminal)
  const threadMenuRef = useRef<HTMLDivElement>(null)
  /** Seconds the running turn has taken, so a slow turn visibly progresses. */
  const [elapsed, setElapsed] = useState(0)
  const [menuThreadId, setMenuThreadId] = useState<string | null>(null)
  const [renamingId, setRenamingId] = useState<string | null>(null)
  const [renameDraft, setRenameDraft] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [liveReply, setLiveReply] = useState<{
    readonly streamId: string
    readonly content: string
    readonly reasoning: string
    /**
     * Reasoning and tool calls in the order they happened.
     *
     * One timeline rather than two boxes: the reasoning explains the tool calls
     * that follow it, and showing them separately put the thinking after the
     * work it described.
     */
    readonly timeline: readonly { readonly kind: 'reasoning' | 'tool'; readonly text: string }[]
  } | null>(null)

  const activeThread = threads.find((t) => t.id === activeThreadId) ?? threads[0]
  const messages = activeThread?.messages ?? []

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, thinking])

  // Auto-resize textarea dynamically up to 192px max height.
  // When within max height, overflow is hidden so NO default scrollbar appears!
  // When content exceeds 192px, overflow-y-auto activates so user can scroll within the field.
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    const scrollHeight = el.scrollHeight
    if (scrollHeight > 192) {
      el.style.height = '192px'
      el.style.overflowY = 'auto'
    } else {
      el.style.height = `${String(Math.max(scrollHeight, 38))}px`
      el.style.overflowY = 'hidden'
    }
  }, [input])

  const saveThreads = (updatedThreads: readonly ChatThread[]): void => {
    setThreads(updatedThreads)
    localStorage.setItem('forge.ask_threads', JSON.stringify(updatedThreads))
  }

  const handleCreateThread = (): void => {
    const now = new Date()
    const newThreadId = `thread-${String(now.getTime())}`
    const newThread: ChatThread = {
      id: newThreadId,
      title: '',
      createdAt: now.toLocaleDateString(),
      messages: [],
    }

    const updated = [newThread, ...threads]
    saveThreads(updated)
    setActiveThreadId(newThreadId)
    show({ tone: 'neutral', title: 'New chat created' })
  }

  const handleDeleteThread = (threadId: string, e?: React.MouseEvent): void => {
    e?.stopPropagation()
    const remaining = threads.filter((t) => t.id !== threadId)
    if (remaining.length === 0) {
      const freshThread: ChatThread = {
        id: `thread-${String(Date.now())}`,
        title: '',
        createdAt: 'Today',
        messages: [],
      }
      saveThreads([freshThread])
      setActiveThreadId(freshThread.id)
    } else {
      saveThreads(remaining)
      if (activeThreadId === threadId && remaining[0]) {
        setActiveThreadId(remaining[0].id)
      }
    }
    show({ tone: 'neutral', title: 'Chat deleted' })
  }

  // A visible clock while a turn runs.
  useEffect(() => {
    if (!thinking) return undefined

    const started = Date.now()
    const timer = setInterval(() => {
      setElapsed(Math.round((Date.now() - started) / 1000))
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [thinking])

  // Dismissed on outside click (mousedown) or Escape key, without intercepting
  // menu button clicks in capture phase.
  useEffect(() => {
    if (menuThreadId === null) return undefined
    const handleOutsideClick = (e: MouseEvent): void => {
      if (threadMenuRef.current && !threadMenuRef.current.contains(e.target as Node)) {
        setMenuThreadId(null)
      }
    }
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setMenuThreadId(null)
    }
    document.addEventListener('mousedown', handleOutsideClick)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleOutsideClick)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuThreadId])

  /** Applies one change to one thread and persists the result. */
  const updateThread = (threadId: string, change: Partial<ChatThread>): void => {
    saveThreads(threads.map((t) => (t.id === threadId ? { ...t, ...change } : t)))
  }

  const handleTogglePin = (thread: ChatThread): void => {
    const pinned = thread.pinned !== true
    updateThread(thread.id, { pinned })
    show({ tone: 'neutral', title: pinned ? 'Chat pinned to top' : 'Chat unpinned' })
  }

  const handleToggleArchive = (thread: ChatThread): void => {
    const archived = thread.archived !== true
    updateThread(thread.id, { archived, ...(archived ? { pinned: false } : {}) })

    if (archived && activeThreadId === thread.id) {
      const next = threads.find((t) => t.id !== thread.id && t.archived !== true)
      if (next !== undefined) setActiveThreadId(next.id)
    }
    show({ tone: 'neutral', title: archived ? 'Chat archived' : 'Chat unarchived' })
  }

  const handleRenameThread = (thread: ChatThread): void => {
    const title = renameDraft.trim()
    if (title !== '' && title !== thread.title) {
      updateThread(thread.id, { title })
      show({ tone: 'neutral', title: 'Chat renamed' })
    }
    setRenamingId(null)
  }

  const handleCopyPrompt = (promptText: string, messageId: string): void => {
    navigator.clipboard
      .writeText(promptText)
      .then(() => {
        setCopiedPromptId(messageId)
        setTimeout(() => {
          setCopiedPromptId(null)
        }, 1500)
        show({ tone: 'neutral', title: 'Prompt copied to clipboard' })
      })
      .catch(() => {
        // clipboard access denied
      })
  }

  const handleRetryPrompt = (promptText: string): void => {
    setInput(promptText)
    textareaRef.current?.focus()
    show({ tone: 'neutral', title: 'Prompt restored to input' })
  }

  const handleForkFromPrompt = (messageId: string): void => {
    if (!activeThread) return
    const msgIndex = activeThread.messages.findIndex((m) => m.id === messageId)
    if (msgIndex === -1) return
    const slicedMessages = activeThread.messages.slice(0, msgIndex + 1)
    const now = new Date()
    const newThreadId = `thread-${String(now.getTime())}`
    const newThread: ChatThread = {
      ...activeThread,
      id: newThreadId,
      title: `${activeThread.title} (Fork)`,
      createdAt: now.toLocaleDateString(),
      messages: slicedMessages,
    }
    const updated = [newThread, ...threads]
    saveThreads(updated)
    setActiveThreadId(newThreadId)
    show({ tone: 'neutral', title: 'Conversation branched from prompt' })
  }

  const handleSend = async (queryText?: string): Promise<void> => {
    const textToSend = queryText ?? input
    if (textToSend.trim() === '' || thinking || activeThread === undefined) return
    // Captured before the awaits below: agent mode needs a project id to resolve
    // the workspace in main, and the page renders a placeholder without one.
    const projectId = project?.id
    if (projectId === undefined) return

    const now = new Date()
    const userMsg: ChatMessage = {
      id: `user-${now.getTime().toString()}`,
      role: 'user',
      text: textToSend.trim(),
      timestamp: now.toLocaleTimeString(),
    }

    const updatedMessages = [...activeThread.messages, userMsg]
    const firstLine = textToSend.trim().split('\n')[0] ?? ''
    const cleanPromptTitle = firstLine
      .replace(/^["'#*-]\s*/, '')
      .slice(0, 36)
      .trim()
    const updatedTitle =
      !activeThread.title ||
      activeThread.title.trim() === '' ||
      activeThread.title === 'New Conversation' ||
      activeThread.title.startsWith('Conversation ')
        ? cleanPromptTitle + (textToSend.trim().length > 36 ? '...' : '')
        : activeThread.title

    const updatedThread: ChatThread = {
      ...activeThread,
      title: updatedTitle,
      messages: updatedMessages,
    }

    const updatedThreads = threads.map((t) => (t.id === activeThread.id ? updatedThread : t))
    saveThreads(updatedThreads)
    setInput('')
    setThinking(true)
    setElapsed(0)

    const startTime = Date.now()
    const activeEngineLabel =
      availableEngines.find((e) => e.id === selectedEngineId)?.label ?? selectedEngineId
    const isForgeNative = selectedEngineId === 'forge-native-agent'
    const activeModelLabel = isForgeNative
      ? `${currentProvider?.name ?? 'Ollama (Local)'} / ${currentModel}`
      : `${activeEngineLabel} · ${activeEngineModelLabel}`

    // Construct direct, context-aware system prompt with repository context
    const systemPrompt = `You are an expert AI software engineer assisting directly inside Forge Orchestrator.
Project Context:
- Name: ${project?.name ?? 'Unknown'}
- Branch: ${probe?.branch ?? 'main'}
- Head Commit: ${probe?.headSha?.slice(0, 8) ?? 'N/A'}
- Tech Stack: ${project?.repository.tech.length ? project.repository.tech.join(', ') : 'TypeScript'}
- Rules & Guardrails: ${rules.length > 0 ? rules.map((r) => `[${r.scope}] ${r.statement}`).join('; ') : 'None'}

Instructions:
- Provide clear, direct, accurate, and context-aware responses.
- Use markdown formatting, code blocks, bullet points, and actionable solutions.`

    // Prepare chat history
    const historyPayload = updatedMessages
      .filter((m) => m.id !== 'welcome')
      .map((m) => ({
        role: m.role,
        content: m.text,
      }))

    let answer = ''
    let thinkingText = ''
    /** The tool trail, appended to whatever answer (or non-answer) results. */
    let toolTrail = ''

    // Streamed, so the reply appears as it is produced. Filtered by streamId
    // because chunks are broadcast to every window and two replies can overlap.
    const streamId = `s-${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`
    setLiveReply({ streamId, content: '', reasoning: '', timeline: [] })

    const unsubscribe = window.forge.onProviderChunk((chunk) => {
      if (chunk.streamId !== streamId) return
      setLiveReply((current) => {
        if (current?.streamId !== streamId) return current
        if (chunk.kind === 'reasoning') {
          const last = current.timeline.at(-1)
          // Appended to the open reasoning entry rather than starting a new one,
          // so a round's thinking reads as one paragraph instead of fragments.
          const timeline =
            last?.kind === 'reasoning'
              ? [
                  ...current.timeline.slice(0, -1),
                  { kind: 'reasoning' as const, text: last.text + chunk.text },
                ]
              : [...current.timeline, { kind: 'reasoning' as const, text: chunk.text }]
          return { ...current, reasoning: current.reasoning + chunk.text, timeline }
        }
        if (chunk.kind === 'tool') {
          return {
            ...current,
            timeline: [...current.timeline, { kind: 'tool' as const, text: chunk.text }],
          }
        }
        return { ...current, content: current.content + chunk.text }
      })
    })

    try {
      // Always the agent path. Whether tools are actually sent is decided in
      // main from the model's own reported capabilities, so a model without
      // tool support degrades to a plain completion rather than failing — and
      // nobody has to know in advance which of their models is which.
      const res = await window.forge.provider.agentTurn({
        streamId,
        projectId,
        providerId: currentProvider?.id ?? 'ollama',
        model: currentModel,
        endpointUrl: currentProvider?.localUrl,
        apiKey: currentProvider?.apiKey,
        systemPrompt: `${systemPrompt}

You are operating on a real repository through tools, not describing work to
someone else who will do it.

RULE: a request to change, update, add, fix or remove something in a file is a
request to EDIT IT NOW. Read what you need, then call edit_file. Replying with a
plan, a proposal, or a description of what you would add is a failed turn — the
file must actually change. Your final message reports what you changed.

- edit_file replaces one exact snippet and is the tool to reach for; you supply
  only the part that changes, so it works on large files.
- write_file replaces a whole file, so use it only for a new one.
- Never guess a file's contents. Read it, or list and search first.
- If a write is refused as out of scope, say so plainly rather than working
  around it.`,
        messages: historyPayload,
      })

      if (res.ok) thinkingText = res.value.reasoning

      if (res.ok && res.value.ok && res.value.content.trim() !== '') {
        answer = res.value.content
      } else if (res.ok && res.value.error !== null) {
        answer = `⚠️ **${activeModelLabel} could not finish:**\n\n${res.value.error}`
      }

      // Appended whatever the outcome. The trail is how the answer can be
      // trusted (A3), and on a turn that produced no answer it is the only
      // record of what was attempted — which is exactly the case where it was
      // previously dropped, leaving a bare and untrue connection error.
      if (res.ok) {
        const summary = toolSummary(res.value)
        if (summary !== null) toolTrail = summary
      }
    } catch (err) {
      console.error('Chat error:', err)
      answer = `⚠️ **Connection Error**:\n\nCould not reach ${activeModelLabel}. Please verify that the provider service is running.`
    } finally {
      // Unsubscribed in `finally` so a thrown request cannot leave a listener
      // attached, accumulating a second copy of the next reply.
      unsubscribe()
      setLiveReply(null)
    }

    // An empty reply is not evidence of a connection problem, and claiming one
    // was actively misleading: a turn that read six files and was then refused
    // a write reported "Unable to connect" while the model was plainly
    // reachable and had just answered. The tool trail is appended either way,
    // so what actually happened is visible rather than guessed at.
    if (!answer) {
      answer = `⚠️ **${activeModelLabel} finished without an answer.**\n\nIt used its tools but produced no final reply — usually a small model losing track after several rounds, or every path it tried being refused. The tool trail below shows what it attempted; asking again more specifically often works.`
    }

    if (toolTrail !== '')
      answer = `${answer}

---
${toolTrail}`

    const elapsedSeconds = Math.max(1, Math.round((Date.now() - startTime) / 1000))
    const responseTime = new Date()

    const assistantMsg: ChatMessage = {
      id: `ai-${responseTime.getTime().toString()}`,
      role: 'assistant',
      engineId: selectedEngineId,
      modelName: activeModelLabel,
      text: answer,
      timestamp: responseTime.toLocaleTimeString(),
      elapsed: `Taken ${String(elapsedSeconds)}s`,
      ...(thinkingText.trim() === '' ? {} : { reasoning: thinkingText }),
    }

    const finalMessages = [...updatedMessages, assistantMsg]
    const finalThread: ChatThread = {
      ...updatedThread,
      messages: finalMessages,
    }

    const finalThreads = threads.map((t) => (t.id === activeThread.id ? finalThread : t))
    saveThreads(finalThreads)
    setThinking(false)
  }

  // Filtered and sorted threads
  const filteredThreads = threads
    .filter((t) => {
      // Archived threads stay out of the list unless the archive is being shown,
      // and a search still reaches them there rather than hiding them twice.
      if (t.archived === true && !showArchived) return false
      if (searchQuery.trim() === '') return true
      return t.title.toLowerCase().includes(searchQuery.toLowerCase())
    })
    .slice()
    .sort((a, b) => {
      // Pinned first, regardless of the chosen order — that is what pinning is
      // for, and applying the sort to it would make the pin do nothing.
      if ((a.pinned === true) !== (b.pinned === true)) return a.pinned === true ? -1 : 1
      if (sortOrder === 'newest') return b.id.localeCompare(a.id)
      return a.id.localeCompare(b.id)
    })

  const archivedCount = threads.filter((t) => t.archived === true).length

  if (project === null) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-(--color-border) px-6 py-4">
          <h1 className="text-[16px] font-semibold text-(--color-text)">Ask</h1>
        </div>
        <div className="grid flex-1 place-content-center p-8 text-center text-[13px] text-(--color-text-muted)">
          Select or create a project from the top bar to explore and ask questions about its
          codebase.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full overflow-hidden">
      {/* ── Left Sidebar ── */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-(--color-border) bg-(--color-surface)">
        {/* New Chat Button */}
        <div className="p-3">
          <Button
            variant="primary"
            size="sm"
            onClick={handleCreateThread}
            className="w-full justify-center rounded-lg text-[12px] font-semibold h-9"
          >
            + New chat
          </Button>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <Input
            placeholder="Search chats..."
            value={searchQuery}
            onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
              setSearchQuery(e.target.value)
            }}
            className="h-8 text-[12px] bg-(--color-surface-raised)"
          />
        </div>

        {/* Sort & Persona selector */}
        <div className="flex items-center justify-between px-3 pb-2">
          <span className="text-[10px] font-semibold text-(--color-text-subtle) uppercase tracking-wider">
            Sort: {sortOrder === 'newest' ? 'Newest first' : 'Oldest first'}
          </span>
          <button
            type="button"
            onClick={() => {
              setSortOrder((prev) => (prev === 'newest' ? 'oldest' : 'newest'))
            }}
            className="text-[10px] text-(--color-accent) hover:underline cursor-pointer"
          >
            Toggle
          </button>
        </div>

        {/* Thread List */}
        <ScrollArea className="flex-1 px-2 pb-2">
          <div className="space-y-0.5">
            {filteredThreads.map((thread) => {
              const isCurrent = thread.id === activeThreadId
              const isRenaming = renamingId === thread.id

              return (
                // A div, not a button: the row carries its own action buttons,
                // and a button nested inside a button is invalid markup that
                // browsers resolve unpredictably.
                <div
                  key={thread.id}
                  className={cn(
                    'group relative flex w-full items-start justify-between rounded-lg px-2.5 py-2 transition-colors',
                    isCurrent
                      ? 'bg-(--color-accent)/10 text-(--color-accent)'
                      : 'text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text)',
                  )}
                >
                  {isRenaming ? (
                    <Input
                      autoFocus
                      value={renameDraft}
                      onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                        setRenameDraft(e.target.value)
                      }}
                      onBlur={() => {
                        handleRenameThread(thread)
                      }}
                      onKeyDown={(e: React.KeyboardEvent) => {
                        if (e.key === 'Enter') handleRenameThread(thread)
                        // Escape abandons the edit, leaving the old title.
                        if (e.key === 'Escape') setRenamingId(null)
                      }}
                      className="h-7 text-[12px]"
                    />
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => {
                          setActiveThreadId(thread.id)
                        }}
                        className="min-w-0 flex-1 cursor-pointer truncate pr-1.5 text-left py-0.5"
                      >
                        <div
                          className={cn(
                            'truncate text-[12px] leading-snug',
                            isCurrent ? 'font-semibold' : 'font-medium',
                          )}
                        >
                          {thread.pinned === true && <span className="mr-1">📌</span>}
                          {thread.archived === true && <span className="mr-1">🗄️</span>}
                          {thread.title.trim() !== '' ? thread.title : 'New chat'}
                        </div>
                      </button>

                      <button
                        type="button"
                        aria-label="Thread actions"
                        onClick={(e) => {
                          e.stopPropagation()
                          setMenuThreadId((current) => (current === thread.id ? null : thread.id))
                        }}
                        className="shrink-0 cursor-pointer px-1 text-[13px] opacity-0 group-hover:opacity-100 hover:text-(--color-text)"
                      >
                        ⋯
                      </button>
                    </>
                  )}

                  {menuThreadId === thread.id && (
                    <div
                      ref={threadMenuRef}
                      onClick={(e) => {
                        e.stopPropagation()
                      }}
                      className="absolute top-8 right-1 z-30 w-36 overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface-raised) shadow-lg"
                    >
                      <ThreadMenuItem
                        label={thread.pinned === true ? 'Unpin' : 'Pin'}
                        onSelect={() => {
                          handleTogglePin(thread)
                          setMenuThreadId(null)
                        }}
                      />
                      <ThreadMenuItem
                        label="Rename"
                        onSelect={() => {
                          setRenameDraft(thread.title)
                          setRenamingId(thread.id)
                          setMenuThreadId(null)
                        }}
                      />
                      <ThreadMenuItem
                        label={thread.archived === true ? 'Unarchive' : 'Archive'}
                        onSelect={() => {
                          handleToggleArchive(thread)
                          setMenuThreadId(null)
                        }}
                      />
                      <ThreadMenuItem
                        label="Delete"
                        danger
                        onSelect={(e) => {
                          handleDeleteThread(thread.id, e)
                          setMenuThreadId(null)
                        }}
                      />
                    </div>
                  )}
                </div>
              )
            })}
          </div>

          {archivedCount > 0 && (
            <button
              type="button"
              onClick={() => {
                setShowArchived((current) => !current)
              }}
              className="mt-2 w-full cursor-pointer px-2.5 py-1 text-left text-[10px] text-(--color-text-subtle) hover:text-(--color-text)"
            >
              {showArchived ? 'Hide' : 'Show'} archived ({archivedCount})
            </button>
          )}
        </ScrollArea>
      </aside>

      {/* ── Main Chat Area ── */}
      <div className="relative flex flex-1 flex-col min-w-0 bg-(--color-canvas) overflow-hidden">
        {/* Top Header Bar */}
        <header className="relative z-20 flex items-center justify-between px-6 py-2.5 bg-(--color-canvas)/85 backdrop-blur-md">
          {/* Subtle downward blur feather under header */}
          <div className="pointer-events-none absolute -bottom-5 left-0 right-0 h-5 bg-gradient-to-b from-(--color-canvas)/85 to-transparent" />
          <div className="min-w-0 flex items-center gap-3">
            <h1 className="text-[14px] font-bold text-(--color-text) truncate">
              {activeThread?.title && activeThread.title.trim() !== ''
                ? activeThread.title
                : 'New chat'}
            </h1>
          </div>
        </header>

        {/* Messages Area */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="max-w-4xl mx-auto px-6 pt-2 pb-6">
            {/* Empty state matching Image 3 when conversation has no messages */}
            {messages.length === 0 && (
              <div className="flex flex-col items-center justify-center min-h-[48vh] text-center px-4">
                <div className="flex items-center gap-2.5 mb-2">
                  <span className="text-2xl text-(--color-accent)">✦</span>
                  <h2 className="text-xl font-medium tracking-tight text-(--color-text)">
                    What&apos;s up next{project.name ? `, ${project.name}` : ''}?
                  </h2>
                </div>
                <p className="text-[13px] text-(--color-text-muted) max-w-md">
                  Ask a question about the codebase, explore architecture, plan changes, or run tasks.
                </p>
              </div>
            )}

            {messages.map((msg, index) => {
              const prevMsg = index > 0 ? messages[index - 1] : undefined
              const isFollowUp = msg.role === 'assistant' && prevMsg?.role === 'user'
              const isNewTurn = msg.role === 'user' && prevMsg?.role === 'assistant'
              const spacingClass =
                index === 0 ? '' : isFollowUp ? 'mt-2.5' : isNewTurn ? 'mt-6' : 'mt-3'

              return (
                <div key={msg.id} className={spacingClass}>
                  {msg.role === 'assistant' ? (
                    /* Assistant message — clean direct response stream (Claude Code style) */
                    <div className="group relative space-y-2">
                      {msg.reasoning !== undefined && msg.reasoning !== '' && (
                        <ThinkingBlock text={msg.reasoning} />
                      )}
                      <div
                        className="prose-container text-[13.5px] leading-relaxed text-(--color-text) select-text"
                        data-selectable
                      >
                        <MarkdownRenderer content={msg.text} />
                      </div>
                      {/* Subtle footer controls on hover: copy & elapsed */}
                      <div className="flex items-center gap-3 pt-0.5 text-[11px] text-(--color-text-subtle) opacity-0 group-hover:opacity-100 transition-opacity select-none">
                        <CopyTextButton text={msg.text} />
                        {msg.elapsed && <span>· {msg.elapsed}</span>}
                      </div>
                    </div>
                  ) : (
                    /* User message — right-aligned bubble with hover features on the left */
                    <div className="group flex items-center justify-end gap-2">
                      {/* On hover show some features; no hover don't show any */}
                      <div className="flex items-center gap-1.5 opacity-0 pointer-events-none transition-opacity duration-150 group-hover:opacity-100 group-hover:pointer-events-auto select-none shrink-0">
                        <span className="text-[11.5px] text-(--color-text-subtle)">
                          {formatRelativeTime(msg.timestamp, msg.id)}
                        </span>
                        <button
                          type="button"
                          onClick={() => {
                            handleCopyPrompt(msg.text, msg.id)
                          }}
                          title="Copy prompt"
                          aria-label="Copy prompt"
                          className="flex size-5 items-center justify-center rounded-md text-(--color-text-subtle) hover:bg-(--color-surface-raised) hover:text-(--color-text) transition-colors cursor-pointer"
                        >
                          {copiedPromptId === msg.id ? (
                            <PromptCheckIcon className="size-3.5 text-(--color-success)" />
                          ) : (
                            <PromptCopyIcon className="size-3.5" />
                          )}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            handleRetryPrompt(msg.text)
                          }}
                          title="Edit & retry prompt"
                          aria-label="Edit & retry prompt"
                          className="flex size-5 items-center justify-center rounded-md text-(--color-text-subtle) hover:bg-(--color-surface-raised) hover:text-(--color-text) transition-colors cursor-pointer"
                        >
                          <PromptRetryIcon className="size-3.5" />
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            handleForkFromPrompt(msg.id)
                          }}
                          title="Fork conversation from this prompt"
                          aria-label="Fork conversation from this prompt"
                          className="flex size-5 items-center justify-center rounded-md text-(--color-text-subtle) hover:bg-(--color-surface-raised) hover:text-(--color-text) transition-colors cursor-pointer"
                        >
                          <PromptForkIcon className="size-3.5" />
                        </button>
                      </div>

                      <div className="max-w-xl rounded-2xl bg-(--color-surface) border border-(--color-border)/40 px-3.5 py-1.5 text-[13px] leading-normal text-(--color-text) shadow-xs transition-colors">
                        {/* Selectable for the same reason the reply is: the body sets
                            `user-select: none`, so without this a user could not copy
                            back what they themselves had typed. */}
                        <div className="whitespace-pre-wrap select-text" data-selectable>
                          {msg.text}
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              )
            })}

            {/* The reply as it arrives */}
            {liveReply !== null && (
              <div className="mt-2.5 space-y-2">
                {liveReply.timeline.length > 0 && (
                  <div
                    className="space-y-1.5 rounded-lg border border-(--color-border) bg-(--color-surface-inset) px-3 py-2"
                    data-selectable
                  >
                    {liveReply.timeline.map((entry, index) =>
                      entry.kind === 'reasoning' ? (
                        <div
                          key={`r-${String(index)}`}
                          className="text-[11px] leading-relaxed whitespace-pre-wrap text-(--color-text-muted)"
                        >
                          <span className="mr-1">💭</span>
                          {entry.text}
                        </div>
                      ) : (
                        <div
                          key={`t-${String(index)}`}
                          className="font-mono text-[10px] leading-relaxed text-(--color-text-subtle)"
                        >
                          {entry.text}
                        </div>
                      ),
                    )}
                    {thinking && (
                      <div className="font-mono text-[10px] text-(--color-text-subtle)">
                        <span className="animate-pulse">working…</span>
                        {elapsed > 0 ? ` ${String(elapsed)}s` : ''}
                      </div>
                    )}
                  </div>
                )}
                {liveReply.content !== '' && (
                  <div className="prose-container text-[13.5px] leading-relaxed text-(--color-text)">
                    <MarkdownRenderer content={liveReply.content} />
                  </div>
                )}
              </div>
            )}

            {thinking &&
              liveReply?.content === '' &&
              liveReply.reasoning === '' &&
              liveReply.timeline.length === 0 && (
                <div className="mt-2.5 flex items-center gap-2 py-1 text-[12px] italic text-(--color-text-muted)">
                  <span className="inline-flex gap-1">
                    <span className="animate-bounce [animation-delay:0ms]">·</span>
                    <span className="animate-bounce [animation-delay:150ms]">·</span>
                    <span className="animate-bounce [animation-delay:300ms]">·</span>
                  </span>
                  <span>
                    Thinking...
                    {elapsed > 0 ? ` · ${String(elapsed)}s` : ''}
                  </span>
                </div>
              )}

            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        {/* Bottom Input Bar with Image 1-style blur feel */}
        <div className="relative z-20 bg-gradient-to-t from-(--color-canvas) via-(--color-canvas)/90 to-transparent px-6 pb-4 pt-4 backdrop-blur-md">
          {/* Top blur feather overlay fading into the message scroll area */}
          <div className="pointer-events-none absolute -top-8 left-0 right-0 h-8 bg-gradient-to-t from-(--color-canvas)/90 to-transparent backdrop-blur-[2px]" />
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleSend()
            }}
            className="mx-auto max-w-4xl"
          >
            <div className="relative flex flex-col rounded-2xl border border-(--color-border) bg-(--color-surface-raised) shadow-xs transition-colors focus-within:border-(--color-border-focus)/80 focus-within:ring-2 focus-within:ring-(--color-border-focus)/15">
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => {
                  setInput(e.target.value)
                }}
                onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void handleSend()
                  }
                }}
                disabled={thinking}
                placeholder="Describe a task or ask a question... (Shift+Enter for newline)"
                className="w-full resize-none border-0 bg-transparent px-4 pt-3 pb-1.5 text-[13.5px] leading-relaxed text-(--color-text) placeholder:text-(--color-text-subtle) focus:outline-none"
                autoFocus
              />

              {/* Bottom Card Controls Strip */}
              <div className="flex items-center justify-between px-3 pb-2.5 pt-1">
                <div className="flex items-center gap-2">
                  {/* Custom UI-matched Engine Selector Dropdown */}
                  <EngineSelectDropdown
                    value={selectedEngineId}
                    onChange={(newEngineId) => {
                      setSelectedEngineId(newEngineId)
                    }}
                    options={engineOptions}
                  />

                  {/* Custom UI-matched Model Selector Dropdown (Image 2 style) */}
                  {currentEngineModels.length > 0 && (
                    <ModelSelectDropdown
                      value={activeEngineModelId}
                      onChange={(newModel) => {
                        handleSelectEngineModel(newModel)
                      }}
                      options={currentEngineModels}
                    />
                  )}

                  {/* Dev Terminal Quick Launcher (Dev Mode Only) */}
                  {import.meta.env.DEV && (
                    <button
                      type="button"
                      onClick={openDevTerminal}
                      title="Inspect real model API calls, prompts, responses, and tool executions"
                      className="flex items-center gap-1 rounded-lg border border-(--color-border) bg-(--color-surface-inset) px-2 py-1 text-[11px] font-mono text-(--color-accent) hover:border-(--color-accent) hover:bg-(--color-accent)/10 transition-colors cursor-pointer"
                    >
                      <span>📟</span>
                      <span className="hidden sm:inline font-semibold">Dev Terminal</span>
                    </button>
                  )}
                </div>

                {/* Circular Send Button inside input card (Image 4) */}
                <button
                  type="submit"
                  disabled={input.trim() === '' || thinking}
                  title="Send message"
                  aria-label="Send message"
                  className="flex size-8 items-center justify-center rounded-full bg-(--color-accent) text-white shadow-xs transition-all hover:bg-(--color-accent-hover) disabled:cursor-not-allowed disabled:opacity-30 cursor-pointer shrink-0"
                >
                  <SendArrowIcon className="size-4" />
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    </div>
  )
}
