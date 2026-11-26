import { Icon } from '../icons/Icon'
import type { ForgeIconName } from '../icons/registry'
import { cn } from '../lib/cn'
import { Button, type ButtonProps } from './Button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from './DropdownMenu'
import { Separator } from './Separator'

export interface ToolbarProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly 'aria-label'?: string | undefined
}

export function Toolbar({
  className,
  'aria-label': ariaLabel = 'Toolbar',
  ...props
}: ToolbarProps): React.JSX.Element {
  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      data-slot="toolbar"
      className={cn(
        'flex items-center gap-1 rounded-(--radius-lg) border border-(--color-edge-muted) bg-(--color-surface) px-1.5 py-1',
        className,
      )}
      {...props}
    />
  )
}

export function ToolbarDivider({ className }: { readonly className?: string }): React.JSX.Element {
  return <Separator orientation="vertical" className={cn('mx-1 h-4', className)} />
}

export interface ToolbarButtonProps extends Omit<ButtonProps, 'children' | 'variant' | 'size'> {
  readonly label: string
  readonly icon: ForgeIconName
  readonly pressed?: boolean | undefined
  readonly done?: boolean | undefined
  readonly showLabel?: boolean | undefined
}

export function ToolbarButton({
  label,
  icon,
  pressed,
  done = false,
  showLabel = false,
  className,
  ...props
}: ToolbarButtonProps): React.JSX.Element {
  return (
    <Button
      variant={pressed === true ? 'chip' : 'ghost'}
      size="xs"
      aria-label={label}
      aria-pressed={pressed}
      title={label}
      className={cn(
        showLabel ? 'px-2' : 'w-6 px-0',
        pressed === true
          ? 'bg-(--color-interactive-selection) text-(--color-text)'
          : 'text-(--color-text-muted) hover:text-(--color-text)',
        className,
      )}
      {...props}
    >
      <Icon
        name={done ? 'check' : icon}
        className={cn('size-3.5', done && 'text-(--color-success)')}
      />
      {showLabel ? <span>{label}</span> : null}
    </Button>
  )
}

export interface ToolbarAction {
  readonly id: string
  readonly label: string
  readonly icon: ForgeIconName
  readonly onSelect: () => void
  readonly pressed?: boolean | undefined
  readonly disabled?: boolean | undefined
  readonly done?: boolean | undefined
  readonly destructive?: boolean | undefined
  readonly overflowOnly?: boolean | undefined
}

export interface ActionToolbarProps {
  readonly actions: readonly ToolbarAction[]
  readonly showLabels?: boolean | undefined
  readonly className?: string | undefined
  readonly 'aria-label'?: string | undefined
}

/**
 * Document/panel action toolbar modeled on `@openchamber/ui`'s ActionToolbar:
 * primary pinned buttons stay inline with optional overflow actions folded into a More menu.
 */
export function ActionToolbar({
  actions,
  showLabels = false,
  className,
  'aria-label': ariaLabel = 'Document actions',
}: ActionToolbarProps): React.JSX.Element {
  const inlineActions = actions.filter((action) => action.overflowOnly !== true)
  const overflowActions = actions.filter((action) => action.overflowOnly === true)

  return (
    <div
      role="toolbar"
      aria-label={ariaLabel}
      data-slot="action-toolbar"
      className={cn('inline-flex items-center gap-0.5', className)}
    >
      {inlineActions.map((action) => (
        <ToolbarButton
          key={action.id}
          label={action.label}
          icon={action.icon}
          pressed={action.pressed}
          done={action.done}
          disabled={action.disabled}
          showLabel={showLabels}
          onClick={action.onSelect}
          className={action.destructive === true ? 'hover:text-(--color-danger)' : undefined}
        />
      ))}

      {overflowActions.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="xs"
              aria-label="More actions"
              title="More actions"
              className="w-6 px-0 text-(--color-text-muted) hover:text-(--color-text)"
            >
              <Icon name="more" className="size-3.5" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {overflowActions.map((action) => (
              <DropdownMenuItem
                key={action.id}
                disabled={action.disabled}
                variant={action.destructive === true ? 'destructive' : 'default'}
                onClick={action.onSelect}
              >
                <Icon name={action.done === true ? 'check' : action.icon} className="size-3.5" />
                <span>{action.label}</span>
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
    </div>
  )
}
