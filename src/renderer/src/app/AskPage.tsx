import React, { useEffect, useRef, useState } from 'react'
import {
  Badge,
  Button,
  type CustomAgentConfig,
  Input,
  MarkdownRenderer,
  ScrollArea,
  Select,
  useToast,
} from '../ui'
import { cn } from '../ui'
import { useProjectStore } from './projectStore'
import { unwrap } from '@renderer/ipc'

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
  readonly personaId: string
}

interface PersonaOption {
  readonly id: string
  readonly label: string
  readonly icon: string
  readonly description: string
  readonly defaultRole: string
}

interface StoredProviderConfig {
  readonly id: string
  readonly name: string
  readonly type: 'api_key' | 'local' | 'custom'
  readonly description: string
  readonly apiKey?: string | undefined
  readonly envVarHint?: string | undefined
  readonly localUrl?: string | undefined
  readonly models?: readonly string[] | undefined
  readonly activeModel?: string | undefined
}

const BUILTIN_PERSONAS: readonly PersonaOption[] = [
  {
    id: 'planner',
    label: 'Implementation Planner',
    icon: '🧠',
    description: 'Specializes in architecture design, dependency analysis, and stage planning.',
    defaultRole: 'planner',
  },
  {
    id: 'coder',
    label: 'Coding Agent',
    icon: '💻',
    description: 'Writes modular code, helper functions, refactors, and implementation patterns.',
    defaultRole: 'implementer',
  },
  {
    id: 'reviewer',
    label: 'Code Reviewer',
    icon: '🔍',
    description: 'Audits code quality, security boundaries, edge cases, and performance.',
    defaultRole: 'reviewer',
  },
  {
    id: 'tester',
    label: 'Test Designer',
    icon: '🧪',
    description: 'Designs unit test suites, integration tests, mocks, and edge case coverage.',
    defaultRole: 'tester',
  },
  {
    id: 'qa',
    label: 'QA Approver',
    icon: '🛡️',
    description: 'Validates acceptance criteria, regression safeguards, and verification flows.',
    defaultRole: 'qa',
  },
  {
    id: 'debugger',
    label: 'Debugger',
    icon: '🐛',
    description: 'Investigates root causes, error stack traces, and targeted fix recipes.',
    defaultRole: 'debugger',
  },
]

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

export function AskPage(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const project = detail?.project ?? null
  const probe = detail?.probe ?? null
  const rules = detail?.rules ?? []
  const { show } = useToast()

  const messagesEndRef = useRef<HTMLDivElement>(null)

  // Custom agents from localStorage
  const [customAgents] = useState<readonly CustomAgentConfig[]>(() => {
    const saved = localStorage.getItem('forge.custom_agents')
    if (saved) {
      try {
        return JSON.parse(saved) as CustomAgentConfig[]
      } catch {
        // fallback
      }
    }
    return []
  })

  // Providers & Active Model from localStorage
  const [providers, setProviders] = useState<readonly StoredProviderConfig[]>(() => {
    const saved = localStorage.getItem('forge.providers')
    if (saved) {
      try {
        const parsed = JSON.parse(saved) as StoredProviderConfig[]
        return parsed.map((p) => {
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
      } catch {
        // fallback
      }
    }
    return [
      {
        id: 'ollama',
        name: 'Ollama (Local)',
        type: 'local',
        description: 'Run open-weight models locally on your machine with Ollama.',
        localUrl: 'http://localhost:11434',
        models: [],
        activeModel: '',
      },
    ]
  })

  // Auto-scan Ollama on mount
  useEffect(() => {
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
  }, [])

  const [activeProviderId] = useState<string>(() => {
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

  // Combine personas
  const allPersonas: readonly PersonaOption[] = [
    ...BUILTIN_PERSONAS,
    ...customAgents.map((ca) => ({
      id: ca.id,
      label: ca.name,
      icon: '🤖',
      description: ca.instructions || 'Custom specialized agent persona',
      defaultRole: ca.roleType,
    })),
  ]

  const [selectedPersonaId, setSelectedPersonaId] = useState<string>('planner')
  const [selectedEngineId, setSelectedEngineId] = useState<string>('forge-native-agent')
  const [availableEngines, setAvailableEngines] = useState<
    readonly { id: string; label: string }[]
  >([
    { id: 'forge-native-agent', label: 'Forge Native Agent (Built-in)' },
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
          { id: 'forge-native-agent', label: 'Forge Native Agent (Built-in)' },
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

  // Chat Threads
  const [threads, setThreads] = useState<readonly ChatThread[]>(() => {
    const saved = localStorage.getItem('forge.ask_threads')
    if (saved) {
      try {
        return JSON.parse(saved) as ChatThread[]
      } catch {
        // fallback
      }
    }
    const initThreadId = 'thread-init'
    return [
      {
        id: initThreadId,
        title: 'New Conversation',
        createdAt: 'Today',
        personaId: 'planner',
        messages: [
          {
            id: 'welcome',
            role: 'assistant',
            personaName: 'Implementation Planner',
            personaIcon: '🧠',
            engineId: 'forge-native-agent',
            modelName: `${currentProvider?.name ?? 'Ollama'} / ${currentModel}`,
            text: `Hello! I am your **Implementation Planner** for **${project?.name ?? 'this project'}**.\n\nPowered by **Forge Native Agent** using **${currentProvider?.name ?? 'Ollama'} (${currentModel})**.\n\nAsk me anything to explore repository architecture, inspect code workflows, plan features, or diagnose issues.`,
            timestamp: '0:00:00',
          },
        ],
      },
    ]
  })

  const [activeThreadId, setActiveThreadId] = useState<string>(threads[0]?.id ?? 'thread-1')
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)
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
  /** Seconds the running turn has taken, so a slow turn visibly progresses. */
  const [elapsed, setElapsed] = useState(0)
  const [capabilities, setCapabilities] = useState<{
    readonly tools: boolean
    readonly vision: boolean
    readonly thinking: boolean
    readonly source: string
  } | null>(null)
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

  const activePersona = allPersonas.find((p) => p.id === selectedPersonaId) ?? allPersonas[0]

  // Auto-scroll to bottom on new messages
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages.length, thinking])

  const saveThreads = (updatedThreads: readonly ChatThread[]): void => {
    setThreads(updatedThreads)
    localStorage.setItem('forge.ask_threads', JSON.stringify(updatedThreads))
  }

  const handleCreateThread = (): void => {
    const now = new Date()
    const newThreadId = `thread-${String(now.getTime())}`
    const persona = allPersonas.find((p) => p.id === selectedPersonaId) ?? allPersonas[0]
    const activeModelDesc =
      selectedEngineId === 'forge-native-agent'
        ? `${currentProvider?.name ?? 'Ollama'} / ${currentModel}`
        : selectedEngineId

    const newThread: ChatThread = {
      id: newThreadId,
      title: `Conversation ${String(threads.length + 1)}`,
      createdAt: now.toLocaleDateString(),
      personaId: selectedPersonaId,
      messages: [
        {
          id: `welcome-${newThreadId}`,
          role: 'assistant',
          personaName: persona?.label ?? 'Assistant',
          personaIcon: persona?.icon ?? '🤖',
          engineId: selectedEngineId,
          modelName: activeModelDesc,
          text: `Started new thread with **${persona?.label ?? 'Assistant'}** (${activeModelDesc}).\n\nHow can I assist you with **${project?.name ?? 'your repository'}** today?`,
          timestamp: now.toLocaleTimeString(),
        },
      ],
    }

    const updated = [newThread, ...threads]
    saveThreads(updated)
    setActiveThreadId(newThreadId)
    show({ tone: 'neutral', title: 'New chat thread created' })
  }

  const handleDeleteThread = (threadId: string, e: React.MouseEvent): void => {
    e.stopPropagation()
    if (threads.length <= 1) return
    const updated = threads.filter((t) => t.id !== threadId)
    saveThreads(updated)
    if (activeThreadId === threadId && updated[0]) {
      setActiveThreadId(updated[0].id)
    }
  }

  // A visible clock while a turn runs. An agent turn reads files and can take
  // 30s or more, and the previous static "analyzing" line made that look like a
  // hang — which is exactly how it was reported.
  useEffect(() => {
    if (!thinking) return undefined

    const started = Date.now()
    // State is set only from the interval callback, never synchronously in the
    // effect body — the latter triggers the cascading render the
    // `react-hooks/set-state-in-effect` rule exists to prevent. The counter is
    // reset when the next turn starts rather than when this one ends.
    const timer = setInterval(() => {
      setElapsed(Math.round((Date.now() - started) / 1000))
    }, 1000)
    return () => {
      clearInterval(timer)
    }
  }, [thinking])

  // Dismissed on any outside click, so the menu cannot be left open over a row
  // it no longer belongs to. Registered only while a menu is open.
  useEffect(() => {
    if (menuThreadId === null) return undefined
    const close = (): void => {
      setMenuThreadId(null)
    }
    // Capture phase, so a click on another row's trigger still toggles that one
    // rather than being swallowed by this listener.
    window.addEventListener('click', close, { capture: true })
    return () => {
      window.removeEventListener('click', close, { capture: true })
    }
  }, [menuThreadId])

  /** Applies one change to one thread and persists the result. */
  const updateThread = (threadId: string, change: Partial<ChatThread>): void => {
    saveThreads(threads.map((t) => (t.id === threadId ? { ...t, ...change } : t)))
  }

  const handleTogglePin = (thread: ChatThread): void => {
    updateThread(thread.id, { pinned: thread.pinned !== true })
  }

  const handleToggleArchive = (thread: ChatThread): void => {
    const archived = thread.archived !== true
    updateThread(thread.id, { archived, ...(archived ? { pinned: false } : {}) })

    // Archiving the open thread would leave the transcript showing something the
    // list no longer offers, so move to the first thread still visible.
    if (archived && activeThreadId === thread.id) {
      const next = threads.find((t) => t.id !== thread.id && t.archived !== true)
      if (next !== undefined) setActiveThreadId(next.id)
    }
  }

  const handleRenameThread = (thread: ChatThread): void => {
    const title = renameDraft.trim()
    // An empty title would leave an unidentifiable row; keeping the old one is
    // the honest outcome of a cancelled rename.
    if (title !== '') updateThread(thread.id, { title })
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
    inputRef.current?.focus()
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
    const updatedTitle =
      activeThread.messages.length <= 1
        ? textToSend.trim().slice(0, 30) + (textToSend.trim().length > 30 ? '...' : '')
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
    const isForgeNative = selectedEngineId === 'forge-native-agent'
    const activeModelLabel = isForgeNative
      ? `${currentProvider?.name ?? 'Ollama (Local)'} / ${currentModel}`
      : selectedEngineId

    // Construct system prompt with repository context & active persona
    const systemPrompt = `You are ${activePersona?.label ?? 'an AI Assistant'}, an expert software engineering persona inside Forge Orchestrator.
Project Context:
- Name: ${project?.name ?? 'Unknown'}
- Branch: ${probe?.branch ?? 'main'}
- Head Commit: ${probe?.headSha?.slice(0, 8) ?? 'N/A'}
- Tech Stack: ${project?.repository.tech.length ? project.repository.tech.join(', ') : 'TypeScript'}
- Rules & Guardrails: ${rules.length > 0 ? rules.map((r) => `[${r.scope}] ${r.statement}`).join('; ') : 'None'}

Persona Role:
- ${activePersona?.description ?? 'Provide helpful code explanations and guidance.'}

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

      if (res.ok) setCapabilities(res.value.capabilities)

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
      personaName: activePersona?.label ?? 'Assistant',
      personaIcon: activePersona?.icon ?? '🤖',
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
                        className="min-w-0 flex-1 cursor-pointer truncate pr-1.5 text-left"
                      >
                        <div
                          className={cn(
                            'truncate text-[12px]',
                            isCurrent ? 'font-semibold' : 'font-medium',
                          )}
                        >
                          {thread.pinned === true && <span className="mr-1">📌</span>}
                          {thread.archived === true && <span className="mr-1">🗄️</span>}
                          {thread.title}
                        </div>
                        <div className="mt-0.5 font-mono text-[10px] text-(--color-text-subtle)">
                          {thread.messages.length > 1
                            ? `${String(thread.messages.length)} msgs`
                            : '1 msg'}{' '}
                          · {thread.createdAt}
                        </div>
                      </button>

                      <button
                        type="button"
                        aria-label="Thread actions"
                        onClick={() => {
                          setMenuThreadId((current) => (current === thread.id ? null : thread.id))
                        }}
                        className="shrink-0 cursor-pointer px-1 text-[13px] opacity-0 group-hover:opacity-100 hover:text-(--color-text)"
                      >
                        ⋯
                      </button>
                    </>
                  )}

                  {menuThreadId === thread.id && (
                    <div className="absolute top-8 right-1 z-20 w-36 overflow-hidden rounded-lg border border-(--color-border) bg-(--color-surface-raised) shadow-lg">
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
                      {threads.length > 1 && (
                        <ThreadMenuItem
                          label="Delete"
                          danger
                          onSelect={(e) => {
                            handleDeleteThread(thread.id, e)
                            setMenuThreadId(null)
                          }}
                        />
                      )}
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

        {/* Bottom controls: Persona selector */}
        <div className="border-t border-(--color-border) p-3">
          <span className="text-[10px] font-bold uppercase tracking-wider text-(--color-text-subtle) block mb-1.5">
            Active Persona
          </span>
          {/* Persona selector (compact) — opens upward */}
          <Select
            aria-label="Active Persona"
            value={selectedPersonaId}
            direction="up"
            onChange={(e: { target: { value: string } }) => {
              setSelectedPersonaId(e.target.value)
            }}
            options={allPersonas.map((p) => ({
              value: p.id,
              label: p.label,
            }))}
          />
        </div>
      </aside>

      {/* ── Main Chat Area ── */}
      <div className="flex flex-1 flex-col min-w-0 bg-(--color-canvas)">
        {/* Top Header Bar */}
        <header className="flex items-center justify-between border-b border-(--color-border) px-6 py-2.5 bg-(--color-surface-raised)">
          <div className="min-w-0 flex items-center gap-3">
            <h1 className="text-[14px] font-bold text-(--color-text) truncate">
              {activeThread?.title ?? 'Chat'}
            </h1>
            <Badge tone="accent" size="sm" className="hidden sm:inline-flex font-mono text-[11px]">
              {selectedEngineId === 'forge-native-agent'
                ? `Forge Agent · ${currentProvider?.name ?? 'Ollama'} (${currentModel})`
                : selectedEngineId}
            </Badge>
            {/* What the model reported it can do, once a turn has asked. Shown
                rather than offered as a choice: capability belongs to the model,
                and a toggle let tools be enabled on one that has none. */}
            {capabilities !== null && (
              <div className="hidden items-center gap-1 lg:flex">
                {capabilities.tools ? (
                  <Badge tone="success" size="sm" className="text-[10px]">
                    tools
                  </Badge>
                ) : (
                  <Badge tone="warning" size="sm" className="text-[10px]">
                    no tools — chat only
                  </Badge>
                )}
                {capabilities.thinking && (
                  <Badge tone="neutral" size="sm" className="text-[10px]">
                    thinking
                  </Badge>
                )}
                {capabilities.vision && (
                  <Badge tone="neutral" size="sm" className="text-[10px]">
                    vision
                  </Badge>
                )}
                {capabilities.source !== 'reported' && (
                  <Badge
                    tone="neutral"
                    size="sm"
                    className="text-[10px]"
                    title="Assumed, not reported by the provider"
                  >
                    {capabilities.source}
                  </Badge>
                )}
              </div>
            )}
          </div>

          <div className="flex items-center gap-2">
            {/* If Forge Agent is selected, allow picking models directly */}
            {selectedEngineId === 'forge-native-agent' &&
              currentProvider?.models &&
              currentProvider.models.length > 0 && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] font-semibold text-(--color-text-subtle) hidden md:inline">
                    Model:
                  </span>
                  <div className="w-44">
                    <Select
                      aria-label="Active Model"
                      value={currentModel}
                      onChange={(e: { target: { value: string } }) => {
                        handleSelectModel(e.target.value)
                      }}
                      options={currentProvider.models.map((m) => ({
                        value: m,
                        label: m,
                      }))}
                    />
                  </div>
                </div>
              )}
          </div>
        </header>

        {/* Messages Area */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="max-w-4xl mx-auto px-6 py-4 space-y-5">
            {messages.map((msg) => (
              <div key={msg.id}>
                {msg.role === 'assistant' ? (
                  /* Assistant message — full-width block with icon & metadata */
                  <div className="flex gap-3">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-(--color-accent-muted) text-[14px] mt-1">
                      {msg.personaIcon ?? '🤖'}
                    </div>
                    <div className="min-w-0 flex-1 space-y-1.5">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-bold text-(--color-text)">
                          {msg.personaName ?? 'Assistant'}
                        </span>
                        {msg.modelName && (
                          <Badge tone="neutral" size="sm" className="font-mono text-[10px]">
                            {msg.modelName}
                          </Badge>
                        )}
                        {msg.elapsed && (
                          <span className="text-[10px] text-(--color-text-subtle)">
                            {msg.elapsed}
                          </span>
                        )}
                        {/* The whole reply, as its markdown source rather than the
                            rendered text — pasting a table back as pipes is what
                            makes it reusable somewhere else. */}
                        <CopyTextButton text={msg.text} />
                      </div>
                      {msg.reasoning !== undefined && msg.reasoning !== '' && (
                        <ThinkingBlock text={msg.reasoning} />
                      )}
                      <div className="prose-container text-[13px] leading-relaxed text-(--color-text)">
                        <MarkdownRenderer content={msg.text} />
                      </div>
                    </div>
                  </div>
                ) : (
                  /* User message — right-aligned bubble with hover features */
                  <div className="group flex flex-col items-end">
                    <div className="max-w-xl rounded-2xl bg-(--color-surface) border border-(--color-border) px-5 py-3 text-[13.5px] leading-relaxed text-(--color-text) shadow-xs transition-colors">
                      {/* Selectable for the same reason the reply is: the body sets
                          `user-select: none`, so without this a user could not copy
                          back what they themselves had typed. */}
                      <div className="whitespace-pre-wrap select-text" data-selectable>
                        {msg.text}
                      </div>
                    </div>

                    {/* On hover show some features; no hover don't show any */}
                    <div className="mt-1 flex items-center gap-2 pr-1 opacity-0 pointer-events-none transition-opacity duration-150 group-hover:opacity-100 group-hover:pointer-events-auto select-none">
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
                        className="flex size-6 items-center justify-center rounded-md text-(--color-text-subtle) hover:bg-(--color-surface-raised) hover:text-(--color-text) transition-colors cursor-pointer"
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
                        className="flex size-6 items-center justify-center rounded-md text-(--color-text-subtle) hover:bg-(--color-surface-raised) hover:text-(--color-text) transition-colors cursor-pointer"
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
                        className="flex size-6 items-center justify-center rounded-md text-(--color-text-subtle) hover:bg-(--color-surface-raised) hover:text-(--color-text) transition-colors cursor-pointer"
                      >
                        <PromptForkIcon className="size-3.5" />
                      </button>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* The reply as it arrives. The dots alone said only "something is
                happening"; the text says what, and whether the model is making
                progress or stuck. */}
            {liveReply !== null && (
              <div className="flex gap-3 px-10">
                <div className="min-w-0 flex-1 space-y-1.5">
                  {/* Reasoning and tool calls in the order they happened, so
                      the thinking reads as the explanation for the calls that
                      follow it. Live only: this is evidence about the turn, not
                      part of the answer that gets saved. */}
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
                    <div className="text-[13px] leading-relaxed text-(--color-text)">
                      <MarkdownRenderer content={liveReply.content} />
                    </div>
                  )}
                </div>
              </div>
            )}

            {thinking &&
              liveReply?.content === '' &&
              liveReply.reasoning === '' &&
              liveReply.timeline.length === 0 && (
                <div className="flex items-center gap-2 px-10 text-[12px] italic text-(--color-text-muted)">
                  <span className="inline-flex gap-1">
                    <span className="animate-bounce [animation-delay:0ms]">·</span>
                    <span className="animate-bounce [animation-delay:150ms]">·</span>
                    <span className="animate-bounce [animation-delay:300ms]">·</span>
                  </span>
                  <span>
                    {activePersona?.label} is working ({currentModel})
                    {elapsed > 0 ? ` · ${String(elapsed)}s` : ''}
                  </span>
                </div>
              )}

            <div ref={messagesEndRef} />
          </div>
        </ScrollArea>

        {/* Bottom Input Bar */}
        <div className="border-t border-(--color-border) bg-(--color-surface-raised) px-6 py-3">
          <form
            onSubmit={(e) => {
              e.preventDefault()
              void handleSend()
            }}
            className="flex items-center gap-3 max-w-4xl mx-auto"
          >
            <div className="flex-1 relative">
              <Input
                ref={inputRef}
                placeholder={
                  currentModel
                    ? `Ask Forge Agent (${currentModel}) about ${project.name}...`
                    : `Ask about ${project.name}...`
                }
                value={input}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setInput(e.target.value)
                }}
                disabled={thinking}
                className="h-10 text-[13px] pr-10 rounded-xl bg-(--color-surface) border-(--color-border)"
                autoFocus
              />
            </div>

            {/* Engine selector (compact) */}
            <div className="w-48 shrink-0">
              <Select
                aria-label="Engine"
                value={selectedEngineId}
                direction="up"
                onChange={(e: { target: { value: string } }) => {
                  setSelectedEngineId(e.target.value)
                }}
                options={availableEngines.map((eng) => ({
                  value: eng.id,
                  label: eng.label,
                }))}
              />
            </div>

            {/* Model selector if Forge Native Agent is active */}
            {selectedEngineId === 'forge-native-agent' &&
              currentProvider?.models &&
              currentProvider.models.length > 0 && (
                <div className="w-44 shrink-0">
                  <Select
                    aria-label="Model"
                    value={currentModel}
                    direction="up"
                    onChange={(e: { target: { value: string } }) => {
                      handleSelectModel(e.target.value)
                    }}
                    options={currentProvider.models.map((m) => ({
                      value: m,
                      label: m,
                    }))}
                  />
                </div>
              )}

            <Button
              type="submit"
              variant="primary"
              disabled={input.trim() === '' || thinking}
              className="h-9 px-5 text-[12px] font-semibold rounded-lg shrink-0"
            >
              Send
            </Button>
          </form>
        </div>
      </div>
    </div>
  )
}
