import { useState } from 'react'
import type { ProjectView } from '@shared/ipc'
import { Button, Code, Dialog, useToast } from '@renderer/ui'
import { useProjectStore } from './projectStore'

export interface DeleteProjectDialogProps {
  readonly open: boolean
  readonly project: ProjectView
  readonly onClose: () => void
  readonly onDeleted?: () => void
}

/**
 * Confirms and executes removal of a project from Forge sessions and local SQLite database.
 *
 * Distinct from deleting a directory on disk: the git repository and local files stay
 * 100% intact, and only Forge's internal workflows and session audit records are removed.
 */
export function DeleteProjectDialog({
  open,
  project,
  onClose,
  onDeleted,
}: DeleteProjectDialogProps): React.JSX.Element {
  const { show } = useToast()
  const deleteProject = useProjectStore((state) => state.deleteProject)
  const [deleting, setDeleting] = useState(false)

  const handleDelete = async (): Promise<void> => {
    setDeleting(true)
    try {
      await deleteProject(project.id)
      show({
        tone: 'success',
        title: `Project "${project.name}" removed`,
        description: 'Project sessions were removed from Forge. Local files on disk are untouched.',
      })
      onClose()
      onDeleted?.()
    } catch (cause) {
      show({
        tone: 'danger',
        title: 'Could not remove project',
        description: cause instanceof Error ? cause.message : 'Unknown error',
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={open} onClose={onClose} title="Remove Project from Forge" size="sm">
      <div className="grid gap-4">
        <div className="rounded-(--radius-md) border border-(--color-danger)/30 bg-(--color-danger)/10 p-3 text-(length:--text-xs) text-(--color-text)">
          <p className="font-semibold text-(--color-danger)">
            Are you sure you want to remove &ldquo;{project.name}&rdquo;?
          </p>
          <p className="mt-1.5 mb-0 text-(--color-text-muted)">
            This will permanently remove this project, all its workflow runs, decisions, questions, and
            session history from Forge.
          </p>
        </div>

        <div className="rounded-(--radius-md) bg-(--color-surface-inset) p-3 text-(length:--text-xs)">
          <p className="m-0 text-(--color-text-muted)">Local Repository Folder:</p>
          <Code className="mt-1 block break-all">{project.repository.absolutePath}</Code>
          <p className="mt-2 mb-0 text-[11px] text-(--color-success)">
            ✓ Your files and git history on disk will NOT be deleted or modified.
          </p>
        </div>

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="ghost" onClick={onClose} disabled={deleting}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={deleting}
            onClick={() => {
              void handleDelete()
            }}
          >
            {deleting ? 'Removing…' : 'Remove Project'}
          </Button>
        </div>
      </div>
    </Dialog>
  )
}
