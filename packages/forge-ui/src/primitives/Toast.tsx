import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { Icon } from '../icons/Icon'
import { cn } from '../lib/cn'
import { IconButton } from './IconButton'

const toast = cva(
  [
    'forge-glass-popover pointer-events-auto flex w-80 items-start gap-2.5',
    'rounded-(--radius-xl) border p-3.5 transition-all duration-(--duration-fast)',
  ],
  {
    variants: {
      tone: {
        neutral: 'border-(--color-edge-strong)',
        success: 'border-(--color-success)/40 text-(--color-success)',
        warning: 'border-(--color-warning)/40 text-(--color-warning)',
        danger: 'border-(--color-danger)/40 text-(--color-danger)',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export type ToastTone = NonNullable<VariantProps<typeof toast>['tone']>

export interface ToastMessage {
  readonly id: string
  readonly title: string
  readonly description?: string | undefined
  readonly tone?: ToastTone | undefined
  /** Duration in milliseconds before auto-dismiss. Defaults to 4500 (6000 for danger). Set 0 to disable. */
  readonly duration?: number | undefined
}

interface ToastContextValue {
  readonly show: (message: Omit<ToastMessage, 'id'>) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

export function useToast(): ToastContextValue {
  const context = useContext(ToastContext)
  if (context === null) throw new Error('useToast must be used inside <ToastProvider>')
  return context
}

export function ToastProvider({ children }: { children: React.ReactNode }): React.JSX.Element {
  const [messages, setMessages] = useState<readonly ToastMessage[]>([])

  const dismiss = useCallback((id: string) => {
    setMessages((current) => current.filter((message) => message.id !== id))
  }, [])

  const show = useCallback((message: Omit<ToastMessage, 'id'>) => {
    const id = crypto.randomUUID()
    setMessages((current) => [...current, { ...message, id }])
  }, [])

  const value = useMemo(() => ({ show }), [show])

  return (
    <ToastContext.Provider value={value}>
      {children}

      <div
        role="region"
        aria-live="polite"
        aria-label="Notifications"
        className="pointer-events-none fixed right-4 bottom-4 z-(--z-toast) flex flex-col gap-2"
      >
        {messages.map((message) => (
          <ToastItem key={message.id} message={message} onDismiss={dismiss} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({
  message,
  onDismiss,
}: {
  readonly message: ToastMessage
  readonly onDismiss: (id: string) => void
}): React.JSX.Element {
  const duration = message.duration ?? (message.tone === 'danger' ? 6000 : 4500)

  useEffect(() => {
    if (duration <= 0 || duration === Number.POSITIVE_INFINITY) return

    const timer = setTimeout(() => {
      onDismiss(message.id)
    }, duration)

    return () => {
      clearTimeout(timer)
    }
  }, [message.id, duration, onDismiss])

  return (
    <div className={cn(toast({ tone: message.tone }))}>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="typography-ui-label font-medium text-(--color-text)">{message.title}</p>
        {message.description !== undefined ? (
          <p className="typography-meta break-words text-(--color-text-muted)">
            {message.description}
          </p>
        ) : null}
      </div>

      <IconButton
        label="Dismiss notification"
        size="sm"
        onClick={() => {
          onDismiss(message.id)
        }}
        className="text-(--color-text-muted) hover:text-(--color-text)"
        icon={<Icon name="close" className="size-3.5" />}
      />
    </div>
  )
}
