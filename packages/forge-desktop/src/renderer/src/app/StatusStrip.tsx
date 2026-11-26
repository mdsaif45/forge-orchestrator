import type { ProjectView } from '@shared/ipc'
import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Icon,
  IconButton,
  Separator,
  StatusDot,
  Tooltip,
} from '../ui'

/**
 * The always-visible frameless title bar / status strip.
 *
 * Provides the window drag region, unified @forge/ui Project Switcher dropdown,
 * active workflow indicator, right context panel toggle, and dev kitchen sink launcher.
 */
export interface StatusStripProps {
  readonly projects: readonly ProjectView[]
  readonly selectedProjectId: string | null
  readonly onSelectProject: (projectId: string) => void
  readonly onNewProject: () => void
  readonly onProjectSettings?: () => void
  readonly workflowState?: WorkflowStatePlaceholder | undefined
  readonly contextPanelOpen?: boolean | undefined
  readonly hasUnreadPlan?: boolean | undefined
  readonly drawerBadgeCount?: number | undefined
  readonly onToggleContextPanel?: () => void
  readonly onOpenKitchenSink: () => void
}

export type WorkflowStatePlaceholder = 'idle' | 'running' | 'waiting' | 'passed' | 'failed'

const WORKFLOW_STATUS_LABELS: Record<Exclude<WorkflowStatePlaceholder, 'idle'>, string> = {
  running: 'Running',
  waiting: 'Waiting',
  passed: 'Passed',
  failed: 'Halted',
}

export function StatusStrip({
  projects,
  selectedProjectId,
  onSelectProject,
  onNewProject,
  onProjectSettings,
  workflowState = 'idle',
  contextPanelOpen = false,
  hasUnreadPlan = false,
  drawerBadgeCount = 0,
  onToggleContextPanel,
  onOpenKitchenSink,
}: StatusStripProps): React.JSX.Element {
  const activeProject = projects.find((project) => project.id === selectedProjectId) ?? null
  const activeWorkflowLabel =
    workflowState === 'idle' ? null : WORKFLOW_STATUS_LABELS[workflowState]

  return (
    <header className="app-drag-region flex h-(--header-height) shrink-0 select-none items-center gap-2 border-b border-(--color-edge) bg-(--color-surface) px-3 pr-36 text-(--color-text) transition-colors duration-(--duration-fast)">
      {/* Brand & App Title */}
      <div className="flex items-center gap-2">
        <span className="flex size-5 items-center justify-center rounded-(--radius-md) border border-(--color-accent)/25 bg-(--color-accent-muted) text-(--color-accent)">
          <Icon name="workflows" className="size-3.5" />
        </span>
        <span className="typography-ui-label font-semibold tracking-tight text-(--color-text)">
          Forge
        </span>
      </div>

      <Separator orientation="vertical" className="h-3.5" />

      {/* Unified Project Switcher Dropdown */}
      <div className="app-no-drag flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              size="sm"
              variant="secondary"
              aria-label="Active project"
              className="max-w-60 justify-between gap-2 rounded-(--radius-lg) px-2.5"
            >
              <span className="flex min-w-0 items-center gap-1.5">
                <Icon name="project" className="size-3.5 text-(--color-text-muted)" />
                <span className="truncate typography-meta font-medium text-(--color-text)">
                  {activeProject?.name ?? 'Select project'}
                </span>
              </span>
              <Icon name="chevron-down" className="size-3.5 text-(--color-text-subtle)" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" sideOffset={6} className="w-72">
            <DropdownMenuGroup>
              <DropdownMenuLabel>Projects</DropdownMenuLabel>
              {projects.length === 0 ? (
                <div className="px-2 py-2 typography-meta text-(--color-text-subtle)">
                  No projects linked yet.
                </div>
              ) : (
                projects.map((project) => {
                  const isSelected = project.id === selectedProjectId
                  return (
                    <DropdownMenuItem
                      key={project.id}
                      onClick={() => {
                        onSelectProject(project.id)
                      }}
                      className="items-start justify-between gap-2 py-1.5"
                    >
                      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                        <span className="truncate typography-meta font-medium text-(--color-text)">
                          {project.name}
                        </span>
                        <span className="truncate typography-micro text-(--color-text-subtle)">
                          {project.repository.absolutePath}
                        </span>
                      </div>
                      {isSelected ? (
                        <Icon
                          name="check"
                          className="mt-0.5 size-3.5 shrink-0 text-(--color-accent)"
                        />
                      ) : null}
                    </DropdownMenuItem>
                  )
                })
              )}
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onNewProject}>
              <Icon name="plus" className="size-3.5 text-(--color-accent)" />
              <span>+ New project</span>
            </DropdownMenuItem>
            {onProjectSettings !== undefined ? (
              <DropdownMenuItem onClick={onProjectSettings}>
                <Icon name="settings" className="size-3.5 text-(--color-text-muted)" />
                <span>Project settings</span>
              </DropdownMenuItem>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      {/* Right Header Controls */}
      <div className="ml-auto app-no-drag flex items-center gap-1.5">
        {activeWorkflowLabel !== null ? (
          <div className="flex h-7 items-center gap-1.5 rounded-(--radius-lg) border border-(--color-edge-muted) bg-(--color-surface-raised) px-2.5 typography-micro text-(--color-text-muted)">
            <StatusDot
              status={workflowState}
              pulse={workflowState === 'running'}
              label={`Workflow ${activeWorkflowLabel}`}
            />
            <span>{activeWorkflowLabel}</span>
          </div>
        ) : null}

        <Badge
          tone="neutral"
          size="sm"
          className="rounded-(--radius-md) font-mono typography-micro"
        >
          pre-alpha
        </Badge>

        {import.meta.env.DEV && (
          <Button
            size="xs"
            variant="ghost"
            onClick={onOpenKitchenSink}
            className="font-mono text-(--color-text-subtle) hover:text-(--color-text)"
          >
            Kitchen sink
          </Button>
        )}

        {onToggleContextPanel !== undefined ? (
          <Tooltip
            content={contextPanelOpen ? 'Hide context panel' : 'Show context panel'}
            side="bottom"
          >
            <div className="relative inline-flex items-center">
              <IconButton
                size="sm"
                variant={contextPanelOpen ? 'secondary' : 'ghost'}
                label={contextPanelOpen ? 'Hide context panel' : 'Show context panel'}
                aria-pressed={contextPanelOpen}
                icon={<Icon name="panel-right" />}
                onClick={onToggleContextPanel}
              />
              {!contextPanelOpen && (hasUnreadPlan || drawerBadgeCount > 0) ? (
                <span
                  aria-label="Unread execution context updates"
                  className="pointer-events-none absolute -top-0.5 -right-0.5 size-2 rounded-(--radius-full) bg-(--color-accent)"
                />
              ) : null}
            </div>
          </Tooltip>
        ) : null}
      </div>
    </header>
  )
}
