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
 * What is about to happen, shown before the user starts a workflow.
 *
 * The page previously showed a template dropdown, an empty log with four controls,
 * and an inspector hint for a graph that did not exist yet — chrome for the running
 * state, rendered unconditionally (#105). A first-time reader could not tell what
 * pressing Start would cause without reading `template.ts`.
 *
 * Everything here was already in the contract; none of it was on screen. The template
 * carries its own stages and description, and the preconditions are read from state
 * the page already had.
 */
export function WorkflowPreflight({
  template,
  project,
  bindings,
  onlySimulated,
}: WorkflowPreflightProps): React.JSX.Element {
  const blockers = collectBlockers(project, bindings, onlySimulated)

  return (
    <div className="grid gap-4 rounded-lg border border-(--color-border) bg-(--color-surface-raised) p-5">
      <div>
        <h2 className="text-(length:--text-md) font-semibold text-(--color-text)">
          {template?.name ?? 'No template selected'}
        </h2>
        {template !== null && (
          <p className="mt-1 text-(length:--text-xs) text-(--color-text-muted)">
            {template.description}
          </p>
        )}
      </div>

      {template !== null && template.steps.length > 0 && (
        <div>
          <div className="mb-2 text-(length:--text-xs) font-semibold uppercase tracking-wide text-(--color-text-muted)">
            What will run
          </div>
          <ol className="grid gap-1.5">
            {template.steps.map((step, index) => (
              <li
                key={`${step.role}-${String(index)}`}
                className="flex items-center gap-2 text-(length:--text-sm) text-(--color-text)"
              >
                <span className="w-5 shrink-0 text-right text-(length:--text-xs) text-(--color-text-muted)">
                  {index + 1}
                </span>
                <span className="font-medium">{step.label}</span>
                <span className="text-(length:--text-xs) text-(--color-text-muted)">
                  {/* Named plainly, because "who does this step" is the thing a reader
                      most needs and the role alone does not say it. */}
                  {step.performedByForge
                    ? 'Forge runs this'
                    : step.role === 'user'
                      ? 'waits for you'
                      : `agent as ${step.role}`}
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div>
        <div className="mb-2 text-(length:--text-xs) font-semibold uppercase tracking-wide text-(--color-text-muted)">
          Before starting
        </div>
        {blockers.length === 0 ? (
          <p className="text-(length:--text-sm) text-(--color-text-muted)">
            Everything this workflow needs is configured.
          </p>
        ) : (
          <ul className="grid gap-1.5">
            {blockers.map((blocker) => (
              <li key={blocker.detail} className="flex items-start gap-2">
                <Badge tone={blocker.blocking ? 'danger' : 'warning'} size="sm">
                  {blocker.blocking ? 'blocked' : 'note'}
                </Badge>
                <span className="text-(length:--text-sm) text-(--color-text)">
                  {blocker.detail}
                </span>
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
  /** True when the workflow cannot produce trustworthy results without it. */
  readonly blocking: boolean
}

/**
 * The preconditions worth stating, in the order they bite.
 *
 * Distinguishes blocking from advisory rather than showing one undifferentiated list:
 * a missing test command means Forge cannot gather evidence at all, while an unbound
 * role merely falls back to a default. Treating those alike would train the reader to
 * ignore both.
 */
function collectBlockers(
  project: ProjectView,
  bindings: RoleBindingsView | null,
  onlySimulated: boolean,
): readonly Precondition[] {
  const found: Precondition[] = []

  if (onlySimulated) {
    found.push({
      detail:
        'Only a simulated runtime is registered, so this run replays a scripted scenario rather than doing real work.',
      blocking: true,
    })
  }

  if (project.repository.testCommand === null) {
    // A3: without a command to run, "the tests pass" can only ever be the agent's
    // claim, which is exactly what Forge exists not to take on trust.
    found.push({
      detail: 'No test command is configured, so Forge cannot verify a claim that the tests pass.',
      blocking: true,
    })
  }

  if (project.repository.buildCommand === null) {
    found.push({
      detail: 'No build command is configured, so a broken build will not be caught.',
      blocking: true,
    })
  }

  const unbound = (bindings?.roles ?? []).filter((role) => role.binding === null)
  if (unbound.length > 0) {
    found.push({
      detail: `${unbound.map((role) => role.role).join(', ')} ${unbound.length === 1 ? 'has' : 'have'} no runtime bound, and will fall back to a default. Set one on the Agents page.`,
      blocking: false,
    })
  }

  return found
}
