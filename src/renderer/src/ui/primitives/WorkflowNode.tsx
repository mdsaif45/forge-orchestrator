import React from 'react'
import { cn } from '../cn'
import { StatusDot } from './StatusDot'

export type WorkflowNodeState =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'halted'
  | 'awaiting_user'

export interface WorkflowNodeProps extends React.HTMLAttributes<HTMLButtonElement> {
  readonly role: string
  readonly label: string
  readonly state: WorkflowNodeState
  readonly runtimeId?: string | null
  readonly verdict?: string | null
  readonly simulated?: boolean | null
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
      simulated = null,
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
          'group relative flex flex-col items-start gap-1.5 rounded-xl border p-3 text-left transition-all duration-(--duration-fast) cursor-pointer select-none',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-(--color-border-focus)',
          'min-w-[140px] max-w-[200px]',
          selected
            ? 'border-(--color-accent) bg-(--color-accent-muted) shadow-sm ring-1 ring-(--color-accent)'
            : 'border-(--color-border) bg-(--color-surface-raised) hover:border-(--color-border-strong) hover:bg-(--color-surface)',
          active ? 'ring-2 ring-(--color-accent)/50' : undefined,
          className,
        )}
        {...rest}
      >
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-[11px] font-semibold uppercase tracking-wider text-(--color-text-subtle)">
            {role}
          </span>
          <StatusDot status={status} pulse={state === 'running' || active} />
        </div>

        <div className="flex items-center gap-1.5">
          <span className="text-[13px] font-medium text-(--color-text)">
            {label}
          </span>
        </div>

        <div className="mt-1 flex w-full items-center justify-between gap-1.5 text-[11px] text-(--color-text-muted)">
          <span className="truncate">{runtimeId ?? state}</span>
          {verdict !== undefined && verdict !== null && (
            <span
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-semibold uppercase',
                simulated === true
                  ? 'bg-(--color-surface-inset) text-(--color-text-muted) ring-1 ring-(--color-border)'
                  : verdict === 'pass'
                    ? 'bg-(--color-success-muted) text-(--color-success)'
                    : verdict === 'fail'
                      ? 'bg-(--color-danger-muted) text-(--color-danger)'
                      : 'bg-(--color-surface-inset) text-(--color-text-muted)',
              )}
              title={
                simulated === true
                  ? 'Simulated: replayed from a scripted scenario, not real work'
                  : undefined
              }
            >
              {simulated === true ? `sim ${verdict}` : verdict}
            </span>
          )}
        </div>

        {simulated === true && (
          <span
            className={cn(
              'mt-1.5 block w-full rounded-md border border-(--color-warning)/40 bg-(--color-warning-muted) px-2 py-0.5 text-center',
              'font-mono text-[9px] font-bold uppercase tracking-wider text-(--color-warning)',
            )}
          >
            SIMULATED
          </span>
        )}
      </button>
    )
  },
)

WorkflowNode.displayName = 'WorkflowNode'
