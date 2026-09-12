import React, { useEffect, useState } from 'react'
import { cn } from '../ui'
import {
  useOverviewStore,
  type OverviewFileChange,
  type WorkspaceTab,
} from './overviewStore'
import { useProjectStore } from './projectStore'
import { unwrap } from '../ipc'
import { FileTabViewer } from './FileTabViewer'
import { ArtifactTabViewer } from './ArtifactTabViewer'
import { TerminalTabViewer } from './TerminalTabViewer'
import {
  BookIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  CloseIcon,
  CodeFileIcon,
  DocumentIcon,
  MaximizeSquareIcon,
  MediaIcon,
  OverviewPanelIcon,
  PanelRightIcon,
  PlusIcon,
  RefreshIcon,
  RestoreSquareIcon,
  ReviewIcon,
  TerminalIcon,
  TerminalSquareIcon,
} from './icons'

export function RightOverviewPanel(): React.JSX.Element {
  const isOpen = useOverviewStore((state) => state.isOpen)
  const toggleOpen = useOverviewStore((state) => state.toggleOpen)
  const isExpanded = useOverviewStore((state) => state.isExpanded)
  const toggleExpanded = useOverviewStore((state) => state.toggleExpanded)
  const panelWidth = useOverviewStore((state) => state.panelWidth)
  const isDraggingSplitter = useOverviewStore((state) => state.isDraggingSplitter)

  const panelMode = useOverviewStore((state) => state.panelMode)
  const showOverview = useOverviewStore((state) => state.showOverview)
  const tabs = useOverviewStore((state) => state.tabs)
  const activeTabId = useOverviewStore((state) => state.activeTabId)
  const openTab = useOverviewStore((state) => state.openTab)
  const closeTab = useOverviewStore((state) => state.closeTab)
  const setActiveTab = useOverviewStore((state) => state.setActiveTab)

  const activeFilter = useOverviewStore((state) => state.activeFilter)
  const setActiveFilter = useOverviewStore((state) => state.setActiveFilter)
  const isFilterDropdownOpen = useOverviewStore((state) => state.isFilterDropdownOpen)
  const setFilterDropdownOpen = useOverviewStore((state) => state.setFilterDropdownOpen)

  const subagents = useOverviewStore((state) => state.subagents)
  const artifacts = useOverviewStore((state) => state.artifacts)
  const uploads = useOverviewStore((state) => state.uploads)
  const backgroundTasks = useOverviewStore((state) => state.backgroundTasks)
  const terminals = useOverviewStore((state) => state.terminals)
  const filesChanged = useOverviewStore((state) => state.filesChanged)
  const setFilesChanged = useOverviewStore((state) => state.setFilesChanged)
  const agentEditedFiles = useOverviewStore((state) => state.agentEditedFiles)

  const detail = useProjectStore((state) => state.detail)

  // Expandable section states (matching Antigravity Images 2, 3, 5)
  const [expandedSubagents, setExpandedSubagents] = useState(false)
  const [expandedFilesChanged, setExpandedFilesChanged] = useState(true)
  const [expandedArtifacts, setExpandedArtifacts] = useState(false)
  const [expandedUploads, setExpandedUploads] = useState(false)
  const [expandedBgTasks, setExpandedBgTasks] = useState(false)
  const [expandedTerminals, setExpandedTerminals] = useState(false)

  const [showAllFiles, setShowAllFiles] = useState(false)
  const [showAllArtifacts, setShowAllArtifacts] = useState(false)
  const [showAllUploads, setShowAllUploads] = useState(false)
  const [loadingGit, setLoadingGit] = useState(false)

  // Live git probe for working tree changes
  const refreshGitStatus = async () => {
    const repoPath = detail?.project.repository.absolutePath
    if (!repoPath) return

    setLoadingGit(true)
    try {
      const probe = await window.forge.project.probeRepository(repoPath).then(unwrap)
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
    } catch {
      // ignore
    } finally {
      setLoadingGit(false)
    }
  }

  useEffect(() => {
    let cancelled = false
    const repoPath = detail?.project.repository.absolutePath
    if (!repoPath) return

    window.forge.project
      .probeRepository(repoPath)
      .then((res) => {
        if (cancelled) return
        const probe = unwrap(res)
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
      })
      .catch(() => {
        // ignore
      })

    return () => {
      cancelled = true
    }
  }, [detail?.project.repository.absolutePath, setFilesChanged])

  const panelStyle = React.useMemo<React.CSSProperties>(() => {
    if (!isOpen) {
      return { width: 0 }
    }
    if (isExpanded) {
      return { width: '100%' }
    }
    return { width: `${String(panelWidth)}px` }
  }, [isOpen, isExpanded, panelWidth])

  const activeTab = tabs.find((t) => t.id === activeTabId) ?? null

  // Filter files changed based on active filter
  const displayedSourceFiles =
    activeFilter === 'agent_edits'
      ? filesChanged.filter((f) => agentEditedFiles.includes(f.fullPath ?? f.path))
      : filesChanged

  const displayedFiles = showAllFiles ? displayedSourceFiles : displayedSourceFiles.slice(0, 5)
  const displayedArtifacts = showAllArtifacts ? artifacts : artifacts.slice(0, 5)
  const displayedUploads = showAllUploads ? uploads : uploads.slice(0, 5)

  const currentBranch = detail?.project.repository.defaultBranch ?? 'main'

  const renderFileIcon = (fileName: string): React.JSX.Element => {
    const lower = fileName.toLowerCase()
    if (lower.endsWith('.md') || lower.endsWith('.txt') || lower.endsWith('.doc')) {
      return <DocumentIcon className="size-3.5 text-(--color-text-muted) shrink-0" />
    }
    return <CodeFileIcon className="size-3.5 text-(--color-text-muted) shrink-0" />
  }

  const renderTabIcon = (tab: WorkspaceTab): React.JSX.Element => {
    if (tab.kind === 'terminal') {
      return <TerminalIcon className="size-3.5 shrink-0 text-emerald-400" />
    }
    if (tab.kind === 'artifact') {
      const lower = tab.title.toLowerCase()
      if (lower.includes('walkthrough')) {
        return <BookIcon className="size-3.5 shrink-0 text-(--color-text-muted)" />
      }
      return <DocumentIcon className="size-3.5 shrink-0 text-(--color-text-muted)" />
    }

    const name = tab.title.toLowerCase()
    if (name.endsWith('.ts') || name.endsWith('.tsx')) {
      return (
        <span className="text-[10px] font-bold text-sky-400 font-mono shrink-0 select-none">
          TS
        </span>
      )
    }
    if (name.endsWith('.js') || name.endsWith('.jsx')) {
      return (
        <span className="text-[10px] font-bold text-yellow-400 font-mono shrink-0 select-none">
          JS
        </span>
      )
    }
    if (name.endsWith('.rs') || name === 'cargo.toml' || name === 'cargo.lock') {
      return (
        <span className="text-[10px] font-bold text-amber-500 font-mono shrink-0 select-none">
          RS
        </span>
      )
    }
    if (name.endsWith('.py')) {
      return (
        <span className="text-[10px] font-bold text-blue-400 font-mono shrink-0 select-none">
          PY
        </span>
      )
    }
    if (name.endsWith('.json')) {
      return (
        <span className="text-[10px] font-bold text-amber-400 font-mono shrink-0 select-none">
          JSON
        </span>
      )
    }
    if (name.endsWith('.md') || name.endsWith('.txt')) {
      return <DocumentIcon className="size-3.5 shrink-0 text-(--color-text-muted)" />
    }
    return <CodeFileIcon className="size-3.5 text-(--color-text-muted)" />
  }

  return (
    <aside
      aria-label="Inspection and Overview Panel"
      style={panelStyle}
      className={cn(
        'relative flex flex-col bg-(--color-surface) text-(--color-text) overflow-hidden select-none z-10',
        !isOpen && 'w-0 opacity-0 pointer-events-none border-l-0 shrink-0',
        isOpen && !isExpanded && 'shrink-0 border-l border-(--color-border) opacity-100',
        isOpen && isExpanded && 'flex-1 border-l-0 opacity-100',
        isDraggingSplitter
          ? 'transition-none'
          : 'transition-[width,opacity] duration-300 ease-in-out',
      )}
    >
      <div className="flex flex-col h-full w-full min-w-[320px]">
      {/* ── Top Header Bar with Tabs (Strictly matching Antigravity Image 3) ── */}
      <div className="flex h-9 shrink-0 items-center justify-between border-b border-(--color-border)/70 bg-(--color-surface) px-2 select-none text-[12px]">
        {/* Left Quick-Switch Icons & Opened Tabs */}
        <div className="flex h-full items-center gap-1 overflow-x-auto no-scrollbar min-w-0 pr-2">
          {/* Quick Icon Group (Overview, Review, Terminal) */}
          <div className="flex items-center gap-0.5 shrink-0">
            {/* Icon 1: Overview */}
            <button
              type="button"
              title="Overview"
              aria-label="Overview"
              onClick={() => {
                showOverview()
              }}
              className={cn(
                'flex size-6 items-center justify-center rounded transition-colors cursor-pointer',
                panelMode === 'overview'
                  ? 'text-(--color-text) bg-(--color-surface-raised)/80'
                  : 'text-(--color-text-subtle) hover:text-(--color-text) hover:bg-(--color-surface-raised)/50',
              )}
            >
              <OverviewPanelIcon className="size-3.5" />
            </button>

            {/* Icon 2: Review */}
            <button
              type="button"
              title="Review"
              aria-label="Review"
              onClick={() => {
                const existingFileTab = tabs.find((t) => t.kind === 'file')
                if (existingFileTab) {
                  setActiveTab(existingFileTab.id)
                  return
                }
                const firstDirty = filesChanged[0]
                if (firstDirty) {
                  openTab({
                    id: `file:${firstDirty.fullPath ?? firstDirty.path}`,
                    kind: 'file',
                    title: firstDirty.path,
                    subtitle: '(review)',
                    filePath: firstDirty.fullPath ?? firstDirty.path,
                    directory: firstDirty.directory,
                  })
                } else {
                  showOverview()
                  setExpandedFilesChanged(true)
                }
              }}
              className={cn(
                'flex size-6 items-center justify-center rounded transition-colors cursor-pointer',
                panelMode === 'tab' && activeTab?.kind === 'file'
                  ? 'text-(--color-text) bg-(--color-surface-raised)/80'
                  : 'text-(--color-text-subtle) hover:text-(--color-text) hover:bg-(--color-surface-raised)/50',
              )}
            >
              <ReviewIcon className="size-3.5" />
            </button>

            {/* Icon 3: Terminal */}
            <button
              type="button"
              title="Terminal"
              aria-label="Terminal"
              onClick={() => {
                const existingTerm = tabs.find((t) => t.id === 'tab:terminal')
                if (existingTerm) {
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
              className={cn(
                'flex size-6 items-center justify-center rounded transition-colors cursor-pointer',
                panelMode === 'tab' && activeTab?.kind === 'terminal'
                  ? 'text-(--color-text) bg-(--color-surface-raised)/80'
                  : 'text-(--color-text-subtle) hover:text-(--color-text) hover:bg-(--color-surface-raised)/50',
              )}
            >
              <TerminalIcon className="size-3.5" />
            </button>
          </div>

          {/* Hairline Divider between Quick Icons and Tabs */}
          <div className="h-3.5 w-px bg-(--color-border)/70 mx-1 shrink-0" />

          {/* Dynamic Tabs Opened in Right Panel */}
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
                  'group flex h-6.5 items-center gap-1.5 rounded-md px-2 transition-all cursor-pointer shrink-0 max-w-[280px]',
                  isTabActive
                    ? 'bg-(--color-surface-raised) text-(--color-text) font-medium shadow-xs'
                    : 'bg-transparent text-(--color-text-muted) hover:text-(--color-text) hover:bg-(--color-surface-raised)/40',
                )}
              >
                {renderTabIcon(tab)}
                <span className="truncate text-[12px]">{tab.title}</span>
                {tab.subtitle && (
                  <span className="text-[10px] text-(--color-text-subtle) font-normal shrink-0 italic">
                    {tab.subtitle}
                  </span>
                )}
                <button
                  type="button"
                  title="Close tab"
                  onClick={(e) => {
                    e.stopPropagation()
                    closeTab(tab.id)
                  }}
                  className="opacity-0 group-hover:opacity-100 flex size-4 items-center justify-center rounded hover:bg-(--color-surface-inset) text-(--color-text-subtle) hover:text-(--color-text) transition-opacity ml-0.5 cursor-pointer"
                >
                  <CloseIcon className="size-2.5" />
                </button>
              </div>
            )
          })}

          {/* Plus Button: Return to Overview */}
          <button
            type="button"
            title="Overview"
            onClick={() => {
              showOverview()
            }}
            className="flex size-6 items-center justify-center rounded hover:bg-(--color-surface-raised) text-(--color-text-subtle) hover:text-(--color-text) transition-colors cursor-pointer shrink-0 ml-0.5"
          >
            <PlusIcon className="size-3.5" />
          </button>
        </div>

        {/* Right Window Controls (Matching Antigravity Image 3) */}
        <div className="flex items-center gap-1 shrink-0 pl-1.5">
          {/* Maximize / Expand Toggle */}
          <button
            type="button"
            title={isExpanded ? 'Restore panel size' : 'Expand panel size'}
            onClick={() => {
              toggleExpanded()
            }}
            className="flex size-6 items-center justify-center rounded hover:bg-(--color-surface-raised) text-(--color-text-subtle) hover:text-(--color-text) cursor-pointer"
          >
            {isExpanded ? (
              <RestoreSquareIcon className="size-3.5" />
            ) : (
              <MaximizeSquareIcon className="size-3.5" />
            )}
          </button>

          {/* Collapse Right Panel Button (Image 3 style) */}
          <button
            type="button"
            title="Collapse right panel"
            aria-label="Collapse right panel"
            onClick={toggleOpen}
            className="flex size-6 items-center justify-center rounded hover:bg-(--color-surface-raised) text-(--color-text-subtle) hover:text-(--color-text) cursor-pointer"
          >
            <PanelRightIcon className="size-3.5" />
          </button>
        </div>
      </div>

      {/* ── Main Right Panel Body: Tab View OR Overview View ── */}
      {panelMode === 'tab' && activeTab !== null ? (
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
        /* ── Dynamic Session Overview (Images 2 & 5) ── */
        <div className="flex-1 overflow-y-auto px-4 py-3 space-y-3.5 text-[12px]">
          {/* ── 1. SUBAGENTS SECTION (Dynamic: 0 by default) ── */}
          <div>
            <button
              type="button"
              onClick={() => {
                setExpandedSubagents((prev) => !prev)
              }}
              className="flex w-full items-center justify-between py-1 text-left hover:text-(--color-text) cursor-pointer group"
            >
              <div className="flex items-center gap-2">
                <span className="text-(--color-text-muted) group-hover:text-(--color-text) transition-colors font-medium">
                  Subagents
                </span>
                <span className="text-[11px] text-(--color-text-subtle)">{subagents.length}</span>
              </div>
              <ChevronRightIcon
                className={cn(
                  'size-3 text-(--color-text-subtle) transition-transform',
                  expandedSubagents && 'rotate-90',
                )}
              />
            </button>

            {expandedSubagents && (
              <div className="mt-1 pl-2 space-y-1.5 border-l border-(--color-border)/50">
                {subagents.length === 0 ? (
                  <div className="text-[11px] text-(--color-text-subtle) italic py-1">
                    No subagents active in this session.
                  </div>
                ) : (
                  subagents.map((sub) => (
                    <div
                      key={sub.id}
                      className="p-1.5 rounded hover:bg-(--color-surface-raised) text-[11px]"
                    >
                      <div className="flex items-center justify-between font-medium">
                        <span>{sub.role}</span>
                        <span className="text-[9.5px] uppercase font-bold text-amber-400">
                          {sub.status}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* ── 2. FILES CHANGED SECTION (Images 2 & 3) ── */}
          <div className="relative">
            <div className="flex items-center justify-between py-1">
              <button
                type="button"
                onClick={() => {
                  setExpandedFilesChanged((prev) => !prev)
                }}
                className="flex items-center gap-2 text-left hover:text-(--color-text) cursor-pointer group"
              >
                <span className="text-(--color-text-muted) group-hover:text-(--color-text) transition-colors font-medium">
                  Files Changed
                </span>
                <span className="text-[11px] text-(--color-text-subtle)">
                  {displayedSourceFiles.length}
                </span>
                <ChevronRightIcon
                  className={cn(
                    'size-3 text-(--color-text-subtle) transition-transform',
                    expandedFilesChanged && 'rotate-90',
                  )}
                />
              </button>

              <div className="flex items-center gap-1.5">
                <button
                  type="button"
                  title="Refresh git status"
                  onClick={() => {
                    void refreshGitStatus()
                  }}
                  className="flex size-5 items-center justify-center rounded text-(--color-text-subtle) hover:text-(--color-text) hover:bg-(--color-surface-raised) transition-colors cursor-pointer"
                >
                  <RefreshIcon className={cn('size-3', loadingGit && 'animate-spin')} />
                </button>

                {/* Filter Dropdown Pill Button (Matching Antigravity Image 2) */}
                <div className="relative">
                <button
                  type="button"
                  onClick={() => {
                    setFilterDropdownOpen(!isFilterDropdownOpen)
                  }}
                  className="flex items-center gap-1 rounded border border-(--color-border) bg-(--color-surface-raised)/80 px-2 py-0.5 text-[11px] font-medium text-(--color-text) hover:bg-(--color-surface-raised) cursor-pointer shadow-2xs"
                >
                  <span>
                    {activeFilter === 'uncommitted'
                      ? 'Uncommitted'
                      : activeFilter === 'branch'
                        ? 'Branch'
                        : 'Agent Edits'}
                  </span>
                  <ChevronDownIcon className="size-2.5 text-(--color-text-subtle)" />
                </button>

                {/* Dropdown Menu (Image 2) */}
                {isFilterDropdownOpen && (
                  <div className="absolute right-0 top-full mt-1.5 w-64 rounded-lg border border-(--color-border) bg-(--color-surface) p-1.5 shadow-xl z-50 text-[11.5px] space-y-1">
                    {/* Option 1: Uncommitted */}
                    <button
                      type="button"
                      onClick={() => {
                        setActiveFilter('uncommitted')
                      }}
                      className="flex w-full items-start justify-between rounded p-2 text-left hover:bg-(--color-surface-raised) transition-colors cursor-pointer"
                    >
                      <div>
                        <div className="font-semibold text-(--color-text)">Uncommitted</div>
                        <div className="text-[10.5px] text-(--color-text-subtle) leading-snug">
                          Staged index changes and working tree changes
                        </div>
                      </div>
                      {activeFilter === 'uncommitted' && (
                        <CheckIcon className="size-3.5 text-(--color-accent) shrink-0 pl-1" />
                      )}
                    </button>

                    {/* Option 2: Branch */}
                    <button
                      type="button"
                      onClick={() => {
                        setActiveFilter('branch')
                      }}
                      className="flex w-full items-start justify-between rounded p-2 text-left hover:bg-(--color-surface-raised) transition-colors cursor-pointer"
                    >
                      <div>
                        <div className="flex items-center gap-1 font-semibold text-(--color-text)">
                          <span>Branch</span>
                          <span className="font-mono text-[10px] text-(--color-text-muted)">
                            {currentBranch}
                          </span>
                        </div>
                        <div className="text-[10.5px] text-(--color-text-subtle) leading-snug">
                          All changes since origin/main
                        </div>
                      </div>
                      {activeFilter === 'branch' && (
                        <CheckIcon className="size-3.5 text-(--color-accent) shrink-0 pl-1" />
                      )}
                    </button>

                    {/* Option 3: Agent Edits */}
                    <button
                      type="button"
                      onClick={() => {
                        setActiveFilter('agent_edits')
                      }}
                      className="flex w-full items-start justify-between rounded p-2 text-left hover:bg-(--color-surface-raised) transition-colors cursor-pointer"
                    >
                      <div>
                        <div className="font-semibold text-(--color-text)">Agent Edits</div>
                        <div className="text-[10.5px] text-(--color-text-subtle) leading-snug">
                          Files modified by the agent in this conversation
                        </div>
                      </div>
                      {activeFilter === 'agent_edits' && (
                        <CheckIcon className="size-3.5 text-(--color-accent) shrink-0 pl-1" />
                      )}
                    </button>
                  </div>
                )}
              </div>
              </div>
            </div>

            {/* Files List (Image 3) */}
            {expandedFilesChanged && (
              <div className="mt-1 space-y-0.5">
                {displayedSourceFiles.length === 0 ? (
                  <div className="py-2 text-[11px] text-(--color-text-subtle) italic">
                    Clean working tree · No changes detected
                  </div>
                ) : (
                  <>
                    {displayedFiles.map((file, idx) => {
                      const fullRelPath = file.fullPath ?? `${file.directory}/${file.path}`
                      return (
                        <button
                          key={`${file.path}-${String(idx)}`}
                          type="button"
                          onClick={() => {
                            openTab({
                              id: `file:${fullRelPath}`,
                              kind: 'file',
                              title: file.path,
                              subtitle: '(uncommitted)',
                              filePath: fullRelPath,
                              directory: file.directory,
                            })
                          }}
                          className="flex w-full items-center justify-between rounded px-1.5 py-1.5 text-left hover:bg-(--color-surface-raised) transition-colors cursor-pointer group"
                        >
                          <div className="flex items-center gap-2 min-w-0">
                            {renderFileIcon(file.path)}
                            <span className="truncate text-[12px] font-medium text-(--color-text) group-hover:text-(--color-accent)">
                              {file.path}
                            </span>
                          </div>
                          <span className="truncate pl-2 text-[10.5px] text-(--color-text-subtle) font-mono max-w-[120px] text-right">
                            {file.directory}
                          </span>
                        </button>
                      )
                    })}

                    {displayedSourceFiles.length > 5 && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowAllFiles((prev) => !prev)
                        }}
                        className="pt-1 text-[11px] text-(--color-text-subtle) hover:text-(--color-text) cursor-pointer"
                      >
                        {showAllFiles
                          ? 'Show less'
                          : `See all (${String(displayedSourceFiles.length)})`}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* ── 3. ARTIFACTS SECTION (Dynamic: 0 by default) ── */}
          <div>
            <button
              type="button"
              onClick={() => {
                setExpandedArtifacts((prev) => !prev)
              }}
              className="flex w-full items-center justify-between py-1 text-left hover:text-(--color-text) cursor-pointer group"
            >
              <div className="flex items-center gap-2">
                <span className="text-(--color-text-muted) group-hover:text-(--color-text) transition-colors font-medium">
                  Artifacts
                </span>
                <span className="text-[11px] text-(--color-text-subtle)">{artifacts.length}</span>
              </div>
              <ChevronRightIcon
                className={cn(
                  'size-3 text-(--color-text-subtle) transition-transform',
                  expandedArtifacts && 'rotate-90',
                )}
              />
            </button>

            {/* Artifacts List */}
            {expandedArtifacts && (
              <div className="mt-1 space-y-0.5">
                {artifacts.length === 0 ? (
                  <div className="py-2 text-[11px] text-(--color-text-subtle) italic">
                    No artifacts generated in this conversation yet.
                  </div>
                ) : (
                  <>
                    {displayedArtifacts.map((art) => (
                      <button
                        key={art.id}
                        type="button"
                        onClick={() => {
                          openTab({
                            id: `artifact:${art.id}`,
                            kind: 'artifact',
                            title: art.name,
                            artifactId: art.id,
                            content: art.content,
                          })
                        }}
                        className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-left hover:bg-(--color-surface-raised) transition-colors cursor-pointer group"
                      >
                        <DocumentIcon className="size-3.5 text-(--color-text-muted) group-hover:text-(--color-accent) shrink-0" />
                        <span className="truncate text-[12px] text-(--color-text) group-hover:text-(--color-accent)">
                          {art.name}
                        </span>
                      </button>
                    ))}

                    {artifacts.length > 5 && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowAllArtifacts((prev) => !prev)
                        }}
                        className="pt-1 text-[11px] text-(--color-text-subtle) hover:text-(--color-text) cursor-pointer"
                      >
                        {showAllArtifacts ? 'Show less' : `See all (${String(artifacts.length)})`}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* ── 4. UPLOADS SECTION (Dynamic: 0 by default) ── */}
          <div>
            <button
              type="button"
              onClick={() => {
                setExpandedUploads((prev) => !prev)
              }}
              className="flex w-full items-center justify-between py-1 text-left hover:text-(--color-text) cursor-pointer group"
            >
              <div className="flex items-center gap-2">
                <span className="text-(--color-text-muted) group-hover:text-(--color-text) transition-colors font-medium">
                  Uploads
                </span>
                <span className="text-[11px] text-(--color-text-subtle)">{uploads.length}</span>
              </div>
              <ChevronRightIcon
                className={cn(
                  'size-3 text-(--color-text-subtle) transition-transform',
                  expandedUploads && 'rotate-90',
                )}
              />
            </button>

            {/* Uploads List */}
            {expandedUploads && (
              <div className="mt-1 space-y-0.5">
                {uploads.length === 0 ? (
                  <div className="py-2 text-[11px] text-(--color-text-subtle) italic">
                    No media or files uploaded in this conversation.
                  </div>
                ) : (
                  <>
                    {displayedUploads.map((up) => (
                      <div
                        key={up.id}
                        className="flex w-full items-center gap-2 rounded px-1.5 py-1.5 text-[12px] text-(--color-text) hover:bg-(--color-surface-raised) transition-colors"
                      >
                        <MediaIcon className="size-3.5 text-(--color-text-muted) shrink-0" />
                        <span className="truncate">{up.name}</span>
                      </div>
                    ))}

                    {uploads.length > 5 && (
                      <button
                        type="button"
                        onClick={() => {
                          setShowAllUploads((prev) => !prev)
                        }}
                        className="pt-1 text-[11px] text-(--color-text-subtle) hover:text-(--color-text) cursor-pointer"
                      >
                        {showAllUploads ? 'Show less' : `See all (${String(uploads.length)})`}
                      </button>
                    )}
                  </>
                )}
              </div>
            )}
          </div>

          {/* ── 5. BACKGROUND TASKS SECTION (Dynamic: 0 by default) ── */}
          <div>
            <button
              type="button"
              onClick={() => {
                setExpandedBgTasks((prev) => !prev)
              }}
              className="flex w-full items-center justify-between py-1 text-left hover:text-(--color-text) cursor-pointer group"
            >
              <div className="flex items-center gap-2">
                <span className="text-(--color-text-muted) group-hover:text-(--color-text) transition-colors font-medium">
                  Background Tasks
                </span>
                <span className="text-[11px] text-(--color-text-subtle)">
                  {backgroundTasks.length}
                </span>
              </div>
              <ChevronRightIcon
                className={cn(
                  'size-3 text-(--color-text-subtle) transition-transform',
                  expandedBgTasks && 'rotate-90',
                )}
              />
            </button>

            {expandedBgTasks && (
              <div className="mt-1 pl-2 space-y-1 text-[11px] text-(--color-text-subtle) italic">
                {backgroundTasks.length === 0 ? (
                  <div>No background tasks running.</div>
                ) : (
                  backgroundTasks.map((t) => (
                    <div key={t.id} className="font-mono text-(--color-text)">
                      {t.command}
                    </div>
                  ))
                )}
              </div>
            )}
          </div>

          {/* ── 6. TERMINALS SECTION (Dynamic: 0 by default) ── */}
          <div>
            <button
              type="button"
              onClick={() => {
                setExpandedTerminals((prev) => !prev)
              }}
              className="flex w-full items-center justify-between py-1 text-left hover:text-(--color-text) cursor-pointer group"
            >
              <div className="flex items-center gap-2">
                <span className="text-(--color-text-muted) group-hover:text-(--color-text) transition-colors font-medium">
                  Terminals
                </span>
                <span className="text-[11px] text-(--color-text-subtle)">{terminals.length}</span>
              </div>
              <ChevronRightIcon
                className={cn(
                  'size-3 text-(--color-text-subtle) transition-transform',
                  expandedTerminals && 'rotate-90',
                )}
              />
            </button>

            {expandedTerminals && (
              <div className="mt-1 pl-2 space-y-1 text-[11px]">
                {terminals.length === 0 ? (
                  <div className="text-(--color-text-subtle) italic">No active terminals.</div>
                ) : (
                  terminals.map((t) => (
                    <div key={t.id} className="flex items-center gap-1.5 text-(--color-text)">
                      <TerminalSquareIcon className="size-3.5 text-(--color-text-muted) shrink-0" />
                      <span>{t.name}</span>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        </div>
      )}
      </div>
    </aside>
  )
}
