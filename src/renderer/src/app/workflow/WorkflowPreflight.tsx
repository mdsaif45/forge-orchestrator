import React from 'react'
import type { ProjectView, RoleBindingsView, WorkflowTemplateView } from '@shared/ipc'
import { Badge } from '@renderer/ui'

export interface WorkflowPreflightProps {
  readonly template: WorkflowTemplateView | null
  readonly project: ProjectView
  readonly bindings: RoleBindingsView | null
  readonly onlySimulated: boolean
}

/**
 * Pre-workflow overview card.
 * Explains the workflow sequence and validation approach before execution starts.
 */
export function WorkflowPreflight({
  template,
  project,
  bindings,
  onlySimulated,
}: WorkflowPreflightProps): React.JSX.Element {
  const blockers = collectBlockers(project, bindings, onlySimulated)

  return (
    <div className="grid gap-4 rounded-xl border border-(--color-border) bg-(--color-surface-raised) p-5">
      <div>
        <h2 className="text-[15px] font-semibold text-(--color-text)">
          {template?.name ?? 'No template selected'}
        </h2>
        {template !== null && (
          <p className="mt-1 text-[12px] text-(--color-text-muted)">{template.description}</p>
        )}
      </div>

      {template !== null && template.steps.length > 0 && (
        <div>
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-(--color-text-subtle)">
            What will run
          </div>
          <ol className="grid gap-1.5 list-none p-0 m-0">
            {template.steps.map((step, index) => (
              <li
                key={`${step.role}-${String(index)}`}
                className="flex items-center gap-2 text-[13px] text-(--color-text)"
              >
                <span className="w-5 shrink-0 text-right text-[11px] font-mono text-(--color-text-muted)">
                  {index + 1}
                </span>
                <span className="font-medium">{step.label}</span>
                <span className="text-[12px] text-(--color-text-muted)">
                  {step.performedByForge
                    ? 'Forge runs this'
                    : step.role === 'user'
                      ? 'waits for your review'
                      : `agent as ${step.role}`}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div>
        <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-(--color-text-subtle)">
          Verification & Readiness
        </div>
        {blockers.length === 0 ? (
          <p className="text-[12px] text-(--color-success)">
            Ready to start. Forge will coordinate planning, implementation in an isolated worktree,
            and changeset review.
          </p>
        ) : (
          <ul className="grid gap-1.5 list-none p-0 m-0">
            {blockers.map((blocker) => (
              <li key={blocker.detail} className="flex items-start gap-2">
                <Badge tone={blocker.blocking ? 'danger' : 'neutral'} size="sm">
                  {blocker.blocking ? 'blocked' : 'info'}
                </Badge>
                <span className="text-[12px] text-(--color-text-muted)">{blocker.detail}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

interface Precondition {
  readonly detail: string
  readonly blocking: boolean
}

function collectBlockers(
  project: ProjectView,
  bindings: RoleBindingsView | null,
  onlySimulated: boolean,
): readonly Precondition[] {
  const found: Precondition[] = []

  if (onlySimulated) {
    found.push({
      detail: 'Running in simulated sandbox mode. A scripted workflow scenario will execute.',
      blocking: false,
    })
  }

  // If no custom test command is configured, provide a user-friendly, non-blocking fallback
  if (project.repository.testCommand === null && project.repository.buildCommand === null) {
    found.push({
      detail:
        'Standard verification active: Forge will automatically verify code changes through Git worktree diffs and safety audits.',
      blocking: false,
    })
  } else if (project.repository.testCommand === null) {
    found.push({
      detail:
        'No custom test command configured. Forge will verify code changes using build checks and Git diff audits.',
      blocking: false,
    })
  } else if (project.repository.buildCommand === null) {
    found.push({
      detail:
        'No custom build command configured. Forge will verify changes using tests and Git diff audits.',
      blocking: false,
    })
  }

  const unbound = (bindings?.roles ?? []).filter((role) => role.binding === null)
  if (unbound.length > 0) {
    found.push({
      detail: `${unbound.map((role) => role.role).join(', ')} ${unbound.length === 1 ? 'has' : 'have'} no specific runtime assigned; default agent runtime will be used.`,
      blocking: false,
    })
  }

  return found
}
