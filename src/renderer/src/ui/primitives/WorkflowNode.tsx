import React from 'react'
import { cn } from '../cn'
import { StatusDot } from './StatusDot'

export type WorkflowNodeState =
  'pending' | 'running' | 'completed' | 'failed' | 'halted' | 'awaiting_user'

export interface WorkflowNodeProps extends React.HTMLAttributes<HTMLButtonElement> {
  readonly role: string
  readonly label: string
  readonly state: WorkflowNodeState
  readonly runtimeId?: string | null
  readonly verdict?: string | null
  readonly selected?: boolean
  readonly active?: boolean
}

export const WorkflowNode = React.forwardRef<HTMLButtonElement, WorkflowNodeProps>(
  function WorkflowNode(
    {
      role,
      label,
      state,
      runtimeId,
      verdict,
      selected = false,
      active = false,
      className,
      onClick,
      ...rest
    },
    ref,
  ) {
    const status: 'idle' | 'running' | 'waiting' | 'passed' | 'failed' | 'halted' =
      state === 'running'
        ? 'running'
        : state === 'completed'
          ? 'passed'
          : state === 'failed'
            ? 'failed'
            : state === 'halted'
              ? 'halted'
              : state === 'awaiting_user'
                ? 'waiting'
                : 'idle'

    return (
      <button
        ref={ref}
        type="button"
        onClick={onClick}
        aria-pressed={selected}
        aria-current={active ? 'step' : undefined}
        className={cn(
          'group relative flex flex-col items-start gap-1.5 rounded-lg border p-3 text-left transition-all',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2',
          'min-w-[140px] max-w-[200px]',
          selected
            ? 'border-blue-500 bg-blue-950/20 shadow-md ring-1 ring-blue-500'
            : 'border-neutral-800 bg-neutral-900/80 hover:border-neutral-700 hover:bg-neutral-800/60',
          active ? 'ring-2 ring-blue-500/50' : undefined,
          className,
        )}
        {...rest}
      >
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
            {role}
          </span>
          <StatusDot status={status} pulse={state === 'running' || active} />
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-sm font-medium text-neutral-100 group-hover:text-white">
            {label}
          </span>
        </div>

        <div className="mt-1 flex w-full items-center justify-between text-[11px] text-neutral-400">
          <span className="truncate">{runtimeId ?? state}</span>
          {verdict !== undefined && verdict !== null && (
            <span
              className={cn(
                'rounded px-1 py-0.5 font-mono text-[10px] uppercase',
                verdict === 'pass'
                  ? 'bg-emerald-950/60 text-emerald-400'
                  : verdict === 'fail'
                    ? 'bg-red-950/60 text-red-400'
                    : 'bg-neutral-800 text-neutral-300',
              )}
            >
              {verdict}
            </span>
          )}
        </div>
      </button>
    )
  },
)
