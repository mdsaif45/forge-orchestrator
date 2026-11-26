import { useId } from 'react'
import { cn } from '../lib/cn'
import { Label } from './Label'

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

  const describedBy = error !== undefined ? errorId : hint !== undefined ? hintId : undefined

  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label htmlFor={id} required={required}>
        {label}
      </Label>

      {children({
        id,
        'aria-describedby': describedBy,
        'aria-invalid': error !== undefined ? true : undefined,
      })}

      {error !== undefined ? (
        <p id={errorId} role="alert" className="typography-meta text-(--color-danger)">
          {error}
        </p>
      ) : hint !== undefined ? (
        <p id={hintId} className="typography-meta text-(--color-text-subtle)">
          {hint}
        </p>
      ) : null}
    </div>
  )
}
