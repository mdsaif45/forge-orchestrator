import React from 'react'
import type { RoleBindingsView, WorkflowTemplateView } from '@shared/ipc'
import { Badge } from './Badge'
import { Button } from './Button'
import { Card } from './Card'

export interface WorkflowLaunchpadProps {
  readonly projectName: string
  readonly repositoryPath: string
  readonly templates: readonly WorkflowTemplateView[]
  readonly selectedTemplateId: string
  readonly onSelectTemplate: (templateId: string) => void
  readonly onStartWork: (templateId?: string) => void
  readonly onCreateTemplate: () => void
  readonly bindings: RoleBindingsView | null
}

const TEMPLATE_ICONS: Record<string, string> = {
  feature: '🚀',
  bugfix: '🐛',
  security: '🛡️',
  refactor: '⚙️',
  investigation: '🔍',
}

export function WorkflowLaunchpad({
  projectName,
  repositoryPath,
  templates,
  selectedTemplateId,
  onSelectTemplate,
  onStartWork,
  onCreateTemplate,
  bindings,
}: WorkflowLaunchpadProps): React.JSX.Element {
  return (
    <div className="flex flex-1 flex-col gap-6 overflow-y-auto p-2">
      {/* 1. HERO HEADER */}
      <div className="rounded-2xl border border-(--color-border) bg-(--color-surface-raised) p-6 shadow-sm">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <span className="flex size-7 items-center justify-center rounded-lg bg-(--color-accent)/15 text-(--color-accent) text-sm font-bold">
                ⚡
              </span>
              <h2 className="text-[18px] font-bold text-(--color-text)">
                Launch Multi-Agent Work on{' '}
                <span className="text-(--color-accent)">{projectName}</span>
              </h2>
            </div>
            <p className="max-w-2xl text-[12px] leading-relaxed text-(--color-text-muted)">
              Autonomous agent teams collaborate under a shared protocol: planning architecture,
              pausing for human review gates, executing sandboxed edits in a git worktree, and
              auditing code quality before merge.
            </p>
            <div className="pt-1 text-[11px] font-mono text-(--color-text-subtle)">
              Repository Path: <span className="text-(--color-text)">{repositoryPath}</span>
            </div>
          </div>

          <div className="flex items-center gap-2.5 shrink-0">
            <Button
              variant="primary"
              onClick={() => {
                onStartWork(selectedTemplateId)
              }}
              className="h-9 rounded-xl px-5 text-[13px] font-bold shadow-md cursor-pointer"
            >
              + Start New Work
            </Button>
          </div>
        </div>
      </div>

      {/* 2. CHOOSE WORKFLOW TEMPLATE */}
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[14px] font-bold text-(--color-text)">
              Select a Workflow Template
            </h3>
            <p className="text-[11px] text-(--color-text-muted)">
              Choose the execution pipeline that matches your objective.
            </p>
          </div>

          <Button
            size="sm"
            variant="ghost"
            onClick={onCreateTemplate}
            className="h-7 text-[11px] font-semibold text-(--color-accent) hover:underline"
          >
            + Create Custom Template
          </Button>
        </div>

        <div className="grid grid-cols-1 gap-3.5 md:grid-cols-2 lg:grid-cols-3">
          {templates.map((template) => {
            const isSelected = template.id === selectedTemplateId
            const icon = TEMPLATE_ICONS[template.id] ?? '📋'

            return (
              <Card
                key={template.id}
                tone="raised"
                onClick={() => {
                  onSelectTemplate(template.id)
                }}
                className={`flex flex-col justify-between p-4 cursor-pointer transition-all duration-(--duration-fast) rounded-xl border ${
                  isSelected
                    ? 'border-(--color-accent) ring-2 ring-(--color-accent)/30 shadow-md bg-(--color-surface)'
                    : 'border-(--color-border) hover:border-(--color-border-strong) hover:bg-(--color-surface)'
                }`}
              >
                <div className="space-y-2.5">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="text-xl">{icon}</span>
                      <h4 className="text-[13px] font-bold text-(--color-text)">{template.name}</h4>
                    </div>
                    {isSelected && (
                      <Badge tone="accent" size="sm">
                        Selected
                      </Badge>
                    )}
                  </div>

                  <p className="text-[11px] leading-relaxed text-(--color-text-muted)">
                    {template.description}
                  </p>

                  {/* Stage sequence preview */}
                  <div className="space-y-1.5 pt-1">
                    <span className="text-[10px] font-bold uppercase tracking-wider text-(--color-text-subtle)">
                      Pipeline Stages ({template.steps.length}):
                    </span>
                    <div className="flex flex-wrap gap-1">
                      {template.steps.map((step, idx) => (
                        <span
                          key={`${step.role}-${String(idx)}`}
                          className="rounded bg-(--color-surface-inset) border border-(--color-border) px-1.5 py-0.5 text-[10px] font-mono text-(--color-text-muted)"
                        >
                          {idx + 1}. {step.role}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-(--color-border)/50 pt-3">
                  <span className="text-[10px] text-(--color-text-subtle) font-mono">
                    ID: {template.id}
                  </span>
                  <Button
                    size="sm"
                    variant={isSelected ? 'primary' : 'secondary'}
                    onClick={(e) => {
                      e.stopPropagation()
                      onSelectTemplate(template.id)
                      onStartWork(template.id)
                    }}
                    className="h-6 px-2.5 text-[11px] font-semibold"
                  >
                    Start Work &rarr;
                  </Button>
                </div>
              </Card>
            )
          })}
        </div>
      </div>

      {/* 3. CONFIGURED AGENT TEAM ROSTER */}
      <div className="rounded-2xl border border-(--color-border) bg-(--color-surface-raised) p-5 space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-[13px] font-bold text-(--color-text)">Assigned Agent Team</h3>
            <p className="text-[11px] text-(--color-text-muted)">
              Configured roles and model engine bindings for this repository.
            </p>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="rounded-xl border border-(--color-border) bg-(--color-surface-inset) p-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-base">🧠</span>
              <Badge tone="neutral" size="sm" className="font-mono text-[9px]">
                {bindings?.roles.find((r) => r.role === 'planner')?.binding?.runtimeId ??
                  'primary-engine'}
              </Badge>
            </div>
            <h4 className="text-[12px] font-bold text-(--color-text)">Alex (Planner)</h4>
            <p className="text-[10px] text-(--color-text-muted)">
              Architectural design, task decomposition, and criteria.
            </p>
          </div>

          <div className="rounded-xl border border-(--color-border) bg-(--color-surface-inset) p-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-base">👤</span>
              <Badge tone="warning" size="sm" className="text-[9px]">
                Human Authority
              </Badge>
            </div>
            <h4 className="text-[12px] font-bold text-(--color-text)">You (Approval Gate)</h4>
            <p className="text-[10px] text-(--color-text-muted)">
              Reviews plan, locks decisions, and authorizes worktree changes.
            </p>
          </div>

          <div className="rounded-xl border border-(--color-border) bg-(--color-surface-inset) p-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-base">💻</span>
              <Badge tone="neutral" size="sm" className="font-mono text-[9px]">
                {bindings?.roles.find((r) => r.role === 'implementer')?.binding?.runtimeId ??
                  'secondary-engine'}
              </Badge>
            </div>
            <h4 className="text-[12px] font-bold text-(--color-text)">Sam (Implementer)</h4>
            <p className="text-[10px] text-(--color-text-muted)">
              Executes code changes, refactors, and file modifications in worktree.
            </p>
          </div>

          <div className="rounded-xl border border-(--color-border) bg-(--color-surface-inset) p-3 space-y-1">
            <div className="flex items-center justify-between">
              <span className="text-base">🔍</span>
              <Badge tone="neutral" size="sm" className="font-mono text-[9px]">
                {bindings?.roles.find((r) => r.role === 'reviewer')?.binding?.runtimeId ??
                  'primary-engine'}
              </Badge>
            </div>
            <h4 className="text-[12px] font-bold text-(--color-text)">Morgan (Reviewer)</h4>
            <p className="text-[10px] text-(--color-text-muted)">
              Audits code changes, runs regression tests, and assesses security.
            </p>
          </div>
        </div>
      </div>
    </div>
  )
}
