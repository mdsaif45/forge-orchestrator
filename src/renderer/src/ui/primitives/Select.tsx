import { forwardRef } from 'react'
import { cn } from '../cn'

export interface SelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean
}

export interface SelectProps extends Omit<
  React.SelectHTMLAttributes<HTMLSelectElement>,
  'children' | 'size'
> {
  readonly options: readonly SelectOption[]
  /** Rendered as a disabled first option, so it cannot be submitted as a value. */
  readonly placeholder?: string
  readonly invalid?: boolean
}

/**
 * A native `<select>`.
 *
 * Deliberately not a custom listbox: the native control brings keyboard
 * behaviour, typeahead, and OS-level rendering that a hand-built menu would have
 * to reimplement. A custom one is only worth it when options need rich content.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, options, placeholder, invalid = false, ...props },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'w-full appearance-none bg-(--color-surface-inset) text-(--color-text)',
          'h-8 rounded-(--radius-md) border pr-8 pl-2.5 text-(length:--text-sm)',
          'transition-colors duration-(--duration-fast) ease-(--ease-out)',
          'outline-none focus-visible:border-(--color-border-focus) focus-visible:ring-2 focus-visible:ring-(--color-border-focus)/25',
          'disabled:cursor-not-allowed disabled:opacity-50',
          invalid ? 'border-(--color-danger)' : 'border-(--color-border)',
          className,
        )}
        {...props}
      >
        {placeholder !== undefined ? (
          <option value="" disabled>
            {placeholder}
          </option>
        ) : null}
        {options.map((option) => (
          <option key={option.value} value={option.value} disabled={option.disabled}>
            {option.label}
          </option>
        ))}
      </select>

      <svg
        viewBox="0 0 16 16"
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 right-2.5 size-3 -translate-y-1/2 text-(--color-text-muted)"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
      >
        <path d="M4 6l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  )
})
