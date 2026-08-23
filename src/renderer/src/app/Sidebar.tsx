import { useCallback, useEffect, useState } from 'react'
import { NavLink } from 'react-router'
import { unwrap } from '../ipc'
import { Badge, cn, IconButton, Separator, Tooltip } from '../ui'
import { CollapseIcon, ExpandIcon } from './icons'
import { useProjectStore } from './projectStore'
import { ROUTES } from './routes'
import { useUiStore } from './uiStore'

/**
 * Persistent navigation, derived from the route table.
 *
 * Uses a real `<nav>` with `NavLink`, so the active route is announced via
 * `aria-current` and links behave like links — focusable, and traversable with
 * Tab in document order. Collapsed mode keeps the accessible name by moving the
 * label into a tooltip and `aria-label` rather than dropping it.
 */
export function Sidebar(): React.JSX.Element {
  const collapsed = useUiStore((state) => state.sidebarCollapsed)
  const toggleSidebar = useUiStore((state) => state.toggleSidebar)
  const projects = useProjectStore((state) => state.projects)
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId)
  const [unansweredCount, setUnansweredCount] = useState(0)

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
        collapsed ? 'w-12' : 'w-44',
      )}
    >
      <ul className="flex min-h-0 flex-1 flex-col gap-0.5 overflow-y-auto p-2">
        {ROUTES.map((route) => (
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

      <Separator />

      <div className={cn('flex p-2', collapsed ? 'justify-center' : 'justify-end')}>
        <IconButton
          size="sm"
          label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          onClick={toggleSidebar}
          icon={collapsed ? <ExpandIcon /> : <CollapseIcon />}
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
      // `end` on the index route only, so "/" is not treated as a prefix match
      // of every other path.
      end={route.path === '/'}
      aria-label={collapsed ? route.label : undefined}
      className={({ isActive }) =>
        cn(
          'flex items-center gap-2.5 rounded-(--radius-md) px-2 py-1.5',
          'text-(length:--text-sm) no-underline',
          'transition-colors duration-(--duration-fast) ease-(--ease-out)',
          'outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus)',
          '[&>svg]:size-4 [&>svg]:shrink-0',
          collapsed && 'justify-center px-0',
          isActive
            ? 'bg-(--color-accent-muted) text-(--color-text)'
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
            'ml-auto shrink-0 animate-pulse font-bold',
            collapsed && 'absolute right-1 top-1 size-2 rounded-full p-0 text-[0px]',
          )}
        >
          {badge}
        </Badge>
      ) : null}
    </NavLink>
  )
}
