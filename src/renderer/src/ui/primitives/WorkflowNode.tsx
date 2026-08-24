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
  /**
   * Whether this step's runtime replays scripted output instead of doing real work.
   *
   * Null means no runtime is bound, or its identity is unknown — deliberately not
   * treated as "real", because absence of evidence is not evidence of verification.
   */
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

        <div className="mt-1 flex w-full items-center justify-between gap-1.5 text-[11px] text-neutral-400">
          <span className="truncate">{runtimeId ?? state}</span>
          {verdict !== undefined && verdict !== null && (
            <span
              // A simulated verdict never borrows the success or failure colour. The
              // whole defect in #101 was that a mock's scripted "pass" was rendered
              // identically to evidence Forge had actually gathered — the same
              // substitution of a claim for a verified fact that A3 exists to prevent.
              // Neutral styling and a "sim" prefix keep the outcome legible without
              // letting it read as proof.
              className={cn(
                'shrink-0 rounded px-1 py-0.5 font-mono text-[10px] uppercase',
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
          // Stated on the node itself, not left to the small runtime id underneath.
          // That id ("mock:default") carried the entire weight of "none of this is
          // real" and lost, which is how a scripted run read as a completed one.
          <div className="mt-1 w-full rounded bg-(--color-warning-muted) px-1.5 py-0.5 text-center text-[10px] font-medium uppercase tracking-wide text-(--color-warning)">
            simulated
          </div>
        )}
      </button>
    )
  },
)
