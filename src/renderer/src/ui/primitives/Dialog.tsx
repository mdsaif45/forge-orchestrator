import { useEffect, useRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../cn'
import { IconButton } from './IconButton'

/**
 * Modal dialog built on the native `<dialog>` element.
 *
 * Using the platform element rather than a div gives focus trapping, the top
 * layer, and Escape-to-close for free — all of which are easy to get subtly
 * wrong by hand, and all of which matter for the confirmation dialogs Forge uses
 * before destructive or irreversible actions.
 */
const panel = cva(
  [
    'relative m-auto w-full bg-(--color-surface-overlay) text-(--color-text)',
    'border border-(--color-border-strong) rounded-(--radius-xl) shadow-(--shadow-lg)',
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
  readonly description?: string
  /** Hides the close affordance for a decision the user must actually make. */
  readonly dismissible?: boolean
  readonly footer?: React.ReactNode
  readonly children?: React.ReactNode
  readonly className?: string
}

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

  // `showModal()` is what puts the element in the top layer and traps focus, so
  // open state is driven imperatively rather than by an `open` attribute.
  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return

    if (open && !dialog.open) dialog.showModal()
    if (!open && dialog.open) dialog.close()
  }, [open])

  // Escape fires the native `cancel` event; route it through onClose so React
  // state stays the source of truth.
  useEffect(() => {
    const dialog = ref.current
    if (dialog === null) return

    const onCancel = (event: Event): void => {
      event.preventDefault()
      if (dismissible) onClose()
    }

    dialog.addEventListener('cancel', onCancel)
    return () => dialog.removeEventListener('cancel', onCancel)
  }, [dismissible, onClose])

  return (
    <dialog ref={ref} aria-labelledby="dialog-title" className={cn(panel({ size }), className)}>
      <div className="flex items-start justify-between gap-4 border-b border-(--color-border) p-4">
        <div className="flex flex-col gap-1">
          <h2
            id="dialog-title"
            className="text-(length:--text-lg) font-semibold text-(--color-text)"
          >
            {title}
          </h2>
          {description !== undefined ? (
            <p className="text-(length:--text-xs) text-(--color-text-muted)">{description}</p>
          ) : null}
        </div>

        {dismissible ? <IconButton label="Close dialog" onClick={onClose} icon={<CloseIcon />} /> : null}
      </div>

      {children !== undefined ? <div className="p-4">{children}</div> : null}

      {footer !== undefined ? (
        <div className="flex justify-end gap-2 border-t border-(--color-border) p-4">{footer}</div>
      ) : null}
    </dialog>
  )
}

function CloseIcon(): React.JSX.Element {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
      <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
    </svg>
  )
}
