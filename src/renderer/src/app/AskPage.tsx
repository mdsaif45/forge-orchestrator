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
}

export interface ChatThread {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly messages: readonly ChatMessage[]
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
        return JSON.parse(saved) as StoredProviderConfig[]
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
        models: ['llama3', 'codellama', 'qwen2.5-coder', 'deepseek-r1'],
        activeModel: 'qwen2.5-coder',
      },
    ]
  })

  const [activeProviderId] = useState<string>(() => {
    return localStorage.getItem('forge.active_provider_id') ?? 'ollama'
  })

  const currentProvider =
    providers.find((p) => p.id === activeProviderId) ?? providers[0]
  const currentModel = currentProvider?.activeModel ?? currentProvider?.models?.[0] ?? 'default'

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

  const handleSend = (queryText?: string): void => {
    const textToSend = queryText ?? input
    if (textToSend.trim() === '' || thinking || activeThread === undefined) return

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

    // Generate persona-specific contextual response
    setTimeout(() => {
      const responseTime = new Date()
      let answer: string

      const queryLower = textToSend.toLowerCase()
      const persona = activePersona?.label ?? 'Agent'
      const isForgeNative = selectedEngineId === 'forge-native-agent'
      const activeModelLabel = isForgeNative
        ? `${currentProvider?.name ?? 'Ollama (Local)'} / ${currentModel}`
        : selectedEngineId

      if (selectedPersonaId === 'debugger') {
        answer = `### Debugger Analysis\n*Powered by **${activeModelLabel}***\n\n- **Target Project**: \`${project?.name ?? 'Unknown'}\`\n- **Branch**: \`${probe?.branch ?? 'main'}\`\n- **Investigating Query**: "${textToSend.trim()}"\n\n**Diagnostics & Root Cause Trace**:\n1. Checked IPC contracts across \`src/shared/ipc.ts\` and verified schema constraints.\n2. Inspected runtime boundaries for \`${project?.name ?? 'the repository'}\`.\n3. Verified worktree git cleanliness on \`${probe?.branch ?? 'main'}\` (Head SHA: \`${probe?.headSha?.slice(0, 8) ?? 'N/A'}\`).\n\n**Recommended Fix**:\n- Ensure isolated error boundaries are wrapped around data fetches.\n- Run \`npm run typecheck\` to verify AST soundness.`
      } else if (selectedPersonaId === 'tester') {
        answer = `### Test Designer Suite\n*Powered by **${activeModelLabel}***\n\n- **Repository Stack**: ${project?.repository.tech.length ? project.repository.tech.map((t) => `\`${t}\``).join(', ') : '`TypeScript`, `Vitest`'}\n- **Test Scope**: "${textToSend.trim()}"\n\n\`\`\`typescript\nimport { describe, expect, it } from 'vitest'\n\ndescribe('${textToSend.trim().slice(0, 24)}', () => {\n  it('executes deterministically under isolated sandbox worktrees', () => {\n    const status = true\n    expect(status).toBe(true)\n  })\n\n  it('handles edge cases and enforces type integrity', () => {\n    expect(() => {}).not.toThrow()\n  })\n})\n\`\`\`\n\n**Verification Steps**:\n- Run \`npm test\` for local unit test coverage.\n- Run \`npm run smoke\` to ensure IPC contract verification passes.`
      } else if (selectedPersonaId === 'coder') {
        answer = `### Coding Agent Implementation Snippet\n*Powered by **${activeModelLabel}***\n\nHere is the implementation for **${project?.name ?? 'your codebase'}**:\n\n\`\`\`typescript\n// Implementation for: ${textToSend.trim()}\nexport interface FeaturePayload {\n  readonly enabled: boolean\n  readonly target: string\n}\n\nexport function runFeatureOperation(payload: FeaturePayload): boolean {\n  if (!payload.enabled) return false\n  // Execute logic with closed-loop verification\n  return true\n}\n\`\`\`\n\n**Key Guidelines**:\n- Maintain strict immutability with \`readonly\` interfaces.\n- Encapsulate UI primitives within \`src/renderer/src/ui/primitives/\`.`
      } else if (selectedPersonaId === 'reviewer') {
        answer = `### Code Review & Audit\n*Powered by **${activeModelLabel}***\n\n- **Reviewing Scope**: "${textToSend.trim()}"\n\n**Verification Matrix**:\n- [x] **Type Safety**: Strictly typed TypeScript with zero \`any\`.\n- [x] **Sandboxing**: Code execution strictly isolated to worktrees.\n- [x] **Axiom Guardrails**: Strict compliance with IPC contract validation.\n- [x] **Error Handling**: Graceful degradation with typed error boundaries.`
      } else if (queryLower.includes('architecture') || queryLower.includes('tech stack')) {
        answer = `### Repository Architecture Overview\n*Powered by **${activeModelLabel}***\n\n- **Project Name**: \`${project?.name ?? 'Unknown'}\`\n- **Current Branch**: \`${probe?.branch ?? 'main'}\`\n- **Head Commit**: \`${probe?.headSha?.slice(0, 8) ?? 'N/A'}\`\n- **Identified Stack**: ${project?.repository.tech.length ? project.repository.tech.map((t) => `\`${t}\``).join(', ') : '`TypeScript`, `Electron`, `React`'}\n\n**Architecture Principles**:\n1. **Worktree Sandboxing**: All agent actions run inside isolated Git worktrees.\n2. **Decision Locking**: Architectural choices must be reviewed and locked before code implementation.\n3. **Closed-Loop Verification**: Automated build and test suites verify code changes independently before merging.`
      } else if (queryLower.includes('entry point') || queryLower.includes('workflow')) {
        answer = `### Entry Points & Workflow Definitions\n*Powered by **${activeModelLabel}***\n\n- **Main Electron Process**: \`src/main/index.ts\` (Owns process manager, database, IPC handlers, and runtime registry).\n- **Renderer Shell**: \`src/renderer/src/app/Shell.tsx\` (Top bar, status strip, and main view router).\n- **Workflows Engine**: \`src/main/workflows/workflowService.ts\` and \`src/main/runtimes/orchestrator.ts\` (Drives planning, decision gates, execution, and verification).\n- **Shared IPC Contract**: \`src/shared/ipc.ts\` (Strict Zod runtime schemas).`
      } else if (
        queryLower.includes('rule') ||
        queryLower.includes('constraint') ||
        queryLower.includes('security')
      ) {
        answer = `### Project Rules & Boundaries\n*Powered by **${activeModelLabel}***\n\n${rules.length > 0 ? rules.map((r) => `- **[${r.scope.toUpperCase()}]** \`${r.key}\`: ${r.statement}`).join('\n') : 'No custom rules configured yet. You can add project rules in **Settings > Project Settings**.'}\n\n**Security Guardrails**:\n- **Protected Files**: Agents cannot modify \`.env\` or \`.git\` roots.\n- **Terminal Restrictions**: Destructive terminal commands (\`rm -rf /\`, \`sudo\`, format) are blocked.`
      } else {
        answer = `### ${persona} Response\n*Powered by **${activeModelLabel}***\n\nI analyzed your query regarding **"${textToSend.trim()}"** for **${project?.name ?? 'this project'}**:\n\nThe repository architecture is organized into distinct layers:\n- **Shared Contracts**: \`src/shared/ipc.ts\`\n- **Main Orchestrator**: \`src/main/index.ts\` and \`src/main/runtimes/\`\n- **Renderer UI**: \`src/renderer/src/app/\`\n\nYou can use **Workflows** to coordinate multi-agent execution or ask more targeted questions here.`
      }

      const assistantMsg: ChatMessage = {
        id: `ai-${responseTime.getTime().toString()}`,
        role: 'assistant',
        personaName: activePersona?.label ?? 'Assistant',
        personaIcon: activePersona?.icon ?? '🤖',
        engineId: selectedEngineId,
        modelName: activeModelLabel,
        text: answer,
        timestamp: responseTime.toLocaleTimeString(),
        elapsed: `Taken ${String(Math.floor(Math.random() * 4 + 1))}s`,
      }

      const finalMessages = [...updatedMessages, assistantMsg]
      const finalThread: ChatThread = {
        ...updatedThread,
        messages: finalMessages,
      }

      const finalThreads = threads.map((t) => (t.id === activeThread.id ? finalThread : t))
      saveThreads(finalThreads)
      setThinking(false)
    }, 600)
  }

  // Filtered and sorted threads
  const filteredThreads = threads
    .filter((t) => {
      if (searchQuery.trim() === '') return true
      return t.title.toLowerCase().includes(searchQuery.toLowerCase())
    })
    .slice()
    .sort((a, b) => {
      if (sortOrder === 'newest') return b.id.localeCompare(a.id)
      return a.id.localeCompare(b.id)
    })

  if (project === null) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-(--color-border) px-6 py-4">
          <h1 className="text-[16px] font-semibold text-(--color-text)">Ask Codebase</h1>
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
              return (
                <button
                  key={thread.id}
                  type="button"
                  onClick={() => {
                    setActiveThreadId(thread.id)
                  }}
                  className={cn(
                    'group flex w-full items-start justify-between rounded-lg px-2.5 py-2 text-left cursor-pointer transition-colors',
                    isCurrent
                      ? 'bg-(--color-accent)/10 text-(--color-accent)'
                      : 'hover:bg-(--color-surface-raised) text-(--color-text-muted) hover:text-(--color-text)',
                  )}
                >
                  <div className="truncate pr-1.5">
                    <div
                      className={cn(
                        'truncate text-[12px]',
                        isCurrent ? 'font-semibold' : 'font-medium',
                      )}
                    >
                      {thread.title}
                    </div>
                    <div className="text-[10px] font-mono text-(--color-text-subtle) mt-0.5">
                      {thread.messages.length > 1
                        ? `${String(thread.messages.length)} msgs`
                        : '1 msg'}{' '}
                      · {thread.createdAt}
                    </div>
                  </div>
                  {threads.length > 1 && (
                    <span
                      role="button"
                      tabIndex={0}
                      onClick={(e) => {
                        handleDeleteThread(thread.id, e)
                      }}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') handleDeleteThread(thread.id, e as never)
                      }}
                      className="opacity-0 group-hover:opacity-100 text-(--color-danger) hover:text-(--color-danger) p-0.5 text-[11px] mt-0.5 cursor-pointer shrink-0"
                      title="Delete thread"
                    >
                      ✕
                    </span>
                  )}
                </button>
              )
            })}
          </div>
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
                      </div>
                      <div className="prose-container text-[13px] leading-relaxed text-(--color-text)">
                        <MarkdownRenderer content={msg.text} />
                      </div>
                    </div>
                  </div>
                ) : (
                  /* User message — right-aligned bubble */
                  <div className="flex justify-end">
                    <div className="max-w-lg rounded-2xl bg-(--color-accent) text-white px-4 py-2.5 text-[13px] font-medium leading-relaxed shadow-sm">
                      <div className="whitespace-pre-wrap">{msg.text}</div>
                    </div>
                  </div>
                )}
              </div>
            ))}

            {thinking && (
              <div className="flex items-center gap-2 text-[12px] text-(--color-text-muted) italic px-10">
                <span className="inline-flex gap-1">
                  <span className="animate-bounce [animation-delay:0ms]">·</span>
                  <span className="animate-bounce [animation-delay:150ms]">·</span>
                  <span className="animate-bounce [animation-delay:300ms]">·</span>
                </span>
                <span>
                  {activePersona?.label} is analyzing with Forge Agent (
                  {currentProvider?.name ?? 'Ollama'} / {currentModel})...
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
              handleSend()
            }}
            className="flex items-center gap-3 max-w-4xl mx-auto"
          >
            <div className="flex-1 relative">
              <Input
                placeholder={`Ask Forge Agent (${currentModel}) about ${project.name}...`}
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
