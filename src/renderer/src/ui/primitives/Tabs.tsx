import { cn } from '../cn'

/**
 * Keyboard-navigable tabs following the ARIA tabs pattern.
 *
 * Controlled by design: which tab is active is often URL or workflow state, not
 * component state, so the caller owns it.
 */
export interface TabItem<T extends string> {
  readonly value: T
  readonly label: string
  /** Optional trailing count or status, e.g. an unanswered-question badge. */
  readonly adornment?: React.ReactNode
  readonly disabled?: boolean
}

export interface TabsProps<T extends string> {
  readonly items: readonly TabItem<T>[]
  readonly value: T
  readonly onChange: (value: T) => void
  readonly className?: string
  readonly 'aria-label': string
}

export function Tabs<T extends string>({
  items,
  value,
  onChange,
  className,
  'aria-label': ariaLabel,
}: TabsProps<T>): React.JSX.Element {
  // Arrow keys move between tabs, skipping disabled ones — expected behaviour
  // for the role, and not something a div-based implementation gets by default.
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
      className={cn('flex items-center gap-1 border-b border-(--color-border)', className)}
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
            onClick={() => onChange(item.value)}
            className={cn(
              'inline-flex items-center gap-1.5 px-3 py-2',
              'text-(length:--text-sm) font-medium',
              '-mb-px border-b-2',
              'transition-colors duration-(--duration-fast) ease-(--ease-out)',
              'outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus)',
              'disabled:pointer-events-none disabled:opacity-40',
              selected
                ? 'border-(--color-accent) text-(--color-text)'
                : 'border-transparent text-(--color-text-muted) hover:text-(--color-text)',
            )}
          >
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
