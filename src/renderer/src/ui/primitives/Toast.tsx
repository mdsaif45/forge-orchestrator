import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../cn'
import { IconButton } from './IconButton'

/**
 * Transient notifications.
 *
 * Reserved for feedback on completed actions. Automatically dismisses after
 * a duration (default 4.5s, 6s for danger/errors) or when manually dismissed by user.
 */
const toast = cva(
  [
    'pointer-events-auto flex w-80 items-start gap-2.5',
    'rounded-xl border p-3.5 shadow-lg backdrop-blur-xs transition-all duration-(--duration-fast)',
  ],
  {
    variants: {
      tone: {
        neutral: 'bg-(--color-surface-raised) border-(--color-border-strong)',
        success: 'bg-(--color-surface-raised) border-(--color-success)/40 text-(--color-success)',
        warning: 'bg-(--color-surface-raised) border-(--color-warning)/40 text-(--color-warning)',
        danger: 'bg-(--color-surface-raised) border-(--color-danger)/40 text-(--color-danger)',
      },
    },
    defaultVariants: { tone: 'neutral' },
  },
)

export type ToastTone = NonNullable<VariantProps<typeof toast>['tone']>

export interface ToastMessage {
  readonly id: string
  readonly title: string
  readonly description?: string
  readonly tone?: ToastTone
  /** Duration in milliseconds before auto-dismiss. Defaults to 4500 (6000 for danger). Set to 0 to disable. */
  readonly duration?: number
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

      {/* `polite` so a toast never interrupts what the user is reading. */}
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
        <p className="text-[13px] font-medium text-(--color-text)">
          {message.title}
        </p>
        {message.description !== undefined ? (
          <p className="text-[12px] break-words text-(--color-text-muted)">
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
        icon={
          <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
          </svg>
        }
      />
    </div>
  )
}
