import React from 'react'
import type { ToolCallEntry } from '@shared/domain'
import { Badge } from './Badge'
import { Spinner } from './Spinner'

export interface ToolCallTimelineProps {
  readonly tools: readonly ToolCallEntry[]
  readonly className?: string | undefined
}

function formatDuration(startedAt: string, finishedAt: string | null): string | null {
  if (finishedAt === null) return null
  const start = new Date(startedAt).getTime()
  const finish = new Date(finishedAt).getTime()
  if (Number.isNaN(start) || Number.isNaN(finish) || finish < start) return null
  const diffMs = finish - start
  if (diffMs < 1000) return `${String(diffMs)}ms`
  return `${(diffMs / 1000).toFixed(1)}s`
}

function toolCategoryTone(
  name: string,
): 'neutral' | 'accent' | 'info' | 'warning' | 'success' | 'danger' {
  const lower = name.toLowerCase()
  if (lower.includes('bash') || lower.includes('terminal') || lower.includes('exec'))
    return 'accent'
  if (lower.includes('write') || lower.includes('edit')) return 'warning'
  if (lower.includes('read')) return 'info'
  return 'neutral'
}

/**
 * Renders the live tool-call timeline for a workflow step.
 *
 * Axiom A3 Compliance:
 * A tool call is an agent claim about what it asked to do, never verified evidence.
 * The prominent warning banner explicitly reminds the operator that tool calls prove
 * invocation, not authoritative test passage or repository correctness.
 */
export function ToolCallTimeline({ tools, className }: ToolCallTimelineProps): React.JSX.Element {
  return (
    <div
      className={`flex flex-col rounded-xl border border-(--color-border) bg-(--color-surface-raised) text-[13px] overflow-hidden ${
        className ?? ''
      }`}
    >
      {/* Header with Axiom A3 demarcation */}
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-(--color-border) bg-(--color-surface) px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="font-semibold text-(--color-text)">Tool Call Timeline</span>
          <span className="text-[11px] text-(--color-text-muted)">({String(tools.length)})</span>
        </div>
        <div className="flex items-center gap-1.5">
          <Badge tone="warning" size="sm" className="font-semibold">
            Agent Claim • Not Physical Evidence
          </Badge>
        </div>
      </div>

      {/* Timeline items list */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2 max-h-[450px]">
        {tools.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center text-(--color-text-muted)">
            <p className="text-[12px]">No tool calls recorded for this step.</p>
            <p className="text-[11px] text-(--color-text-muted)/70 mt-1">
              Tool invocations will stream here in real time as the agent executes.
            </p>
          </div>
        ) : (
          tools.map((tool) => {
            const duration = formatDuration(tool.startedAt, tool.finishedAt)
            return (
              <div
                key={tool.id}
                className="flex flex-col gap-1 rounded-lg border border-(--color-border)/70 bg-(--color-surface-inset)/60 p-2.5 transition-colors"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-2">
                    <Badge tone={toolCategoryTone(tool.name)} size="sm" className="font-mono">
                      {tool.name}
                    </Badge>
                    <span className="font-mono text-[12px] font-medium text-(--color-text) truncate max-w-[280px]">
                      {tool.target || tool.name}
                    </span>
                  </div>

                  <div className="flex items-center gap-2">
                    {duration !== null && (
                      <span className="text-[11px] font-mono text-(--color-text-muted)">
                        {duration}
                      </span>
                    )}

                    {tool.status === 'running' && (
                      <Badge tone="accent" size="sm" className="gap-1 animate-pulse">
                        <Spinner className="h-3 w-3" />
                        Running
                      </Badge>
                    )}
                    {tool.status === 'completed' && (
                      <Badge tone="success" size="sm">
                        ✓ Completed
                      </Badge>
                    )}
                    {tool.status === 'failed' && (
                      <Badge tone="danger" size="sm">
                        ✕ Failed
                      </Badge>
                    )}
                  </div>
                </div>

                {tool.detail && tool.detail !== tool.target && (
                  <div className="mt-1 font-mono text-[11px] text-(--color-text-muted) break-all line-clamp-2 bg-(--color-surface)/50 p-1.5 rounded">
                    {tool.detail}
                  </div>
                )}
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
