import React, { useCallback, useEffect, useState } from 'react'
import type { ArtifactMetadataView, WorkflowDetailView } from '@shared/ipc'
import { unwrap } from '../ipc'
import {
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  List,
  ListRow,
  ScrollArea,
  Separator,
  Tooltip,
  cn,
} from '../ui'
import { ArtifactTabViewer } from './ArtifactTabViewer'
import { DrawerGitView } from './DrawerGitView'
import { DrawerPlanView } from './DrawerPlanView'
import { FileTabViewer } from './FileTabViewer'
import { useOverviewStore, type OverviewFileChange, type WorkspaceTab } from './overviewStore'
import { useProjectStore } from './projectStore'
import { TerminalTabViewer } from './TerminalTabViewer'

function DrawerOverviewSection({
  title,
  count,
  open,
  onOpenChange,
  trailing,
  children,
}: {
  readonly title: string
  readonly count: number
  readonly open: boolean
  readonly onOpenChange: (open: boolean) => void
  readonly trailing?: React.ReactNode | undefined
  readonly children: React.ReactNode
}): React.JSX.Element {
  return (
    <Collapsible open={open} onOpenChange={onOpenChange}>
      <div className="rounded-(--radius-lg) border border-(--color-edge-muted) bg-(--color-surface-raised)/40">
        <div className="flex items-center justify-between gap-2 px-3 py-1.5">
          <CollapsibleTrigger className="flex-1 py-0.5 text-left typography-meta text-(--color-text-muted) hover:text-(--color-text)">
            <span className="flex items-center gap-2">
              <span className="font-medium text-(--color-text)">{title}</span>
              <Badge tone="neutral" size="sm" className="font-mono">
                {String(count)}
              </Badge>
            </span>
            <Icon
              name={open ? 'chevron-down' : 'chevron-right'}
              className="ml-auto size-3.5 text-(--color-text-subtle)"
            />
          </CollapsibleTrigger>
          {trailing !== undefined ? (
            <div className="flex shrink-0 items-center gap-1">{trailing}</div>
          ) : null}
        </div>
        <CollapsibleContent className="border-t border-(--color-edge-muted) p-2">
          {children}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

function tabIconName(tab: WorkspaceTab): 'terminal' | 'plan' | 'file-code' | 'file' {
  if (tab.kind === 'terminal') return 'terminal'
  if (tab.kind === 'artifact') return 'plan'
  const lower = tab.title.toLowerCase()
  if (
    lower.endsWith('.ts') ||
    lower.endsWith('.tsx') ||
    lower.endsWith('.js') ||
    lower.endsWith('.jsx') ||
    lower.endsWith('.rs') ||
    lower.endsWith('.py') ||
    lower.endsWith('.json')
  ) {
    return 'file-code'
  }
  return 'file'
}

/**
 * Global right-hand Execution Context Drawer modeled on OpenChamber's
 * ContextPanel / PlanView / GitView: hosts Overview, planning.md Plan Viewer,
 * Diffs & Git Actions, Terminal, and dynamic opened file/artifact tabs.
 */
export function RightOverviewPanel(): React.JSX.Element | null {
  const isOpen = useOverviewStore((state) => state.isOpen)
  const toggleOpen = useOverviewStore((state) => state.toggleOpen)
  const isExpanded = useOverviewStore((state) => state.isExpanded)
  const toggleExpanded = useOverviewStore((state) => state.toggleExpanded)
  const panelWidth = useOverviewStore((state) => state.panelWidth)

  const panelMode = useOverviewStore((state) => state.panelMode)
  const hasUnreadPlan = useOverviewStore((state) => state.hasUnreadPlan)
  const showOverview = useOverviewStore((state) => state.showOverview)
  const showPlan = useOverviewStore((state) => state.showPlan)
  const showGit = useOverviewStore((state) => state.showGit)
  const tabs = useOverviewStore((state) => state.tabs)
  const activeTabId = useOverviewStore((state) => state.activeTabId)
  const openTab = useOverviewStore((state) => state.openTab)
  const closeTab = useOverviewStore((state) => state.closeTab)
  const setActiveTab = useOverviewStore((state) => state.setActiveTab)

  const activeFilter = useOverviewStore((state) => state.activeFilter)
  const setActiveFilter = useOverviewStore((state) => state.setActiveFilter)

  const subagents = useOverviewStore((state) => state.subagents)
  const sessionArtifacts = useOverviewStore((state) => state.artifacts)
  const uploads = useOverviewStore((state) => state.uploads)
  const backgroundTasks = useOverviewStore((state) => state.backgroundTasks)
  const terminals = useOverviewStore((state) => state.terminals)
  const filesChanged = useOverviewStore((state) => state.filesChanged)
  const setFilesChanged = useOverviewStore((state) => state.setFilesChanged)
  const agentEditedFiles = useOverviewStore((state) => state.agentEditedFiles)

  const detail = useProjectStore((state) => state.detail)
  const project = detail?.project ?? null

  const [expandedSubagents, setExpandedSubagents] = useState(false)
  const [expandedFilesChanged, setExpandedFilesChanged] = useState(true)
  const [expandedArtifacts, setExpandedArtifacts] = useState(true)
  const [expandedUploads, setExpandedUploads] = useState(false)
  const [expandedBgTasks, setExpandedBgTasks] = useState(false)
  const [expandedTerminals, setExpandedTerminals] = useState(false)

  const [showAllFiles, setShowAllFiles] = useState(false)
  const [loadingGit, setLoadingGit] = useState(false)
  const [activeWorkflow, setActiveWorkflow] = useState<WorkflowDetailView | null>(null)
  const [runArtifacts, setRunArtifacts] = useState<readonly ArtifactMetadataView[]>([])

  const refreshContext = useCallback(async (): Promise<void> => {
    if (!isOpen || project === null) return
    setLoadingGit(true)
    try {
      const [probe, wf] = await Promise.all([
        window.forge.project.probeRepository(project.repository.absolutePath).then(unwrap),
        window.forge.workflow.getActive(project.id).then(unwrap),
      ])
      const mapped: OverviewFileChange[] = probe.dirtyPaths.map((fullPath) => {
        const normalized = fullPath.replace(/\\/g, '/')
        const parts = normalized.split('/')
        const fileName = parts.pop() ?? fullPath
        const dir = parts.length > 0 ? parts.join('/') : '.'
        return {
          path: fileName,
          directory: dir,
          fullPath: normalized,
          status: 'M+',
        }
      })
      setFilesChanged(mapped)
      setActiveWorkflow(wf)
      if (wf !== null) {
        const artsRes = await window.forge.artifacts.listForRun(wf.id).then(unwrap)
        setRunArtifacts(artsRes.artifacts)
      } else {
        setRunArtifacts([])
      }
    } catch {
      // Non-fatal in stubbed or offline modes
    } finally {
      setLoadingGit(false)
    }
  }, [isOpen, project, setFilesChanged])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void refreshContext()
    })
    const unsub = window.forge.onWorkflowEvent(() => {
      if (active) void refreshContext()
    })
    return () => {
      active = false
      unsub()
    }
  }, [refreshContext])

  const panelStyle = React.useMemo<React.CSSProperties>(() => {
    if (!isOpen) return { width: 0 }
    if (isExpanded) return { width: '100%' }
    return { width: `${String(panelWidth)}px` }
  }, [isOpen, isExpanded, panelWidth])

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  const displayedSourceFiles =
    activeFilter === 'agent_edits'
      ? filesChanged.filter((f) => agentEditedFiles.includes(f.fullPath ?? f.path))
      : filesChanged
  const displayedFiles = showAllFiles ? displayedSourceFiles : displayedSourceFiles.slice(0, 6)

  const currentBranch = detail?.probe?.branch ?? project?.repository.defaultBranch ?? 'main'
  const totalArtifactsCount = runArtifacts.length + sessionArtifacts.length
  const combinedSubagentsCount =
    subagents.length +
    (activeWorkflow?.steps.filter((s) => s.state !== 'pending' && s.role !== 'user').length ?? 0)

  const handleOpenWorkflowArtifact = async (meta: ArtifactMetadataView): Promise<void> => {
    if (meta.kind === 'plan' || meta.name.toLowerCase().includes('planning')) {
      showPlan()
      return
    }
    try {
      const win = await window.forge.artifacts
        .readWindow({
          artifactId: meta.id,
          offsetBytes: 0,
          lengthBytes: Math.min(Math.max(meta.sizeBytes, 1), 262_144),
        })
        .then(unwrap)
      const bytes = Uint8Array.from(atob(win.data), (c) => c.charCodeAt(0))
      const decoded = new TextDecoder().decode(bytes)
      openTab({
        id: `artifact:${meta.id}`,
        kind: 'artifact',
        title: meta.name,
        artifactId: meta.id,
        content: decoded,
      })
    } catch {
      openTab({
        id: `artifact:${meta.id}`,
        kind: 'artifact',
        title: meta.name,
        artifactId: meta.id,
        content: '',
      })
    }
  }

  if (!isOpen) {
    return null
  }

  return (
    <aside
      aria-label="Inspection and Overview Panel"
      style={panelStyle}
      className={cn(
        'relative z-10 flex flex-col overflow-hidden bg-(--color-surface) text-(--color-text) select-none',
        !isExpanded && 'shrink-0 border-l border-(--color-edge)',
        isExpanded && 'flex-1 border-l-0',
      )}
    >
      <div className="flex h-full w-full min-w-[320px] flex-col">
        {/* Top Execution Drawer Navigation Strip */}
        <div className="flex h-9 shrink-0 items-center justify-between border-b border-(--color-edge) bg-(--color-surface) px-2">
          <div className="no-scrollbar flex min-w-0 items-center gap-1 overflow-x-auto pr-2">
            <Button
              size="xs"
              variant={panelMode === 'overview' ? 'secondary' : 'ghost'}
              onClick={showOverview}
            >
              <Icon name="overview" className="size-3.5" />
              <span>Overview</span>
            </Button>

            <Button
              size="xs"
              variant={panelMode === 'plan' ? 'secondary' : 'ghost'}
              onClick={showPlan}
            >
              <Icon name="plan" className="size-3.5 text-(--color-accent)" />
              <span>planning.md</span>
              {hasUnreadPlan ? (
                <span className="size-1.5 rounded-(--radius-full) bg-(--color-accent)" />
              ) : null}
            </Button>

            <Button
              size="xs"
              variant={panelMode === 'git' ? 'secondary' : 'ghost'}
              onClick={showGit}
            >
              <Icon name="git-branch" className="size-3.5 text-(--color-info)" />
              <span>Diffs / Git</span>
              {filesChanged.length > 0 ? (
                <Badge tone="warning" size="sm" className="px-1 py-0 typography-micro">
                  {String(filesChanged.length)}
                </Badge>
              ) : null}
            </Button>

            <Tooltip content="Open Drawer Terminal" side="bottom">
              <IconButton
                size="xs"
                variant={
                  panelMode === 'tab' && activeTab?.kind === 'terminal' ? 'secondary' : 'ghost'
                }
                label="Terminal"
                icon={<Icon name="terminal" />}
                onClick={() => {
                  const existingTerm = tabs.find((t) => t.id === 'tab:terminal')
                  if (existingTerm !== undefined) {
                    setActiveTab('tab:terminal')
                  } else {
                    openTab({
                      id: 'tab:terminal',
                      kind: 'terminal',
                      title: 'Terminal',
                      subtitle: terminals.length > 0 ? `(${String(terminals.length)})` : undefined,
                    })
                  }
                }}
              />
            </Tooltip>

            {tabs.length > 0 ? <Separator orientation="vertical" className="mx-1 h-3.5" /> : null}

            {tabs.map((tab) => {
              const isTabActive = panelMode === 'tab' && tab.id === activeTabId
              return (
                <div
                  key={tab.id}
                  role="tab"
                  aria-selected={isTabActive}
                  tabIndex={0}
                  onClick={() => {
                    setActiveTab(tab.id)
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      setActiveTab(tab.id)
                    }
                  }}
                  className={cn(
                    'group flex h-6 max-w-[200px] shrink-0 cursor-pointer items-center gap-1.5 rounded-(--radius-md) px-2 transition-colors',
                    isTabActive
                      ? 'bg-(--color-surface-raised) font-medium text-(--color-text)'
                      : 'text-(--color-text-muted) hover:bg-(--color-interactive-hover) hover:text-(--color-text)',
                  )}
                >
                  <Icon name={tabIconName(tab)} className="size-3.5 shrink-0" />
                  <span className="truncate typography-meta">{tab.title}</span>
                  <button
                    type="button"
                    aria-label={`Close ${tab.title}`}
                    onClick={(e) => {
                      e.stopPropagation()
                      closeTab(tab.id)
                    }}
                    className="ml-0.5 flex size-4 items-center justify-center rounded text-(--color-text-subtle) opacity-0 transition-opacity hover:bg-(--color-surface-inset) hover:text-(--color-text) group-hover:opacity-100"
                  >
                    <Icon name="close" className="size-3" />
                  </button>
                </div>
              )
            })}
          </div>

          <div className="flex shrink-0 items-center gap-0.5 pl-1">
            <Tooltip
              content={isExpanded ? 'Restore panel size' : 'Expand panel size'}
              side="bottom"
            >
              <IconButton
                size="xs"
                variant="ghost"
                label={isExpanded ? 'Restore panel size' : 'Expand panel size'}
                icon={<Icon name={isExpanded ? 'minimize' : 'maximize'} />}
                onClick={toggleExpanded}
              />
            </Tooltip>

            <Tooltip content="Collapse right panel" side="bottom">
              <IconButton
                size="xs"
                variant="ghost"
                label="Collapse right panel"
                icon={<Icon name="panel-right" />}
                onClick={toggleOpen}
              />
            </Tooltip>
          </div>
        </div>

        {/* Drawer Body */}
        {panelMode === 'plan' ? (
          <DrawerPlanView />
        ) : panelMode === 'git' ? (
          <DrawerGitView />
        ) : panelMode === 'tab' && activeTab !== null ? (
          <div className="flex-1 overflow-hidden">
            {activeTab.kind === 'file' ? (
              <FileTabViewer tab={activeTab} />
            ) : activeTab.kind === 'terminal' ? (
              <TerminalTabViewer tab={activeTab} />
            ) : (
              <ArtifactTabViewer tab={activeTab} />
            )}
          </div>
        ) : (
          <ScrollArea className="flex-1 p-3">
            <div className="flex flex-col gap-2.5">
              {/* 1. Artifacts & Generated Plans (planning.md surfaced first) */}
              <DrawerOverviewSection
                title="Artifacts & Plans"
                count={totalArtifactsCount}
                open={expandedArtifacts}
                onOpenChange={setExpandedArtifacts}
                trailing={
                  <Button size="xs" variant="ghost" onClick={showPlan}>
                    Open planning.md
                  </Button>
                }
              >
                {totalArtifactsCount === 0 ? (
                  <p className="px-1.5 py-2 typography-meta text-(--color-text-subtle)">
                    No generated plans or artifacts yet.
                  </p>
                ) : (
                  <List>
                    {runArtifacts.map((art) => (
                      <ListRow
                        key={art.id}
                        leading={<Icon name="plan" className="size-3.5 text-(--color-accent)" />}
                        title={art.name}
                        subtitle={art.kind}
                        onSelect={() => {
                          void handleOpenWorkflowArtifact(art)
                        }}
                      />
                    ))}
                    {sessionArtifacts.map((art) => (
                      <ListRow
                        key={art.id}
                        leading={
                          <Icon name="file" className="size-3.5 text-(--color-text-muted)" />
                        }
                        title={art.name}
                        subtitle={art.type ?? 'artifact'}
                        onSelect={() => {
                          openTab({
                            id: `artifact:${art.id}`,
                            kind: 'artifact',
                            title: art.name,
                            artifactId: art.id,
                            content: art.content,
                          })
                        }}
                      />
                    ))}
                  </List>
                )}
              </DrawerOverviewSection>

              {/* 2. Files Changed */}
              <DrawerOverviewSection
                title="Files Changed"
                count={displayedSourceFiles.length}
                open={expandedFilesChanged}
                onOpenChange={setExpandedFilesChanged}
                trailing={
                  <>
                    <IconButton
                      size="xs"
                      variant="ghost"
                      label="Refresh git status"
                      icon={<Icon name="refresh" spin={loadingGit} />}
                      onClick={() => {
                        void refreshContext()
                      }}
                    />
                    <DropdownMenu>
                      <DropdownMenuTrigger asChild>
                        <Button size="xs" variant="outline" className="gap-1">
                          <span>
                            {activeFilter === 'uncommitted'
                              ? 'Uncommitted'
                              : activeFilter === 'branch'
                                ? 'Branch'
                                : 'Agent Edits'}
                          </span>
                          <Icon name="chevron-down" className="size-3" />
                        </Button>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end" className="w-60">
                        <DropdownMenuGroup>
                          <DropdownMenuLabel>Scope Filter</DropdownMenuLabel>
                          <DropdownMenuItem
                            onClick={() => {
                              setActiveFilter('uncommitted')
                            }}
                            className="justify-between"
                          >
                            <span>Uncommitted Changes</span>
                            {activeFilter === 'uncommitted' ? (
                              <Icon name="check" className="size-3.5 text-(--color-accent)" />
                            ) : null}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              setActiveFilter('branch')
                            }}
                            className="justify-between"
                          >
                            <span>Branch ({currentBranch})</span>
                            {activeFilter === 'branch' ? (
                              <Icon name="check" className="size-3.5 text-(--color-accent)" />
                            ) : null}
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => {
                              setActiveFilter('agent_edits')
                            }}
                            className="justify-between"
                          >
                            <span>Agent Edits Only</span>
                            {activeFilter === 'agent_edits' ? (
                              <Icon name="check" className="size-3.5 text-(--color-accent)" />
                            ) : null}
                          </DropdownMenuItem>
                        </DropdownMenuGroup>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </>
                }
              >
                {displayedSourceFiles.length === 0 ? (
                  <p className="px-1.5 py-2 typography-meta text-(--color-text-subtle)">
                    Clean working tree. No modified files detected.
                  </p>
                ) : (
                  <div className="space-y-1.5">
                    <List>
                      {displayedFiles.map((file, idx) => {
                        const fullRelPath = file.fullPath ?? `${file.directory}/${file.path}`
                        return (
                          <ListRow
                            key={`${file.path}-${String(idx)}`}
                            leading={
                              <Icon
                                name="file-code"
                                className="size-3.5 text-(--color-text-muted)"
                              />
                            }
                            title={file.path}
                            subtitle={file.directory}
                            trailing={
                              <Badge tone="warning" size="sm" className="font-mono">
                                {file.status}
                              </Badge>
                            }
                            onSelect={() => {
                              openTab({
                                id: `file:${fullRelPath}`,
                                kind: 'file',
                                title: file.path,
                                subtitle: '(diff)',
                                filePath: fullRelPath,
                                directory: file.directory,
                              })
                            }}
                          />
                        )
                      })}
                    </List>

                    <div className="flex items-center justify-between px-1">
                      {displayedSourceFiles.length > 6 ? (
                        <Button
                          size="xs"
                          variant="ghost"
                          onClick={() => {
                            setShowAllFiles((prev) => !prev)
                          }}
                        >
                          {showAllFiles
                            ? 'Show less'
                            : `See all (${String(displayedSourceFiles.length)})`}
                        </Button>
                      ) : (
                        <span />
                      )}
                      <Button size="xs" variant="outline" onClick={showGit}>
                        <Icon name="git-commit" className="size-3" />
                        <span>Git Actions</span>
                      </Button>
                    </div>
                  </div>
                )}
              </DrawerOverviewSection>

              {/* 3. Subagents & Workflow Turns */}
              <DrawerOverviewSection
                title="Subagents & Stages"
                count={combinedSubagentsCount}
                open={expandedSubagents}
                onOpenChange={setExpandedSubagents}
              >
                {combinedSubagentsCount === 0 ? (
                  <p className="px-1.5 py-2 typography-meta text-(--color-text-subtle)">
                    No active subagent turns.
                  </p>
                ) : (
                  <List>
                    {activeWorkflow?.steps
                      .filter((s) => s.state !== 'pending' && s.role !== 'user')
                      .map((step) => (
                        <ListRow
                          key={step.id}
                          leading={
                            <Icon name="subagent" className="size-3.5 text-(--color-accent)" />
                          }
                          title={`Stage ${String(step.index + 1)}: ${step.role}`}
                          subtitle={step.runtimeId ?? 'system'}
                          trailing={
                            <Badge tone={step.state === 'running' ? 'accent' : 'neutral'} size="sm">
                              {step.state}
                            </Badge>
                          }
                        />
                      ))}
                    {subagents.map((sub) => (
                      <ListRow
                        key={sub.id}
                        leading={<Icon name="subagent" className="size-3.5 text-(--color-info)" />}
                        title={sub.role}
                        subtitle={sub.prompt}
                        trailing={
                          <Badge tone="neutral" size="sm">
                            {sub.status}
                          </Badge>
                        }
                      />
                    ))}
                  </List>
                )}
              </DrawerOverviewSection>

              {/* 4. Uploads, Background Tasks, Terminals */}
              <DrawerOverviewSection
                title="Uploads"
                count={uploads.length}
                open={expandedUploads}
                onOpenChange={setExpandedUploads}
              >
                {uploads.length === 0 ? (
                  <p className="px-1.5 py-1.5 typography-meta text-(--color-text-subtle)">
                    No session uploads.
                  </p>
                ) : (
                  <List>
                    {uploads.map((up) => (
                      <ListRow
                        key={up.id}
                        leading={<Icon name="file" className="size-3.5" />}
                        title={up.name}
                      />
                    ))}
                  </List>
                )}
              </DrawerOverviewSection>

              <DrawerOverviewSection
                title="Background Tasks"
                count={backgroundTasks.length}
                open={expandedBgTasks}
                onOpenChange={setExpandedBgTasks}
              >
                {backgroundTasks.length === 0 ? (
                  <p className="px-1.5 py-1.5 typography-meta text-(--color-text-subtle)">
                    No background tasks running.
                  </p>
                ) : (
                  <List>
                    {backgroundTasks.map((task) => (
                      <ListRow
                        key={task.id}
                        leading={<Icon name="clock" className="size-3.5" />}
                        title={task.command}
                        trailing={
                          <Badge tone="neutral" size="sm">
                            {task.status}
                          </Badge>
                        }
                      />
                    ))}
                  </List>
                )}
              </DrawerOverviewSection>

              <DrawerOverviewSection
                title="Terminals"
                count={terminals.length}
                open={expandedTerminals}
                onOpenChange={setExpandedTerminals}
              >
                {terminals.length === 0 ? (
                  <p className="px-1.5 py-1.5 typography-meta text-(--color-text-subtle)">
                    No active terminals.
                  </p>
                ) : (
                  <List>
                    {terminals.map((term) => (
                      <ListRow
                        key={term.id}
                        leading={<Icon name="terminal" className="size-3.5" />}
                        title={term.name}
                        trailing={
                          <Badge tone={term.active ? 'success' : 'neutral'} size="sm">
                            {term.active ? 'active' : 'idle'}
                          </Badge>
                        }
                      />
                    ))}
                  </List>
                )}
              </DrawerOverviewSection>
            </div>
          </ScrollArea>
        )}
      </div>
    </aside>
  )
}
