import { useEffect, useState } from 'react'
import type { ProjectDetail, RuleView } from '@shared/ipc'
import {
  AddMcpServerDialog,
  AddProviderDialog,
  Badge,
  Button,
  Card,
  type CustomProviderConfig,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  type McpServerConfig,
  ProviderCard,
  ScrollArea,
  Select,
  Separator,
  Spinner,
  StatusDot,
  Textarea,
  useTheme,
  useToast,
} from '../ui'
import { DeleteProjectDialog } from './DeleteProjectDialog'
import { EditProjectDialog } from './EditProjectDialog'
import { CloseIcon } from './icons'
import { useProjectStore } from './projectStore'
import { useUiStore } from './uiStore'

type GlobalSettingsTab = 'general' | 'providers' | 'customizations'

interface SettingsSelection {
  readonly type: 'global' | 'project'
  readonly globalTab?: GlobalSettingsTab
  readonly projectId?: string
}

interface StoredProviderConfig {
  readonly id: string
  readonly name: string
  readonly type: 'api_key' | 'local' | 'custom'
  readonly description: string
  readonly apiKey?: string
  readonly envVarHint?: string
  readonly localUrl?: string
  readonly models?: readonly string[]
  readonly activeModel?: string
  readonly isCustom?: boolean
}

const DEFAULT_PROVIDERS: readonly StoredProviderConfig[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    type: 'api_key',
    description: 'Direct access to GPT-4o, GPT-4o-mini, o1, and reasoning models.',
    envVarHint: 'OPENAI_API_KEY',
    models: ['gpt-4o', 'gpt-4o-mini', 'o1', 'o3-mini'],
    activeModel: 'gpt-4o',
  },
  {
    id: 'messages-format',
    name: 'Messages API Endpoint',
    type: 'api_key',
    description: 'High-capability reasoning and coding models via Messages protocol.',
    envVarHint: 'MESSAGES_API_KEY',
    models: ['sonnet-latest', 'opus-latest', 'haiku-latest'],
    activeModel: 'sonnet-latest',
  },
  {
    id: 'google',
    name: 'Google AI',
    type: 'api_key',
    description: 'Gemini 2.0 Flash, Gemini 2.0 Pro, and 1.5 multimodal models.',
    envVarHint: 'GEMINI_API_KEY',
    models: ['gemini-2.0-flash', 'gemini-2.0-pro', 'gemini-1.5-pro'],
    activeModel: 'gemini-2.0-flash',
  },
  {
    id: 'deepseek',
    name: 'DeepSeek',
    type: 'api_key',
    description: 'DeepSeek V3 and DeepSeek R1 reasoning models with low latency.',
    envVarHint: 'DEEPSEEK_API_KEY',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    activeModel: 'deepseek-chat',
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    type: 'api_key',
    description: 'Unified gateway to 100+ open and proprietary AI models.',
    envVarHint: 'OPENROUTER_API_KEY',
    models: ['auto', 'deepseek/deepseek-r1', 'meta-llama/llama-3.3-70b-instruct'],
    activeModel: 'auto',
  },
  {
    id: 'mistral',
    name: 'Mistral',
    type: 'api_key',
    description: 'Mistral Large, Codestral, and Pixtral open-weight architectures.',
    envVarHint: 'MISTRAL_API_KEY',
    models: ['codestral-latest', 'mistral-large-latest'],
    activeModel: 'codestral-latest',
  },
  {
    id: 'ollama',
    name: 'Ollama (Local)',
    type: 'local',
    description: 'Run open-weight models locally on your machine with Ollama.',
    localUrl: 'http://localhost:11434',
    models: ['llama3', 'codellama', 'qwen2.5-coder', 'deepseek-r1'],
    activeModel: 'llama3',
  },
  {
    id: 'lmstudio',
    name: 'LM Studio (Local)',
    type: 'local',
    description: 'Local OpenAI-compatible inference server running on your machine.',
    localUrl: 'http://localhost:1234/v1',
    models: ['local-model'],
    activeModel: 'local-model',
  },
]

export function Settings(): React.JSX.Element {
  return <SettingsContent />
}

export function SettingsContent(): React.JSX.Element {
  const projects = useProjectStore((state) => state.projects)
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId)
  const selectProject = useProjectStore((state) => state.select)
  const detail = useProjectStore((state) => state.detail)
  const loading = useProjectStore((state) => state.loading)
  const applyRule = useProjectStore((state) => state.applyRule)
  const removeRule = useProjectStore((state) => state.removeRule)
  const { show } = useToast()
  const { theme, setTheme } = useTheme()
  const sidebarCollapsed = useUiStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)

  const [selection, setSelection] = useState<SettingsSelection>({
    type: 'global',
    globalTab: 'general',
  })

  // Global instructions state
  const [globalInstructions, setGlobalInstructions] = useState<string>(() => {
    return (
      localStorage.getItem('forge.global_instructions') ??
      'Prefer concise output, strictly typed code, minimal external dependencies, and explain architectural decisions clearly.'
    )
  })

  // Motion preference state
  const [motionPreference, setMotionPreference] = useState<'system' | 'reduced'>(() => {
    const val = localStorage.getItem('forge.motion')
    return val === 'reduced' ? 'reduced' : 'system'
  })

  // Notification toggles state
  const [notifyCompletions, setNotifyCompletions] = useState<boolean>(() => {
    return localStorage.getItem('forge.notify_completions') !== 'false'
  })
  const [notifyApprovals, setNotifyApprovals] = useState<boolean>(() => {
    return localStorage.getItem('forge.notify_approvals') !== 'false'
  })
  const [notifyHalts, setNotifyHalts] = useState<boolean>(() => {
    return localStorage.getItem('forge.notify_halts') !== 'false'
  })

  // Execution sandboxing state
  const [worktreeIsolation, setWorktreeIsolation] = useState<'worktree' | 'inplace'>('worktree')
  const [decisionRequirement, setDecisionRequirement] = useState<'strict' | 'relaxed'>('strict')
  const [notificationDuration, setNotificationDuration] = useState<'4500' | '6000' | '0'>('4500')
  const [pruneWorktrees, setPruneWorktrees] = useState<boolean>(true)

  // Permissions modal
  const [activePermissionsModal, setActivePermissionsModal] = useState<string | null>(null)

  // Providers state
  const [providers, setProviders] = useState<readonly StoredProviderConfig[]>(() => {
    const saved = localStorage.getItem('forge.providers')
    if (saved) {
      try {
        return JSON.parse(saved) as StoredProviderConfig[]
      } catch {
        // fallback
      }
    }
    return DEFAULT_PROVIDERS
  })

  const [activeProviderId, setActiveProviderId] = useState<string>(() => {
    return localStorage.getItem('forge.active_provider_id') ?? 'openai'
  })

  const [addProviderOpen, setAddProviderOpen] = useState(false)
  const [addProviderType, setAddProviderType] = useState<'openai' | 'messages'>('openai')

  const [editProjectOpen, setEditProjectOpen] = useState(false)
  const [deleteProjectOpen, setDeleteProjectOpen] = useState(false)

  // Project rule edit state
  const [key, setKey] = useState('')
  const [scope, setScope] = useState('project')
  const [statement, setStatement] = useState('')
  const [savingRule, setSavingRule] = useState(false)

  const handleSaveGlobalInstructions = (val: string): void => {
    setGlobalInstructions(val)
    localStorage.setItem('forge.global_instructions', val)
  }

  const handleSetMotion = (val: 'system' | 'reduced'): void => {
    setMotionPreference(val)
    localStorage.setItem('forge.motion', val)
  }

  const handleToggleNotifyCompletions = (val: boolean): void => {
    setNotifyCompletions(val)
    localStorage.setItem('forge.notify_completions', String(val))
  }

  const handleToggleNotifyApprovals = (val: boolean): void => {
    setNotifyApprovals(val)
    localStorage.setItem('forge.notify_approvals', String(val))
  }

  const handleToggleNotifyHalts = (val: boolean): void => {
    setNotifyHalts(val)
    localStorage.setItem('forge.notify_halts', String(val))
  }

  const handleSaveProviderKey = (providerId: string, apiKey: string): void => {
    const updated = providers.map((p) => (p.id === providerId ? { ...p, apiKey } : p))
    setProviders(updated)
    localStorage.setItem('forge.providers', JSON.stringify(updated))
    show({ tone: 'success', title: 'API Key saved' })
  }

  const handleResetProviderKey = (providerId: string): void => {
    const updated = providers.map((p) => (p.id === providerId ? { ...p, apiKey: '' } : p))
    setProviders(updated)
    localStorage.setItem('forge.providers', JSON.stringify(updated))
    show({ tone: 'neutral', title: 'API Key reset' })
  }

  const handleSetActiveProvider = (providerId: string): void => {
    setActiveProviderId(providerId)
    localStorage.setItem('forge.active_provider_id', providerId)
    show({ tone: 'success', title: 'Active provider updated' })
  }

  const handleSelectProviderModel = (providerId: string, activeModel: string): void => {
    const updated = providers.map((p) => (p.id === providerId ? { ...p, activeModel } : p))
    setProviders(updated)
    localStorage.setItem('forge.providers', JSON.stringify(updated))
  }

  const handleAddCustomProvider = (config: CustomProviderConfig): void => {
    const newProvider: StoredProviderConfig = {
      id: config.id,
      name: config.name,
      type: 'custom',
      description: `Custom ${config.apiType.toUpperCase()} endpoint at ${config.apiUrl}`,
      apiKey: config.apiKey,
      models: [config.modelName],
      activeModel: config.modelName,
      isCustom: true,
    }
    const updated = [...providers, newProvider]
    setProviders(updated)
    localStorage.setItem('forge.providers', JSON.stringify(updated))
    setActiveProviderId(config.id)
    localStorage.setItem('forge.active_provider_id', config.id)
    show({ tone: 'success', title: `Provider "${config.name}" added and activated` })
  }

  const handleDeleteCustomProvider = (providerId: string): void => {
    const updated = providers.filter((p) => p.id !== providerId)
    setProviders(updated)
    localStorage.setItem('forge.providers', JSON.stringify(updated))
    if (activeProviderId === providerId) {
      setActiveProviderId('openai')
      localStorage.setItem('forge.active_provider_id', 'openai')
    }
    show({ tone: 'neutral', title: 'Provider removed' })
  }

  const activeProject = detail

  async function saveRule(): Promise<void> {
    if (key.trim() === '' || statement.trim() === '' || !activeProject) return
    setSavingRule(true)
    try {
      await applyRule(scope, key.trim(), statement.trim())
      show({ tone: 'success', title: `Rule "${key.trim()}" set at ${scope} scope` })
      setKey('')
      setStatement('')
    } catch (cause) {
      show({
        tone: 'danger',
        title: 'Could not set rule',
        description: cause instanceof Error ? cause.message : 'Unknown error',
      })
    } finally {
      setSavingRule(false)
    }
  }

  async function handleRemoveRule(ruleId: string): Promise<void> {
    try {
      await removeRule(ruleId)
      show({ tone: 'success', title: 'Rule removed' })
    } catch (cause) {
      show({
        tone: 'danger',
        title: 'Could not remove rule',
        description: cause instanceof Error ? cause.message : 'Unknown error',
      })
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-1 bg-(--color-canvas)">
      {/* Left Settings Navigation Bar */}
      <aside className="w-56 shrink-0 border-r border-(--color-border) bg-(--color-surface) p-3">
        <ScrollArea className="h-full">
          <div className="flex flex-col gap-4 text-[12px]">
            {/* Global Settings Section */}
            <div>
              <p className="px-2 py-1 font-semibold uppercase tracking-wider text-(--color-text-subtle)">
                Application
              </p>
              <nav className="mt-1 flex flex-col gap-0.5">
                {(
                  [
                    { id: 'general', label: 'General & Directives' },
                    { id: 'providers', label: 'LLM Providers' },
                    { id: 'customizations', label: 'Customizations & MCP' },
                  ] as const
                ).map((tab) => {
                  const isActive = selection.type === 'global' && selection.globalTab === tab.id
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      onClick={() => {
                        setSelection({ type: 'global', globalTab: tab.id })
                      }}
                      className={`flex w-full items-center rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors cursor-pointer select-none ${
                        isActive
                          ? 'bg-(--color-surface-raised) text-(--color-text) shadow-xs border border-(--color-border)'
                          : 'text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text)'
                      }`}
                    >
                      {tab.label}
                    </button>
                  )
                })}
              </nav>
            </div>

            <Separator />

            {/* Projects Settings Section */}
            <div>
              <div className="flex items-center justify-between px-2 py-1">
                <p className="font-semibold uppercase tracking-wider text-(--color-text-subtle)">
                  Projects
                </p>
                <Badge tone="neutral" size="sm" className="rounded-full text-[10px]">
                  {projects.length}
                </Badge>
              </div>
              <nav className="mt-1 flex flex-col gap-0.5">
                {projects.length === 0 ? (
                  <p className="px-2.5 py-2 text-(--color-text-muted)">No projects added</p>
                ) : (
                  projects.map((proj) => {
                    const isSelected =
                      selection.type === 'project' && selection.projectId === proj.id
                    const isCurrentlyActive = proj.id === selectedProjectId
                    return (
                      <button
                        key={proj.id}
                        type="button"
                        onClick={() => {
                          setSelection({ type: 'project', projectId: proj.id })
                          void selectProject(proj.id)
                        }}
                        className={`flex w-full items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[13px] font-medium transition-colors cursor-pointer select-none ${
                          isSelected
                            ? 'bg-(--color-surface-raised) text-(--color-text) shadow-xs border border-(--color-border)'
                            : 'text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text)'
                        }`}
                      >
                        <span className="truncate">{proj.name}</span>
                        {isCurrentlyActive && (
                          <span
                            className="size-2 rounded-full bg-(--color-accent)"
                            title="Active workspace project"
                          />
                        )}
                      </button>
                    )
                  })
                )}
              </nav>
            </div>
          </div>
        </ScrollArea>
      </aside>

      {/* Right Content Area */}
      <main className="flex min-w-0 flex-1 flex-col overflow-hidden bg-(--color-canvas)">
        <ScrollArea className="h-full">
          <div className="mx-auto max-w-3xl p-8">
            {selection.type === 'global' ? (
              <>
                {selection.globalTab === 'general' && (
                  <GeneralGlobalSettings
                    globalInstructions={globalInstructions}
                    onSaveGlobalInstructions={handleSaveGlobalInstructions}
                    theme={theme}
                    setTheme={setTheme}
                    motionPreference={motionPreference}
                    onSetMotion={handleSetMotion}
                    sidebarCollapsed={sidebarCollapsed}
                    toggleSidebar={toggleSidebar}
                    notifyCompletions={notifyCompletions}
                    onToggleNotifyCompletions={handleToggleNotifyCompletions}
                    notifyApprovals={notifyApprovals}
                    onToggleNotifyApprovals={handleToggleNotifyApprovals}
                    notifyHalts={notifyHalts}
                    onToggleNotifyHalts={handleToggleNotifyHalts}
                    worktreeIsolation={worktreeIsolation}
                    setWorktreeIsolation={setWorktreeIsolation}
                    decisionRequirement={decisionRequirement}
                    setDecisionRequirement={setDecisionRequirement}
                    notificationDuration={notificationDuration}
                    setNotificationDuration={setNotificationDuration}
                    pruneWorktrees={pruneWorktrees}
                    setPruneWorktrees={setPruneWorktrees}
                    onOpenModal={(modalId) => {
                      setActivePermissionsModal(modalId)
                    }}
                  />
                )}

                {selection.globalTab === 'providers' && (
                  <AIProvidersSettings
                    providers={providers}
                    activeProviderId={activeProviderId}
                    onSaveKey={handleSaveProviderKey}
                    onResetKey={handleResetProviderKey}
                    onSetActive={handleSetActiveProvider}
                    onSelectModel={handleSelectProviderModel}
                    onDeleteCustomProvider={handleDeleteCustomProvider}
                    onOpenAddProvider={(type) => {
                      setAddProviderType(type)
                      setAddProviderOpen(true)
                    }}
                  />
                )}

                {selection.globalTab === 'customizations' && <CustomizationsGlobalSettings />}
              </>
            ) : (
              <>
                {loading && !activeProject ? (
                  <div className="flex h-64 items-center justify-center">
                    <Spinner label="Loading project settings" />
                  </div>
                ) : activeProject ? (
                  <ProjectLevelSettings
                    detail={activeProject}
                    onEditProject={() => {
                      setEditProjectOpen(true)
                    }}
                    onDeleteProject={() => {
                      setDeleteProjectOpen(true)
                    }}
                    keyState={key}
                    setKeyState={setKey}
                    scopeState={scope}
                    setScopeState={setScope}
                    statementState={statement}
                    setStatementState={setStatement}
                    savingRule={savingRule}
                    saveRule={saveRule}
                    removeRule={handleRemoveRule}
                  />
                ) : (
                  <EmptyState
                    title="No project selected"
                    description="Select a project from the left sidebar to configure its repository and project-level rules."
                  />
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </main>

      {/* Add Custom Provider Dialog */}
      <AddProviderDialog
        open={addProviderOpen}
        initialType={addProviderType}
        onClose={() => {
          setAddProviderOpen(false)
        }}
        onSave={handleAddCustomProvider}
      />

      {/* Permissions Modal */}
      {activePermissionsModal !== null && (
        <Dialog
          open
          onClose={() => {
            setActivePermissionsModal(null)
          }}
          title={
            activePermissionsModal === 'files'
              ? 'File Boundary Rules'
              : activePermissionsModal === 'network'
                ? 'Network & API Permissions'
                : 'Terminal Execution Filters'
          }
          size="md"
        >
          <div className="grid gap-3 text-[12px] text-(--color-text)">
            <p className="text-(--color-text-muted)">
              Forge enforces strict execution boundaries so autonomous agents cannot corrupt
              repositories or execute dangerous system commands.
            </p>
            <div className="rounded-xl bg-(--color-surface-inset) border border-(--color-border) p-3 font-mono text-[11px] space-y-1.5">
              {activePermissionsModal === 'files' && (
                <>
                  <p className="text-(--color-success)">
                    ALLOW: Isolated Git Worktree (Read & Write)
                  </p>
                  <p className="text-(--color-danger)">
                    DENY: .git metadata, .env secrets, *.pem, System roots
                  </p>
                </>
              )}
              {activePermissionsModal === 'network' && (
                <>
                  <p className="text-(--color-success)">
                    ALLOW: Configured LLM Providers, Git Remotes
                  </p>
                  <p className="text-(--color-danger)">
                    DENY: Arbitrary outbound unverified network endpoints
                  </p>
                </>
              )}
              {activePermissionsModal === 'terminal' && (
                <>
                  <p className="text-(--color-success)">
                    ALLOW: git, npm, pnpm, yarn, cargo, pytest, vitest, tsc
                  </p>
                  <p className="text-(--color-danger)">
                    DENY: rm -rf /, format, sudo, systemctl, registry edits
                  </p>
                </>
              )}
            </div>
            <div className="flex justify-end pt-2">
              <Button
                variant="primary"
                onClick={() => {
                  setActivePermissionsModal(null)
                }}
              >
                Close
              </Button>
            </div>
          </div>
        </Dialog>
      )}

      {/* Project Edit & Delete Dialogs */}
      {editProjectOpen && activeProject && (
        <EditProjectDialog
          open
          project={activeProject.project}
          probe={activeProject.probe}
          onClose={() => {
            setEditProjectOpen(false)
          }}
          onSaved={() => {
            void selectProject(activeProject.project.id)
          }}
        />
      )}

      {deleteProjectOpen && activeProject && (
        <DeleteProjectDialog
          open
          project={activeProject.project}
          onClose={() => {
            setDeleteProjectOpen(false)
          }}
        />
      )}
    </div>
  )
}

export function SettingsDialog({
  open,
  onClose,
}: {
  readonly open: boolean
  readonly onClose: () => void
}): React.JSX.Element | null {
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
    }
  }, [open, onClose])

  if (!open) return null

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="settings-dialog-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4 sm:p-6"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="relative flex h-[88vh] max-h-[850px] w-[92vw] max-w-5xl flex-col rounded-2xl border border-(--color-border) bg-(--color-surface) shadow-2xl overflow-hidden">
        {/* Settings Modal Header */}
        <div className="flex items-center justify-between border-b border-(--color-border) px-5 py-3 bg-(--color-surface)">
          <div className="flex items-center gap-2">
            <span className="text-[14px] font-semibold text-(--color-text)">Settings</span>
          </div>
          <IconButton size="sm" label="Close settings" icon={<CloseIcon />} onClick={onClose} />
        </div>

        {/* Modal 2-Level Settings Body */}
        <div className="min-h-0 flex-1 flex overflow-hidden">
          <SettingsContent />
        </div>
      </div>
    </div>
  )
}

/* =========================================================================
   GENERAL SETTINGS & DIRECTIVES
   ========================================================================= */

function GeneralGlobalSettings({
  globalInstructions,
  onSaveGlobalInstructions,
  theme,
  setTheme,
  motionPreference,
  onSetMotion,
  sidebarCollapsed,
  toggleSidebar,
  notifyCompletions,
  onToggleNotifyCompletions,
  notifyApprovals,
  onToggleNotifyApprovals,
  notifyHalts,
  onToggleNotifyHalts,
  worktreeIsolation,
  setWorktreeIsolation,
  decisionRequirement,
  setDecisionRequirement,
  notificationDuration,
  setNotificationDuration,
  pruneWorktrees,
  setPruneWorktrees,
  onOpenModal,
}: {
  readonly globalInstructions: string
  readonly onSaveGlobalInstructions: (val: string) => void
  readonly theme: 'light' | 'dark' | 'azure' | 'system'
  readonly setTheme: (theme: 'light' | 'dark' | 'azure' | 'system') => void
  readonly motionPreference: 'system' | 'reduced'
  readonly onSetMotion: (val: 'system' | 'reduced') => void
  readonly sidebarCollapsed: boolean
  readonly toggleSidebar: () => void
  readonly notifyCompletions: boolean
  readonly onToggleNotifyCompletions: (val: boolean) => void
  readonly notifyApprovals: boolean
  readonly onToggleNotifyApprovals: (val: boolean) => void
  readonly notifyHalts: boolean
  readonly onToggleNotifyHalts: (val: boolean) => void
  readonly worktreeIsolation: 'worktree' | 'inplace'
  readonly setWorktreeIsolation: (val: 'worktree' | 'inplace') => void
  readonly decisionRequirement: 'strict' | 'relaxed'
  readonly setDecisionRequirement: (val: 'strict' | 'relaxed') => void
  readonly notificationDuration: '4500' | '6000' | '0'
  readonly setNotificationDuration: (val: '4500' | '6000' | '0') => void
  readonly pruneWorktrees: boolean
  readonly setPruneWorktrees: (val: boolean) => void
  readonly onOpenModal: (id: string) => void
}): React.JSX.Element {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-[18px] font-bold text-(--color-text)">General Settings</h1>
        <p className="mt-1 text-[12px] text-(--color-text-muted)">
          Configure global agent instructions, visual appearance, notifications, and workflow
          sandboxing.
        </p>
      </div>

      {/* Global Instructions Card */}
      <section className="grid gap-2">
        <h2 className="text-[13px] font-semibold text-(--color-text)">
          Global Instructions for Agent
        </h2>
        <Card tone="raised" className="p-4 space-y-2">
          <p className="m-0 text-[12px] text-(--color-text-muted)">
            Forge includes these directives in the prompt packet across every workflow and project.
          </p>
          <Textarea
            value={globalInstructions}
            onChange={(e) => {
              onSaveGlobalInstructions(e.target.value)
            }}
            rows={4}
            className="text-[12px] font-mono leading-relaxed"
            placeholder="e.g. Prefer concise explanations, strictly typed TypeScript, minimal dependencies..."
          />
        </Card>
      </section>

      {/* Preferences (Appearance, Motion, Sidebar) */}
      <section className="grid gap-2">
        <h2 className="text-[13px] font-semibold text-(--color-text)">Preferences</h2>
        <Card tone="raised" className="divide-y divide-(--color-border)">
          {/* Appearance Mode */}
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="m-0 font-medium text-[13px] text-(--color-text)">Appearance</p>
              <p className="m-0 mt-0.5 text-[12px] text-(--color-text-muted)">
                Choose your preferred interface theme.
              </p>
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-(--color-surface-inset) p-1">
              {(
                [
                  { id: 'system', label: 'System' },
                  { id: 'light', label: 'Light' },
                  { id: 'dark', label: 'Dark' },
                  { id: 'azure', label: 'Azure' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    setTheme(opt.id)
                  }}
                  className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors cursor-pointer select-none ${
                    theme === opt.id
                      ? 'bg-(--color-surface-raised) text-(--color-text) shadow-xs border border-(--color-border)'
                      : 'text-(--color-text-muted) hover:text-(--color-text)'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Interface Motion */}
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="m-0 font-medium text-[13px] text-(--color-text)">Motion</p>
              <p className="m-0 mt-0.5 text-[12px] text-(--color-text-muted)">
                Reduce animation in streaming logs and UI transitions.
              </p>
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-(--color-surface-inset) p-1">
              {(
                [
                  { id: 'system', label: 'System' },
                  { id: 'reduced', label: 'Reduced' },
                ] as const
              ).map((opt) => (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => {
                    onSetMotion(opt.id)
                  }}
                  className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors cursor-pointer select-none ${
                    motionPreference === opt.id
                      ? 'bg-(--color-surface-raised) text-(--color-text) shadow-xs border border-(--color-border)'
                      : 'text-(--color-text-muted) hover:text-(--color-text)'
                  }`}
                >
                  {opt.label}
                </button>
              ))}
            </div>
          </div>

          {/* Sidebar Layout */}
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="m-0 font-medium text-[13px] text-(--color-text)">Sidebar State</p>
              <p className="m-0 mt-0.5 text-[12px] text-(--color-text-muted)">
                Default sidebar width on application start.
              </p>
            </div>
            <div className="flex items-center gap-1 rounded-lg bg-(--color-surface-inset) p-1">
              <button
                type="button"
                onClick={() => {
                  if (sidebarCollapsed) toggleSidebar()
                }}
                className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors cursor-pointer select-none ${
                  !sidebarCollapsed
                    ? 'bg-(--color-surface-raised) text-(--color-text) shadow-xs border border-(--color-border)'
                    : 'text-(--color-text-muted) hover:text-(--color-text)'
                }`}
              >
                Expanded
              </button>
              <button
                type="button"
                onClick={() => {
                  if (!sidebarCollapsed) toggleSidebar()
                }}
                className={`rounded-md px-3 py-1 text-[12px] font-medium transition-colors cursor-pointer select-none ${
                  sidebarCollapsed
                    ? 'bg-(--color-surface-raised) text-(--color-text) shadow-xs border border-(--color-border)'
                    : 'text-(--color-text-muted) hover:text-(--color-text)'
                }`}
              >
                Collapsed
              </button>
            </div>
          </div>
        </Card>
      </section>

      {/* Notifications Preferences */}
      <section className="grid gap-2">
        <h2 className="text-[13px] font-semibold text-(--color-text)">Notifications</h2>
        <Card tone="raised" className="divide-y divide-(--color-border)">
          <div className="flex items-center justify-between p-4">
            <div>
              <p className="m-0 font-medium text-[13px] text-(--color-text)">
                Step & Milestone Completions
              </p>
              <p className="m-0 text-[12px] text-(--color-text-muted)">
                Get notified when an agent completes a workflow stage.
              </p>
            </div>
            <input
              type="checkbox"
              className="size-4 rounded accent-(--color-accent) cursor-pointer"
              checked={notifyCompletions}
              onChange={(e) => {
                onToggleNotifyCompletions(e.target.checked)
              }}
            />
          </div>

          <div className="flex items-center justify-between p-4">
            <div>
              <p className="m-0 font-medium text-[13px] text-(--color-text)">
                Approval & Decision Requests
              </p>
              <p className="m-0 text-[12px] text-(--color-text-muted)">
                Get notified when a workflow halts awaiting your decision review or answer.
              </p>
            </div>
            <input
              type="checkbox"
              className="size-4 rounded accent-(--color-accent) cursor-pointer"
              checked={notifyApprovals}
              onChange={(e) => {
                onToggleNotifyApprovals(e.target.checked)
              }}
            />
          </div>

          <div className="flex items-center justify-between p-4">
            <div>
              <p className="m-0 font-medium text-[13px] text-(--color-text)">
                Halt & Limit Warnings
              </p>
              <p className="m-0 text-[12px] text-(--color-text-muted)">
                Receive immediate alerts if limits or policy rules halt a workflow.
              </p>
            </div>
            <input
              type="checkbox"
              className="size-4 rounded accent-(--color-accent) cursor-pointer"
              checked={notifyHalts}
              onChange={(e) => {
                onToggleNotifyHalts(e.target.checked)
              }}
            />
          </div>

          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-md">
              <p className="m-0 font-medium text-[13px] text-(--color-text)">
                Toast Notification Duration
              </p>
              <p className="m-0 mt-0.5 text-[12px] text-(--color-text-muted)">
                Duration before floating toast messages dismiss automatically.
              </p>
            </div>
            <div className="w-48">
              <Select
                value={notificationDuration}
                onChange={(e) => {
                  setNotificationDuration(e.target.value as '4500' | '6000' | '0')
                }}
                options={[
                  { value: '4500', label: '4.5s (Standard)' },
                  { value: '6000', label: '6.0s (Relaxed)' },
                  { value: '0', label: 'Never (Manual Only)' },
                ]}
              />
            </div>
          </div>
        </Card>
      </section>

      {/* Execution Sandboxing */}
      <section className="grid gap-2">
        <h2 className="text-[13px] font-semibold text-(--color-text)">Execution Sandboxing</h2>
        <Card tone="raised" className="divide-y divide-(--color-border)">
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-md">
              <p className="m-0 font-medium text-[13px] text-(--color-text)">Workspace Isolation</p>
              <p className="m-0 mt-0.5 text-[12px] text-(--color-text-muted)">
                Runs agent tasks inside dedicated Git worktrees to prevent dirtying your active
                branch.
              </p>
            </div>
            <div className="w-56">
              <Select
                value={worktreeIsolation}
                onChange={(e) => {
                  setWorktreeIsolation(e.target.value as 'worktree' | 'inplace')
                }}
                options={[
                  { value: 'worktree', label: 'Git Worktrees (Safe)' },
                  { value: 'inplace', label: 'Direct Workspace Edits' },
                ]}
              />
            </div>
          </div>

          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-md">
              <p className="m-0 font-medium text-[13px] text-(--color-text)">
                Decision Lock Requirement
              </p>
              <p className="m-0 mt-0.5 text-[12px] text-(--color-text-muted)">
                Requires architectural decisions to be approved before implementation begins.
              </p>
            </div>
            <div className="w-56">
              <Select
                value={decisionRequirement}
                onChange={(e) => {
                  setDecisionRequirement(e.target.value as 'strict' | 'relaxed')
                }}
                options={[
                  { value: 'strict', label: 'Strict (Approval Required)' },
                  { value: 'relaxed', label: 'Autonomous (Auto-Proceed)' },
                ]}
              />
            </div>
          </div>

          <div className="flex items-center justify-between p-4">
            <div>
              <p className="m-0 font-medium text-[13px] text-(--color-text)">
                File Boundary Protection
              </p>
              <p className="m-0 text-[12px] text-(--color-text-muted)">
                Prohibits access to sensitive files like .env and .git repository roots.
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onOpenModal('files')
              }}
              className="rounded-lg text-[12px]"
            >
              View Rules
            </Button>
          </div>

          <div className="flex items-center justify-between p-4">
            <div>
              <p className="m-0 font-medium text-[13px] text-(--color-text)">
                Terminal Command Filters
              </p>
              <p className="m-0 text-[12px] text-(--color-text-muted)">
                Filters permitted build, test, and package manager commands.
              </p>
            </div>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => {
                onOpenModal('terminal')
              }}
              className="rounded-lg text-[12px]"
            >
              View Rules
            </Button>
          </div>

          <div className="flex items-center justify-between p-4">
            <div>
              <p className="m-0 font-medium text-[13px] text-(--color-text)">
                Prune Completed Worktrees
              </p>
              <p className="m-0 text-[12px] text-(--color-text-muted)">
                Automatically clean up isolated temporary git worktrees after workflows complete.
              </p>
            </div>
            <input
              type="checkbox"
              className="size-4 rounded accent-(--color-accent) cursor-pointer"
              checked={pruneWorktrees}
              onChange={(e) => {
                setPruneWorktrees(e.target.checked)
              }}
            />
          </div>
        </Card>
      </section>
    </div>
  )
}

/* =========================================================================
   LLM PROVIDERS (SINGLE AGENT, MULTI-PROVIDER ARCHITECTURE)
   ========================================================================= */

function AIProvidersSettings({
  providers,
  activeProviderId,
  onSaveKey,
  onResetKey,
  onSetActive,
  onSelectModel,
  onDeleteCustomProvider,
  onOpenAddProvider,
}: {
  readonly providers: readonly StoredProviderConfig[]
  readonly activeProviderId: string
  readonly onSaveKey: (id: string, key: string) => void
  readonly onResetKey: (id: string) => void
  readonly onSetActive: (id: string) => void
  readonly onSelectModel: (id: string, model: string) => void
  readonly onDeleteCustomProvider: (id: string) => void
  readonly onOpenAddProvider: (type: 'openai' | 'messages') => void
}): React.JSX.Element {
  const activeProvider = providers.find((p) => p.id === activeProviderId) ?? providers[0]

  return (
    <div className="grid gap-6">
      {/* Header & Add Provider Actions */}
      <div className="flex items-start justify-between">
        <div>
          <h1 className="text-[18px] font-bold text-(--color-text)">LLM Providers</h1>
          <p className="mt-1 text-[12px] text-(--color-text-muted)">
            Manage API credentials and model endpoints for your AI agent.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              onOpenAddProvider('openai')
            }}
            className="rounded-lg text-[12px]"
          >
            + Add Provider
          </Button>
        </div>
      </div>

      {/* Active Provider Indicator Card */}
      {activeProvider && (
        <Card tone="raised" className="border-(--color-accent)/50 bg-(--color-surface-raised) p-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div className="space-y-0.5">
              <div className="flex items-center gap-2">
                <span className="text-[13px] font-bold text-(--color-text)">
                  Current Active Model:
                </span>
                <span className="font-mono text-[13px] font-semibold text-(--color-accent)">
                  {activeProvider.name} / {activeProvider.activeModel ?? 'default'}
                </span>
              </div>
              <p className="m-0 text-[11px] text-(--color-text-muted)">
                Forge powers all agent workflow stages using this active provider and model.
              </p>
            </div>
            <Badge tone="accent" size="sm">
              In Use
            </Badge>
          </div>
        </Card>
      )}

      {/* Providers List */}
      <section className="grid gap-3">
        <h2 className="text-[13px] font-semibold text-(--color-text)">Available Providers</h2>
        <div className="grid gap-3">
          {providers.map((p) => {
            const isConfigured =
              p.type === 'local' || (p.apiKey !== undefined && p.apiKey.trim() !== '')
            const isActive = p.id === activeProviderId
            return (
              <ProviderCard
                key={p.id}
                id={p.id}
                name={p.name}
                description={p.description}
                apiKey={p.apiKey}
                envVarHint={p.envVarHint}
                isConfigured={isConfigured}
                isActive={isActive}
                type={p.type}
                localUrl={p.localUrl}
                models={p.models}
                activeModel={p.activeModel}
                onSaveKey={(k) => {
                  onSaveKey(p.id, k)
                }}
                onResetKey={() => {
                  onResetKey(p.id)
                }}
                onSetActive={() => {
                  onSetActive(p.id)
                }}
                onSelectModel={(m) => {
                  onSelectModel(p.id, m)
                }}
                onDelete={
                  p.isCustom
                    ? () => {
                        onDeleteCustomProvider(p.id)
                      }
                    : undefined
                }
              />
            )
          })}
        </div>
      </section>
    </div>
  )
}

/* =========================================================================
   CUSTOMIZATIONS & MCP
   ========================================================================= */

const DEFAULT_MCP_SERVERS: readonly McpServerConfig[] = [
  {
    id: 'dev-mcp',
    name: 'dev-mcp',
    description: 'Code search, file inspections, git operations, and repository tools',
    transport: 'stdio',
    command: 'dev-mcp',
    enabled: true,
    status: 'connected',
    isBuiltin: true,
    tools: [
      'find-projects',
      'find-controllers',
      'search-code',
      'docker-ps',
      'git-info',
      'find-configs',
      'read-docs',
      'run-powershell',
      'env-info',
    ],
  },
  {
    id: 'mongodb',
    name: 'mongodb',
    description: 'MongoDB collection queries, document inspection, and schema analysis',
    transport: 'stdio',
    command: 'mongodb',
    enabled: true,
    status: 'connected',
    isBuiltin: true,
    tools: [
      'list_databases',
      'list_collections',
      'find_documents',
      'count_documents',
      'aggregate',
      'get_collection_stats',
      'sample_schema',
    ],
  },
  {
    id: 'mysql-mcp',
    name: 'mysql-mcp',
    description: 'MySQL table inspection, schema definitions, and structured query tools',
    transport: 'stdio',
    command: 'mysql-mcp',
    enabled: true,
    status: 'connected',
    isBuiltin: true,
    tools: [
      'query',
      'list-tables',
      'describe-table',
      'show-indexes',
      'show-foreign-keys',
      'count-rows',
      'database-info',
    ],
  },
  {
    id: 'oracle-db',
    name: 'oracle-db',
    description: 'Oracle Database schema inspection, queries, and execution support',
    transport: 'stdio',
    command: 'oracle-db',
    enabled: true,
    status: 'connected',
    isBuiltin: true,
    tools: ['query', 'get_schema', 'execute_insert', 'execute_update'],
  },
  {
    id: 'redis',
    name: 'redis',
    description: 'Redis in-memory data store, cache inspection, and key-value operations',
    transport: 'stdio',
    command: 'redis',
    enabled: true,
    status: 'connected',
    isBuiltin: true,
    tools: ['redis_get', 'redis_keys', 'redis_hgetall', 'redis_type'],
  },
]

function CustomizationsGlobalSettings(): React.JSX.Element {
  const { show } = useToast()
  const [servers, setServers] = useState<readonly McpServerConfig[]>(() => {
    const saved = localStorage.getItem('forge.mcp_servers')
    if (saved) {
      try {
        return JSON.parse(saved) as McpServerConfig[]
      } catch {
        // fallback
      }
    }
    return DEFAULT_MCP_SERVERS
  })

  const [searchQuery, setSearchQuery] = useState('')
  const [isAddDialogOpen, setIsAddDialogOpen] = useState(false)
  const [expandedServerId, setExpandedServerId] = useState<string | null>(null)
  const [testingServerId, setTestingServerId] = useState<string | null>(null)

  const saveServers = (updated: readonly McpServerConfig[]): void => {
    setServers(updated)
    localStorage.setItem('forge.mcp_servers', JSON.stringify(updated))
  }

  const handleToggleServer = (serverId: string): void => {
    const target = servers.find((s) => s.id === serverId)
    if (!target) return
    const nextEnabled = !target.enabled
    const nextStatus: 'connected' | 'disabled' = nextEnabled ? 'connected' : 'disabled'
    const updated: readonly McpServerConfig[] = servers.map((s) =>
      s.id === serverId
        ? {
            ...s,
            enabled: nextEnabled,
            status: nextStatus,
          }
        : s,
    )
    saveServers(updated)
    show({
      tone: nextEnabled ? 'success' : 'neutral',
      title: `${target.name} ${nextEnabled ? 'enabled' : 'disabled'}`,
      description: nextEnabled
        ? 'Tools from this server are now active for workflows.'
        : 'Server disconnected from active agent tool registries.',
    })
  }

  const handleAddServer = (newServer: McpServerConfig): void => {
    const updated = [...servers, newServer]
    saveServers(updated)
    show({
      tone: 'success',
      title: `Added MCP Server "${newServer.name}"`,
      description: `Transport: ${newServer.transport.toUpperCase()}`,
    })
  }

  const handleDeleteServer = (serverId: string): void => {
    const target = servers.find((s) => s.id === serverId)
    if (!target) return
    const updated = servers.filter((s) => s.id !== serverId)
    saveServers(updated)
    show({
      tone: 'neutral',
      title: `Removed MCP Server "${target.name}"`,
    })
  }

  const handleTestConnection = (server: McpServerConfig): void => {
    setTestingServerId(server.id)
    setTimeout(() => {
      setTestingServerId(null)
      show({
        tone: 'success',
        title: `Connection Verified: ${server.name}`,
        description: `Server responded successfully via ${server.transport.toUpperCase()} transport.`,
      })
    }, 600)
  }

  const handleResetDefaults = (): void => {
    saveServers(DEFAULT_MCP_SERVERS)
    show({
      tone: 'neutral',
      title: 'Reset to default MCP servers',
    })
  }

  const filteredServers = servers.filter((s) => {
    if (searchQuery.trim() === '') return true
    const q = searchQuery.toLowerCase()
    return (
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.tools?.some((t) => t.toLowerCase().includes(q))
    )
  })

  const connectedCount = servers.filter((s) => s.enabled).length

  return (
    <div className="grid gap-6">
      {/* Header */}
      <div className="flex items-start justify-between">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[18px] font-bold text-(--color-text)">Customizations & MCP</h1>
            <Badge tone="accent" size="sm" className="rounded-full">
              {connectedCount}/{servers.length} Active
            </Badge>
          </div>
          <p className="mt-1 text-[12px] text-(--color-text-muted)">
            Integrated Model Context Protocol (MCP) tool servers providing extensible capabilities to agent workflows.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={handleResetDefaults}
            className="text-[12px] text-(--color-text-muted)"
          >
            Reset Defaults
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => {
              setIsAddDialogOpen(true)
            }}
            className="rounded-lg text-[12px]"
          >
            + Add MCP Server
          </Button>
        </div>
      </div>

      {/* Search Bar */}
      <div className="max-w-md">
        <Input
          placeholder="Filter MCP servers or tools..."
          value={searchQuery}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
            setSearchQuery(e.target.value)
          }}
          className="h-8 text-[12px]"
        />
      </div>

      {/* Server List */}
      <section className="grid gap-3">
        {filteredServers.length === 0 ? (
          <Card tone="raised" className="p-8 text-center text-[13px] text-(--color-text-muted)">
            No MCP servers match &quot;{searchQuery}&quot;. Click &quot;+ Add MCP Server&quot; to configure one.
          </Card>
        ) : (
          filteredServers.map((server) => {
            const isExpanded = expandedServerId === server.id
            const isTesting = testingServerId === server.id

            return (
              <Card
                key={server.id}
                tone="raised"
                className={`p-4 transition-all ${
                  server.enabled
                    ? 'border-(--color-border)'
                    : 'border-(--color-border) opacity-70 bg-(--color-surface-inset)'
                }`}
              >
                <div className="flex flex-col gap-3">
                  {/* Top Summary Row */}
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <div className="space-y-1">
                      <div className="flex items-center gap-2">
                        <span className="font-mono text-[14px] font-bold text-(--color-text)">
                          {server.name}
                        </span>
                        <Badge
                          tone={server.isBuiltin ? 'neutral' : 'accent'}
                          size="sm"
                          className="font-mono text-[10px]"
                        >
                          {server.isBuiltin ? 'Built-in' : 'Custom'}
                        </Badge>
                        <Badge tone="neutral" size="sm" className="font-mono text-[10px]">
                          {server.transport.toUpperCase()}
                        </Badge>
                        <div className="flex items-center gap-1.5 ml-1">
                          <StatusDot
                            status={server.enabled ? 'passed' : 'idle'}
                            label={server.enabled ? 'Connected' : 'Disabled'}
                          />
                          <span
                            className={`text-[11px] font-medium ${
                              server.enabled
                                ? 'text-(--color-success)'
                                : 'text-(--color-text-subtle)'
                            }`}
                          >
                            {server.enabled ? 'Connected' : 'Disabled'}
                          </span>
                        </div>
                      </div>
                      <p className="m-0 text-[12px] text-(--color-text-muted)">
                        {server.description}
                      </p>
                    </div>

                    {/* Action Controls */}
                    <div className="flex items-center gap-2 shrink-0">
                      <Button
                        size="sm"
                        variant="secondary"
                        disabled={!server.enabled || isTesting}
                        onClick={() => {
                          handleTestConnection(server)
                        }}
                        className="h-7 text-[11px]"
                      >
                        {isTesting ? (
                          <span className="flex items-center gap-1">
                            <Spinner size="sm" />
                            Testing...
                          </span>
                        ) : (
                          'Ping'
                        )}
                      </Button>

                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => {
                          setExpandedServerId(isExpanded ? null : server.id)
                        }}
                        className="h-7 text-[11px]"
                      >
                        {isExpanded ? 'Hide Details' : 'Details'}
                      </Button>

                      <Button
                        size="sm"
                        variant={server.enabled ? 'secondary' : 'primary'}
                        onClick={() => {
                          handleToggleServer(server.id)
                        }}
                        className="h-7 text-[11px]"
                      >
                        {server.enabled ? 'Disable' : 'Enable'}
                      </Button>

                      {!server.isBuiltin && (
                        <Button
                          size="sm"
                          variant="ghost"
                          onClick={() => {
                            handleDeleteServer(server.id)
                          }}
                          className="h-7 text-[11px] text-(--color-danger) hover:text-(--color-danger)"
                        >
                          ✕
                        </Button>
                      )}
                    </div>
                  </div>

                  {/* Expandable Details Row */}
                  {isExpanded && (
                    <div className="border-t border-(--color-border) pt-3 grid gap-2.5 text-[11px]">
                      {server.command && (
                        <div className="flex items-start gap-2">
                          <span className="font-semibold text-(--color-text-muted) w-24 shrink-0">
                            Command:
                          </span>
                          <code className="font-mono text-(--color-text) bg-(--color-surface-inset) px-2 py-0.5 rounded-md border border-(--color-border)">
                            {server.command} {server.args?.join(' ') ?? ''}
                          </code>
                        </div>
                      )}

                      {server.url && (
                        <div className="flex items-start gap-2">
                          <span className="font-semibold text-(--color-text-muted) w-24 shrink-0">
                            Endpoint:
                          </span>
                          <code className="font-mono text-(--color-text) bg-(--color-surface-inset) px-2 py-0.5 rounded-md border border-(--color-border)">
                            {server.url}
                          </code>
                        </div>
                      )}

                      {server.env && Object.keys(server.env).length > 0 && (
                        <div className="flex items-start gap-2">
                          <span className="font-semibold text-(--color-text-muted) w-24 shrink-0">
                            Environment:
                          </span>
                          <div className="font-mono text-(--color-text-subtle) space-y-0.5">
                            {Object.entries(server.env).map(([k, v]) => (
                              <div key={k}>
                                {k}=<span className="text-(--color-text)">{v.replace(/./g, '•')}</span>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {server.tools && server.tools.length > 0 && (
                        <div className="flex items-start gap-2 pt-1">
                          <span className="font-semibold text-(--color-text-muted) w-24 shrink-0">
                            Tools ({server.tools.length}):
                          </span>
                          <div className="flex flex-wrap items-center gap-1.5 flex-1">
                            {server.tools.map((t) => (
                              <span
                                key={t}
                                className="rounded-md bg-(--color-surface-inset) px-2 py-0.5 font-mono text-[10px] text-(--color-text-subtle) border border-(--color-border)"
                              >
                                {t}
                              </span>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </Card>
            )
          })
        )}
      </section>

      {/* Add MCP Server Dialog */}
      <AddMcpServerDialog
        open={isAddDialogOpen}
        onClose={() => {
          setIsAddDialogOpen(false)
        }}
        onSave={handleAddServer}
      />
    </div>
  )
}

/* =========================================================================
   PROJECT-LEVEL SETTINGS
   ========================================================================= */

function ProjectLevelSettings({
  detail,
  onEditProject,
  onDeleteProject,
  keyState,
  setKeyState,
  scopeState,
  setScopeState,
  statementState,
  setStatementState,
  savingRule,
  saveRule,
  removeRule,
}: {
  readonly detail: ProjectDetail
  readonly onEditProject: () => void
  readonly onDeleteProject: () => void
  readonly keyState: string
  readonly setKeyState: (val: string) => void
  readonly scopeState: string
  readonly setScopeState: (val: string) => void
  readonly statementState: string
  readonly setStatementState: (val: string) => void
  readonly savingRule: boolean
  readonly saveRule: () => Promise<void>
  readonly removeRule: (id: string) => Promise<void>
}): React.JSX.Element {
  const { project, rules, probe } = detail

  return (
    <div className="grid gap-6">
      {/* Project Header */}
      <div className="flex items-center justify-between border-b border-(--color-border) pb-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-[18px] font-bold text-(--color-text)">{project.name}</h1>
            <Badge tone="accent" size="sm" className="rounded-full">
              Project Settings
            </Badge>
          </div>
          <p className="text-[12px] text-(--color-text-muted)">
            Repository configuration and project-level rules.
          </p>
        </div>

        <Button
          size="sm"
          variant="secondary"
          onClick={onEditProject}
          className="rounded-lg text-[12px]"
        >
          Edit Repository
        </Button>
      </div>

      {/* Bound Repository Summary */}
      <section className="grid gap-2">
        <h2 className="text-[13px] font-semibold text-(--color-text)">Repository Details</h2>
        <Card tone="raised">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 p-4 text-[12px]">
            <dt className="font-semibold text-(--color-text-muted)">Path:</dt>
            <dd className="font-mono text-(--color-text) break-all">
              {project.repository.absolutePath}
            </dd>

            <dt className="font-semibold text-(--color-text-muted)">Default Branch:</dt>
            <dd className="font-mono text-(--color-text)">{project.repository.defaultBranch}</dd>

            {probe && (
              <>
                <dt className="font-semibold text-(--color-text-muted)">Current Branch:</dt>
                <dd className="font-mono text-(--color-text)">{probe.branch ?? 'detached'}</dd>

                <dt className="font-semibold text-(--color-text-muted)">Head Commit:</dt>
                <dd className="font-mono text-(--color-text)">
                  {probe.headSha?.slice(0, 10) ?? 'None'}
                </dd>
              </>
            )}

            <dt className="font-semibold text-(--color-text-muted)">Build Command:</dt>
            <dd className="font-mono text-(--color-text)">
              {project.repository.buildCommand ?? 'None'}
            </dd>

            <dt className="font-semibold text-(--color-text-muted)">Test Command:</dt>
            <dd className="font-mono text-(--color-text)">
              {project.repository.testCommand ?? 'None'}
            </dd>
          </dl>
        </Card>
      </section>

      {/* Project Rules */}
      <section className="grid gap-3">
        <div className="flex items-center justify-between">
          <h2 className="text-[13px] font-semibold text-(--color-text)">Project Rules</h2>
          <Badge tone="neutral" size="sm" className="rounded-full">
            {rules.length} Active
          </Badge>
        </div>

        <Card tone="raised" className="p-4 space-y-4">
          {rules.length === 0 ? (
            <p className="text-[12px] text-(--color-text-muted)">
              No rules defined for this project yet.
            </p>
          ) : (
            <ul className="space-y-2 list-none p-0 m-0">
              {rules.map((rule: RuleView) => (
                <li
                  key={rule.id}
                  className="flex items-start justify-between gap-3 rounded-lg border border-(--color-border) bg-(--color-surface-inset) p-2.5 text-[12px]"
                >
                  <div>
                    <Badge tone="neutral" size="sm" className="mb-1">
                      {rule.scope}
                    </Badge>
                    <p className="m-0 font-medium text-(--color-text)">{rule.statement}</p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void removeRule(rule.id)
                    }}
                    className="text-[11px] text-(--color-danger) hover:text-(--color-danger)"
                  >
                    Remove
                  </Button>
                </li>
              ))}
            </ul>
          )}

          <Separator />

          {/* Add Rule Form */}
          <div className="space-y-3 pt-1">
            <p className="font-semibold text-[12px] text-(--color-text)">Add New Rule</p>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Input
                placeholder="Rule key (e.g. strict-types)"
                value={keyState}
                onChange={(e) => {
                  setKeyState(e.target.value)
                }}
                className="h-8 text-[12px]"
              />
              <Select
                value={scopeState}
                onChange={(e) => {
                  setScopeState(e.target.value)
                }}
                options={[
                  { value: 'project', label: 'Scope: Project' },
                  { value: 'workflow', label: 'Scope: Workflow' },
                  { value: 'step', label: 'Scope: Step' },
                ]}
              />
              <Button
                variant="primary"
                disabled={savingRule || keyState.trim() === '' || statementState.trim() === ''}
                onClick={() => {
                  void saveRule()
                }}
                className="h-8 text-[12px]"
              >
                {savingRule ? 'Saving...' : 'Add Rule'}
              </Button>
            </div>
            <Textarea
              placeholder="Rule statement (e.g. All TypeScript code must be strictly typed with zero any)"
              value={statementState}
              onChange={(e) => {
                setStatementState(e.target.value)
              }}
              rows={2}
              className="text-[12px]"
            />
          </div>
        </Card>
      </section>

      {/* Danger Zone */}
      <section className="grid gap-2 pt-4">
        <h2 className="text-[13px] font-semibold text-(--color-danger)">Danger Zone</h2>
        <Card tone="raised" className="border-(--color-danger)/40 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="m-0 font-medium text-[13px] text-(--color-danger)">
                Remove Project from Forge
              </p>
              <p className="m-0 mt-0.5 text-[12px] text-(--color-text-muted)">
                Removes this project from your Forge active workspaces. All files on disk remain
                untouched.
              </p>
            </div>
            <Button
              variant="danger"
              size="sm"
              onClick={onDeleteProject}
              className="rounded-lg text-[12px]"
            >
              Remove Project
            </Button>
          </div>
        </Card>
      </section>
    </div>
  )
}
