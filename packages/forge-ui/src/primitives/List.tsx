import { forwardRef } from 'react'
import { cn } from '../lib/cn'

export interface ListProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly divided?: boolean | undefined
}

export function List({ className, divided = true, ...props }: ListProps): React.JSX.Element {
  return (
    <div
      role="list"
      data-slot="list"
      className={cn('flex flex-col', divided && 'divide-y divide-(--color-edge-muted)', className)}
      {...props}
    />
  )
}

export interface ListSectionProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly title?: string | undefined
  readonly count?: number | undefined
  readonly action?: React.ReactNode | undefined
}

export function ListSection({
  title,
  count,
  action,
  className,
  children,
  ...props
}: ListSectionProps): React.JSX.Element {
  return (
    <section data-slot="list-section" className={cn('flex flex-col gap-1', className)} {...props}>
      {title !== undefined ? (
        <div className="flex items-center justify-between gap-2 px-2 py-1">
          <div className="flex items-center gap-1.5">
            <span className="typography-micro font-semibold tracking-wider text-(--color-text-subtle) uppercase">
              {title}
            </span>
            {count !== undefined ? (
              <span className="typography-micro text-(--color-text-subtle)">{count}</span>
            ) : null}
          </div>
          {action}
        </div>
      ) : null}
      {children}
    </section>
  )
}

export interface ListRowProps extends Omit<
  React.HTMLAttributes<HTMLElement>,
  'title' | 'onSelect'
> {
  readonly leading?: React.ReactNode | undefined
  readonly title: React.ReactNode
  readonly subtitle?: React.ReactNode | undefined
  readonly trailing?: React.ReactNode | undefined
  readonly selected?: boolean | undefined
  readonly disabled?: boolean | undefined
  readonly interactive?: boolean | undefined
  readonly onSelect?: (() => void) | undefined
}

export const ListRow = forwardRef<HTMLElement, ListRowProps>(function ListRow(
  {
    leading,
    title,
    subtitle,
    trailing,
    selected = false,
    disabled = false,
    interactive = false,
    onSelect,
    className,
    onClick,
    ...props
  },
  ref,
) {
  const isButton = interactive || onSelect !== undefined || onClick !== undefined
  const sharedClassName = cn(
    'flex w-full items-center gap-2.5 rounded-(--radius-md) px-2.5 py-1.5 text-left',
    'transition-colors duration-(--duration-fast) ease-(--ease-out)',
    isButton &&
      !disabled &&
      'cursor-pointer hover:bg-(--color-interactive-hover) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus)',
    selected && 'bg-(--color-interactive-selection) text-(--color-interactive-selection-text)',
    disabled && 'pointer-events-none opacity-50',
    className,
  )

  const content = (
    <>
      {leading !== undefined ? <span className="shrink-0">{leading}</span> : null}
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate typography-ui-label font-medium text-(--color-text)">
          {title}
        </span>
        {subtitle !== undefined ? (
          <span className="truncate typography-meta text-(--color-text-muted)">{subtitle}</span>
        ) : null}
      </span>
      {trailing !== undefined ? <span className="shrink-0">{trailing}</span> : null}
    </>
  )

  if (isButton) {
    return (
      <button
        ref={ref as React.Ref<HTMLButtonElement>}
        type="button"
        role="listitem"
        disabled={disabled}
        aria-current={selected ? 'true' : undefined}
        onClick={(event) => {
          onSelect?.()
          onClick?.(event)
        }}
        className={sharedClassName}
        {...props}
      >
        {content}
      </button>
    )
  }

  return (
    <div
      ref={ref as React.Ref<HTMLDivElement>}
      role="listitem"
      className={sharedClassName}
      {...props}
    >
      {content}
    </div>
  )
})
