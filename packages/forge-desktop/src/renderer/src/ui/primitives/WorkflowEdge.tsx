import React from 'react'
import { cn } from '../cn'

export interface WorkflowEdgeProps extends React.HTMLAttributes<HTMLDivElement> {
  readonly state?: 'pending' | 'active' | 'completed' | 'failed'
  readonly label?: string
}

export function WorkflowEdge({
  state = 'pending',
  label,
  className,
  ...rest
}: WorkflowEdgeProps): React.JSX.Element {
  const isCompleted = state === 'completed'
  const isActive = state === 'active'
  const isFailed = state === 'failed'

  return (
    <div
      className={cn('flex items-center justify-center px-1 text-(--color-text-muted)', className)}
      {...rest}
    >
      <div className="flex items-center gap-1">
        <div
          className={cn(
            'h-0.5 w-6 transition-colors duration-(--duration-base)',
            isCompleted
              ? 'bg-(--color-success)'
              : isActive
                ? 'bg-(--color-accent) animate-pulse'
                : isFailed
                  ? 'bg-(--color-danger)'
                  : 'bg-(--color-border-strong)',
          )}
        />
        {label !== undefined && (
          <span className="text-[10px] font-mono text-(--color-text-muted)">{label}</span>
        )}
        <svg
          className={cn(
            'h-3 w-3 transition-colors duration-(--duration-base)',
            isCompleted
              ? 'text-(--color-success)'
              : isActive
                ? 'text-(--color-accent)'
                : isFailed
                  ? 'text-(--color-danger)'
                  : 'text-(--color-border-strong)',
          )}
          fill="currentColor"
          viewBox="0 0 20 20"
        >
          <path
            fillRule="evenodd"
            d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
            clipRule="evenodd"
          />
        </svg>
      </div>
    </div>
  )
}
