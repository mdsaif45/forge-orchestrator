import { useCallback, useEffect, useState } from 'react'
import { NavLink } from 'react-router'
import { unwrap } from '../ipc'
import { Badge, IconButton, Separator, Tooltip } from '../ui'
import { cn } from '../ui'
import { CollapseIcon, ExpandIcon } from './icons'
import { useProjectStore } from './projectStore'
import { ROUTES } from './routes'
import { useUiStore } from './uiStore'

/**
 * The persistent navigation sidebar.
 *
 * Designed with Claude Code Desktop aesthetic: refined rounded-lg item pills,
 * clear font hierarchy, smooth hover transitions, and accessible tooltips.
 */
export function Sidebar(): React.JSX.Element {
  const collapsed = useUiStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const projects = useProjectStore((state) => state.projects)
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId)
  const [unansweredCount, setUnansweredCount] = useState(0)

  const primaryRoutes = ROUTES.filter((r) => r.path !== '/settings')
  const settingsRoute = ROUTES.find((r) => r.path === '/settings')

  const refreshCount = useCallback(() => {
    if (selectedProjectId !== null) {
      window.forge.question
        .list(selectedProjectId, true)
        .then((res) => {
          setUnansweredCount(unwrap(res).questions.length)
        })
        .catch(() => {
          // Non-fatal if IPC fails during init
        })
    } else {
      Promise.all(projects.map((p) => window.forge.question.list(p.id, true).then(unwrap)))
        .then((results) => {
          let count = 0
          for (const res of results) {
            count += res.questions.length
          }
          setUnansweredCount(count)
        })
        .catch(() => {
          // Non-fatal
        })
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

  return (
    <nav
      aria-label="Main"
      className={cn(
        'flex shrink-0 flex-col border-r border-(--color-border) bg-(--color-surface)',
        'transition-[width] duration-(--duration-base) ease-(--ease-out)',
        collapsed ? 'w-12' : 'w-48',
      )}
    >
      <ul className="flex min-h-0 flex-1 flex-col gap-1 overflow-y-auto p-2">
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
      </ul>

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
