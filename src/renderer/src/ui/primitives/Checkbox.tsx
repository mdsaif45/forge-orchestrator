import { forwardRef, useId } from 'react'
import { cn } from '../cn'

export interface CheckboxProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type'> {
  readonly label: string
  readonly hint?: string
}

/**
 * A real `<input type="checkbox">` styled with `appearance-none`.
 *
 * Keeping the native input (rather than a styled div with `role="checkbox"`)
 * preserves form participation, the indeterminate state, and label-click
 * toggling.
 */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(
  { className, label, hint, id: providedId, ...props },
  ref,
) {
  const generatedId = useId()
  const id = providedId ?? generatedId
  const hintId = `${id}-hint`

  return (
    <div className={cn('flex gap-2.5', className)}>
      <input
        ref={ref}
        id={id}
        type="checkbox"
        aria-describedby={hint !== undefined ? hintId : undefined}
        className={cn(
          'mt-0.5 size-4 shrink-0 appearance-none',
          'rounded-(--radius-sm) border border-(--color-border-strong) bg-(--color-surface-inset)',
          'transition-colors duration-(--duration-fast) ease-(--ease-out)',
          'checked:border-(--color-accent) checked:bg-(--color-accent)',
          // The tick is a background image so no child element is needed.
          "checked:bg-[url(\"data:image/svg+xml,%3Csvg viewBox='0 0 16 16' fill='none' stroke='white' stroke-width='2.5' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M3.5 8.5l3 3 6-6' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E\")] checked:bg-center checked:bg-no-repeat",
          'outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus) focus-visible:ring-offset-2 focus-visible:ring-offset-(--color-canvas)',
          'disabled:cursor-not-allowed disabled:opacity-50',
        )}
        {...props}
      />

      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-(length:--text-sm) text-(--color-text) select-none">
          {label}
        </label>
        {hint !== undefined ? (
          <p id={hintId} className="text-(length:--text-xs) text-(--color-text-subtle)">
            {hint}
          </p>
        ) : null}
      </div>
    </div>
  )
})
