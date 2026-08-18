import { Badge, Button, Separator, StatusDot } from '../ui'
import { useTheme } from '../ui'

/**
 * The always-visible status strip.
 *
 * A long-running orchestrator's most-asked question is "what is happening right
 * now", so workflow state is global chrome rather than something to navigate to.
 *
 * The state shown here is a placeholder until the workflow engine lands in #32;
 * the shape it renders is the real one.
 */
export interface StatusStripProps {
  readonly projectName: string | null
  readonly workflowState: WorkflowStatePlaceholder
  readonly onOpenKitchenSink: () => void
}

/**
 * A subset of the real `WorkflowState` from `docs/PLAN.md`, enough to render the
 * pill. Replaced by the shared domain type in #14.
 */
export type WorkflowStatePlaceholder = 'idle' | 'running' | 'waiting' | 'passed' | 'failed'

const STATE_PRESENTATION: Record<
  WorkflowStatePlaceholder,
  { readonly label: string; readonly status: 'idle' | 'running' | 'waiting' | 'passed' | 'failed' }
> = {
  idle: { label: 'Idle', status: 'idle' },
  running: { label: 'Running', status: 'running' },
  waiting: { label: 'Waiting for you', status: 'waiting' },
  passed: { label: 'Complete', status: 'passed' },
  failed: { label: 'Halted', status: 'failed' },
}

export function StatusStrip({
  projectName,
  workflowState,
  onOpenKitchenSink,
}: StatusStripProps): React.JSX.Element {
  const { theme, toggleTheme } = useTheme()
  const presentation = STATE_PRESENTATION[workflowState]

  return (
    <header className="flex h-10 shrink-0 items-center gap-3 border-b border-(--color-border) bg-(--color-surface) px-3">
      <span className="text-(length:--text-sm) font-semibold">Forge</span>

      <Separator orientation="vertical" className="h-4" />

      <span className="text-(length:--text-xs) text-(--color-text-muted)">
        {projectName ?? 'No project'}
      </span>

      {/* `aria-live` so a state change is announced without stealing focus. */}
      <span
        aria-live="polite"
        className="ml-auto inline-flex items-center gap-1.5 text-(length:--text-xs) text-(--color-text-muted)"
      >
        <StatusDot
          status={presentation.status}
          pulse={workflowState === 'running'}
          label={presentation.label}
        />
        {presentation.label}
      </span>

      <Separator orientation="vertical" className="h-4" />

      <Badge tone="neutral" size="sm">
        pre-alpha
      </Badge>

      <Button size="sm" variant="ghost" onClick={onOpenKitchenSink}>
        Kitchen sink
      </Button>

      <Button size="sm" variant="ghost" onClick={toggleTheme}>
        {theme === 'dark' ? 'Light' : 'Dark'}
      </Button>
    </header>
  )
}
