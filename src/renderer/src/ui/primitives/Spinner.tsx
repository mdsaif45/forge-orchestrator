import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../cn'

const spinner = cva('animate-spin rounded-full border-current border-t-transparent', {
  variants: {
    size: {
      sm: 'size-3 border-[1.5px]',
      md: 'size-4 border-2',
      lg: 'size-6 border-2',
    },
  },
  defaultVariants: { size: 'md' },
})

export interface SpinnerProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof spinner> {
  /** Announced to assistive tech; omit only when a parent already labels the wait. */
  readonly label?: string
}

export function Spinner({ className, size, label, ...props }: SpinnerProps): React.JSX.Element {
  return (
    <span
      role="status"
      aria-label={label ?? 'Loading'}
      className={cn(spinner({ size }), className)}
      {...props}
    />
  )
}
