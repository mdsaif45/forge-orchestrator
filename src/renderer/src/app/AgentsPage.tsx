import React, { useCallback, useEffect, useState } from 'react'
import type { RoleBindingsView } from '@shared/ipc'
import { Badge, EmptyState, Select, Spinner, useToast } from '@renderer/ui'
import { unwrap } from '@renderer/ipc'
import { useProjectStore } from './projectStore'

/**
 * Which runtime holds which role, for the selected project.
 *
 * This is where A6 becomes visible: a template names a role, a binding names a
 * runtime, and any runtime may hold any role as long as it declares the capability.
 * The eligible list comes from main, computed from those declared capabilities, so an
 * impossible pairing is unselectable rather than rejected after the user picks it.
 */
export function AgentsPage(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const project = detail?.project ?? null
  const { show } = useToast()

  // Keyed by project so "loaded" is derived rather than tracked. A separate `loading`
  // flag would have to be set synchronously inside the effect, which cascades renders
  // — and it can disagree with the data it describes, which is the bug that shape
  // invites.
  const [loaded, setLoaded] = useState<{
    readonly projectId: string
    readonly bindings: RoleBindingsView
  } | null>(null)
  const [saving, setSaving] = useState<string | null>(null)

  const projectId = project?.id ?? null
  const bindings = loaded?.projectId === projectId ? loaded.bindings : null

  const load = useCallback((id: string) => {
    window.forge.binding
      .list(id)
      .then((res) => {
        setLoaded({ projectId: id, bindings: unwrap(res) })
      })
      .catch((err: unknown) => {
        console.error('Failed to load bindings:', err)
      })
  }, [])

  useEffect(() => {
    if (projectId === null) return
    load(projectId)
  }, [projectId, load])

  const handleBind = async (role: string, runtimeId: string): Promise<void> => {
    if (projectId === null) return
    setSaving(role)
    try {
      unwrap(await window.forge.binding.set(projectId, role, runtimeId))
      load(projectId)
      show({ tone: 'success', title: 'Runtime bound', description: `${role} → ${runtimeId}` })
    } catch (err: unknown) {
      // Surfaced rather than swallowed: the most likely cause is a capability the
      // runtime does not declare, and the user can only act on that if told.
      show({
        tone: 'danger',
        title: 'Could not bind that runtime',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setSaving(null)
    }
  }

  if (project === null) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="grid flex-1 place-content-center p-8">
          <EmptyState
            title="No project selected"
            description="Choose a project to see which runtime holds each role."
          />
        </div>
      </div>
    )
  }

  if (bindings === null) {
    return (
      <div className="flex h-full flex-col">
        <Header />
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      </div>
    )
  }

  const roles = bindings.roles

  return (
    <div className="flex h-full flex-col">
      <Header projectName={project.name} />

      <div className="flex-1 overflow-auto p-6">
        {roles.length === 0 ? (
          <EmptyState
            title="No runtimes registered"
            description="Forge has no agent runtimes to bind. A runtime is registered at startup."
          />
        ) : (
          <div className="grid gap-3">
            {roles.map(({ role, binding, eligibleRuntimes }) => (
              <div
                key={role}
                className="grid gap-3 rounded-lg border border-(--color-border) bg-(--color-surface-raised) p-4 sm:grid-cols-[10rem_1fr_auto] sm:items-center"
              >
                <div>
                  <div className="text-sm font-semibold text-(--color-text)">{role}</div>
                  <div className="text-xs text-(--color-text-muted)">
                    {binding === null ? 'not bound' : binding.runtimeId}
                  </div>
                </div>

                {eligibleRuntimes.length === 0 ? (
                  <div className="text-xs text-(--color-text-muted)">
                    No registered runtime declares the capabilities this role needs.
                  </div>
                ) : (
                  <Select
                    aria-label={`Runtime for ${role}`}
                    options={eligibleRuntimes.map((runtime) => ({
                      value: runtime.id,
                      label: runtime.simulated ? `${runtime.id} (simulated)` : runtime.id,
                    }))}
                    value={binding?.runtimeId ?? ''}
                    disabled={saving === role}
                    onChange={(event) => {
                      void handleBind(role, event.target.value)
                    }}
                  />
                )}

                <div className="flex items-center gap-2">
                  {binding?.simulated === true && (
                    // Same rule as the workflow graph (#101): a simulated runtime is
                    // never allowed to look like a real one.
                    <Badge tone="warning" size="sm">
                      simulated
                    </Badge>
                  )}

                  {binding !== null &&
                    eligibleRuntimes.find((runtime) => runtime.id === binding.runtimeId)
                      ?.supportsAccountIsolation === false && (
                      // Stated where the runtime is chosen, not discovered later from
                      // throughput arriving at a fraction of what was expected (#111).
                      <Badge tone="neutral" size="sm">
                        one account at a time
                      </Badge>
                    )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function Header({ projectName }: { readonly projectName?: string }): React.JSX.Element {
  return (
    <div className="border-b border-(--color-border) px-6 py-4">
      <h1 className="text-(length:--text-lg) font-semibold text-(--color-text)">Agents</h1>
      <p className="text-(length:--text-xs) text-(--color-text-muted)">
        {projectName === undefined
          ? 'Runtimes are bound to roles per project.'
          : `Runtimes bound to roles in ${projectName}. Any runtime can hold any role it has the capabilities for.`}
      </p>
    </div>
  )
}
