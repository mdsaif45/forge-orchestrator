import React, { useCallback, useEffect, useState } from 'react'
import type { RoleBindingsView } from '@shared/ipc'
import {
  AgentCard,
  Badge,
  Button,
  Card,
  CreateAgentDialog,
  type CustomAgentConfig,
  EmptyState,
  Select,
  useToast,
} from '@renderer/ui'
import { unwrap } from '@renderer/ipc'
import { useProjectStore } from './projectStore'

const DEFAULT_BUILTIN_AGENTS: readonly CustomAgentConfig[] = [
  {
    id: 'agent-planner-default',
    name: 'Alex (Planner)',
    roleType: 'planner',
    runtimeId: 'primary-engine',
    instructions:
      'Explores codebase, identifies dependencies, and proposes robust architectural decisions.',
    capabilities: ['repo-read', 'plan'],
  },
  {
    id: 'agent-implementer-default',
    name: 'Sam (Implementer)',
    roleType: 'implementer',
    runtimeId: 'secondary-engine',
    instructions:
      'Writes clean, modular code inside isolated worktrees, adhering strictly to project guidelines.',
    capabilities: ['repo-read', 'file-write', 'terminal'],
  },
  {
    id: 'agent-reviewer-default',
    name: 'Morgan (Reviewer)',
    roleType: 'reviewer',
    runtimeId: 'primary-engine',
    instructions:
      'Audits diffs, verifies locked decisions, and checks for edge cases and regressions.',
    capabilities: ['repo-read', 'review', 'test'],
  },
]

export function AgentsPage(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const project = detail?.project ?? null
  const { show } = useToast()

  const [loaded, setLoaded] = useState<{
    readonly projectId: string
    readonly bindings: RoleBindingsView
  } | null>(null)
  const [saving, setSaving] = useState<string | null>(null)
  const [createAgentOpen, setCreateAgentOpen] = useState(false)

  // Custom agents stored in localStorage
  const [customAgents, setCustomAgents] = useState<readonly CustomAgentConfig[]>(() => {
    const saved = localStorage.getItem('forge.custom_agents')
    if (saved) {
      try {
        return JSON.parse(saved) as CustomAgentConfig[]
      } catch {
        // fallback
      }
    }
    return DEFAULT_BUILTIN_AGENTS
  })

  const projectId = project?.id ?? null
  const bindings = loaded?.projectId === projectId ? loaded.bindings : null

  const load = useCallback((id: string) => {
    window.forge.binding
      .list(id)
      .then((res) => {
        setLoaded({ projectId: id, bindings: unwrap(res) })
      })
      .catch((err: unknown) => {
        console.error('Failed to load bindings:', err)
      })
  }, [])

  useEffect(() => {
    if (projectId === null) return
    load(projectId)
  }, [projectId, load])

  const handleBind = async (role: string, runtimeId: string): Promise<void> => {
    if (projectId === null) return
    setSaving(role)
    try {
      unwrap(await window.forge.binding.set(projectId, role, runtimeId))
      load(projectId)
      show({ tone: 'success', title: 'Runtime bound', description: `${role} → ${runtimeId}` })
    } catch (err: unknown) {
      show({
        tone: 'danger',
        title: 'Could not bind that runtime',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setSaving(null)
    }
  }

  const handleSaveCustomAgent = (agent: CustomAgentConfig): void => {
    const updated = [...customAgents, agent]
    setCustomAgents(updated)
    localStorage.setItem('forge.custom_agents', JSON.stringify(updated))
    show({ tone: 'success', title: `Agent "${agent.name}" created` })
  }

  const handleDeleteCustomAgent = (agentId: string): void => {
    const updated = customAgents.filter((a) => a.id !== agentId)
    setCustomAgents(updated)
    localStorage.setItem('forge.custom_agents', JSON.stringify(updated))
    show({ tone: 'neutral', title: 'Agent removed' })
  }

  if (project === null) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="grid flex-1 place-content-center p-8">
          <EmptyState
            title="No project selected"
            description="Choose a project from the top bar to configure AI agent role assignments."
          />
        </div>
      </div>
    )
  }

  const roles = bindings?.roles ?? []

  // Extract available unique runtimes across roles for the creation dialog
  const availableRuntimesMap = new Map<string, string>()
  for (const r of roles) {
    for (const er of r.eligibleRuntimes) {
      availableRuntimesMap.set(er.id, er.simulated ? `${er.id} (simulated)` : er.id)
    }
  }

  if (availableRuntimesMap.size === 0) {
    availableRuntimesMap.set('mock:default', 'mock:default (simulated)')
  }

  const availableRuntimes = [...availableRuntimesMap.entries()].map(([id, label]) => ({
    id,
    label,
  }))

  return (
    <div className="flex h-full flex-col gap-6 p-6 overflow-auto">
      {/* Header with Create Agent Action */}
      <div className="flex items-center justify-between border-b border-(--color-border) pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[18px] font-bold text-(--color-text)">AI Agents & Role Bindings</h1>
            <Badge tone="accent" size="sm" className="rounded-full">
              {project.name}
            </Badge>
          </div>
          <p className="text-[12px] text-(--color-text-muted)">
            Manage agent personas, custom system directives, and assign model engines to pipeline
            stages.
          </p>
        </div>

        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setCreateAgentOpen(true)
          }}
          className="rounded-lg text-[12px]"
        >
          + Create Agent
        </Button>
      </div>

      {/* Section 1: Active Role Assignments */}
      <section className="grid gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[14px] font-bold text-(--color-text)">Pipeline Role Assignments</h2>
          <span className="text-[12px] text-(--color-text-muted)">
            Defines which engine executes each workflow stage
          </span>
        </div>

        {roles.length === 0 ? (
          <Card tone="raised" className="p-4 text-[12px] text-(--color-text-muted)">
            No roles currently bound. Select engines below to assign roles for this project.
          </Card>
        ) : (
          <div className="grid gap-3">
            {roles.map(({ role, binding, eligibleRuntimes }) => (
              <Card
                key={role}
                tone="raised"
                className="p-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"
              >
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="text-[14px] font-bold capitalize text-(--color-text)">
                      {role}
                    </span>
                    <Badge
                      tone={
                        role === 'planner'
                          ? 'warning'
                          : role === 'implementer'
                            ? 'accent'
                            : 'success'
                      }
                      size="sm"
                    >
                      {role === 'planner'
                        ? 'Planning & Decisions'
                        : role === 'implementer'
                          ? 'Worktree Coding'
                          : 'Code Review & Audit'}
                    </Badge>
                  </div>
                  <p className="m-0 font-mono text-[11px] text-(--color-text-muted)">
                    Current Engine:{' '}
                    <span className="text-(--color-text)">{binding?.runtimeId ?? 'Not bound'}</span>
                  </p>
                </div>

                <div className="flex items-center gap-2">
                  <div className="w-64">
                    <Select
                      aria-label={`Runtime for ${role}`}
                      options={eligibleRuntimes.map((runtime) => ({
                        value: runtime.id,
                        label: runtime.simulated ? `${runtime.id} (simulated)` : runtime.id,
                      }))}
                      value={binding?.runtimeId ?? ''}
                      disabled={saving === role}
                      onChange={(event: { target: { value: string } }) => {
                        void handleBind(role, event.target.value)
                      }}
                    />
                  </div>

                  {binding?.simulated === true && (
                    <Badge tone="warning" size="sm">
                      simulated
                    </Badge>
                  )}
                  {binding !== null &&
                    eligibleRuntimes.find((runtime) => runtime.id === binding.runtimeId)
                      ?.supportsAccountIsolation === false && (
                      <Badge tone="neutral" size="sm">
                        one account at a time
                      </Badge>
                    )}
                </div>
              </Card>
            ))}
          </div>
        )}
      </section>

      {/* Section 2: Agent Roster & Custom Agents */}
      <section className="grid gap-3 pt-2">
        <div className="flex items-center justify-between">
          <div>
            <h2 className="text-[14px] font-bold text-(--color-text)">
              Available Agents & Personas
            </h2>
            <p className="m-0 text-[12px] text-(--color-text-muted)">
              Custom agent profiles equipped with specialized directives and capabilities.
            </p>
          </div>
          <Badge tone="neutral" size="sm" className="rounded-full">
            {customAgents.length} Agents
          </Badge>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-3">
          {customAgents.map((agent) => {
            const roleBinding = roles.find((r) => r.role === agent.roleType)
            const isAssigned = roleBinding?.binding !== null && roleBinding?.binding !== undefined
            // The stored binding only. Falling back to the persona's own `runtimeId`
            // showed 'primary-engine' — a label with no registered runtime behind it —
            // on a role the engine considered unbound, so the page read "Bound to
            // planner / Engine: primary-engine" while the role assignment above it
            // read "Not bound" and the workflow silently ran on `mock:default`.
            const activeRuntime = roleBinding?.binding?.runtimeId ?? 'Not bound'
            return (
              <AgentCard
                key={agent.id}
                id={agent.id}
                name={agent.name}
                roleType={agent.roleType}
                runtimeId={activeRuntime}
                instructions={agent.instructions}
                capabilities={agent.capabilities}
                isAssigned={isAssigned}
                assignedRole={roleBinding?.role}
                isCustom={!DEFAULT_BUILTIN_AGENTS.some((d) => d.id === agent.id)}
                onDelete={
                  !DEFAULT_BUILTIN_AGENTS.some((d) => d.id === agent.id)
                    ? () => {
                        handleDeleteCustomAgent(agent.id)
                      }
                    : undefined
                }
              />
            )
          })}
        </div>
      </section>

      {/* Create Custom Agent Modal */}
      <CreateAgentDialog
        open={createAgentOpen}
        availableRuntimes={availableRuntimes}
        onClose={() => {
          setCreateAgentOpen(false)
        }}
        onSave={handleSaveCustomAgent}
      />
    </div>
  )
}

function Header(): React.JSX.Element {
  return (
    <div className="border-b border-(--color-border) px-6 py-4">
      <h1 className="text-[18px] font-bold text-(--color-text)">Agents</h1>
      <p className="text-[12px] text-(--color-text-muted)">
        Runtimes are bound to roles per project.
      </p>
    </div>
  )
}
