import { forwardRef } from 'react'
import { cn } from '../lib/cn'

export interface LabelProps extends React.LabelHTMLAttributes<HTMLLabelElement> {
  readonly required?: boolean
}

export const Label = forwardRef<HTMLLabelElement, LabelProps>(function Label(
  { className, required = false, children, ...props },
  ref,
) {
  return (
    <label
      ref={ref}
      data-slot="label"
      className={cn(
        'typography-meta font-medium text-(--color-text) select-none peer-disabled:opacity-50',
        className,
      )}
      {...props}
    >
      {children}
      {required ? (
        <span className="ml-1 text-(--color-danger)" aria-hidden="true">
          *
        </span>
      ) : null}
    </label>
  )
})
