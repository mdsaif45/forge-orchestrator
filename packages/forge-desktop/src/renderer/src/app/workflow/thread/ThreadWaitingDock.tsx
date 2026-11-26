import { Badge, Button, Icon, StatusDot } from '@renderer/ui'
import type { WaitingGateTarget } from './threadProjection'

export interface ThreadWaitingDockProps {
  readonly target: WaitingGateTarget | null
  readonly isTargetVisible: boolean
  readonly onJumpToTarget: (waitingId: string) => void
}

/**
 * Sticky prompt banner rendered immediately above the thread composer whenever an
 * active Q&A, Axiom A4 decision lock, or approval gate is waiting off-screen.
 */
export function ThreadWaitingDock({
  target,
  isTargetVisible,
  onJumpToTarget,
}: ThreadWaitingDockProps): React.JSX.Element | null {
  if (target === null || isTargetVisible) {
    return null
  }

  return (
    <div
      role="status"
      aria-live="polite"
      className="border-t border-(--color-warning)/40 bg-(--color-warning-muted)/45 px-4 py-2 sm:px-6"
    >
      <div className="mx-auto flex max-w-(--reading-column-wide) items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2">
          <StatusDot status="waiting" pulse label={target.label} />
          <Badge tone="warning" size="sm">
            {target.kind === 'question'
              ? 'Question'
              : target.kind === 'decision'
                ? 'Decision'
                : 'Gate'}
          </Badge>
          <span className="typography-meta font-semibold text-(--color-text)">{target.label}:</span>
          <span className="truncate typography-meta text-(--color-text-muted)">
            {target.summary}
          </span>
        </div>

        <Button
          variant="secondary"
          size="xs"
          onClick={() => {
            onJumpToTarget(target.id)
          }}
          className="shrink-0"
        >
          <Icon name="arrow-right" className="size-3.5" />
          <span>Jump to card</span>
        </Button>
      </div>
    </div>
  )
}
