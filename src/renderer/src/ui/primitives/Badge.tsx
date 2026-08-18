import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../cn'

const badge = cva(
  [
    'inline-flex items-center gap-1 whitespace-nowrap',
    'rounded-(--radius-full) border font-medium',
  ],
  {
    variants: {
      tone: {
        neutral: 'bg-(--color-surface-raised) text-(--color-text-muted) border-(--color-border)',
        accent: 'bg-(--color-accent-muted) text-(--color-accent) border-(--color-accent)/30',
        success: 'bg-(--color-success-muted) text-(--color-success) border-(--color-success)/30',
        warning: 'bg-(--color-warning-muted) text-(--color-warning) border-(--color-warning)/30',
        danger: 'bg-(--color-danger-muted) text-(--color-danger) border-(--color-danger)/30',
        info: 'bg-(--color-info-muted) text-(--color-info) border-(--color-info)/30',
      },
      size: {
        sm: 'h-4.5 px-1.5 text-(length:--text-2xs)',
        md: 'h-5.5 px-2 text-(length:--text-xs)',
      },
    },
    defaultVariants: { tone: 'neutral', size: 'md' },
  },
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>, VariantProps<typeof badge> {}

export function Badge({ className, tone, size, ...props }: BadgeProps): React.JSX.Element {
  return <span className={cn(badge({ tone, size }), className)} {...props} />
}
