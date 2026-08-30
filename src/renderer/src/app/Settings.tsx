import { useEffect, useState } from 'react'
import type { AccountView, ProjectDetail, RoleBindingsView, RuleView } from '@shared/ipc'
import { unwrap } from '@renderer/ipc'
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  IconButton,
  Input,
  ScrollArea,
  Select,
  Separator,
  Spinner,
  StatusDot,
  Textarea,
  useTheme,
  useToast,
} from '../ui'
import { AccountEnrollment } from './AccountEnrollment'
import { DeleteProjectDialog } from './DeleteProjectDialog'
import { EditProjectDialog } from './EditProjectDialog'
import { CloseIcon } from './icons'
import { useProjectStore } from './projectStore'
import { useUiStore } from './uiStore'

type GlobalSettingsTab = 'workflows' | 'appearance' | 'accounts' | 'customizations'

interface SettingsSelection {
  readonly type: 'global' | 'project'
  readonly globalTab?: GlobalSettingsTab
  readonly projectId?: string
}

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
    globalTab: 'workflows',
  })

  // Global settings state
  const [worktreeIsolation, setWorktreeIsolation] = useState<'worktree' | 'inplace'>('worktree')
  const [decisionRequirement, setDecisionRequirement] = useState<'strict' | 'relaxed'>('strict')
  const [notificationDuration, setNotificationDuration] = useState<'4500' | '6000' | '0'>('4500')
  const [pruneWorktrees, setPruneWorktrees] = useState<boolean>(true)

  // Permissions modal
  const [activePermissionsModal, setActivePermissionsModal] = useState<string | null>(null)

  // Accounts state
  const [accounts, setAccounts] = useState<readonly AccountView[]>([])
  const [accountProvider, setAccountProvider] = useState('default')
  const [accountLabel, setAccountLabel] = useState('')
  const [registeringAccount, setRegisteringAccount] = useState(false)
  const [runtimes, setRuntimes] = useState<readonly { id: string; simulated: boolean }[]>([])

  const [editProjectOpen, setEditProjectOpen] = useState(false)
  const [deleteProjectOpen, setDeleteProjectOpen] = useState(false)

  // Project rule edit state
  const [key, setKey] = useState('')
  const [scope, setScope] = useState('project')
  const [statement, setStatement] = useState('')
  const [savingRule, setSavingRule] = useState(false)

  // Project bindings state
  const [bindingsView, setBindingsView] = useState<RoleBindingsView | null>(null)

  useEffect(() => {
    window.forge.account
      .list()
      .then((res) => {
        const data = unwrap(res)
        setAccounts(data.accounts)
      })
      .catch((err: unknown) => {
        console.error('Failed to load accounts:', err)
      })
  }, [])

  useEffect(() => {
    window.forge.runtime
      .list()
      .then((res) => {
        const list = unwrap(res).runtimes
        setRuntimes(list.map((r) => ({ id: r.id, simulated: r.simulated })))
        setAccountProvider((current) => (current === '' ? (list[0]?.id ?? '') : current))
      })
      .catch((err: unknown) => {
        console.error('Failed to load runtimes:', err)
      })
  }, [])

  // When inspecting a project
  useEffect(() => {
    if (selection.type === 'project' && selection.projectId) {
      window.forge.binding
        .list(selection.projectId)
        .then((res) => {
          setBindingsView(unwrap(res))
        })
        .catch(() => {
          // non-fatal
        })
    }
  }, [selection])

  const activeProject = detail

  async function registerAccount(): Promise<void> {
    if (accountLabel.trim() === '') return
    setRegisteringAccount(true)
    try {
      const res = await window.forge.account.register({
        provider: accountProvider.trim() || 'default',
        label: accountLabel.trim(),
      })
      const created = unwrap(res)
      setAccounts((prev) => [...prev, created])
      setAccountLabel('')
      show({ tone: 'success', title: `Account "${created.label}" registered` })
    } catch (cause) {
      show({
        tone: 'danger',
        title: 'Could not register account',
        description: cause instanceof Error ? cause.message : 'Unknown error',
      })
    } finally {
      setRegisteringAccount(false)
    }
  }

  async function removeAccount(accountId: string): Promise<void> {
    try {
      const res = await window.forge.account.remove(accountId)
      unwrap(res)
      setAccounts((prev) => prev.filter((a) => a.id !== accountId))
      show({ tone: 'success', title: 'Account removed' })
    } catch (cause) {
      show({
        tone: 'danger',
        title: 'Could not remove account',
        description: cause instanceof Error ? cause.message : 'Unknown error',
      })
    }
  }

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
                    { id: 'workflows', label: 'Workflows & Execution' },
                    { id: 'appearance', label: 'Appearance' },
                    { id: 'accounts', label: 'AI Accounts & Runtimes' },
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
                {selection.globalTab === 'workflows' && (
                  <WorkflowsGlobalSettings
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

                {selection.globalTab === 'appearance' && (
                  <AppearanceGlobalSettings
                    theme={theme}
                    setTheme={setTheme}
                    sidebarCollapsed={sidebarCollapsed}
                    toggleSidebar={toggleSidebar}
                  />
                )}

                {selection.globalTab === 'accounts' && (
                  <AccountsGlobalSettings
                    accounts={accounts}
                    accountProvider={accountProvider}
                    setAccountProvider={setAccountProvider}
                    accountLabel={accountLabel}
                    setAccountLabel={setAccountLabel}
                    registeringAccount={registeringAccount}
                    registerAccount={registerAccount}
                    removeAccount={removeAccount}
                    runtimes={runtimes}
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
                    bindingsView={bindingsView}
                  />
                ) : (
                  <EmptyState
                    title="No project selected"
                    description="Select a project from the left sidebar to configure its repository, rules, and agent bindings."
                  />
                )}
              </>
            )}
          </div>
        </ScrollArea>
      </main>

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
              Forge enforces strict execution boundaries so autonomous agents cannot corrupt repositories or execute dangerous system commands.
            </p>
            <div className="rounded-xl bg-(--color-surface-inset) border border-(--color-border) p-3 font-mono text-[11px] space-y-1.5">
              {activePermissionsModal === 'files' && (
                <>
                  <p className="text-(--color-success)">ALLOW: Isolated Git Worktree (Read & Write)</p>
                  <p className="text-(--color-danger)">DENY: .git metadata, .env secrets, *.pem, System roots</p>
                </>
              )}
              {activePermissionsModal === 'network' && (
                <>
                  <p className="text-(--color-success)">ALLOW: Configured LLM Providers, Git Remotes</p>
                  <p className="text-(--color-danger)">DENY: Arbitrary outbound unverified network endpoints</p>
                </>
              )}
              {activePermissionsModal === 'terminal' && (
                <>
                  <p className="text-(--color-success)">ALLOW: git, npm, pnpm, yarn, cargo, pytest, vitest, tsc</p>
                  <p className="text-(--color-danger)">DENY: rm -rf /, format, sudo, systemctl, registry edits</p>
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
          <IconButton
            size="sm"
            label="Close settings"
            icon={<CloseIcon />}
            onClick={onClose}
          />
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
   GLOBAL WORKFLOWS & EXECUTION SETTINGS
   ========================================================================= */

function WorkflowsGlobalSettings({
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
        <h1 className="text-[18px] font-bold text-(--color-text)">Workflows & Execution</h1>
        <p className="mt-1 text-[12px] text-(--color-text-muted)">
          Configure how autonomous agents execute workflows, isolate code changes, and notify on milestones.
        </p>
      </div>

      {/* Execution Sandboxing */}
      <section className="grid gap-2">
        <h2 className="text-[13px] font-semibold text-(--color-text)">Execution Sandboxing</h2>
        <Card tone="raised">
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-md">
              <p className="m-0 font-medium text-[13px] text-(--color-text)">
                Workspace Isolation
              </p>
              <p className="m-0 mt-0.5 text-[12px] text-(--color-text-muted)">
                Runs agent tasks inside dedicated Git worktrees to prevent dirtying your active working branch.
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
        </Card>
      </section>

      {/* Decision Locking Policy */}
      <section className="grid gap-2">
        <h2 className="text-[13px] font-semibold text-(--color-text)">Decision Locking Policy</h2>
        <Card tone="raised">
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-md">
              <p className="m-0 font-medium text-[13px] text-(--color-text)">
                Architectural Decision Lock
              </p>
              <p className="m-0 mt-0.5 text-[12px] text-(--color-text-muted)">
                Requires architectural decisions to be explicitly reviewed and approved before code generation starts.
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
        </Card>
      </section>

      {/* Toast Notifications Timing */}
      <section className="grid gap-2">
        <h2 className="text-[13px] font-semibold text-(--color-text)">Notifications</h2>
        <Card tone="raised">
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="max-w-md">
              <p className="m-0 font-medium text-[13px] text-(--color-text)">
                Notification Auto-Dismiss
              </p>
              <p className="m-0 mt-0.5 text-[12px] text-(--color-text-muted)">
                Controls how long toast notifications remain visible before automatically closing.
              </p>
            </div>
            <div className="w-56">
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

      {/* Safety & Boundary Rules */}
      <section className="grid gap-2">
        <h2 className="text-[13px] font-semibold text-(--color-text)">Execution Safety Filters</h2>
        <Card tone="raised" className="divide-y divide-(--color-border)">
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
                Terminal Command Whitelist
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
   APPEARANCE SETTINGS
   ========================================================================= */

function AppearanceGlobalSettings({
  theme,
  setTheme,
  sidebarCollapsed,
  toggleSidebar,
}: {
  readonly theme: 'light' | 'dark'
  readonly setTheme: (theme: 'light' | 'dark') => void
  readonly sidebarCollapsed: boolean
  readonly toggleSidebar: () => void
}): React.JSX.Element {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-[18px] font-bold text-(--color-text)">Appearance</h1>
        <p className="mt-1 text-[12px] text-(--color-text-muted)">
          Customize color theme, typography, and sidebar layout.
        </p>
      </div>

      <section className="grid gap-2">
        <h2 className="text-[13px] font-semibold text-(--color-text)">Theme</h2>
        <Card tone="raised">
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="m-0 font-medium text-[13px] text-(--color-text)">Color Theme</p>
              <p className="m-0 mt-0.5 text-[12px] text-(--color-text-muted)">
                Choose between Claude Code warm light paper aesthetic and rich dark mode.
              </p>
            </div>
            <div className="w-48">
              <Select
                value={theme}
                onChange={(e) => {
                  setTheme(e.target.value as 'light' | 'dark')
                }}
                options={[
                  { value: 'dark', label: '🌙 Dark Mode' },
                  { value: 'light', label: '☀️ Light (Warm Paper)' },
                ]}
              />
            </div>
          </div>
        </Card>
      </section>

      <section className="grid gap-2">
        <h2 className="text-[13px] font-semibold text-(--color-text)">Sidebar Layout</h2>
        <Card tone="raised">
          <div className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="m-0 font-medium text-[13px] text-(--color-text)">Default Sidebar State</p>
              <p className="m-0 mt-0.5 text-[12px] text-(--color-text-muted)">
                Keep sidebar expanded with route labels or collapsed to compact icons.
              </p>
            </div>
            <div className="w-48">
              <Select
                value={sidebarCollapsed ? 'collapsed' : 'expanded'}
                onChange={(e) => {
                  if ((e.target.value === 'collapsed') !== sidebarCollapsed) {
                    toggleSidebar()
                  }
                }}
                options={[
                  { value: 'expanded', label: 'Expanded' },
                  { value: 'collapsed', label: 'Collapsed (Icons only)' },
                ]}
              />
            </div>
          </div>
        </Card>
      </section>
    </div>
  )
}

/* =========================================================================
   AI ACCOUNTS & RUNTIMES
   ========================================================================= */

function AccountsGlobalSettings({
  accounts,
  accountProvider,
  setAccountProvider,
  accountLabel,
  setAccountLabel,
  registeringAccount,
  registerAccount,
  removeAccount,
  runtimes,
}: {
  readonly accounts: readonly AccountView[]
  readonly accountProvider: string
  readonly setAccountProvider: (val: string) => void
  readonly accountLabel: string
  readonly setAccountLabel: (val: string) => void
  readonly registeringAccount: boolean
  readonly registerAccount: () => Promise<void>
  readonly removeAccount: (id: string) => Promise<void>
  readonly runtimes: readonly { id: string; simulated: boolean }[]
}): React.JSX.Element {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-[18px] font-bold text-(--color-text)">AI Accounts & Runtimes</h1>
        <p className="mt-1 text-[12px] text-(--color-text-muted)">
          Manage connected AI model providers, API credentials, and active execution runtimes.
        </p>
      </div>

      {/* Registered Accounts List */}
      <section className="grid gap-2">
        <h2 className="text-[13px] font-semibold text-(--color-text)">Registered Provider Accounts</h2>
        <Card tone="raised" className="divide-y divide-(--color-border)">
          {accounts.length === 0 ? (
            <div className="p-4 text-[12px] text-(--color-text-muted)">
              No accounts registered yet. Register an account below to connect model providers.
            </div>
          ) : (
            accounts.map((acc) => (
              <div key={acc.id} className="flex items-center justify-between p-4">
                <div className="space-y-0.5">
                  <div className="flex items-center gap-2">
                    <span className="font-semibold text-[13px] text-(--color-text)">{acc.label}</span>
                    <Badge tone="accent" size="sm" className="font-mono text-[10px]">
                      {acc.provider}
                    </Badge>
                  </div>
                  <p className="m-0 text-[11px] text-(--color-text-muted)">
                    Status: <span className="text-(--color-success)">{acc.status}</span>
                  </p>
                </div>
                <div className="flex items-center gap-2">
                  {runtimes.length > 0 && (
                    <AccountEnrollment accountId={acc.id} runtimeId={runtimes[0]?.id ?? 'default'} />
                  )}
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => {
                      void removeAccount(acc.id)
                    }}
                    className="text-[11px] text-(--color-danger) hover:text-(--color-danger)"
                  >
                    Remove
                  </Button>
                </div>
              </div>
            ))
          )}
        </Card>
      </section>

      {/* Register Account Form */}
      <section className="grid gap-2">
        <h2 className="text-[13px] font-semibold text-(--color-text)">Add Model Provider Account</h2>
        <Card tone="raised" className="p-4 space-y-3">
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <div>
              <label className="text-[11px] font-semibold text-(--color-text-muted)">Provider</label>
              <Select
                value={accountProvider}
                onChange={(e) => {
                  setAccountProvider(e.target.value)
                }}
                options={
                  runtimes.length > 0
                    ? runtimes.map((r) => ({ value: r.id, label: r.id }))
                    : [{ value: 'default', label: 'default' }]
                }
              />
            </div>
            <div>
              <label className="text-[11px] font-semibold text-(--color-text-muted)">Account Label</label>
              <Input
                placeholder="e.g. Primary Developer Account"
                value={accountLabel}
                onChange={(e) => {
                  setAccountLabel(e.target.value)
                }}
                className="h-8 text-[12px]"
              />
            </div>
          </div>
          <Button
            variant="primary"
            disabled={registeringAccount || accountLabel.trim() === ''}
            onClick={() => {
              void registerAccount()
            }}
            className="rounded-lg text-[12px]"
          >
            {registeringAccount ? 'Registering...' : 'Register Account'}
          </Button>
        </Card>
      </section>
    </div>
  )
}

/* =========================================================================
   CUSTOMIZATIONS & MCP
   ========================================================================= */

function CustomizationsGlobalSettings(): React.JSX.Element {
  return (
    <div className="grid gap-6">
      <div>
        <h1 className="text-[18px] font-bold text-(--color-text)">Customizations & MCP</h1>
        <p className="mt-1 text-[12px] text-(--color-text-muted)">
          Integrated Model Context Protocol (MCP) tool servers available to workflows.
        </p>
      </div>

      <Card tone="raised" className="divide-y divide-(--color-border)">
        {[
          { name: 'dev-mcp', desc: 'Code search, file inspections, and repository tools', status: 'Connected' },
          { name: 'mongodb', desc: 'MongoDB collection queries and schema analysis', status: 'Connected' },
          { name: 'mysql-mcp', desc: 'MySQL table inspection and structured query tools', status: 'Connected' },
          { name: 'oracle-db', desc: 'Oracle Database schema and execution support', status: 'Connected' },
        ].map((server) => (
          <div key={server.name} className="flex items-center justify-between p-4">
            <div>
              <p className="m-0 font-medium text-[13px] text-(--color-text) font-mono">
                {server.name}
              </p>
              <p className="m-0 text-[12px] text-(--color-text-muted)">{server.desc}</p>
            </div>
            <div className="flex items-center gap-2">
              <StatusDot status="passed" label={server.status} />
              <span className="text-[11px] font-medium text-(--color-success)">{server.status}</span>
            </div>
          </div>
        ))}
      </Card>
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
  bindingsView,
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
  readonly bindingsView: RoleBindingsView | null
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
            Repository configuration, role bindings, and project-level rules.
          </p>
        </div>

        <Button size="sm" variant="secondary" onClick={onEditProject} className="rounded-lg text-[12px]">
          Edit Repository
        </Button>
      </div>

      {/* Bound Repository Summary */}
      <section className="grid gap-2">
        <h2 className="text-[13px] font-semibold text-(--color-text)">Repository Details</h2>
        <Card tone="raised">
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 p-4 text-[12px]">
            <dt className="font-semibold text-(--color-text-muted)">Path:</dt>
            <dd className="font-mono text-(--color-text) break-all">{project.repository.absolutePath}</dd>

            <dt className="font-semibold text-(--color-text-muted)">Default Branch:</dt>
            <dd className="font-mono text-(--color-text)">{project.repository.defaultBranch}</dd>

            {probe && (
              <>
                <dt className="font-semibold text-(--color-text-muted)">Current Branch:</dt>
                <dd className="font-mono text-(--color-text)">{probe.branch ?? 'detached'}</dd>

                <dt className="font-semibold text-(--color-text-muted)">Head Commit:</dt>
                <dd className="font-mono text-(--color-text)">{probe.headSha?.slice(0, 10) ?? 'None'}</dd>
              </>
            )}

            <dt className="font-semibold text-(--color-text-muted)">Build Command:</dt>
            <dd className="font-mono text-(--color-text)">{project.repository.buildCommand ?? 'None'}</dd>

            <dt className="font-semibold text-(--color-text-muted)">Test Command:</dt>
            <dd className="font-mono text-(--color-text)">{project.repository.testCommand ?? 'None'}</dd>
          </dl>
        </Card>
      </section>

      {/* Role Bindings */}
      {bindingsView && (
        <section className="grid gap-2">
          <h2 className="text-[13px] font-semibold text-(--color-text)">Agent Role Bindings</h2>
          <Card tone="raised" className="divide-y divide-(--color-border)">
            {bindingsView.roles.map((item) => (
              <div key={item.role} className="flex items-center justify-between p-4">
                <div>
                  <p className="m-0 font-medium uppercase text-[12px] text-(--color-text)">
                    {item.role}
                  </p>
                  <p className="m-0 text-[11px] text-(--color-text-muted)">
                    Agent assigned to execute {item.role} workflow stages
                  </p>
                </div>
                <Badge tone="neutral" className="font-mono text-[11px]">
                  {item.binding?.runtimeId ?? 'default / simulated'}
                </Badge>
              </div>
            ))}
          </Card>
        </section>
      )}

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
            <p className="text-[12px] text-(--color-text-muted)">No rules defined for this project yet.</p>
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
                Removes this project from your Forge active workspaces. All files on disk remain untouched.
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
