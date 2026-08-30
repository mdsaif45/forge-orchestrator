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
      className={`p-4 transition-all ${
        isAssigned ? 'border-(--color-accent)/40 shadow-xs' : 'border-(--color-border)'
      }`}
    >
      <div className="flex flex-col gap-3">
        {/* Header Row */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-(--color-surface-inset) border border-(--color-border) font-bold text-[13px] text-(--color-accent)">
              {name.charAt(0).toUpperCase()}
            </div>
            <div>
              <div className="flex items-center gap-2">
                <span className="font-bold text-[14px] text-(--color-text)">{name}</span>
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
              <p className="m-0 mt-0.5 font-mono text-[11px] text-(--color-text-muted)">
                Engine: <span className="text-(--color-text)">{runtimeId}</span>
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
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

        {/* Custom Persona / Instructions */}
        {instructions && instructions.trim() !== '' && (
          <div className="rounded-lg bg-(--color-surface-inset) border border-(--color-border) p-2.5 text-[11px] font-mono text-(--color-text-muted) line-clamp-2">
            {instructions}
          </div>
        )}

        {/* Capabilities Pill List */}
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          {capabilities.map((cap) => (
            <span
              key={cap}
              className="rounded-md bg-(--color-surface-inset) px-2 py-0.5 font-mono text-[10px] text-(--color-text-subtle) border border-(--color-border)"
            >
              {cap}
            </span>
          ))}
        </div>
      </div>
    </Card>
  )
}
