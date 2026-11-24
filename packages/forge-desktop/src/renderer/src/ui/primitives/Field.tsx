import { useId } from 'react'
import { cn } from '../cn'

/**
 * Label + control + help/error, wired together.
 *
 * Exists so accessibility is structural rather than remembered: the label's
 * `htmlFor`, the control's `id`, and `aria-describedby` are generated here, so a
 * form field cannot ship unlabelled by accident.
 */
export interface FieldProps {
  readonly label: string
  readonly hint?: string
  readonly error?: string
  readonly required?: boolean
  readonly className?: string
  /** Receives the ids to bind onto the control. */
  readonly children: (bind: {
    readonly id: string
    readonly 'aria-describedby': string | undefined
    readonly 'aria-invalid': true | undefined
  }) => React.ReactNode
}

export function Field({
  label,
  hint,
  error,
  required = false,
  className,
  children,
}: FieldProps): React.JSX.Element {
  const id = useId()
  const hintId = `${id}-hint`
  const errorId = `${id}-error`

  // An error message replaces the hint as the description, so assistive tech
  // announces the problem rather than the original guidance.
  const describedBy = error !== undefined ? errorId : hint !== undefined ? hintId : undefined

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <label htmlFor={id} className="text-(length:--text-xs) font-medium text-(--color-text)">
        {label}
        {required ? (
          <span className="ml-1 text-(--color-danger)" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>

      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error !== undefined ? true : undefined,
      })}

      {error !== undefined ? (
        <p id={errorId} role="alert" className="text-(length:--text-xs) text-(--color-danger)">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={hintId} className="text-(length:--text-xs) text-(--color-text-subtle)">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
