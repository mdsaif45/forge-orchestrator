import React, { useState } from 'react'
import type { ProjectView, RepositoryProbe } from '@shared/ipc'
import { Button, Code, Dialog, Field, Input, Select, useToast } from '@renderer/ui'
import { unwrap } from '@renderer/ipc'

export interface EditProjectDialogProps {
  readonly open: boolean
  readonly project: ProjectView
  /** Supplies the branch list, so the default is chosen rather than typed (#100). */
  readonly probe: RepositoryProbe | null
  readonly onClose: () => void
  readonly onSaved: () => Promise<void> | void
}

/**
 * Changes a project's settings after it exists.
 *
 * Until this, a project was create-only: a wrong default branch or an unset build
 * command could be corrected only by deleting and recreating the project, discarding
 * its decisions, changesets, and event history for a one-field fix (#112).
 *
 * Seeded from props on mount only, so the caller remounts it with a `key` each time
 * it opens. Syncing that in an effect instead would cascade a render on every open —
 * and the lint rule that forbids it is right: the state genuinely belongs to one
 * editing session, not to the component across sessions.
 *
 * The repository path is deliberately absent. Pointing a project at a different
 * repository invalidates every recorded path, diff base, and changeset — that is a new
 * project, and offering it as an edit would corrupt what the log means.
 */
export function EditProjectDialog({
  open,
  project,
  probe,
  onClose,
  onSaved,
}: EditProjectDialogProps): React.JSX.Element {
  const { show } = useToast()
  const [name, setName] = useState(project.name)
  const [defaultBranch, setDefaultBranch] = useState(project.repository.defaultBranch)
  const [buildCommand, setBuildCommand] = useState(project.repository.buildCommand ?? '')
  const [testCommand, setTestCommand] = useState(project.repository.testCommand ?? '')
  const [tech, setTech] = useState(project.repository.tech.join(', '))
  const [saving, setSaving] = useState(false)

  const handleSave = async (): Promise<void> => {
    setSaving(true)
    try {
      unwrap(
        await window.forge.project.update({
          projectId: project.id,
          name: name.trim(),
          defaultBranch: defaultBranch.trim(),
          // Empty means "clear it", which the contract distinguishes from omitting the
          // field entirely — that is what makes a command unsettable once set.
          buildCommand: buildCommand.trim() === '' ? null : buildCommand.trim(),
          testCommand: testCommand.trim() === '' ? null : testCommand.trim(),
          tech: tech
            .split(',')
            .map((tag) => tag.trim())
            .filter((tag) => tag !== ''),
        }),
      )

      await onSaved()
      show({ tone: 'success', title: 'Project updated' })
      onClose()
    } catch (cause) {
      // The likeliest cause is a running workflow, and the user can only act on that
      // if told which one it is.
      show({
        tone: 'danger',
        title: 'Could not update the project',
        description: cause instanceof Error ? cause.message : 'Unknown error',
      })
    } finally {
      setSaving(false)
    }
  }

  const branches = probe?.branches ?? []

  return (
    <Dialog open={open} onClose={onClose} title="Project settings" size="md">
      <div className="grid gap-4">
        <Field label="Name" required>
          {(bind) => (
            <Input
              {...bind}
              value={name}
              onChange={(event) => {
                setName(event.target.value)
              }}
            />
          )}
        </Field>

        <Field label="Default branch" required hint="The merge target changes are measured against">
          {(bind) =>
            branches.length > 0 ? (
              <Select
                {...bind}
                options={branches.map((branch) => ({ value: branch, label: branch }))}
                value={defaultBranch}
                onChange={(event) => {
                  setDefaultBranch(event.target.value)
                }}
              />
            ) : (
              <Input
                {...bind}
                mono
                value={defaultBranch}
                onChange={(event) => {
                  setDefaultBranch(event.target.value)
                }}
              />
            )
          }
        </Field>

        <div className="grid grid-cols-2 gap-4">
          <Field label="Build command" hint="Forge runs this to produce evidence">
            {(bind) => (
              <Input
                {...bind}
                mono
                value={buildCommand}
                placeholder="npm run build"
                onChange={(event) => {
                  setBuildCommand(event.target.value)
                }}
              />
            )}
          </Field>

          <Field label="Test command" hint="An agent's claim is checked against it">
            {(bind) => (
              <Input
                {...bind}
                mono
                value={testCommand}
                placeholder="npm test"
                onChange={(event) => {
                  setTestCommand(event.target.value)
                }}
              />
            )}
          </Field>
        </div>

        <Field label="Technology" hint="Comma separated">
          {(bind) => (
            <Input
              {...bind}
              value={tech}
              onChange={(event) => {
                setTech(event.target.value)
              }}
            />
          )}
        </Field>

        <p className="m-0 text-(length:--text-xs) text-(--color-text-muted)">
          The repository path cannot be changed: <Code>{project.repository.absolutePath}</Code>.
          Binding a different repository would invalidate every recorded diff and changeset, so that
          is a new project rather than an edit.
        </p>

        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={saving || name.trim() === '' || defaultBranch.trim() === ''}
            onClick={() => {
              void handleSave()
            }}
          >
            {saving ? 'Saving…' : 'Save changes'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
