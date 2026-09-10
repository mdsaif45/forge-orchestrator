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
import { ConversationMenu } from './ask/ConversationMenu'
import { SlashCommandsMenu, SLASH_COMMANDS } from './ask/SlashCommandsMenu'
import { AskArtifactsDrawer } from './ask/AskArtifactsDrawer'

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
    description: 'Verifies release criteria, regression smoke tests, and PR signoff.',
    defaultRole: 'reviewer',
  },
]

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

/** Collapsible execution step block matching modern developer agent experience */
function ExecutionBlock({
  title = 'Confirmed current branch/commit state before writing the handoff prompt',
  children,
}: {
  readonly title?: string
  readonly children: React.ReactNode
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className="my-2 rounded-xl border border-(--color-border) bg-(--color-surface-raised)/60 overflow-hidden text-[12px]">
      <button
        type="button"
        onClick={() => {
          setExpanded(!expanded)
        }}
        className="flex w-full items-center justify-between px-3 py-2 text-left font-mono text-[11px] text-(--color-text-muted) hover:text-(--color-text) hover:bg-(--color-surface-inset) cursor-pointer select-none"
      >
        <span className="truncate">{title}</span>
        <svg
          className={cn(
            'size-3 text-(--color-text-subtle) transition-transform shrink-0',
            expanded ? 'rotate-90' : '',
          )}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polyline points="9 18 15 12 9 6" />
        </svg>
      </button>
      {expanded && (
        <div
          className="border-t border-(--color-border) p-3 bg-(--color-surface-inset)/50 max-h-60 overflow-y-auto"
          data-selectable
        >
          {children}
        </div>
      )}
    </div>
  )
}

/** Copies one message's markdown source. */
function CopyTextButton({ text }: { readonly text: string }): React.JSX.Element {
  const [copied, setCopied] = useState(false)

  return (
    <button
      type="button"
      aria-label="Copy message"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true)
          setTimeout(() => {
            setCopied(false)
          }, 1200)
        })
      }}
      className="cursor-pointer text-[10px] text-(--color-text-subtle) hover:text-(--color-text)"
    >
      {copied ? 'Copied' : 'Copy'}
    </button>
  )
}

export function AskPage(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const project = detail?.project ?? null
  const probe = detail?.probe ?? null
  const rules = detail?.rules ?? []
  const { show } = useToast()

  const messagesEndRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

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
            modelName: 'Ollama (Local)',
            text: `Welcome to **Forge Ask**. How can I help you explore this project's architecture, workflows, and conventions today?`,
            timestamp: 'Just now',
          },
        ],
      },
    ]
  })

  const [activeThreadId, setActiveThreadId] = useState<string>(
    () => threads[0]?.id ?? 'thread-init',
  )
  const [input, setInput] = useState('')
  const [thinking, setThinking] = useState(false)
  const [elapsed, setElapsed] = useState(0)
  const [capabilities, setCapabilities] = useState<{
    readonly tools: boolean
    readonly thinking: boolean
    readonly vision: boolean
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
    readonly timeline: readonly { readonly kind: 'reasoning' | 'tool'; readonly text: string }[]
  } | null>(null)

  // Modern UI states
  const [artifactsDrawerOpen, setArtifactsDrawerOpen] = useState(false)
  const [conversationMenuOpen, setConversationMenuOpen] = useState(false)
  const [slashMenuOpen, setSlashMenuOpen] = useState(false)
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0)
  const [reasoningEffort, setReasoningEffort] = useState<'Low' | 'Medium' | 'High'>('High')
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [editingSessionTitle, setEditingSessionTitle] = useState(false)
  const [tempSessionTitle, setTempSessionTitle] = useState('')

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

  const handleDeleteThread = (threadId: string, e?: React.MouseEvent): void => {
    e?.stopPropagation()
    if (threads.length <= 1) return
    const updated = threads.filter((t) => t.id !== threadId)
    saveThreads(updated)
    if (activeThreadId === threadId && updated[0]) {
      setActiveThreadId(updated[0].id)
    }
  }

  // A visible clock while a turn runs
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

  // Dismiss menu on outside click
  useEffect(() => {
    if (menuThreadId === null) return undefined
    const close = (): void => {
      setMenuThreadId(null)
    }
    window.addEventListener('click', close, { capture: true })
    return () => {
      window.removeEventListener('click', close, { capture: true })
    }
  }, [menuThreadId])

  const updateThread = (threadId: string, change: Partial<ChatThread>): void => {
    saveThreads(threads.map((t) => (t.id === threadId ? { ...t, ...change } : t)))
  }

  const handleTogglePin = (thread: ChatThread): void => {
    updateThread(thread.id, { pinned: thread.pinned !== true })
  }

  const handleToggleArchive = (thread: ChatThread): void => {
    const archived = thread.archived !== true
    updateThread(thread.id, { archived, ...(archived ? { pinned: false } : {}) })

    if (archived && activeThreadId === thread.id) {
      const next = threads.find((t) => t.id !== thread.id && t.archived !== true)
      if (next !== undefined) setActiveThreadId(next.id)
    }
  }

  const handleRenameThread = (thread: ChatThread): void => {
    const title = renameDraft.trim()
    if (title !== '') updateThread(thread.id, { title })
    setRenamingId(null)
  }

  const handleForkConversation = (fromMessageId?: string): void => {
    if (!activeThread) return
    let forkedMsgs = activeThread.messages
    if (fromMessageId) {
      const idx = activeThread.messages.findIndex((m) => m.id === fromMessageId)
      if (idx !== -1) {
        forkedMsgs = activeThread.messages.slice(0, idx + 1)
      }
    }
    const newId = `thread-${String(Date.now())}`
    const forkedThread: ChatThread = {
      id: newId,
      title: `${activeThread.title} (Fork)`,
      createdAt: 'Just now',
      personaId: selectedPersonaId,
      messages: forkedMsgs,
    }
    const updated = [forkedThread, ...threads]
    saveThreads(updated)
    setActiveThreadId(newId)
    show({
      tone: 'success',
      title: 'Conversation forked',
      description: `Branched into "${forkedThread.title}"`,
    })
  }

  const handleExportTranscript = (format: 'markdown' | 'jsonl'): void => {
    if (!activeThread) return
    let content: string
    if (format === 'markdown') {
      content = `# ${activeThread.title}\n\n`
      for (const m of activeThread.messages) {
        content += `### ${m.role === 'user' ? 'User' : (m.personaName ?? 'Assistant')} (${m.timestamp})\n\n${m.text}\n\n---\n\n`
      }
    } else {
      content = activeThread.messages.map((m) => JSON.stringify(m)).join('\n')
    }
    void navigator.clipboard.writeText(content)
    show({
      tone: 'success',
      title: 'Transcript copied',
      description: `Exported ${format.toUpperCase()} copied to clipboard.`,
    })
  }

  const handleRetryPrompt = (text: string): void => {
    setInput(text)
    textareaRef.current?.focus()
  }

  const handleCommitSessionRename = (): void => {
    if (tempSessionTitle.trim() && activeThread) {
      updateThread(activeThread.id, { title: tempSessionTitle.trim() })
    }
    setEditingSessionTitle(false)
  }

  const handleSend = async (queryText?: string): Promise<void> => {
    const textToSend = queryText ?? input
    if (textToSend.trim() === '' || thinking || activeThread === undefined) return
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
    setSlashMenuOpen(false)
    setThinking(true)
    setElapsed(0)

    const startTime = Date.now()
    const isForgeNative = selectedEngineId === 'forge-native-agent'
    const activeModelLabel = isForgeNative
      ? `${currentProvider?.name ?? 'Ollama (Local)'} / ${currentModel}`
      : selectedEngineId

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

    const historyPayload = updatedMessages
      .filter((m) => m.id !== 'welcome')
      .map((m) => ({
        role: m.role,
        content: m.text,
      }))

    let answer = ''
    let thinkingText = ''
    let toolTrail = ''

    const streamId = `s-${Date.now().toString()}-${Math.random().toString(36).slice(2, 8)}`
    setLiveReply({ streamId, content: '', reasoning: '', timeline: [] })

    const unsubscribe = window.forge.onProviderChunk((chunk) => {
      if (chunk.streamId !== streamId) return
      setLiveReply((current) => {
        if (current?.streamId !== streamId) return current
        if (chunk.kind === 'reasoning') {
          const last = current.timeline.at(-1)
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

      if (res.ok) {
        const summary = toolSummary(res.value)
        if (summary !== null) toolTrail = summary
      }
    } catch (err) {
      console.error('Chat error:', err)
      answer = `⚠️ **Connection Error**:\n\nCould not reach ${activeModelLabel}. Please verify that the provider service is running.`
    } finally {
      unsubscribe()
      setLiveReply(null)
    }

    if (!answer) {
      answer = `⚠️ **${activeModelLabel} finished without an answer.**\n\nIt used its tools but produced no final reply — usually a small model losing track after several rounds, or every path it tried being refused. The tool trail below shows what it attempted; asking again more specifically often works.`
    }

    if (toolTrail !== '') {
      answer = `${answer}\n\n---\n${toolTrail}`
    }

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
      if (t.archived === true && !showArchived) return false
      if (searchQuery.trim() === '') return true
      return t.title.toLowerCase().includes(searchQuery.toLowerCase())
    })
    .slice()
    .sort((a, b) => {
      if ((a.pinned === true) !== (b.pinned === true)) return a.pinned === true ? -1 : 1
      if (sortOrder === 'newest') return b.id.localeCompare(a.id)
      return a.id.localeCompare(b.id)
    })

  const pinnedThreads = filteredThreads.filter((t) => t.pinned === true)
  const recentThreads = filteredThreads.filter((t) => t.pinned !== true)
  const archivedCount = threads.filter((t) => t.archived === true).length

  // Slash commands input handling
  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
    const val = e.target.value
    setInput(val)
    if (val.startsWith('/')) {
      setSlashMenuOpen(true)
      setSlashSelectedIndex(0)
    } else {
      setSlashMenuOpen(false)
    }
  }

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): void => {
    if (slashMenuOpen) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setSlashSelectedIndex((prev) => (prev + 1) % SLASH_COMMANDS.length)
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setSlashSelectedIndex((prev) => (prev - 1 + SLASH_COMMANDS.length) % SLASH_COMMANDS.length)
        return
      }
      if (e.key === 'Enter') {
        e.preventDefault()
        const selected = SLASH_COMMANDS[slashSelectedIndex]
        if (selected) {
          setInput(selected.command + ' ')
          setSlashMenuOpen(false)
        }
        return
      }
      if (e.key === 'Escape') {
        setSlashMenuOpen(false)
        return
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void handleSend()
    }
  }

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
    <div className="flex h-full overflow-hidden relative">
      {/* ── Ask Mode Threads Drawer (Left Pane) ── */}
      <aside className="flex w-64 shrink-0 flex-col border-r border-(--color-border) bg-(--color-surface)">
        {/* New Chat Button */}
        <div className="p-3">
          <Button
            variant="primary"
            size="sm"
            onClick={handleCreateThread}
            className="w-full justify-center rounded-xl text-[12px] font-semibold h-9 shadow-xs"
          >
            <span className="mr-1 text-[13px] font-bold">+</span> New chat
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
            className="h-8 text-[12px] rounded-lg bg-(--color-surface-raised)"
          />
        </div>

        {/* Sort header */}
        <div className="flex items-center justify-between px-3 pb-1.5 text-[10px] font-semibold text-(--color-text-subtle) uppercase tracking-wider">
          <span>Sort: {sortOrder === 'newest' ? 'Newest' : 'Oldest'}</span>
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

        {/* Threads List */}
        <ScrollArea className="flex-1 px-2 pb-2">
          <div className="space-y-1">
            {/* Pinned Section */}
            {pinnedThreads.length > 0 && (
              <div className="mb-2">
                <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold tracking-wider text-(--color-text-subtle) uppercase">
                  <span>📌 Pinned</span>
                </div>
                {pinnedThreads.map((thread) => {
                  const isCurrent = thread.id === activeThreadId
                  const isRenaming = renamingId === thread.id
                  return (
                    <div
                      key={thread.id}
                      className={cn(
                        'group relative flex w-full items-start justify-between rounded-lg px-2.5 py-1.5 transition-colors',
                        isCurrent
                          ? 'bg-(--color-surface-raised) text-(--color-text) font-semibold shadow-xs'
                          : 'text-(--color-text-muted) hover:bg-(--color-surface-raised)/60 hover:text-(--color-text)',
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
                            <div className="flex items-center gap-1.5 truncate text-[12px]">
                              <span className="size-1.5 rounded-full bg-(--color-accent) shrink-0" />
                              <span className="truncate">{thread.title}</span>
                            </div>
                            <div className="ml-3 mt-0.5 font-mono text-[10px] text-(--color-text-subtle)">
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
                              setMenuThreadId((current) =>
                                current === thread.id ? null : thread.id,
                              )
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
                            label="Unpin"
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
            )}

            {/* Recents Section */}
            <div className="flex items-center gap-1 px-2 py-1 text-[10px] font-bold tracking-wider text-(--color-text-subtle) uppercase">
              <span>Recents</span>
            </div>
            {recentThreads.map((thread) => {
              const isCurrent = thread.id === activeThreadId
              const isRenaming = renamingId === thread.id

              return (
                <div
                  key={thread.id}
                  className={cn(
                    'group relative flex w-full items-start justify-between rounded-lg px-2.5 py-1.5 transition-colors',
                    isCurrent
                      ? 'bg-(--color-surface-raised) text-(--color-text) font-semibold shadow-xs'
                      : 'text-(--color-text-muted) hover:bg-(--color-surface-raised)/60 hover:text-(--color-text)',
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
                        <div className="flex items-center gap-1.5 truncate text-[12px]">
                          <span
                            className={cn(
                              'size-1.5 rounded-full shrink-0',
                              isCurrent ? 'bg-(--color-accent)' : 'bg-(--color-text-subtle)',
                            )}
                          />
                          <span className="truncate">{thread.title}</span>
                        </div>
                        <div className="ml-3 mt-0.5 font-mono text-[10px] text-(--color-text-subtle)">
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

        {/* CLI Session Import Callout Banner */}
        {!bannerDismissed && (
          <div className="m-2 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-2.5 text-[11px] shadow-xs">
            <div className="flex items-start justify-between gap-1">
              <span className="font-semibold text-(--color-text)">
                ⚡ 9 CLI sessions on this computer
              </span>
              <button
                type="button"
                onClick={() => {
                  setBannerDismissed(true)
                }}
                className="text-(--color-text-subtle) hover:text-(--color-text) cursor-pointer"
              >
                ✕
              </button>
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  setBannerDismissed(true)
                  handleCreateThread()
                }}
                className="font-medium text-(--color-accent) hover:underline cursor-pointer"
              >
                Import
              </button>
            </div>
          </div>
        )}

        {/* Persona Selector (Bottom of Sidebar) */}
        <div className="border-t border-(--color-border) p-3">
          <span className="text-[10px] font-bold uppercase tracking-wider text-(--color-text-subtle) block mb-1.5">
            Active Persona
          </span>
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
        {/* Top Chat Header Bar */}
        <header className="flex items-center justify-between border-b border-(--color-border) px-5 py-2.5 bg-(--color-surface)">
          <h1 className="sr-only">Ask</h1>
          <div className="min-w-0 flex items-center gap-2.5">
            {editingSessionTitle ? (
              <input
                type="text"
                autoFocus
                value={tempSessionTitle}
                onChange={(e) => {
                  setTempSessionTitle(e.target.value)
                }}
                onBlur={handleCommitSessionRename}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleCommitSessionRename()
                  if (e.key === 'Escape') setEditingSessionTitle(false)
                }}
                className="h-6 rounded border border-(--color-border-focus) bg-(--color-surface-raised) px-1.5 text-[13px] font-semibold text-(--color-text) outline-none"
              />
            ) : (
              <span
                onDoubleClick={() => {
                  setTempSessionTitle(activeThread?.title ?? '')
                  setEditingSessionTitle(true)
                }}
                title="Double click to rename session"
                className="cursor-pointer text-[14px] font-bold text-(--color-text) truncate hover:underline"
              >
                {activeThread?.title ?? 'Chat'}
              </span>
            )}

            <Badge tone="accent" size="sm" className="font-mono text-[11px] truncate max-w-[280px]">
              {selectedEngineId === 'forge-native-agent'
                ? `Forge Agent · ${currentProvider?.name ?? 'Ollama'} (${currentModel})`
                : selectedEngineId}
            </Badge>

            {capabilities !== null && (
              <div className="hidden items-center gap-1 xl:flex">
                {capabilities.tools ? (
                  <Badge tone="success" size="sm" className="text-[10px]">
                    tools
                  </Badge>
                ) : (
                  <Badge tone="warning" size="sm" className="text-[10px]">
                    no tools
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
              </div>
            )}
          </div>

          <div className="flex items-center gap-1.5">
            {/* Deliverables / Artifacts Drawer Toggle */}
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                setArtifactsDrawerOpen(true)
              }}
              className="h-7 px-2 text-[12px] text-(--color-text-muted) hover:text-(--color-text)"
            >
              <svg
                className="size-3.5 mr-1"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="7 10 12 15 17 10" />
                <line x1="12" y1="15" x2="12" y2="3" />
              </svg>
              Deliverables
            </Button>

            {/* Engine Selector */}
            <div className="w-40 hidden md:block">
              <Select
                aria-label="Engine"
                value={selectedEngineId}
                onChange={(e: { target: { value: string } }) => {
                  setSelectedEngineId(e.target.value)
                }}
                options={availableEngines.map((eng) => ({
                  value: eng.id,
                  label: eng.label,
                }))}
              />
            </div>

            {/* Model Selector if native agent */}
            {selectedEngineId === 'forge-native-agent' &&
              currentProvider?.models &&
              currentProvider.models.length > 0 && (
                <div className="w-36 hidden sm:block">
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
              )}

            {/* 3-Dots Conversation Options Menu */}
            <div className="relative">
              <Button
                size="sm"
                variant="ghost"
                aria-label="Conversation options"
                onClick={() => {
                  setConversationMenuOpen(!conversationMenuOpen)
                }}
                className="h-7 w-7 p-0 text-(--color-text-muted) hover:text-(--color-text)"
              >
                ⁝
              </Button>

              <ConversationMenu
                open={conversationMenuOpen}
                onClose={() => {
                  setConversationMenuOpen(false)
                }}
                onRename={() => {
                  setTempSessionTitle(activeThread?.title ?? '')
                  setEditingSessionTitle(true)
                }}
                onFork={() => {
                  handleForkConversation()
                }}
                onTranscriptView={(format) => {
                  handleExportTranscript(format)
                }}
                onArchive={() => {
                  if (activeThread) handleToggleArchive(activeThread)
                }}
                onDelete={() => {
                  if (activeThread) {
                    handleDeleteThread(activeThread.id)
                  }
                }}
              />
            </div>
          </div>
        </header>

        {/* Messages Area */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="max-w-4xl mx-auto px-6 py-5 space-y-6">
            {messages.map((msg) => (
              <div key={msg.id}>
                {msg.role === 'assistant' ? (
                  /* Assistant message — clean typography, Claude sun icon, collapsible execution */
                  <div className="group flex gap-3.5">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-(--color-surface-raised) text-[14px] text-amber-500 font-bold border border-(--color-border) select-none mt-0.5">
                      ✳
                    </div>
                    <div className="min-w-0 flex-1 space-y-2">
                      <div className="flex items-center gap-2">
                        <span className="text-[12px] font-bold text-(--color-text)">
                          {msg.personaName ?? 'Assistant'}
                        </span>
                        {msg.modelName && (
                          <Badge tone="neutral" size="sm" className="font-mono text-[10px]">
                            {msg.modelName}
                          </Badge>
                        )}
                        <CopyTextButton text={msg.text} />
                      </div>

                      {/* Collapsible Execution / Reasoning Block */}
                      {msg.reasoning !== undefined && msg.reasoning !== '' && (
                        <ExecutionBlock title="Confirmed current branch/commit state before writing the handoff prompt">
                          <div className="whitespace-pre-wrap font-mono text-[11px] leading-relaxed text-(--color-text-muted)">
                            {msg.reasoning}
                          </div>
                        </ExecutionBlock>
                      )}

                      <div className="prose-container text-[13px] leading-relaxed text-(--color-text)">
                        <MarkdownRenderer content={msg.text} />
                      </div>

                      {/* Bottom Hover Action Toolbar */}
                      <div className="flex items-center gap-2 pt-1 opacity-0 group-hover:opacity-100 transition-opacity text-[11px] text-(--color-text-subtle)">
                        <button
                          type="button"
                          title="Copy reply"
                          onClick={() => {
                            void navigator.clipboard.writeText(msg.text).then(() => {
                              show({ tone: 'neutral', title: 'Response copied' })
                            })
                          }}
                          className="flex items-center gap-1 hover:text-(--color-text) cursor-pointer"
                        >
                          <span>⎘</span>
                          <span>Copy</span>
                        </button>
                        <span className="opacity-40">·</span>
                        <button
                          type="button"
                          title="Fork conversation from this message"
                          onClick={() => {
                            handleForkConversation(msg.id)
                          }}
                          className="flex items-center gap-1 hover:text-(--color-text) cursor-pointer"
                        >
                          <span>⤤</span>
                          <span>Fork</span>
                        </button>
                        <span className="opacity-40">·</span>
                        <button
                          type="button"
                          title="Star message"
                          onClick={() => {
                            show({ tone: 'neutral', title: 'Starred message' })
                          }}
                          className="flex items-center gap-1 hover:text-(--color-text) cursor-pointer"
                        >
                          <span>☆</span>
                        </button>
                        {msg.elapsed && (
                          <>
                            <span className="opacity-40">·</span>
                            <span>{msg.elapsed}</span>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                ) : (
                  /* User message — right-aligned bubble with hover action bar */
                  <div className="flex justify-end group">
                    <div className="relative max-w-xl">
                      <div
                        className="rounded-2xl rounded-br-xs bg-(--color-surface-raised) border border-(--color-border) px-4 py-3 text-[13px] text-(--color-text) shadow-xs leading-relaxed"
                        data-selectable
                      >
                        <div className="whitespace-pre-wrap">{msg.text}</div>
                      </div>

                      {/* User Message Hover Toolbar */}
                      <div className="absolute -bottom-6 right-1 flex items-center gap-1.5 opacity-0 group-hover:opacity-100 transition-opacity text-[10px] text-(--color-text-subtle) bg-(--color-surface-raised) border border-(--color-border) px-2 py-0.5 rounded-full shadow-xs">
                        <span>{msg.timestamp}</span>
                        <span className="opacity-40">·</span>
                        <button
                          type="button"
                          title="Copy prompt"
                          onClick={() => {
                            void navigator.clipboard.writeText(msg.text).then(() => {
                              show({ tone: 'neutral', title: 'Prompt copied' })
                            })
                          }}
                          className="hover:text-(--color-text) cursor-pointer"
                        >
                          ⎘
                        </button>
                        <button
                          type="button"
                          title="Retry prompt"
                          onClick={() => {
                            handleRetryPrompt(msg.text)
                          }}
                          className="hover:text-(--color-text) cursor-pointer"
                        >
                          ↺
                        </button>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {/* Streaming Live Turn */}
            {liveReply !== null && (
              <div className="flex gap-3.5 px-4">
                <div className="min-w-0 flex-1 space-y-2">
                  {liveReply.timeline.length > 0 && (
                    <div
                      className="space-y-1.5 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-3"
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
                <div className="flex items-center gap-2 px-6 text-[12px] italic text-(--color-text-muted)">
                  <span className="inline-flex gap-1 text-amber-500">
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

        {/* Floating Bottom Prompt Bar matching Claude Code aesthetic */}
        <div className="sticky bottom-3 z-10 mx-auto w-full max-w-3xl px-4">
          <div className="relative rounded-2xl border border-(--color-border) bg-(--color-surface) shadow-xl transition-all focus-within:border-(--color-border-strong) focus-within:ring-2 focus-within:ring-(--color-accent)/20">
            <SlashCommandsMenu
              open={slashMenuOpen}
              query={input}
              selectedIndex={slashSelectedIndex}
              onSelect={(cmd) => {
                setInput(cmd + ' ')
                setSlashMenuOpen(false)
                textareaRef.current?.focus()
              }}
              onClose={() => {
                setSlashMenuOpen(false)
              }}
            />

            <form
              onSubmit={(e) => {
                e.preventDefault()
                void handleSend()
              }}
              className="p-3"
            >
              <textarea
                ref={textareaRef}
                rows={1}
                value={input}
                onChange={handleInputChange}
                onKeyDown={handleInputKeyDown}
                placeholder={
                  currentModel
                    ? `Ask ${activePersona?.label ?? 'Forge'} (${currentModel}) · Type / for commands...`
                    : `Ask about ${project.name} · Type / for commands...`
                }
                disabled={thinking}
                className="w-full resize-none bg-transparent text-[13px] text-(--color-text) placeholder:text-(--color-text-subtle) outline-none max-h-36 overflow-y-auto"
              />

              <div className="mt-2 flex items-center justify-between border-t border-(--color-border)/50 pt-2">
                <div className="flex items-center gap-2 text-[11px]">
                  {/* Attach context button */}
                  <button
                    type="button"
                    title="Add context"
                    onClick={() => {
                      setInput((prev) => prev + ' @')
                      textareaRef.current?.focus()
                    }}
                    className="flex size-6 items-center justify-center rounded-md text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text) cursor-pointer"
                  >
                    +
                  </button>
                  <div className="flex items-center gap-1 rounded-md bg-(--color-surface-raised) px-2 py-0.5 font-medium text-(--color-text-muted)">
                    <span>Auto</span>
                    <span className="text-[9px]">⌄</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {/* Engine / Model indicator */}
                  <span className="hidden sm:inline-block max-w-[160px] truncate text-[11px] font-mono text-(--color-text-subtle)">
                    {currentModel || selectedEngineId}
                  </span>

                  {/* Reasoning effort pill */}
                  <button
                    type="button"
                    onClick={() => {
                      setReasoningEffort((prev) =>
                        prev === 'Low' ? 'Medium' : prev === 'Medium' ? 'High' : 'Low',
                      )
                    }}
                    className="rounded-md bg-(--color-surface-raised) px-2 py-0.5 text-[11px] font-medium text-(--color-text-muted) hover:text-(--color-text) cursor-pointer"
                  >
                    {reasoningEffort} ⌄
                  </button>

                  {/* Submit arrow button */}
                  <button
                    type="submit"
                    disabled={input.trim() === '' || thinking}
                    className="flex size-7 items-center justify-center rounded-full bg-(--color-text) text-(--color-surface) transition-all hover:opacity-90 disabled:opacity-30 cursor-pointer disabled:cursor-not-allowed"
                  >
                    <svg
                      className="size-3.5"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.5"
                    >
                      <line x1="12" y1="19" x2="12" y2="5" />
                      <polyline points="5 12 12 5 19 12" />
                    </svg>
                  </button>
                </div>
              </div>
            </form>
          </div>
        </div>
      </div>

      {/* Deliverables / Artifacts Drawer */}
      <AskArtifactsDrawer
        open={artifactsDrawerOpen}
        onClose={() => {
          setArtifactsDrawerOpen(false)
        }}
        projectName={project.name}
      />
    </div>
  )
}
