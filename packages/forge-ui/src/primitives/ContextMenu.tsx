import { ContextMenu as BaseContextMenu } from '@base-ui/react/context-menu'
import * as React from 'react'
import { Icon } from '../icons/Icon'
import { cn } from '../lib/cn'
import { menuItemClass, menuLabelClass, menuPopupClass, menuSeparatorClass } from './MenuStyles'

export const ContextMenu = BaseContextMenu.Root
export const ContextMenuGroup = BaseContextMenu.Group
export const ContextMenuSub = BaseContextMenu.SubmenuRoot

export interface ContextMenuTriggerProps extends React.ComponentPropsWithoutRef<
  typeof BaseContextMenu.Trigger
> {
  readonly asChild?: boolean | undefined
}

export function ContextMenuTrigger({
  asChild = false,
  children,
  ...props
}: ContextMenuTriggerProps): React.JSX.Element {
  if (asChild && React.isValidElement(children)) {
    return <BaseContextMenu.Trigger render={children} {...props} />
  }
  return <BaseContextMenu.Trigger {...props}>{children}</BaseContextMenu.Trigger>
}

export function ContextMenuContent({
  className,
  children,
  ...props
}: Omit<React.ComponentPropsWithoutRef<typeof BaseContextMenu.Popup>, 'ref'>): React.JSX.Element {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner className="z-(--z-dialog)">
        <BaseContextMenu.Popup
          data-slot="context-menu-content"
          className={cn(menuPopupClass, className)}
          {...props}
        >
          {children}
        </BaseContextMenu.Popup>
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  )
}

export interface ContextMenuItemProps extends React.ComponentPropsWithoutRef<
  typeof BaseContextMenu.Item
> {
  readonly variant?: 'default' | 'destructive' | undefined
  readonly inset?: boolean | undefined
}

export function ContextMenuItem({
  className,
  variant = 'default',
  inset = false,
  ...props
}: ContextMenuItemProps): React.JSX.Element {
  return (
    <BaseContextMenu.Item
      data-slot="context-menu-item"
      data-variant={variant}
      data-inset={inset || undefined}
      className={cn(menuItemClass, inset && 'pl-7', className)}
      {...props}
    />
  )
}

export function ContextMenuLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof BaseContextMenu.GroupLabel>): React.JSX.Element {
  return <BaseContextMenu.GroupLabel className={cn(menuLabelClass, className)} {...props} />
}

export function ContextMenuSeparator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof BaseContextMenu.Separator>): React.JSX.Element {
  return <BaseContextMenu.Separator className={cn(menuSeparatorClass, className)} {...props} />
}

export function ContextMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof BaseContextMenu.SubmenuTrigger>): React.JSX.Element {
  return (
    <BaseContextMenu.SubmenuTrigger className={cn(menuItemClass, className)} {...props}>
      <span className="flex-1 truncate">{children}</span>
      <Icon name="chevron-right" className="ml-auto size-3.5 text-(--color-text-muted)" />
    </BaseContextMenu.SubmenuTrigger>
  )
}

export function ContextMenuSubContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof BaseContextMenu.Popup>): React.JSX.Element {
  return (
    <BaseContextMenu.Portal>
      <BaseContextMenu.Positioner side="right" sideOffset={4} className="z-(--z-dialog)">
        <BaseContextMenu.Popup className={cn(menuPopupClass, className)} {...props} />
      </BaseContextMenu.Positioner>
    </BaseContextMenu.Portal>
  )
}
