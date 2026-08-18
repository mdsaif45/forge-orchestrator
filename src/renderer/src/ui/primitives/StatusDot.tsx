import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../cn'

/**
 * The workflow-state indicator.
 *
 * `pulse` marks live activity, so a running workflow is distinguishable from a
 * stalled one at a glance — the state a long-running orchestrator is read for
 * most often.
 */
const dot = cva('inline-block shrink-0 rounded-(--radius-full)', {
  variants: {
    status: {
      idle: 'bg-(--color-text-subtle)',
      running: 'bg-(--color-accent)',
      waiting: 'bg-(--color-warning)',
      passed: 'bg-(--color-success)',
      failed: 'bg-(--color-danger)',
      halted: 'bg-(--color-danger)',
    },
    size: {
      sm: 'size-1.5',
      md: 'size-2',
      lg: 'size-2.5',
    },
    pulse: {
      true: 'animate-pulse',
    },
  },
  defaultVariants: { status: 'idle', size: 'md' },
})

export interface StatusDotProps
  extends Omit<React.HTMLAttributes<HTMLSpanElement>, 'children'>, VariantProps<typeof dot> {
  /** Screen-reader text; the colour alone must never be the only signal. */
  readonly label?: string
}

export function StatusDot({
  className,
  status,
  size,
  pulse,
  label,
  ...props
}: StatusDotProps): React.JSX.Element {
  return (
    <span className="inline-flex items-center" {...props}>
      <span className={cn(dot({ status, size, pulse }), className)} />
      {label !== undefined ? <span className="sr-only">{label}</span> : null}
    </span>
  )
}
