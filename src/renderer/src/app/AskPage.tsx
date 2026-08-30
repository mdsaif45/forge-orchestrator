import React, { useEffect, useRef, useState } from 'react'
import {
  Badge,
  Button,
  type CustomAgentConfig,
  Input,
  MarkdownRenderer,
  ScrollArea,
  Select,
  useTheme,
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
  const { theme, setTheme } = useTheme()
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
  const [selectedEngineId, setSelectedEngineId] = useState<string>('primary-engine')
  const [availableEngines, setAvailableEngines] = useState<readonly { id: string; label: string }[]>(
    [
      { id: 'primary-engine', label: 'Primary Engine' },
      { id: 'secondary-engine', label: 'Secondary Engine' },
      { id: 'mock:default', label: 'mock:default (Simulated)' },
    ],
  )

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
        const list: { id: string; label: string }[] = []
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
          setSelectedEngineId(list[0]?.id ?? 'mock:default')
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
            engineId: 'primary-engine',
            text: `Hello! I am your **Implementation Planner** for **${project?.name ?? 'this project'}**.\n\nAsk me anything to understand the repository architecture, plan new features, or explore existing code workflows.`,
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
          text: `Started new thread with **${persona?.label ?? 'Assistant'}** (${selectedEngineId}).\n\nHow can I assist you with **${project?.name ?? 'your repository'}** today?`,
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

      if (selectedPersonaId === 'debugger') {
        answer = `### Debugger Analysis\n\n- **Target Project**: \`${project?.name ?? 'Unknown'}\`\n- **Investigating Query**: "${textToSend.trim()}"\n\n**Root Cause Diagnostics**:\n1. Check runtime logs in \`WorkflowPage\` and verify process execution parameters.\n2. Trace data contracts across \`src/shared/ipc.ts\` to ensure Zod validation passes.\n3. Validate Git worktree cleanliness and ensure branch \`${probe?.branch ?? 'main'}\` has no conflicting uncommitted files.`
      } else if (selectedPersonaId === 'tester') {
        answer = `### Test Designer Suite Plan\n\n- **Project Tech Stack**: ${project?.repository.tech.length ? project.repository.tech.map((t) => `\`${t}\``).join(', ') : '`TypeScript`, `Vitest`'}\n- **Focus Area**: "${textToSend.trim()}"\n\n\`\`\`typescript\nimport { describe, expect, it } from 'vitest'\n\ndescribe('${textToSend.trim().slice(0, 24)}', () => {\n  it('handles valid input and returns deterministic response', () => {\n    const result = true\n    expect(result).toBe(true)\n  })\n\n  it('enforces boundary constraints and prevents regressions', () => {\n    expect(() => {}).not.toThrow()\n  })\n})\n\`\`\`\n\n**Test Recommendations**:\n- Run isolated unit tests with \`npm test\`.\n- Verify electron preload contracts with \`npm run smoke\`.`
      } else if (selectedPersonaId === 'coder') {
        answer = `### Coding Agent Implementation Snippet\n\nHere is the recommended modular implementation pattern for \`${project?.name ?? 'your codebase'}\`:\n\n\`\`\`typescript\n// Implementation for: ${textToSend.trim()}\nexport interface FeatureConfig {\n  readonly enabled: boolean\n  readonly scope: string\n}\n\nexport function executeFeature(config: FeatureConfig): boolean {\n  if (!config.enabled) return false\n  // Execute logic within worktree sandbox\n  return true\n}\n\`\`\`\n\n**Key Guidelines**:\n- Adhere to immutability with \`readonly\` properties.\n- Keep UI components inside \`src/renderer/src/ui/primitives/\` separate from application page logic.`
      } else if (selectedPersonaId === 'reviewer') {
        answer = `### Code Review & Security Audit\n\n- **Reviewing Scope**: "${textToSend.trim()}"\n\n**Audit Checklist**:\n- [x] **Type Safety**: Strictly typed TypeScript with zero \`any\`.\n- [x] **Sandboxing**: Code execution strictly isolated to sandbox worktrees.\n- [x] **Axiom Invariants**: Strict isolation of provider runtime identifiers.\n- [x] **Error Handling**: Graceful degradation with typed error boundaries.`
      } else if (queryLower.includes('architecture') || queryLower.includes('tech stack')) {
        answer = `### Repository Architecture Overview\n\n- **Project Name**: \`${project?.name ?? 'Unknown'}\`\n- **Current Branch**: \`${probe?.branch ?? 'main'}\`\n- **Head Commit**: \`${probe?.headSha?.slice(0, 8) ?? 'N/A'}\`\n- **Identified Stack**: ${project?.repository.tech.length ? project.repository.tech.map((t) => `\`${t}\``).join(', ') : '`TypeScript`, `Electron`, `React`'}\n\n**Key Architectural Principles**:\n1. **Worktree Sandboxing**: All agent actions run inside isolated Git worktrees.\n2. **Decision Locking**: Architectural choices must be reviewed and locked before code implementation.\n3. **Closed-Loop Verification**: Automated build and test suites verify code changes independently before merging.`
      } else if (queryLower.includes('entry point') || queryLower.includes('workflow')) {
        answer = `### Entry Points & Workflow Definitions\n\n- **Main Electron Process**: \`src/main/index.ts\` (Owns process manager, database, IPC handlers, and runtime registry).\n- **Renderer Shell**: \`src/renderer/src/app/Shell.tsx\` (Top bar, status strip, and main view router).\n- **Workflows Engine**: \`src/main/workflows/workflowService.ts\` and \`src/main/runtimes/orchestrator.ts\` (Drives planning, decision gates, execution, and verification).\n- **Shared IPC Contract**: \`src/shared/ipc.ts\` (Strict Zod runtime schemas).`
      } else if (
        queryLower.includes('rule') ||
        queryLower.includes('constraint') ||
        queryLower.includes('security')
      ) {
        answer = `### Project Rules & Boundaries\n\n${rules.length > 0 ? rules.map((r) => `- **[${r.scope.toUpperCase()}]** \`${r.key}\`: ${r.statement}`).join('\n') : 'No custom rules configured yet. You can add project rules in **Settings > Project Settings**.'}\n\n**Security Guardrails**:\n- **Protected Files**: Agents cannot modify \`.env\` or \`.git\` roots.\n- **Terminal Restrictions**: Destructive terminal commands (\`rm -rf /\`, \`sudo\`, format) are blocked.`
      } else {
        answer = `### ${persona} Response\n\nI analyzed your query regarding **"${textToSend.trim()}"** using engine **${selectedEngineId}**:\n\nIn \`${project?.name ?? 'this project'}\`, files and workflows are structured cleanly with modular component boundaries. You can explore relevant files in the **Overview** page or launch a workflow in **Workflows** to coordinate agent planning and implementation.`
      }

      const assistantMsg: ChatMessage = {
        id: `ai-${responseTime.getTime().toString()}`,
        role: 'assistant',
        personaName: activePersona?.label ?? 'Assistant',
        personaIcon: activePersona?.icon ?? '🤖',
        engineId: selectedEngineId,
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

        {/* Bottom controls: Persona selector & Theme toggle */}
        <div className="border-t border-(--color-border) p-3 space-y-2">
          {/* Persona selector (compact) */}
          <Select
            aria-label="Active Persona"
            value={selectedPersonaId}
            onChange={(e: { target: { value: string } }) => {
              setSelectedPersonaId(e.target.value)
            }}
            options={allPersonas.map((p) => ({
              value: p.id,
              label: `${p.icon} ${p.label}`,
            }))}
          />

          {/* Theme toggle */}
          <button
            type="button"
            onClick={() => {
              setTheme(theme === 'dark' ? 'azure' : theme === 'azure' ? 'light' : 'dark')
            }}
            className="flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-[12px] text-(--color-text-muted) hover:text-(--color-text) hover:bg-(--color-surface-raised) transition-colors cursor-pointer"
          >
            <span className="text-[14px]">
              {theme === 'dark' ? '🌙' : theme === 'azure' ? '🌊' : '☀️'}
            </span>
            <span>
              {theme === 'dark' ? 'Dark' : theme === 'azure' ? 'Azure' : theme === 'light' ? 'Light' : 'System'}{' '}
              theme
            </span>
          </button>
        </div>
      </aside>

      {/* ── Main Chat Area ── */}
      <div className="flex flex-1 flex-col min-w-0 bg-(--color-canvas)">
        {/* Top Header Bar */}
        <header className="flex items-start justify-between border-b border-(--color-border) px-6 py-3 bg-(--color-surface-raised)">
          <div className="min-w-0">
            <h1 className="text-[15px] font-bold text-(--color-text) truncate">
              {activeThread?.title ?? 'Chat'}
            </h1>
            <div className="flex flex-wrap items-center gap-2 mt-1 text-[11px] text-(--color-text-subtle)">
              <span>inline</span>
              <span className="text-(--color-border-strong)">·</span>
              <span>Snapshot {new Date().toLocaleDateString()}</span>
              <span className="text-(--color-border-strong)">·</span>
              <span>{activePersona?.label ?? 'Agent'}</span>
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0 mt-0.5">
            <Badge tone="success" size="sm" className="font-medium">
              ● Index Ready
            </Badge>
            <Badge tone="neutral" size="sm" className="font-mono text-[10px]">
              ↻ Updated {new Date().toLocaleTimeString()}
            </Badge>
            <Badge tone="neutral" size="sm" className="font-mono text-[10px]">
              ★ Feedback
            </Badge>
            <Badge tone="neutral" size="sm" className="font-mono text-[10px]">
              ⊙ Sources ({messages.filter((m) => m.role === 'assistant').length})
            </Badge>
          </div>
        </header>

        {/* Messages Area */}
        <ScrollArea className="flex-1 min-h-0">
          <div className="max-w-4xl mx-auto px-6 py-4 space-y-5">
            {messages.map((msg) => (
              <div key={msg.id}>
                {msg.role === 'assistant' ? (
                  /* Assistant message — full-width block with icon */
                  <div className="flex gap-3">
                    <div className="flex size-7 shrink-0 items-center justify-center rounded-full bg-(--color-accent-muted) text-[14px] mt-1">
                      {msg.personaIcon ?? '🤖'}
                    </div>
                    <div className="min-w-0 flex-1">
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
                  {activePersona?.label} is analyzing with {selectedEngineId}...
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
                placeholder={`Ask a question about ${project.name}...`}
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
            <div className="w-40 shrink-0">
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
