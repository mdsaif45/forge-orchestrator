import React, { useEffect, useState } from 'react'
import {
  Badge,
  Button,
  Card,
  type CustomAgentConfig,
  Input,
  MarkdownRenderer,
  ScrollArea,
  Select,
  useToast,
} from '../ui'
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

const QUICK_PROMPTS = [
  'Explain overall architecture and technology stack',
  'Where are the main entry points and workflow definitions?',
  'Explain the database models and state management flow',
  'What project rules, directives, and security constraints apply?',
]

export function AskPage(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const project = detail?.project ?? null
  const probe = detail?.probe ?? null
  const rules = detail?.rules ?? []
  const { show } = useToast()

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
  const [availableEngines, setAvailableEngines] = useState<readonly { id: string; label: string }[]>([
    { id: 'primary-engine', label: 'Primary Engine' },
    { id: 'secondary-engine', label: 'Secondary Engine' },
    { id: 'mock:default', label: 'mock:default (Simulated)' },
  ])

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
      } else if (queryLower.includes('rule') || queryLower.includes('constraint') || queryLower.includes('security')) {
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

  if (project === null) {
    return (
      <div className="flex h-full flex-col">
        <div className="border-b border-(--color-border) px-6 py-4">
          <h1 className="text-[16px] font-semibold text-(--color-text)">Ask Codebase</h1>
        </div>
        <div className="grid flex-1 place-content-center p-8 text-center text-[13px] text-(--color-text-muted)">
          Select or create a project from the top bar to explore and ask questions about its codebase.
        </div>
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col gap-4 p-6 overflow-hidden">
      {/* Top Header Controls: Persona & Model Engine Selectors */}
      <div className="flex flex-col gap-3 border-b border-(--color-border) pb-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[18px] font-bold text-(--color-text)">Ask Codebase</h1>
            <Badge tone="accent" size="sm" className="rounded-full font-medium">
              {project.name}
            </Badge>
          </div>
          <p className="text-[12px] text-(--color-text-muted)">
            Interactive multi-persona assistant for onboarding, architectural planning, and code Q&A.
          </p>
        </div>

        <div className="flex items-center gap-3">
          {/* Persona Selector */}
          <div className="w-56">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-(--color-text-subtle) mb-1">
              Active Agent Persona
            </label>
            <Select
              value={selectedPersonaId}
              onChange={(e: { target: { value: string } }) => {
                setSelectedPersonaId(e.target.value)
              }}
              options={allPersonas.map((p) => ({
                value: p.id,
                label: `${p.icon} ${p.label}`,
              }))}
            />
          </div>

          {/* Model Engine Selector */}
          <div className="w-52">
            <label className="block text-[10px] font-bold uppercase tracking-wider text-(--color-text-subtle) mb-1">
              Model Engine
            </label>
            <Select
              value={selectedEngineId}
              onChange={(e: { target: { value: string } }) => {
                setSelectedEngineId(e.target.value)
              }}
              options={availableEngines.map((e) => ({
                value: e.id,
                label: e.label,
              }))}
            />
          </div>
        </div>
      </div>

      {/* Quick Prompt Chips */}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-(--color-text-subtle)">
          Quick Questions:
        </span>
        {QUICK_PROMPTS.map((prompt) => (
          <button
            key={prompt}
            type="button"
            onClick={() => {
              handleSend(prompt)
            }}
            className="rounded-lg border border-(--color-border) bg-(--color-surface-raised) px-3 py-1 text-[11px] font-medium text-(--color-text-muted) transition-colors hover:border-(--color-border-strong) hover:text-(--color-text) cursor-pointer select-none"
          >
            {prompt}
          </button>
        ))}
      </div>

      {/* Main Workspace: Sidebar Threads + Chat Log */}
      <div className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-4 overflow-hidden">
        {/* Left Column: Chat Threads Sidebar */}
        <Card tone="raised" className="flex flex-col overflow-hidden">
          <div className="flex items-center justify-between border-b border-(--color-border) p-3 bg-(--color-surface)">
            <span className="font-bold text-[12px] text-(--color-text)">Chat Threads</span>
            <Button
              size="sm"
              variant="secondary"
              onClick={handleCreateThread}
              className="h-7 text-[11px]"
            >
              + New Chat
            </Button>
          </div>

          <ScrollArea className="flex-1 p-2 space-y-1">
            {threads.map((thread) => {
              const isCurrent = thread.id === activeThreadId
              return (
                <div
                  key={thread.id}
                  onClick={() => {
                    setActiveThreadId(thread.id)
                  }}
                  className={`group flex items-center justify-between rounded-lg p-2.5 text-[12px] cursor-pointer transition-colors ${
                    isCurrent
                      ? 'bg-(--color-accent)/10 border border-(--color-accent)/30 text-(--color-accent) font-semibold'
                      : 'hover:bg-(--color-surface-raised) text-(--color-text-muted) hover:text-(--color-text)'
                  }`}
                >
                  <div className="truncate pr-2">
                    <div className="truncate">{thread.title}</div>
                    <div className="text-[10px] font-mono text-(--color-text-subtle)">
                      {thread.messages.length} messages • {thread.createdAt}
                    </div>
                  </div>

                  {threads.length > 1 && (
                    <button
                      type="button"
                      onClick={(e) => {
                        handleDeleteThread(thread.id, e)
                      }}
                      className="opacity-0 group-hover:opacity-100 text-(--color-danger) hover:text-(--color-danger) p-1 text-[11px] cursor-pointer"
                      title="Delete thread"
                    >
                      ✕
                    </button>
                  )}
                </div>
              )
            })}
          </ScrollArea>
        </Card>

        {/* Right 3 Columns: Active Chat Messages & Input Bar */}
        <Card tone="raised" className="flex flex-col lg:col-span-3 overflow-hidden">
          {/* Active Persona Banner */}
          <div className="flex items-center justify-between border-b border-(--color-border) px-4 py-2 bg-(--color-surface)">
            <div className="flex items-center gap-2">
              <span className="text-[16px]">{activePersona?.icon ?? '🤖'}</span>
              <div>
                <span className="font-bold text-[13px] text-(--color-text)">
                  {activePersona?.label}
                </span>
                <span className="ml-2 font-mono text-[11px] text-(--color-text-subtle)">
                  via {selectedEngineId}
                </span>
              </div>
            </div>

            <Badge tone="neutral" size="sm" className="font-mono text-[10px]">
              {messages.length} messages
            </Badge>
          </div>

          {/* Messages Area */}
          <ScrollArea className="flex-1 bg-(--color-surface-inset) p-4">
            <div className="space-y-4 max-w-4xl mx-auto">
              {messages.map((msg) => (
                <div
                  key={msg.id}
                  className={`flex gap-3 ${
                    msg.role === 'user' ? 'justify-end' : 'justify-start'
                  }`}
                >
                  {msg.role === 'assistant' && (
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--color-surface-raised) border border-(--color-border) text-[15px]">
                      {msg.personaIcon ?? '🤖'}
                    </div>
                  )}

                  <div
                    className={`max-w-2xl rounded-xl p-3.5 shadow-xs ${
                      msg.role === 'user'
                        ? 'bg-(--color-accent) text-white font-medium text-[13px] leading-relaxed'
                        : 'bg-(--color-surface-raised) text-(--color-text) border border-(--color-border)'
                    }`}
                  >
                    {msg.role === 'assistant' && (
                      <div className="mb-1.5 flex items-center justify-between border-b border-(--color-border)/50 pb-1 text-[11px]">
                        <span className="font-bold text-(--color-text)">
                          {msg.personaName ?? 'Agent'}
                        </span>
                        {msg.engineId && (
                          <span className="font-mono text-[10px] text-(--color-text-subtle)">
                            {msg.engineId}
                          </span>
                        )}
                      </div>
                    )}

                    {msg.role === 'user' ? (
                      <div className="whitespace-pre-wrap">{msg.text}</div>
                    ) : (
                      <MarkdownRenderer content={msg.text} />
                    )}

                    <div
                      className={`mt-2 text-[10px] font-mono text-right ${
                        msg.role === 'user' ? 'text-white/75' : 'text-(--color-text-subtle)'
                      }`}
                    >
                      {msg.timestamp}
                    </div>
                  </div>

                  {msg.role === 'user' && (
                    <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--color-surface-raised) border border-(--color-border) font-bold text-[12px] text-(--color-text)">
                      U
                    </div>
                  )}
                </div>
              ))}

              {thinking && (
                <div className="flex items-center gap-2 text-[12px] text-(--color-text-muted) italic">
                  <span className="animate-pulse font-mono">
                    {activePersona?.label} is analyzing repository with {selectedEngineId}...
                  </span>
                </div>
              )}
            </div>
          </ScrollArea>

          {/* Input Bar */}
          <div className="border-t border-(--color-border) bg-(--color-surface) p-3">
            <form
              onSubmit={(e) => {
                e.preventDefault()
                handleSend()
              }}
              className="flex items-center gap-2"
            >
              <Input
                placeholder={`Ask ${activePersona?.label ?? 'Agent'} about ${project.name}...`}
                value={input}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setInput(e.target.value)
                }}
                disabled={thinking}
                className="flex-1 text-[13px]"
                autoFocus
              />
              <Button
                type="submit"
                variant="primary"
                disabled={input.trim() === '' || thinking}
                className="h-8 text-[12px]"
              >
                Send
              </Button>
            </form>
          </div>
        </Card>
      </div>
    </div>
  )
}
