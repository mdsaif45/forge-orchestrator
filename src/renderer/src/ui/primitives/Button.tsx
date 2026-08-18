import { forwardRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../cn'
import { Spinner } from './Spinner'

/**
 * Variants describe intent, not appearance: a caller asks for `danger`, never
 * for red. That keeps the palette swappable and the call sites readable.
 */
const button = cva(
  [
    'inline-flex items-center justify-center gap-2 whitespace-nowrap',
    'font-medium select-none',
    'rounded-(--radius-md)',
    'transition-colors duration-(--duration-fast) ease-(--ease-out)',
    // A visible focus ring is a requirement, not a style choice.
    'outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus) focus-visible:ring-offset-2 focus-visible:ring-offset-(--color-canvas)',
    'disabled:pointer-events-none disabled:opacity-50',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-(--color-accent) text-white hover:bg-(--color-accent-hover) active:brightness-95',
        secondary:
          'bg-(--color-surface-raised) text-(--color-text) border border-(--color-border) hover:bg-(--color-surface-overlay) hover:border-(--color-border-strong)',
        ghost: 'bg-transparent text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text)',
        danger: 'bg-(--color-danger) text-white hover:brightness-110 active:brightness-95',
        // For the one primary-destructive case per screen at most.
        'danger-subtle':
          'bg-(--color-danger-muted) text-(--color-danger) border border-(--color-danger)/30 hover:border-(--color-danger)/60',
      },
      size: {
        sm: 'h-7 px-2.5 text-(length:--text-xs)',
        md: 'h-8 px-3 text-(length:--text-sm)',
        lg: 'h-10 px-4 text-(length:--text-base)',
      },
      fullWidth: {
        true: 'w-full',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof button> {
  /** Shows a spinner and blocks interaction without changing the button's width. */
  readonly loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant, size, fullWidth, loading = false, disabled, children, ...props },
  ref,
) {
  return (
    <button
      ref={ref}
      // Disable during load so a slow action cannot be double-submitted.
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(button({ variant, size, fullWidth }), className)}
      {...props}
    >
      {loading ? <Spinner size="sm" /> : null}
      {children}
    </button>
  )
})
