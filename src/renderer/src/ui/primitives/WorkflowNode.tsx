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
  readonly label?: string | undefined
  readonly personaName?: string | undefined
  readonly personaIcon?: string | undefined
  readonly stageLabel?: string | undefined
  readonly state: WorkflowNodeState
  readonly runtimeId?: string | null | undefined
  readonly verdict?: string | null | undefined
  readonly simulated?: boolean | null | undefined
  readonly selected?: boolean | undefined
  readonly active?: boolean | undefined
}

export const WorkflowNode = React.forwardRef<HTMLButtonElement, WorkflowNodeProps>(
  function WorkflowNode(
    {
      role,
      label,
      personaName,
      personaIcon,
      stageLabel,
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
        : verdict === 'pass' || state === 'completed'
          ? 'passed'
          : verdict === 'fail' || state === 'failed'
            ? 'failed'
            : state === 'halted'
              ? 'halted'
              : state === 'awaiting_user'
                ? 'waiting'
                : 'idle'

    // Determine friendly human persona display
    const resolvedIcon =
      personaIcon ??
      (role === 'planner'
        ? '🧠'
        : role === 'user'
          ? '👤'
          : role === 'implementer'
            ? '💻'
            : role === 'reviewer'
              ? '🔍'
              : '⚙️')

    const resolvedPersona =
      personaName ??
      (role === 'planner'
        ? 'Alex (Planner)'
        : role === 'user'
          ? 'You (Approval Gate)'
          : role === 'implementer'
            ? 'Sam (Implementer)'
            : role === 'reviewer'
              ? 'Morgan (Reviewer)'
              : 'Forge Engine')

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
          'min-w-[170px] max-w-[220px]',
          selected
            ? 'border-(--color-accent) bg-(--color-accent)/10 shadow-sm ring-1 ring-(--color-accent)'
            : 'border-(--color-border) bg-(--color-surface-raised) hover:border-(--color-border-strong) hover:bg-(--color-surface)',
          active ? 'ring-2 ring-(--color-accent)/60 animate-pulse' : undefined,
          className,
        )}
        {...rest}
      >
        {/* Top: Stage Tag & Live Status Dot */}
        <div className="flex w-full items-center justify-between gap-2 border-b border-(--color-border)/40 pb-1.5">
          <span className="text-[10px] font-bold uppercase tracking-wider text-(--color-text-subtle) truncate">
            {stageLabel ?? role}
          </span>
          <StatusDot status={status} pulse={state === 'running' || active} />
        </div>

        {/* Middle: Friendly Persona Name & Icon */}
        <div className="flex items-center gap-2 py-0.5 w-full">
          <span className="text-[16px] shrink-0">{resolvedIcon}</span>
          <div className="truncate">
            <span className="text-[13px] font-bold text-(--color-text) truncate block">
              {label ?? resolvedPersona}
            </span>
            {label && label !== resolvedPersona && (
              <span className="text-[10px] text-(--color-text-muted) truncate block">
                {resolvedPersona}
              </span>
            )}
          </div>
        </div>

        {/* Bottom: Engine & Verdict */}
        <div className="mt-1 flex w-full items-center justify-between gap-1.5 text-[11px] text-(--color-text-muted) border-t border-(--color-border)/30 pt-1.5">
          <div className="flex items-center gap-1 font-mono text-[10px] truncate max-w-[95px]" title={runtimeId ?? state}>
            <span className="truncate">{runtimeId ?? (role === 'user' ? 'human-gate' : state)}</span>
            {simulated === true && (
              <span className="shrink-0 text-[9px] text-(--color-text-muted)">simulated</span>
            )}
          </div>
          {verdict !== undefined && verdict !== null && (
            <span
              className={cn(
                'shrink-0 rounded px-1.5 py-0.5 font-mono text-[10px] font-bold uppercase',
                simulated === true
                  ? 'bg-(--color-surface-inset) text-(--color-text-muted) ring-1 ring-(--color-border)'
                  : verdict === 'pass'
                    ? 'bg-(--color-success)/15 text-(--color-success)'
                    : verdict === 'fail'
                      ? 'bg-(--color-danger)/15 text-(--color-danger)'
                      : 'bg-(--color-surface-inset) text-(--color-text-muted)',
              )}
            >
              {simulated === true ? `sim ${verdict}` : verdict}
            </span>
          )}
        </div>
      </button>
    )
  }
)
