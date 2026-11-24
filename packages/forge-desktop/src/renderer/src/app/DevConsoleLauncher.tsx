import React from 'react'
import { useDevConsoleStore } from './devConsoleStore'
import { cn } from '../ui'

/**
 * Bottom-right launcher icon for the Dev Console.
 *
 * Click to toggle the docked Dev Console (1/4 screen at bottom by default, or right panel).
 * Visible only in development mode.
 */
export function DevConsoleLauncher(): React.JSX.Element | null {
  const isOpen = useDevConsoleStore((state) => state.isOpen)
  const toggleDevConsole = useDevConsoleStore((state) => state.toggleDevConsole)
  const transactions = useDevConsoleStore((state) => state.transactions)

  if (!import.meta.env.DEV) return null

  const pendingCount = transactions.filter((t) => t.status === 'pending').length

  return (
    <button
      type="button"
      onClick={toggleDevConsole}
      title={isOpen ? 'Close Dev Console' : 'Open Dev Console (AI Network Transactions)'}
      className={cn(
        'fixed bottom-3 right-4 z-40 flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[11px] font-mono shadow-lg transition-all backdrop-blur-md cursor-pointer',
        isOpen
          ? 'border-(--color-accent) bg-(--color-accent)/20 text-(--color-accent) shadow-(--color-accent)/10 ring-1 ring-(--color-accent)/30'
          : 'border-(--color-border) bg-(--color-surface-raised)/90 text-(--color-text-muted) hover:border-(--color-accent)/50 hover:bg-(--color-surface-overlay) hover:text-(--color-text)',
      )}
    >
      <span className="relative flex h-2 w-2">
        {pendingCount > 0 ? (
          <>
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-emerald-500" />
          </>
        ) : (
          <span
            className={cn(
              'inline-flex h-2 w-2 rounded-full',
              isOpen ? 'bg-(--color-accent)' : 'bg-neutral-500',
            )}
          />
        )}
      </span>

      <span className="font-semibold tracking-tight">DEV CONSOLE</span>

      {transactions.length > 0 && (
        <span
          className={cn(
            'ml-0.5 rounded-full px-1.5 py-0.2 text-[9.5px] font-medium leading-none',
            pendingCount > 0
              ? 'bg-emerald-500/20 text-emerald-400'
              : 'bg-(--color-surface-inset) text-(--color-text-subtle)',
          )}
        >
          {transactions.length}
        </span>
      )}
    </button>
  )
}
