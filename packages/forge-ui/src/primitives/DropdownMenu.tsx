import { Menu as BaseMenu } from '@base-ui/react/menu'
import * as React from 'react'
import { Icon } from '../icons/Icon'
import { cn } from '../lib/cn'
import { menuItemClass, menuLabelClass, menuPopupClass, menuSeparatorClass } from './MenuStyles'

export const DropdownMenu = BaseMenu.Root
export const DropdownMenuGroup = BaseMenu.Group
export const DropdownMenuRadioGroup = BaseMenu.RadioGroup
export const DropdownMenuSub = BaseMenu.SubmenuRoot

export interface DropdownMenuTriggerProps extends React.ComponentPropsWithoutRef<
  typeof BaseMenu.Trigger
> {
  readonly asChild?: boolean | undefined
}

export function DropdownMenuTrigger({
  asChild = false,
  children,
  ...props
}: DropdownMenuTriggerProps): React.JSX.Element {
  if (asChild && React.isValidElement(children)) {
    return <BaseMenu.Trigger render={children} {...props} />
  }
  return <BaseMenu.Trigger {...props}>{children}</BaseMenu.Trigger>
}

export interface DropdownMenuContentProps extends Omit<
  React.ComponentPropsWithoutRef<typeof BaseMenu.Popup>,
  'ref'
> {
  readonly align?: 'start' | 'center' | 'end' | undefined
  readonly side?: 'top' | 'bottom' | 'left' | 'right' | undefined
  readonly sideOffset?: number | undefined
}

export function DropdownMenuContent({
  className,
  align = 'start',
  side = 'bottom',
  sideOffset = 6,
  children,
  ...props
}: DropdownMenuContentProps): React.JSX.Element {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="z-(--z-dialog)"
      >
        <BaseMenu.Popup
          data-slot="dropdown-menu-content"
          className={cn(menuPopupClass, className)}
          {...props}
        >
          {children}
        </BaseMenu.Popup>
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  )
}

export interface DropdownMenuItemProps extends React.ComponentPropsWithoutRef<
  typeof BaseMenu.Item
> {
  readonly variant?: 'default' | 'destructive' | undefined
  readonly inset?: boolean | undefined
}

export function DropdownMenuItem({
  className,
  variant = 'default',
  inset = false,
  ...props
}: DropdownMenuItemProps): React.JSX.Element {
  return (
    <BaseMenu.Item
      data-slot="dropdown-menu-item"
      data-variant={variant}
      data-inset={inset || undefined}
      className={cn(menuItemClass, inset && 'pl-7', className)}
      {...props}
    />
  )
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentPropsWithoutRef<typeof BaseMenu.CheckboxItem>): React.JSX.Element {
  return (
    <BaseMenu.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      checked={checked}
      className={cn(menuItemClass, 'pl-7', className)}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <BaseMenu.CheckboxItemIndicator>
          <Icon name="check" className="size-3.5 text-(--color-accent)" />
        </BaseMenu.CheckboxItemIndicator>
      </span>
      {children}
    </BaseMenu.CheckboxItem>
  )
}

export function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof BaseMenu.RadioItem>): React.JSX.Element {
  return (
    <BaseMenu.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(menuItemClass, 'pl-7', className)}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <BaseMenu.RadioItemIndicator>
          <Icon name="check" className="size-3.5 text-(--color-accent)" />
        </BaseMenu.RadioItemIndicator>
      </span>
      {children}
    </BaseMenu.RadioItem>
  )
}

export function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof BaseMenu.GroupLabel>): React.JSX.Element {
  return <BaseMenu.GroupLabel className={cn(menuLabelClass, className)} {...props} />
}

export function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof BaseMenu.Separator>): React.JSX.Element {
  return <BaseMenu.Separator className={cn(menuSeparatorClass, className)} {...props} />
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof BaseMenu.SubmenuTrigger>): React.JSX.Element {
  return (
    <BaseMenu.SubmenuTrigger className={cn(menuItemClass, className)} {...props}>
      <span className="flex-1 truncate">{children}</span>
      <Icon name="chevron-right" className="ml-auto size-3.5 text-(--color-text-muted)" />
    </BaseMenu.SubmenuTrigger>
  )
}

export function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof BaseMenu.Popup>): React.JSX.Element {
  return (
    <BaseMenu.Portal>
      <BaseMenu.Positioner side="right" sideOffset={4} className="z-(--z-dialog)">
        <BaseMenu.Popup className={cn(menuPopupClass, className)} {...props} />
      </BaseMenu.Positioner>
    </BaseMenu.Portal>
  )
}
