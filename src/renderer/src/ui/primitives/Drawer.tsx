import { useEffect, useRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../cn'
import { IconButton } from './IconButton'

/**
 * Side panel for inspecting something without losing the current view — a
 * workflow step's prompt packet, a file's diff, an agent's raw output.
 *
 * Built on `<dialog>` for the same reasons as `Dialog`: focus containment and
 * Escape handling come from the platform.
 */
const panel = cva(
  [
    'fixed inset-y-0 m-0 flex h-full max-h-full flex-col',
    'bg-(--color-surface) text-(--color-text)',
    'border-(--color-border-strong) shadow-(--shadow-lg)',
    'backdrop:bg-black/50',
  ],
  {
    variants: {
      side: {
        right: 'right-0 border-l',
        left: 'left-0 border-r',
      },
      size: {
        sm: 'w-80',
        md: 'w-[28rem]',
        lg: 'w-[40rem]',
        xl: 'w-[56rem]',
      },
    },
    defaultVariants: { side: 'right', size: 'md' },
  },
)

export interface DrawerProps extends VariantProps<typeof panel> {
  readonly open: boolean
  readonly onClose: () => void
  readonly title: string
  readonly description?: string
  readonly footer?: React.ReactNode
  readonly children?: React.ReactNode
  readonly className?: string
}

export function Drawer({
  open,
  onClose,
  title,
  description,
  footer,
  children,
  side,
  size,
  className,
}: DrawerProps): React.JSX.Element {
  const ref = useRef<HTMLDialogElement>(null)

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
      onClose()
    }

    dialog.addEventListener('cancel', onCancel)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
    }
  }, [onClose])

  return (
    <dialog
      ref={ref}
      aria-labelledby="drawer-title"
      className={cn(panel({ side, size }), className)}
    >
      <header className="flex items-start justify-between gap-4 border-b border-(--color-border) p-4">
        <div className="flex flex-col gap-1">
          <h2
            id="drawer-title"
            className="text-(length:--text-base) font-semibold text-(--color-text)"
          >
            {title}
          </h2>
          {description !== undefined ? (
            <p className="text-(length:--text-xs) text-(--color-text-muted)">{description}</p>
          ) : null}
        </div>

        <IconButton label="Close panel" onClick={onClose} icon={<CloseIcon />} />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>

      {footer !== undefined ? (
        <footer className="flex justify-end gap-2 border-t border-(--color-border) p-4">
          {footer}
        </footer>
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
