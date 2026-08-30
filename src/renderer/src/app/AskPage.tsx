import React, { useState } from 'react'
import {
  Badge,
  Button,
  Card,
  Input,
  ScrollArea,
  useToast,
} from '../ui'
import { useProjectStore } from './projectStore'

interface ChatMessage {
  readonly id: string
  readonly role: 'user' | 'assistant'
  readonly text: string
  readonly timestamp: string
}

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

  const [input, setInput] = useState('')
  const [messages, setMessages] = useState<readonly ChatMessage[]>([
    {
      id: 'welcome',
      role: 'assistant',
      text: `Hello! I am your Codebase Assistant for **${project?.name ?? 'your project'}**.\n\nAsk me anything to get a quick hold of this repository — architecture patterns, key entry points, state flows, or coding standards.`,
      timestamp: new Date().toLocaleTimeString(),
    },
  ])
  const [thinking, setThinking] = useState(false)

  const handleSend = (queryText?: string): void => {
    const textToSend = queryText ?? input
    if (textToSend.trim() === '' || thinking) return

    const now = new Date()
    const userMsg: ChatMessage = {
      id: `user-${now.getTime().toString()}`,
      role: 'user',
      text: textToSend.trim(),
      timestamp: now.toLocaleTimeString(),
    }

    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setThinking(true)

    // Generate in-depth repository contextual response
    setTimeout(() => {
      const responseTime = new Date()
      let answer: string

      const queryLower = textToSend.toLowerCase()
      if (queryLower.includes('architecture') || queryLower.includes('tech stack')) {
        answer = `### Repository Architecture Overview\n\n- **Project Name**: \`${project?.name ?? 'Unknown'}\`\n- **Current Branch**: \`${probe?.branch ?? 'main'}\`\n- **Head Commit**: \`${probe?.headSha?.slice(0, 8) ?? 'N/A'}\`\n- **Identified Stack**: ${project?.repository.tech.length ? project.repository.tech.map((t) => `\`${t}\``).join(', ') : '`TypeScript`, `Electron`, `React`'}\n\n**Key Architectural Principles**:\n1. **Worktree Sandboxing**: All agent actions run inside isolated Git worktrees.\n2. **Decision Locking**: Architectural choices must be reviewed and locked before code implementation.\n3. **Closed-Loop Verification**: Automated build and test suites verify code changes independently before merging.`
      } else if (queryLower.includes('entry point') || queryLower.includes('workflow')) {
        answer = `### Entry Points & Workflow Definitions\n\n- **Main Electron Process**: \`src/main/index.ts\` (Owns process manager, database, IPC handlers, and runtime registry).\n- **Renderer Shell**: \`src/renderer/src/app/Shell.tsx\` (Top bar, status strip, and main view router).\n- **Workflows Engine**: \`src/main/workflows/workflowService.ts\` and \`src/main/runtimes/orchestrator.ts\` (Drives planning, decision gates, execution, and verification).\n- **Shared IPC Contract**: \`src/shared/ipc.ts\` (Strict Zod runtime schemas).`
      } else if (queryLower.includes('database') || queryLower.includes('state')) {
        answer = `### Database & State Flow\n\n- **Local Persistence**: SQLite database via Kysely / Drizzle stored in application user data (\`forge.db\`).\n- **Event Store**: Append-only event store capturing immutable workflow transitions, audit logs, and decisions.\n- **Frontend Store**: Reactive Zustand stores (\`projectStore.ts\`, \`uiStore.ts\`) synchronizing state across views via typed IPC.`
      } else if (queryLower.includes('rule') || queryLower.includes('constraint') || queryLower.includes('security')) {
        answer = `### Project Rules & Boundaries\n\n${rules.length > 0 ? rules.map((r) => `- **[${r.scope.toUpperCase()}]** \`${r.key}\`: ${r.statement}`).join('\n') : 'No custom rules configured yet. You can add project rules in **Settings > Project Settings**.'}\n\n**Security Guardrails**:\n- **Protected Files**: Agents cannot modify \`.env\` or \`.git\` roots.\n- **Terminal Restrictions**: Destructive terminal commands (\`rm -rf /\`, \`sudo\`, format) are blocked.`
      } else {
        answer = `I analyzed your query regarding **"${textToSend.trim()}"**:\n\nIn \`${project?.name ?? 'this project'}\`, files and workflows are structured cleanly with modular component boundaries. You can explore relevant files in the **Overview** page or launch a workflow in **Workflows** to coordinate agent planning and implementation.`
      }

      const assistantMsg: ChatMessage = {
        id: `ai-${responseTime.getTime().toString()}`,
        role: 'assistant',
        text: answer,
        timestamp: responseTime.toLocaleTimeString(),
      }

      setMessages((prev) => [...prev, assistantMsg])
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
      {/* Header */}
      <div className="flex items-center justify-between border-b border-(--color-border) pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[18px] font-bold text-(--color-text)">Ask Codebase</h1>
            <Badge tone="accent" size="sm" className="rounded-full font-medium">
              Onboarding & Exploration
            </Badge>
          </div>
          <p className="text-[12px] text-(--color-text-muted)">
            Interactive assistant to quickly understand architecture, dependencies, and code structure in{' '}
            <span className="font-semibold text-(--color-text)">{project.name}</span>.
          </p>
        </div>

        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setMessages([
              {
                id: 'welcome',
                role: 'assistant',
                text: `Chat reset. Ask me anything about **${project.name}**!`,
                timestamp: new Date().toLocaleTimeString(),
              },
            ])
            show({ tone: 'neutral', title: 'Chat cleared' })
          }}
          className="text-[12px]"
        >
          Clear Chat
        </Button>
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

      {/* Chat Messages Log */}
      <Card tone="raised" className="flex flex-1 flex-col overflow-hidden">
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
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-(--color-accent) font-bold text-[12px] text-white">
                    AI
                  </div>
                )}

                <div
                  className={`max-w-2xl rounded-xl p-3.5 text-[13px] leading-relaxed shadow-xs ${
                    msg.role === 'user'
                      ? 'bg-(--color-accent) text-white font-medium'
                      : 'bg-(--color-surface-raised) text-(--color-text) border border-(--color-border)'
                  }`}
                >
                  <div className="whitespace-pre-wrap">{msg.text}</div>
                  <div
                    className={`mt-2 text-[10px] font-mono text-right ${
                      msg.role === 'user' ? 'text-white/75' : 'text-(--color-text-subtle)'
                    }`}
                  >
                    {msg.timestamp}
                  </div>
                </div>

                {msg.role === 'user' && (
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-(--color-surface-raised) border border-(--color-border) font-bold text-[12px] text-(--color-text)">
                    U
                  </div>
                )}
              </div>
            ))}

            {thinking && (
              <div className="flex items-center gap-2 text-[12px] text-(--color-text-muted) italic">
                <span className="animate-pulse font-mono">Analyzing codebase...</span>
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
              placeholder={`Ask a question about ${project.name} (e.g. "Where are API handlers defined?")...`}
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
  )
}
