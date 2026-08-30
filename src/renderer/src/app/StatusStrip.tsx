import type { ProjectView } from '@shared/ipc'
import { Badge, Button, Select, Separator, StatusDot } from '../ui'
import { useTheme } from '../ui'

/**
 * The always-visible frameless title bar / status strip.
 *
 * Designed with Claude Code Desktop aesthetics: seamless drag region,
 * integrated title bar overlay padding, smooth pill controls, and global workflow status.
 */
export interface StatusStripProps {
  readonly projects: readonly ProjectView[]
  readonly selectedProjectId: string | null
  readonly onSelectProject: (projectId: string) => void
  readonly onNewProject: () => void
  readonly workflowState: WorkflowStatePlaceholder
  readonly onOpenKitchenSink: () => void
}

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
  projects,
  selectedProjectId,
  onSelectProject,
  onNewProject,
  workflowState,
  onOpenKitchenSink,
}: StatusStripProps): React.JSX.Element {
  const { theme, toggleTheme } = useTheme()
  const presentation = STATE_PRESENTATION[workflowState]

  return (
    <header className="app-drag-region flex h-[38px] shrink-0 select-none items-center gap-2.5 border-b border-(--color-border) bg-(--color-surface) px-3 pr-36 text-(--color-text) transition-colors duration-(--duration-fast)">
      {/* Brand & App Title */}
      <div className="flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-md bg-(--color-accent)/15 text-(--color-accent) text-xs font-bold shadow-xs">
          ⚡
        </span>
        <span className="text-[13px] font-semibold tracking-tight text-(--color-text)">Forge</span>
      </div>

      <Separator orientation="vertical" className="h-3.5" />

      {/* Project Selector (Claude Code Desktop Pill) */}
      <div className="app-no-drag flex items-center gap-1.5">
        {projects.length === 0 ? (
          <span className="text-[12px] text-(--color-text-muted)">No project</span>
        ) : (
          <Select
            aria-label="Active project"
            className="h-7 w-44 rounded-lg text-[12px] font-medium"
            options={projects.map((project) => ({ value: project.id, label: project.name }))}
            value={selectedProjectId ?? ''}
            onChange={(event) => {
              onSelectProject(event.target.value)
            }}
          />
        )}

        <Button
          size="sm"
          variant="ghost"
          onClick={onNewProject}
          className="h-7 rounded-lg px-2 text-[12px] font-medium text-(--color-text-muted) hover:text-(--color-text)"
        >
          <span className="mr-1 text-[13px] font-bold">+</span> New
        </Button>
      </div>

      {/* Global Workflow Status Indicator */}
      <div
        aria-live="polite"
        className="ml-auto inline-flex items-center gap-1.5 rounded-full border border-(--color-border) bg-(--color-surface-raised) px-2.5 py-0.5 text-[11px] text-(--color-text-muted)"
      >
        <StatusDot
          status={presentation.status}
          pulse={workflowState === 'running'}
          label={presentation.label}
        />
        <span className="font-medium text-(--color-text)">{presentation.label}</span>
      </div>

      <Separator orientation="vertical" className="h-3.5" />

      <Badge tone="neutral" size="sm" className="rounded-md font-mono text-[10px]">
        pre-alpha
      </Badge>

      {/* Dev Kitchen Sink */}
      {import.meta.env.DEV && (
        <div className="app-no-drag">
          <Button
            size="sm"
            variant="ghost"
            onClick={onOpenKitchenSink}
            className="h-7 rounded-lg px-2 text-[11px] text-(--color-text-muted)"
          >
            Kitchen sink
          </Button>
        </div>
      )}

      {/* Theme Switcher */}
      <div className="app-no-drag">
        <Button
          size="sm"
          variant="ghost"
          onClick={toggleTheme}
          className="h-7 rounded-lg px-2 text-[12px] text-(--color-text-muted) hover:text-(--color-text)"
        >
          {theme === 'dark' ? '☀️ Light' : '🌙 Dark'}
        </Button>
      </div>
    </header>
  )
}
