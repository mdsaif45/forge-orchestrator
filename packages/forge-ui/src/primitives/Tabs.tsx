import { cn } from '../lib/cn'

export interface TabItem<T extends string> {
  readonly value: T
  readonly label: string
  readonly icon?: React.ReactNode | undefined
  /** Optional trailing count or badge. */
  readonly adornment?: React.ReactNode | undefined
  readonly disabled?: boolean | undefined
}

export interface TabsProps<T extends string> {
  readonly items: readonly TabItem<T>[]
  readonly value: T
  readonly onChange: (value: T) => void
  readonly variant?: 'underline' | 'pill' | undefined
  readonly className?: string | undefined
  readonly 'aria-label': string
}

/**
 * Keyboard-navigable tabs implementing the ARIA tabs pattern (ArrowLeft/ArrowRight).
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  variant = 'underline',
  className,
  'aria-label': ariaLabel,
}: TabsProps<T>): React.JSX.Element {
  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const delta = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0
    if (delta === 0) return
    event.preventDefault()

    const enabled = items.filter((item) => item.disabled !== true)
    const current = enabled.findIndex((item) => item.value === value)
    if (current === -1) return

    const next = enabled[(current + delta + enabled.length) % enabled.length]
    if (next !== undefined) onChange(next.value)
  }

  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      onKeyDown={onKeyDown}
      className={cn(
        variant === 'underline'
          ? 'flex items-center gap-1 border-b border-(--color-edge)'
          : 'inline-flex items-center gap-1 rounded-(--radius-lg) border border-(--color-edge-muted) bg-(--color-surface-inset) p-0.5',
        className,
      )}
    >
      {items.map((item) => {
        const selected = item.value === value
        return (
          <button
            key={item.value}
            role="tab"
            type="button"
            aria-selected={selected}
            disabled={item.disabled}
            tabIndex={selected ? 0 : -1}
            onClick={() => {
              onChange(item.value)
            }}
            className={cn(
              'inline-flex cursor-pointer items-center gap-1.5 font-medium transition-colors duration-(--duration-fast) ease-(--ease-out)',
              'outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus)',
              'disabled:pointer-events-none disabled:opacity-40',
              variant === 'underline'
                ? [
                    '-mb-px border-b-2 px-3 py-2 typography-ui-label',
                    selected
                      ? 'border-(--color-accent) text-(--color-text)'
                      : 'border-transparent text-(--color-text-muted) hover:text-(--color-text)',
                  ]
                : [
                    'h-6 rounded-(--radius-md) px-2.5 typography-meta',
                    selected
                      ? 'bg-(--color-surface-raised) text-(--color-text) shadow-(--elevation-button)'
                      : 'text-(--color-text-muted) hover:text-(--color-text)',
                  ],
            )}
          >
            {item.icon}
            {item.label}
            {item.adornment}
          </button>
        )
      })}
    </div>
  )
}

export interface TabPanelProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly active: boolean
}

export function TabPanel({ active, className, ...props }: TabPanelProps): React.JSX.Element | null {
  if (!active) return null
  return <div role="tabpanel" className={cn('py-4', className)} {...props} />
}
