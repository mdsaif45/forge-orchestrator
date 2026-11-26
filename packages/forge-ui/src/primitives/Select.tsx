import { forwardRef } from 'react'
import { Icon } from '../icons/Icon'
import { cn } from '../lib/cn'

export interface SelectOption {
  readonly value: string
  readonly label: string
  readonly disabled?: boolean | undefined
}

export interface SelectProps extends Omit<
  React.SelectHTMLAttributes<HTMLSelectElement>,
  'children' | 'size'
> {
  readonly options: readonly SelectOption[]
  /** Rendered as a disabled first option so it cannot be submitted as a value. */
  readonly placeholder?: string | undefined
  readonly invalid?: boolean | undefined
  readonly direction?: 'down' | 'up' | undefined
}

/**
 * Standardized native form `<select>` primitive.
 * For rich workspace switchers or nested action menus, use `DropdownMenu`.
 */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(
  { className, options, placeholder, invalid = false, direction: _direction, ...props },
  ref,
) {
  return (
    <div className="relative">
      <select
        ref={ref}
        aria-invalid={invalid || undefined}
        className={cn(
          'w-full appearance-none bg-(--color-surface-inset) text-(--color-text)',
          'h-8 rounded-(--radius-md) border pr-8 pl-2.5 typography-ui-label',
          'transition-colors duration-(--duration-fast) ease-(--ease-out)',
          'outline-none focus-visible:border-(--color-border-focus) focus-visible:ring-2 focus-visible:ring-(--color-border-focus)/25',
          'disabled:cursor-not-allowed disabled:opacity-50',
          invalid ? 'border-(--color-danger)' : 'border-(--color-edge)',
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
          <option
            key={option.value}
            value={option.value}
            disabled={option.disabled}
            className="bg-(--color-surface-raised) text-(--color-text)"
          >
            {option.label}
          </option>
        ))}
      </select>

      <Icon
        name="chevron-down"
        className="pointer-events-none absolute top-1/2 right-2.5 size-3.5 -translate-y-1/2 text-(--color-text-muted)"
      />
    </div>
  )
})
