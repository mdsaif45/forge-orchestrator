import { useEffect, useId, useRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Icon } from '../icons/Icon'
import { cn } from '../lib/cn'
import { IconButton } from './IconButton'

const panel = cva(
  [
    'relative m-auto w-full bg-(--color-surface-overlay) text-(--color-text)',
    'border border-(--color-edge-strong) rounded-(--radius-xl) shadow-(--elevation-floating)',
    'backdrop:bg-black/60',
  ],
  {
    variants: {
      size: {
        sm: 'max-w-sm',
        md: 'max-w-lg',
        lg: 'max-w-2xl',
        xl: 'max-w-4xl',
      },
    },
    defaultVariants: { size: 'md' },
  },
)

export interface DialogProps extends VariantProps<typeof panel> {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: string
  readonly description?: string | undefined
  /** Hides the close affordance for a decision the user must actually make. */
  readonly dismissible?: boolean | undefined
  readonly footer?: React.ReactNode | undefined
  readonly children?: React.ReactNode | undefined
  readonly className?: string | undefined
}

/**
 * Accessible Modal Dialog built on native `<dialog>` for top-layer stacking,
 * focus trapping, and Escape handling.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  dismissible = true,
  footer,
  children,
  size,
  className,
}: DialogProps): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return

    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return

    const onCancel = (event: Event): void => {
      event.preventDefault()
      if (dismissible) onClose()
    }

    dialog.addEventListener('cancel', onCancel)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
    }
  }, [dismissible, onClose])

  return (
    <dialog ref={ref} aria-labelledby={titleId} className={cn(panel({ size }), className)}>
      <div className="flex items-start justify-between gap-4 border-b border-(--color-edge-muted) p-4">
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="text-(length:--text-lg) font-semibold text-(--color-text)">
            {title}
          </h2>
          {description !== undefined ? (
            <p className="typography-meta text-(--color-text-muted)">{description}</p>
          ) : null}
        </div>

        {dismissible ? (
          <IconButton
            label="Close dialog"
            size="sm"
            onClick={onClose}
            icon={<Icon name="close" className="size-4" />}
          />
        ) : null}
      </div>

      {children !== undefined ? <div className="p-4">{children}</div> : null}

      {footer !== undefined ? (
        <div className="flex justify-end gap-2 border-t border-(--color-edge-muted) p-4">
          {footer}
        </div>
      ) : null}
    </dialog>
  )
}
