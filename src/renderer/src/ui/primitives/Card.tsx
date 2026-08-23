import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../cn'

const card = cva('rounded-(--radius-lg) border', {
  variants: {
    tone: {
      default: 'bg-(--color-surface) border-(--color-border)',
      raised: 'bg-(--color-surface-raised) border-(--color-border) shadow-(--shadow-sm)',
      inset: 'bg-(--color-surface-inset) border-(--color-border)',
    },
    interactive: {
      true: 'text-left transition-colors duration-(--duration-fast) ease-(--ease-out) hover:border-(--color-border-strong) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus)',
    },
    padding: {
      none: '',
      sm: 'p-3',
      md: 'p-4',
      lg: 'p-6',
    },
  },
  defaultVariants: { tone: 'default', padding: 'md' },
})

export interface CardProps
  extends React.HTMLAttributes<HTMLDivElement>, VariantProps<typeof card> {}

export function Card({
  className,
  tone,
  padding,
  interactive,
  ...props
}: CardProps): React.JSX.Element {
  return <div className={cn(card({ tone, padding, interactive }), className)} {...props} />
}

export function CardHeader({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('flex items-start justify-between gap-3', className)} {...props} />
}

export function CardTitle({
  className,
  ...props
}: React.HTMLAttributes<HTMLHeadingElement>): React.JSX.Element {
  return (
    <h3
      className={cn('text-(length:--text-base) font-semibold text-(--color-text)', className)}
      {...props}
    />
  )
}

export function CardDescription({
  className,
  ...props
}: React.HTMLAttributes<HTMLParagraphElement>): React.JSX.Element {
  return (
    <p className={cn('text-(length:--text-xs) text-(--color-text-muted)', className)} {...props} />
  )
}

export function CardContent({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('flex flex-col gap-3', className)} {...props} />
}

export function CardFooter({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.JSX.Element {
  return <div className={cn('flex items-center justify-between gap-3', className)} {...props} />
}
