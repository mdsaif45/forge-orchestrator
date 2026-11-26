import { Popover as BasePopover } from '@base-ui/react/popover'
import * as React from 'react'
import { cn } from '../lib/cn'

export const Popover = BasePopover.Root
export const PopoverClose = BasePopover.Close

export interface PopoverTriggerProps extends React.ComponentPropsWithoutRef<
  typeof BasePopover.Trigger
> {
  readonly asChild?: boolean | undefined
}

export function PopoverTrigger({
  asChild = false,
  children,
  ...props
}: PopoverTriggerProps): React.JSX.Element {
  if (asChild && React.isValidElement(children)) {
    return <BasePopover.Trigger render={children} {...props} />
  }
  return <BasePopover.Trigger {...props}>{children}</BasePopover.Trigger>
}

export interface PopoverContentProps extends React.ComponentPropsWithoutRef<
  typeof BasePopover.Popup
> {
  readonly align?: 'start' | 'center' | 'end' | undefined
  readonly side?: 'top' | 'bottom' | 'left' | 'right' | undefined
  readonly sideOffset?: number | undefined
}

export function PopoverContent({
  className,
  align = 'start',
  side = 'bottom',
  sideOffset = 6,
  ...props
}: PopoverContentProps): React.JSX.Element {
  return (
    <BasePopover.Portal>
      <BasePopover.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="z-(--z-dialog)"
      >
        <BasePopover.Popup
          data-slot="popover-content"
          className={cn(
            'forge-glass-popover z-(--z-dialog) w-72 rounded-(--radius-xl) border border-(--color-edge) p-3 text-(--color-text) outline-none',
            'transition-[opacity,transform] duration-(--duration-fast) ease-(--ease-out)',
            'data-[starting-style]:scale-95 data-[starting-style]:opacity-0 data-[ending-style]:scale-95 data-[ending-style]:opacity-0',
            className,
          )}
          {...props}
        />
      </BasePopover.Positioner>
    </BasePopover.Portal>
  )
}
