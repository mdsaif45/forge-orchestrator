import { Collapsible as BaseCollapsible } from '@base-ui/react/collapsible'
import * as React from 'react'
import { Icon } from '../icons/Icon'
import { cn } from '../lib/cn'

export const Collapsible = BaseCollapsible.Root

export interface CollapsibleTriggerProps extends Omit<
  React.ComponentPropsWithoutRef<typeof BaseCollapsible.Trigger>,
  'children'
> {
  readonly asChild?: boolean | undefined
  readonly showChevron?: boolean | undefined
  readonly children?: React.ReactNode | undefined
}

export function CollapsibleTrigger({
  className,
  asChild = false,
  showChevron = true,
  children,
  ...props
}: CollapsibleTriggerProps): React.JSX.Element {
  if (asChild && React.isValidElement(children)) {
    return <BaseCollapsible.Trigger render={children} className={className} {...props} />
  }

  return (
    <BaseCollapsible.Trigger
      className={cn(
        'group flex w-full cursor-pointer items-center justify-between gap-2 rounded-(--radius-md) px-2 py-1.5 text-left',
        'typography-ui-label text-(--color-text-muted) hover:bg-(--color-interactive-hover) hover:text-(--color-text)',
        'outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus)',
        className,
      )}
      {...props}
    >
      <span className="min-w-0 flex-1">{children}</span>
      {showChevron ? (
        <Icon
          name="chevron-right"
          className="size-3.5 text-(--color-text-subtle) transition-transform duration-(--duration-fast) group-data-[panel-open]:rotate-90"
        />
      ) : null}
    </BaseCollapsible.Trigger>
  )
}

export function CollapsibleContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof BaseCollapsible.Panel>): React.JSX.Element {
  return (
    <BaseCollapsible.Panel
      className={cn(
        'transition-opacity duration-(--duration-fast) ease-(--ease-out)',
        'data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 motion-reduce:transition-none',
        className,
      )}
      {...props}
    />
  )
}
