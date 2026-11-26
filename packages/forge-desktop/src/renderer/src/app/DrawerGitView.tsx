import { useCallback, useEffect, useState } from 'react'
import type { ChangedFileView, RepositoryProbe } from '@shared/ipc'
import { unwrap } from '../ipc'
import {
  Badge,
  Button,
  DiffViewer,
  EmptyState,
  Icon,
  IconButton,
  List,
  ListRow,
  ScrollArea,
  Textarea,
  useToast,
} from '../ui'
import { useProjectStore } from './projectStore'

function synthesizeCommitMessage(files: readonly ChangedFileView[]): string {
  if (files.length === 0) return ''
  if (files.length === 1) {
    const file = files[0]
    return file === undefined ? '' : `chore: update ${file.path}`
  }
  return `feat: update ${String(files.length)} files from verified workflow changes`
}

/**
 * Execution Drawer Diffs & Git Actions panel:
 * inspects live repository branch status, file diffs, explicit staging/unstaging,
 * commit message synthesis, and operator commits via Forge's sandboxed Git IPC.
 */
export function DrawerGitView(): React.JSX.Element {
  const detail = useProjectStore((state) => state.detail)
  const project = detail?.project ?? null
  const { show } = useToast()

  const [probe, setProbe] = useState<RepositoryProbe | null>(detail?.probe ?? null)
  const [files, setFiles] = useState<readonly ChangedFileView[]>([])
  const [patch, setPatch] = useState('')
  const [selectedPath, setSelectedPath] = useState<string | null>(null)
  const [commitMessage, setCommitMessage] = useState('')
  const [busy, setBusy] = useState(false)

  const refreshGit = useCallback(async (): Promise<void> => {
    if (project === null) return
    setBusy(true)
    try {
      const [nextProbe, diff] = await Promise.all([
        window.forge.project.probeRepository(project.repository.absolutePath).then(unwrap),
        window.forge.git.getWorkingDiff(project.id).then(unwrap),
      ])
      setProbe(nextProbe)
      setFiles(diff.files)
      setPatch(diff.patch)
      setSelectedPath((prev) =>
        prev !== null && diff.files.some((f) => f.path === prev)
          ? prev
          : (diff.files[0]?.path ?? null),
      )
    } catch {
      // Non-fatal during empty/init states
    } finally {
      setBusy(false)
    }
  }, [project])

  useEffect(() => {
    let active = true
    queueMicrotask(() => {
      if (active) void refreshGit()
    })
    const unsub = window.forge.onWorkflowEvent(() => {
      if (active) void refreshGit()
    })
    return () => {
      active = false
      unsub()
    }
  }, [refreshGit])

  if (project === null) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <EmptyState
          icon={<Icon name="git-branch" className="size-6 text-(--color-text-subtle)" />}
          title="No project active"
          description="Select or create a repository project from the top bar to inspect diffs and commit changes."
        />
      </div>
    )
  }

  const handleStagePaths = async (paths: readonly string[]): Promise<void> => {
    setBusy(true)
    try {
      await window.forge.git.stage(project.id, paths).then(unwrap)
      await refreshGit()
      show({
        tone: 'success',
        title: paths.length === 0 ? 'Staged all changes' : `Staged ${paths.join(', ')}`,
      })
    } catch (err: unknown) {
      show({
        tone: 'danger',
        title: 'Git Stage Failed',
        description: err instanceof Error ? err.message : 'Unable to stage paths',
      })
    } finally {
      setBusy(false)
    }
  }

  const handleUnstagePaths = async (paths: readonly string[]): Promise<void> => {
    setBusy(true)
    try {
      await window.forge.git.unstage(project.id, paths).then(unwrap)
      await refreshGit()
      show({ tone: 'neutral', title: 'Unstaged selected changes' })
    } catch (err: unknown) {
      show({
        tone: 'danger',
        title: 'Git Unstage Failed',
        description: err instanceof Error ? err.message : 'Unable to unstage paths',
      })
    } finally {
      setBusy(false)
    }
  }

  const handleCommit = async (): Promise<void> => {
    const trimmed = commitMessage.trim()
    if (trimmed.length === 0) return
    setBusy(true)
    try {
      await window.forge.git.stage(project.id, []).then(unwrap)
      const result = await window.forge.git.commit(project.id, trimmed).then(unwrap)
      setCommitMessage('')
      await refreshGit()
      show({
        tone: 'success',
        title: `Committed ${result.sha.slice(0, 7)}`,
        description: result.message,
      })
    } catch (err: unknown) {
      show({
        tone: 'danger',
        title: 'Git Commit Failed',
        description: err instanceof Error ? err.message : 'Commit aborted',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      {/* Branch Status Strip */}
      <div className="flex items-center justify-between gap-2 border-b border-(--color-edge-muted) bg-(--color-surface-raised)/50 px-3 py-2">
        <div className="flex min-w-0 items-center gap-2">
          <Icon name="git-branch" className="size-3.5 text-(--color-accent)" />
          <span className="truncate font-mono typography-meta font-semibold text-(--color-text)">
            {probe?.branch ?? project.repository.defaultBranch}
          </span>
          {probe?.headSha !== null && probe?.headSha !== undefined ? (
            <Badge tone="neutral" size="sm" className="font-mono">
              {probe.headSha.slice(0, 7)}
            </Badge>
          ) : null}
          <Badge tone={files.length > 0 ? 'warning' : 'success'} size="sm">
            {files.length === 0 ? 'Clean' : `${String(files.length)} changed`}
          </Badge>
        </div>

        <div className="flex items-center gap-1">
          {files.length > 0 ? (
            <Button
              size="xs"
              variant="ghost"
              disabled={busy}
              onClick={() => {
                void handleStagePaths([])
              }}
            >
              Stage all
            </Button>
          ) : null}
          <IconButton
            size="sm"
            variant="ghost"
            label="Refresh git status"
            icon={<Icon name="refresh" spin={busy} />}
            onClick={() => {
              void refreshGit()
            }}
          />
        </div>
      </div>

      <ScrollArea className="flex-1 p-3 space-y-3">
        {files.length === 0 ? (
          <div className="py-8">
            <EmptyState
              icon={<Icon name="git-commit" className="size-6 text-(--color-text-subtle)" />}
              title="Working tree is clean"
              description="Modified or untracked files from implementation turns will appear here with inline diff and commit controls."
            />
          </div>
        ) : (
          <>
            <List>
              {files.map((file) => (
                <div key={file.path} className="flex items-center gap-1">
                  <ListRow
                    selected={selectedPath === file.path}
                    className="min-w-0 flex-1"
                    leading={
                      <Icon name="file-code" className="size-3.5 text-(--color-text-muted)" />
                    }
                    title={file.path}
                    subtitle={file.changeType}
                    onSelect={() => {
                      setSelectedPath(file.path)
                    }}
                    trailing={
                      <div className="flex items-center gap-1 font-mono typography-micro">
                        <span className="text-(--color-success)">+{String(file.insertions)}</span>
                        <span className="text-(--color-danger)">-{String(file.deletions)}</span>
                      </div>
                    }
                  />
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      void handleStagePaths([file.path])
                    }}
                  >
                    Stage
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={() => {
                      void handleUnstagePaths([file.path])
                    }}
                  >
                    Unstage
                  </Button>
                </div>
              ))}
            </List>

            {selectedPath !== null && patch.length > 0 ? (
              <DiffViewer filePath={selectedPath} patch={patch} className="max-h-64" />
            ) : null}

            {/* Commit Finalization Composer */}
            <div className="space-y-2 rounded-(--radius-lg) border border-(--color-edge) bg-(--color-surface-inset) p-3">
              <div className="flex items-center justify-between">
                <span className="typography-meta font-semibold text-(--color-text)">
                  Commit Finalization
                </span>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => {
                    setCommitMessage(synthesizeCommitMessage(files))
                  }}
                >
                  <Icon name="sparkles" className="size-3" />
                  <span>Synthesize message</span>
                </Button>
              </div>
              <Textarea
                aria-label="Commit message"
                rows={2}
                value={commitMessage}
                onChange={(e) => {
                  setCommitMessage(e.target.value)
                }}
                placeholder="feat: describe verified changes to commit..."
              />
              <div className="flex justify-end">
                <Button
                  size="sm"
                  variant="primary"
                  disabled={busy || commitMessage.trim().length === 0}
                  onClick={() => {
                    void handleCommit()
                  }}
                >
                  <Icon name="git-commit" className="size-3.5" />
                  <span>Stage All & Commit</span>
                </Button>
              </div>
            </div>
          </>
        )}
      </ScrollArea>
    </div>
  )
}
