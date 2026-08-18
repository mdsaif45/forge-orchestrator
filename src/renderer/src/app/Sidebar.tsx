import { NavLink } from 'react-router'
import { cn, IconButton, Separator, Tooltip } from '../ui'
import { CollapseIcon, ExpandIcon } from './icons'
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
                <NavItem route={route} collapsed />
              </Tooltip>
            ) : (
              <NavItem route={route} collapsed={false} />
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
}: {
  readonly route: (typeof ROUTES)[number]
  readonly collapsed: boolean
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
    </NavLink>
  )
}
