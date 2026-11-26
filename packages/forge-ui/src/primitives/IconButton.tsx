import { forwardRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'

const iconButton = cva(
  [
    'inline-flex items-center justify-center shrink-0',
    'rounded-(--radius-md)',
    'transition-colors duration-(--duration-fast) ease-(--ease-out)',
    'outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus)',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&>svg]:size-4',
  ],
  {
    variants: {
      variant: {
        ghost:
          'bg-transparent text-(--color-text-muted) hover:bg-(--color-interactive-hover) hover:text-(--color-text)',
        secondary:
          'bg-(--color-surface-raised) text-(--color-text) border border-(--color-edge) shadow-(--elevation-button) hover:border-(--color-edge-strong)',
        outline:
          'bg-transparent text-(--color-text-muted) border border-(--color-edge) hover:bg-(--color-interactive-hover) hover:text-(--color-text)',
        danger:
          'bg-transparent text-(--color-text-muted) hover:bg-(--color-danger-muted) hover:text-(--color-danger)',
      },
      size: {
        xs: 'size-6 [&>svg]:size-3.5',
        sm: 'size-6 [&>svg]:size-3.5',
        md: 'size-8',
        lg: 'size-9 [&>svg]:size-5',
      },
    },
    defaultVariants: { variant: 'ghost', size: 'md' },
  },
)

export interface IconButtonProps
  extends
    Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, 'children'>,
    VariantProps<typeof iconButton> {
  /** Required: an icon-only control has no visible text to name it. */
  readonly label: string
  readonly icon: React.ReactNode
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { className, variant, size, label, icon, type = 'button', ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      title={label}
      className={cn(iconButton({ variant, size }), className)}
      {...props}
    >
      {icon}
    </button>
  )
})
