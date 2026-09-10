import { useCallback, useEffect, useState } from 'react'
import { NavLink, useNavigate } from 'react-router'
import { unwrap } from '../ipc'
import { Badge, IconButton, Separator, Tooltip } from '../ui'
import { cn } from '../ui'
import { CollapseIcon, ExpandIcon } from './icons'
import { useProjectStore } from './projectStore'
import { ROUTES } from './routes'
import { useUiStore } from './uiStore'

/**
 * The persistent navigation sidebar redesigned to match Claude Code desktop (Images 1 & 2).
 *
 * Includes top utility icons, Chat/Code mode switcher, pinned sessions,
 * workspace/project accordion tree, CLI import callout banner, and user profile bar.
 * Maintains full aria and routing contract for ui-check and e2e test suites.
 */
export function Sidebar(): React.JSX.Element {
  const collapsed = useUiStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const activeMode = useUiStore((state) => state.activeMode)
  const setActiveMode = useUiStore((state) => state.setActiveMode)
  const activeThreadTitle = useUiStore((state) => state.activeThreadTitle)
  const setActiveThreadTitle = useUiStore((state) => state.setActiveThreadTitle)
  const toggleSettings = useUiStore((state) => state.toggleSettings)

  const projects = useProjectStore((state) => state.projects)
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId)

  const navigate = useNavigate()
  const [unansweredCount, setUnansweredCount] = useState(0)
  const [bannerDismissed, setBannerDismissed] = useState(false)
  const [expandedProjects, setExpandedProjects] = useState<Record<string, boolean>>({
    Forge: true,
  })

  const primaryRoutes = ROUTES.filter((r) => r.path !== '/settings')
  const settingsRoute = ROUTES.find((r) => r.path === '/settings')

  const refreshCount = useCallback(() => {
    if (selectedProjectId !== null) {
      window.forge.question
        .list(selectedProjectId, true)
        .then((res) => {
          setUnansweredCount(unwrap(res).questions.length)
        })
        .catch(() => undefined)
    } else {
      Promise.all(projects.map((p) => window.forge.question.list(p.id, true).then(unwrap)))
        .then((results) => {
          let count = 0
          for (const res of results) {
            count += res.questions.length
          }
          setUnansweredCount(count)
        })
        .catch(() => undefined)
    }
  }, [projects, selectedProjectId])

  useEffect(() => {
    refreshCount()
    const unsubscribe = window.forge.onWorkflowEvent(() => {
      refreshCount()
    })
    return () => {
      unsubscribe()
    }
  }, [refreshCount])

  const toggleProjectExpand = (name: string): void => {
    setExpandedProjects((prev) => ({
      ...prev,
      [name]: !prev[name],
    }))
  }

  // Pinned threads matching Image 1
  const pinnedItems = [
    { id: 'pin-1', title: 'Artifact API authentication workflow', icon: 'branch' },
    { id: 'pin-2', title: 'Architecture overview', icon: 'dot' },
    { id: 'pin-3', title: 'Static landing page with animations', icon: 'branch' },
    { id: 'pin-4', title: 'Mobile device internet access issue', icon: 'dot' },
    { id: 'pin-5', title: 'AgentStudioClient API consolidation', icon: 'dot' },
    { id: 'pin-6', title: 'API forensics and token optimization', icon: 'dot' },
  ]

  // Forge project threads matching Image 1 & 2
  const forgeThreads = [
    { id: 't-1', title: 'Forge codebase refactor' },
    { id: 't-2', title: 'Project overview' },
    { id: 't-3', title: 'Forge Orchestrator GitHub audit' },
    { id: 't-4', title: 'agent-mem worker unreachable error' },
    { id: 't-5', title: '3. ChatGPT chat file analysis and app plan' },
    { id: 't-6', title: '2. ChatGPT chat file analysis and app plan' },
    { id: 't-7', title: '1. ChatGPT chat file application plan' },
  ]

  return (
    <nav
      aria-label="Main"
      className={cn(
        'flex shrink-0 flex-col border-r border-(--color-border) bg-(--color-surface)',
        'transition-[width] duration-(--duration-base) ease-(--ease-out)',
        collapsed ? 'w-12' : 'w-64',
      )}
    >
      {/* Top Utility Header (Image 1 & 2) */}
      {!collapsed && (
        <div className="flex items-center justify-between border-b border-(--color-border)/60 px-3 py-2 text-(--color-text-muted)">
          <div className="flex items-center gap-1">
            <IconButton
              size="sm"
              variant="ghost"
              label="Toggle sidebar panel"
              onClick={toggleSidebar}
              icon={<CollapseIcon />}
              className="size-7 rounded-md hover:text-(--color-text)"
            />
            <IconButton
              size="sm"
              variant="ghost"
              label="Documentation"
              onClick={() => {
                void navigate('/workflows')
              }}
              icon={
                <svg
                  className="size-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                  <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
                </svg>
              }
              className="size-7 rounded-md hover:text-(--color-text)"
            />
          </div>

          <div className="flex items-center gap-1">
            <IconButton
              size="sm"
              variant="ghost"
              label="Search"
              onClick={() => {
                void navigate('/ask')
              }}
              icon={
                <svg
                  className="size-4"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <circle cx="11" cy="11" r="8" />
                  <line x1="21" y1="21" x2="16.65" y2="16.65" />
                </svg>
              }
              className="size-7 rounded-md hover:text-(--color-text)"
            />
            <IconButton
              size="sm"
              variant="ghost"
              label="Back"
              onClick={() => {
                window.history.back()
              }}
              icon={
                <svg
                  className="size-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              }
              className="size-7 rounded-md hover:text-(--color-text)"
            />
            <IconButton
              size="sm"
              variant="ghost"
              label="Forward"
              onClick={() => {
                window.history.forward()
              }}
              icon={
                <svg
                  className="size-3.5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              }
              className="size-7 rounded-md hover:text-(--color-text)"
            />
          </div>
        </div>
      )}

      {/* Mode Switcher Tabs (Chat and Cowork vs Code) */}
      {!collapsed && (
        <div className="p-2 pb-1">
          <div className="flex items-center rounded-lg bg-(--color-surface-raised) p-0.5 text-[12px] font-medium border border-(--color-border)">
            <button
              type="button"
              onClick={() => {
                setActiveMode('chat')
                void navigate('/ask')
              }}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 transition-all cursor-pointer select-none',
                activeMode === 'chat'
                  ? 'bg-(--color-surface) text-(--color-text) font-semibold shadow-xs'
                  : 'text-(--color-text-muted) hover:text-(--color-text)',
              )}
            >
              <svg
                className="size-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              <span>Chat and Cowork</span>
            </button>
            <button
              type="button"
              onClick={() => {
                setActiveMode('code')
                void navigate('/workflows')
              }}
              className={cn(
                'flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 transition-all cursor-pointer select-none',
                activeMode === 'code'
                  ? 'bg-(--color-surface) text-(--color-text) font-semibold shadow-xs'
                  : 'text-(--color-text-muted) hover:text-(--color-text)',
              )}
            >
              <svg
                className="size-3.5"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <polyline points="16 18 22 12 16 6" />
                <polyline points="8 6 2 12 8 18" />
              </svg>
              <span>Code</span>
            </button>
          </div>
        </div>
      )}

      {/* Primary Routes List (strictly maintains ROUTES contract for ui-check) */}
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {primaryRoutes.map((route) => (
          <li key={route.path}>
            {collapsed ? (
              <Tooltip content={route.label} side="right">
                <NavItem
                  route={route}
                  collapsed
                  badge={
                    route.path === '/questions' && unansweredCount > 0 ? unansweredCount : null
                  }
                />
              </Tooltip>
            ) : (
              <NavItem
                route={route}
                collapsed={false}
                badge={route.path === '/questions' && unansweredCount > 0 ? unansweredCount : null}
              />
            )}
          </li>
        ))}

        {!collapsed && (
          <>
            {/* Pinned Section matching Image 1 */}
            <li className="mt-3 px-2 pt-2 border-t border-(--color-border)/40">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold tracking-wider text-(--color-text-subtle) uppercase">
                <svg
                  className="size-3 text-(--color-text-subtle)"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <line x1="12" y1="17" x2="12" y2="22" />
                  <path d="M5 17h14v-2l-2-3V5a2 2 0 0 0-2-2h-6a2 2 0 0 0-2 2v7l-2 3v2z" />
                </svg>
                <span>Pinned</span>
              </div>
              <ul className="mt-1.5 flex flex-col gap-0.5">
                {pinnedItems.map((pin) => (
                  <li key={pin.id}>
                    <button
                      type="button"
                      onClick={() => {
                        setActiveThreadTitle(pin.title)
                        void navigate('/ask')
                      }}
                      className={cn(
                        'flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12px] transition-colors',
                        activeThreadTitle === pin.title
                          ? 'bg-(--color-surface-raised) text-(--color-text) font-medium'
                          : 'text-(--color-text-muted) hover:bg-(--color-surface-raised)/60 hover:text-(--color-text)',
                      )}
                    >
                      {pin.icon === 'branch' ? (
                        <svg
                          className="size-3.5 text-(--color-success) shrink-0"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <line x1="6" y1="3" x2="6" y2="15" />
                          <circle cx="18" cy="6" r="3" />
                          <circle cx="6" cy="18" r="3" />
                          <path d="M18 9a9 9 0 0 1-9 9" />
                        </svg>
                      ) : (
                        <span className="size-2 rounded-full border border-(--color-text-subtle) shrink-0 ml-0.5" />
                      )}
                      <span className="truncate">{pin.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </li>

            {/* Workspaces / Projects Tree matching Image 1 & 2 */}
            <li className="mt-3 px-2 pt-2 border-t border-(--color-border)/40">
              <div className="flex items-center justify-between text-[11px] font-semibold tracking-wider text-(--color-text-subtle) uppercase">
                <span>Projects</span>
              </div>

              {/* Forge project node */}
              <div className="mt-2 flex flex-col gap-0.5">
                <div className="flex items-center justify-between rounded-md px-1.5 py-1 text-[12px] font-semibold text-(--color-text)">
                  <button
                    type="button"
                    onClick={() => {
                      toggleProjectExpand('Forge')
                    }}
                    className="flex items-center gap-1.5 cursor-pointer text-left"
                  >
                    <svg
                      className={cn(
                        'size-3 text-(--color-text-muted) transition-transform',
                        expandedProjects.Forge ? 'rotate-90' : '',
                      )}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    <span>Forge</span>
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setActiveThreadTitle('New conversation')
                      void navigate('/ask')
                    }}
                    title="New conversation in Forge"
                    className="text-(--color-text-muted) hover:text-(--color-text) cursor-pointer"
                  >
                    +
                  </button>
                </div>

                {expandedProjects.Forge && (
                  <ul className="ml-3.5 flex flex-col gap-0.5 border-l border-(--color-border) pl-2">
                    {forgeThreads.map((thread) => {
                      const isActive = activeThreadTitle === thread.title
                      return (
                        <li key={thread.id}>
                          <button
                            type="button"
                            onClick={() => {
                              setActiveThreadTitle(thread.title)
                              void navigate('/ask')
                            }}
                            className={cn(
                              'flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] transition-colors',
                              isActive
                                ? 'bg-(--color-surface-raised) text-(--color-text) font-semibold shadow-xs'
                                : 'text-(--color-text-muted) hover:bg-(--color-surface-raised)/50 hover:text-(--color-text)',
                            )}
                          >
                            <span
                              className={cn(
                                'size-1.5 rounded-full shrink-0',
                                isActive ? 'bg-(--color-accent)' : 'bg-(--color-text-subtle)',
                              )}
                            />
                            <span className="truncate">{thread.title}</span>
                          </button>
                        </li>
                      )
                    })}
                  </ul>
                )}
              </div>

              {/* Other projects: ClinicPilot, BranchLift */}
              {['ClinicPilot', 'BranchLift', 'Dr-paid-homecare'].map((pName) => (
                <div
                  key={pName}
                  className="mt-1 flex items-center justify-between rounded-md px-1.5 py-1 text-[12px] text-(--color-text-muted) hover:text-(--color-text)"
                >
                  <button
                    type="button"
                    onClick={() => {
                      toggleProjectExpand(pName)
                    }}
                    className="flex items-center gap-1.5 cursor-pointer text-left"
                  >
                    <svg
                      className={cn(
                        'size-3 transition-transform',
                        expandedProjects[pName] ? 'rotate-90' : '',
                      )}
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <polyline points="9 18 15 12 9 6" />
                    </svg>
                    <span>{pName}</span>
                  </button>
                  <span className="text-xs text-(--color-text-subtle)">+</span>
                </div>
              ))}
            </li>
          </>
        )}
      </ul>

      {/* CLI Session Import Callout Banner (Image 1 & 2) */}
      {!collapsed && !bannerDismissed && (
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
                void navigate('/ask')
              }}
              className="font-medium text-(--color-accent) hover:underline cursor-pointer"
            >
              Import
            </button>
          </div>
        </div>
      )}

      {/* Settings Navigation Item */}
      {settingsRoute && (
        <div className="flex flex-col gap-1 p-2 pt-0">
          <Separator className="my-1" />
          {collapsed ? (
            <Tooltip content={settingsRoute.label} side="right">
              <NavItem route={settingsRoute} collapsed />
            </Tooltip>
          ) : (
            <NavItem route={settingsRoute} collapsed={false} />
          )}
        </div>
      )}

      {/* Bottom User Profile Bar (Image 1 & 2) */}
      {!collapsed && (
        <div className="border-t border-(--color-border) p-2">
          <button
            type="button"
            onClick={toggleSettings}
            className="flex w-full items-center justify-between rounded-lg p-1.5 text-left hover:bg-(--color-surface-raised) transition-colors cursor-pointer"
          >
            <div className="flex items-center gap-2 overflow-hidden">
              <div className="flex size-7 items-center justify-center rounded-full bg-(--color-accent) text-[11px] font-bold text-white shrink-0">
                MS
              </div>
              <div className="flex flex-col overflow-hidden">
                <span className="truncate text-[12px] font-semibold text-(--color-text)">
                  MD SAIF
                </span>
                <span className="truncate text-[10px] text-(--color-text-subtle)">
                  Vegam Smart Factory Solutions
                </span>
              </div>
            </div>
            <svg
              className="size-4 text-(--color-text-muted) shrink-0"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        </div>
      )}

      {/* Collapse/Expand Toggle at bottom */}
      <Separator />
      <div className={cn('flex p-2', collapsed ? 'justify-center' : 'justify-end')}>
        <IconButton
          size="sm"
          label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggleSidebar}
          icon={collapsed ? <ExpandIcon /> : <CollapseIcon />}
          className="rounded-lg text-(--color-text-muted) hover:text-(--color-text)"
        />
      </div>
    </nav>
  )
}

function NavItem({
  route,
  collapsed,
  badge = null,
}: {
  readonly route: (typeof ROUTES)[number]
  readonly collapsed: boolean
  readonly badge?: number | null | undefined
}): React.JSX.Element {
  return (
    <NavLink
      to={route.path}
      end={route.path === '/'}
      aria-label={collapsed ? route.label : undefined}
      className={({ isActive }: { readonly isActive: boolean }) =>
        cn(
          'relative flex items-center rounded-lg font-medium select-none',
          'text-[13px] no-underline',
          'transition-all duration-(--duration-fast) ease-(--ease-out)',
          'outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus)',
          '[&>svg]:size-4 [&>svg]:shrink-0',
          collapsed ? 'size-8 justify-center mx-auto' : 'gap-2.5 px-2.5 py-1.5 w-full',
          isActive
            ? 'bg-(--color-surface-raised) text-(--color-text) font-semibold shadow-xs border border-(--color-border)'
            : 'text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text)',
        )
      }
    >
      {route.icon}
      {collapsed ? null : <span className="truncate">{route.label}</span>}
      {badge !== null && badge > 0 ? (
        <Badge
          tone="warning"
          size="sm"
          className={cn(
            'ml-auto shrink-0 animate-pulse font-bold rounded-full text-[10px]',
            collapsed && 'absolute right-1 top-1 size-2 rounded-full p-0 text-[0px]',
          )}
        >
          {badge}
        </Badge>
      ) : null}
    </NavLink>
  )
}
