import { createContext, useCallback, useContext, useMemo, useState } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from '../cn'
import { IconButton } from './IconButton'

/**
 * Transient notifications.
 *
 * Reserved for feedback on completed actions. Anything a workflow is *blocked*
 * on belongs in the question queue (#39), not in a toast that can be missed —
 * axiom A2 requires a durable place to answer, not a disappearing one.
 */
const toast = cva(
  [
    'pointer-events-auto flex w-80 items-start gap-2.5',
    'rounded-(--radius-lg) border p-3 shadow-(--shadow-md)',
  ],
  {
    variants: {
      tone: {
        neutral: 'bg-(--color-surface-overlay) border-(--color-border-strong)',
        success: 'bg-(--color-surface-overlay) border-(--color-success)/40',
        warning: 'bg-(--color-surface-overlay) border-(--color-warning)/40',
        danger: 'bg-(--color-surface-overlay) border-(--color-danger)/40',
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
    // `crypto.randomUUID` is available in the renderer and avoids a counter that
    // could collide across remounts.
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
          <div key={message.id} className={cn(toast({ tone: message.tone }))}>
            <div className="flex min-w-0 flex-1 flex-col gap-0.5">
              <p className="text-(length:--text-sm) font-medium text-(--color-text)">
                {message.title}
              </p>
              {message.description !== undefined ? (
                <p className="text-(length:--text-xs) break-words text-(--color-text-muted)">
                  {message.description}
                </p>
              ) : null}
            </div>

            <IconButton
              label="Dismiss notification"
              size="sm"
              onClick={() => dismiss(message.id)}
              icon={
                <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M4 4l8 8M12 4l-8 8" strokeLinecap="round" />
                </svg>
              }
            />
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  )
}
