import { forwardRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../lib/cn'
import { Spinner } from './Spinner'

/**
 * Standardized Button primitive with intent variants and strict height ladder.
 * Variants describe intent (`primary`, `danger`, `info`, `outline`, `chip`, etc.).
 */
export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-1.5 whitespace-nowrap shrink-0',
    'font-medium select-none rounded-(--radius-md)',
    'transition-[background-color,border-color,color,opacity,box-shadow] duration-(--duration-fast) ease-(--ease-out)',
    'outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus) focus-visible:ring-offset-2 focus-visible:ring-offset-(--color-canvas)',
    'disabled:pointer-events-none disabled:opacity-50',
    '[&_svg]:pointer-events-none [&_svg]:shrink-0',
  ],
  {
    variants: {
      variant: {
        primary:
          'bg-(--color-accent) text-white shadow-(--elevation-button) hover:bg-(--color-accent-hover) active:brightness-95',
        default:
          'bg-(--color-accent-muted) text-(--color-accent) border border-(--color-accent)/25 shadow-(--elevation-button) hover:bg-(--color-accent)/20',
        secondary:
          'bg-(--color-surface-raised) text-(--color-text) border border-(--color-edge) shadow-(--elevation-button) hover:bg-(--color-surface-overlay) hover:border-(--color-edge-strong)',
        outline:
          'bg-transparent text-(--color-text) border border-(--color-edge) hover:bg-(--color-interactive-hover) hover:border-(--color-edge-strong)',
        ghost:
          'bg-transparent text-(--color-text-muted) hover:bg-(--color-interactive-hover) hover:text-(--color-text)',
        chip: 'bg-(--color-interactive-hover) text-(--color-text) hover:bg-(--color-interactive-active) aria-pressed:bg-(--color-interactive-selection) aria-pressed:text-(--color-text)',
        info: 'bg-(--color-info-muted) text-(--color-info) border border-(--color-info)/25 hover:bg-(--color-info)/20',
        danger:
          'bg-(--color-danger) text-white shadow-(--elevation-button) hover:brightness-110 active:brightness-95',
        destructive:
          'bg-(--color-danger-muted) text-(--color-danger) border border-(--color-danger)/30 hover:border-(--color-danger)/60',
        'danger-subtle':
          'bg-(--color-danger-muted) text-(--color-danger) border border-(--color-danger)/30 hover:border-(--color-danger)/60',
        link: 'bg-transparent text-(--color-accent) underline-offset-4 hover:underline',
      },
      size: {
        xs: 'h-6 px-2 typography-micro gap-1 rounded-[5px]',
        sm: 'h-7 px-2.5 typography-meta gap-1.5',
        md: 'h-8 px-3 typography-ui-label',
        default: 'h-8 px-3 typography-ui-label',
        lg: 'h-9 px-4 text-(length:--text-base)',
        icon: 'size-8 p-0',
      },
      fullWidth: {
        true: 'w-full',
      },
    },
    defaultVariants: { variant: 'secondary', size: 'md' },
  },
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
  /** Shows a spinner and blocks interaction without changing width. */
  readonly loading?: boolean
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    className,
    variant,
    size,
    fullWidth,
    loading = false,
    disabled,
    type = 'button',
    children,
    ...props
  },
  ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      data-slot="button"
      disabled={disabled === true || loading}
      aria-busy={loading || undefined}
      className={cn(buttonVariants({ variant, size, fullWidth }), className)}
      {...props}
    >
      {loading ? <Spinner size="sm" /> : null}
      {children}
    </button>
  )
})
