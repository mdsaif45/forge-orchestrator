import { forwardRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../cn'

const field = cva(
  [
    'w-full bg-(--color-surface-inset) text-(--color-text)',
    'border rounded-(--radius-md)',
    'placeholder:text-(--color-text-subtle)',
    'transition-colors duration-(--duration-fast) ease-(--ease-out)',
    'outline-none focus-visible:border-(--color-border-focus) focus-visible:ring-2 focus-visible:ring-(--color-border-focus)/25',
    'disabled:opacity-50 disabled:cursor-not-allowed',
  ],
  {
    variants: {
      invalid: {
        true: 'border-(--color-danger) focus-visible:border-(--color-danger) focus-visible:ring-(--color-danger)/25',
        false: 'border-(--color-border)',
      },
      inputSize: {
        sm: 'h-7 px-2 text-(length:--text-xs)',
        md: 'h-8 px-2.5 text-(length:--text-sm)',
        lg: 'h-10 px-3 text-(length:--text-base)',
      },
      mono: {
        true: 'font-(family-name:--font-mono)',
      },
    },
    defaultVariants: { inputSize: 'md', invalid: false },
  },
)

export interface InputProps
  extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'size'>,
    VariantProps<typeof field> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { className, invalid, inputSize, mono, ...props },
  ref,
) {
  return (
    <input
      ref={ref}
      aria-invalid={invalid === true || undefined}
      className={cn(field({ invalid, inputSize, mono }), className)}
      {...props}
    />
  )
})

export interface TextareaProps
  extends React.TextareaHTMLAttributes<HTMLTextAreaElement>,
    Pick<VariantProps<typeof field>, 'invalid' | 'mono'> {}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(
  { className, invalid, mono, rows = 4, ...props },
  ref,
) {
  return (
    <textarea
      ref={ref}
      rows={rows}
      aria-invalid={invalid === true || undefined}
      className={cn(
        field({ invalid, mono }),
        'resize-y px-2.5 py-2 text-(length:--text-sm) leading-relaxed',
        className,
      )}
      {...props}
    />
  )
})
