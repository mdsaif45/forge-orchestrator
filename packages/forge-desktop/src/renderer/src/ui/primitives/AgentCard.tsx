import React from 'react'
import { Badge } from './Badge'
import { Button } from './Button'
import { Card } from './Card'

export interface AgentCardProps {
  readonly id: string
  readonly name: string
  readonly roleType: 'planner' | 'implementer' | 'reviewer' | 'custom'
  readonly runtimeId: string
  readonly instructions?: string | undefined
  readonly capabilities: readonly string[]
  readonly isAssigned?: boolean | undefined
  readonly assignedRole?: string | undefined
  readonly isCustom?: boolean | undefined
  readonly onAssign?: (() => void) | undefined
  readonly onDelete?: (() => void) | undefined
}

export function AgentCard({
  name,
  roleType,
  runtimeId,
  instructions,
  capabilities,
  isAssigned,
  assignedRole,
  isCustom,
  onAssign,
  onDelete,
}: AgentCardProps): React.JSX.Element {
  return (
    <Card
      tone="raised"
      className={`p-3 transition-all flex flex-col ${
        isAssigned ? 'border-(--color-accent)/40 shadow-xs' : 'border-(--color-border)'
      }`}
    >
      {/* Header Row: avatar + name/badge + bound/actions */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-start gap-2 min-w-0">
          <div className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-(--color-surface-inset) border border-(--color-border) font-bold text-[12px] text-(--color-accent) mt-0.5">
            {name.charAt(0).toUpperCase()}
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-bold text-[13px] text-(--color-text) truncate">{name}</span>
              <Badge
                tone={
                  roleType === 'planner'
                    ? 'warning'
                    : roleType === 'implementer'
                      ? 'accent'
                      : roleType === 'reviewer'
                        ? 'success'
                        : 'neutral'
                }
                size="sm"
                className="capitalize font-medium"
              >
                {roleType}
              </Badge>
            </div>
            <p className="m-0 font-mono text-[10px] text-(--color-text-muted)">
              Engine: <span className="text-(--color-text)">{runtimeId}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-1.5 shrink-0">
          {assignedRole && (
            <Badge tone="accent" size="sm" className="font-mono text-[10px]">
              Bound to {assignedRole}
            </Badge>
          )}
          {onAssign && (
            <Button size="sm" variant="secondary" onClick={onAssign} className="text-[11px]">
              Assign Role
            </Button>
          )}
          {isCustom && onDelete && (
            <Button
              size="sm"
              variant="ghost"
              onClick={onDelete}
              className="text-[11px] text-(--color-danger) hover:text-(--color-danger)"
            >
              Remove
            </Button>
          )}
        </div>
      </div>

      {/* Instructions — fixed height for alignment across cards */}
      {instructions && instructions.trim() !== '' && (
        <div className="mt-2 rounded-lg bg-(--color-surface-inset) border border-(--color-border) p-2 text-[11px] font-mono text-(--color-text-muted) line-clamp-2">
          {instructions}
        </div>
      )}

      {/* Capabilities Pill List — pushed to bottom */}
      <div className="flex flex-wrap items-center gap-1.5 mt-auto pt-2">
        {capabilities.map((cap) => (
          <span
            key={cap}
            className="rounded-md bg-(--color-surface-inset) px-2 py-0.5 font-mono text-[10px] text-(--color-text-subtle) border border-(--color-border)"
          >
            {cap}
          </span>
        ))}
      </div>
    </Card>
  )
}
