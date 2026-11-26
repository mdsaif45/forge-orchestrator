import { useEffect, useId, useRef } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Icon } from '../icons/Icon'
import { cn } from '../lib/cn'
import { IconButton } from './IconButton'

const panel = cva(
  [
    'fixed inset-y-0 m-0 flex h-full max-h-full flex-col',
    'bg-(--color-surface) text-(--color-text)',
    'border-(--color-edge-strong) shadow-(--elevation-floating)',
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
  readonly description?: string | undefined
  readonly footer?: React.ReactNode | undefined
  readonly children?: React.ReactNode | undefined
  readonly className?: string | undefined
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
      onClose()
    }

    dialog.addEventListener('cancel', onCancel)
    return () => {
      dialog.removeEventListener('cancel', onCancel)
    }
  }, [onClose])

  return (
    <dialog ref={ref} aria-labelledby={titleId} className={cn(panel({ side, size }), className)}>
      <header className="flex items-start justify-between gap-4 border-b border-(--color-edge-muted) p-4">
        <div className="flex flex-col gap-1">
          <h2 id={titleId} className="text-(length:--text-base) font-semibold text-(--color-text)">
            {title}
          </h2>
          {description !== undefined ? (
            <p className="typography-meta text-(--color-text-muted)">{description}</p>
          ) : null}
        </div>

        <IconButton
          label="Close panel"
          size="sm"
          onClick={onClose}
          icon={<Icon name="close" className="size-4" />}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-4">{children}</div>

      {footer !== undefined ? (
        <footer className="flex justify-end gap-2 border-t border-(--color-edge-muted) p-4">
          {footer}
        </footer>
      ) : null}
    </dialog>
  )
}
