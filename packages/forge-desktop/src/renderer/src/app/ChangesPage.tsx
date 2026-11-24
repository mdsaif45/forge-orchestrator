import { useEffect, useState } from 'react'
import type { ChangedFileView, ChangeSetView, DiscrepancyView } from '@shared/ipc'
import { unwrap } from '../ipc'
import { Badge, Button, CodeViewer, EmptyState, FileTree, useToast } from '../ui'
import { ChangesIcon } from './icons'
import { useProjectStore } from './projectStore'

export function ChangesPage(): React.JSX.Element {
  const { show } = useToast()
  const projects = useProjectStore((state) => state.projects)
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId)

  const activeProjectId = selectedProjectId ?? projects.at(0)?.id ?? null

  const [changeSets, setChangeSets] = useState<readonly ChangeSetView[]>([])
  const [workingFiles, setWorkingFiles] = useState<readonly ChangedFileView[]>([])
  const [workingPatch, setWorkingPatch] = useState('')
  const [selectedSource, setSelectedSource] = useState<string>('working')
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null)
  const [fileContent, setFileContent] = useState<string>('')
  const [isSaving, setIsSaving] = useState(false)
  const [reloadTrigger, setReloadTrigger] = useState(0)
  const [view, setView] = useState<'changes' | 'explorer'>('changes')
  const [allFiles, setAllFiles] = useState<readonly string[]>([])

  // 1. Fetch ChangeSets and Working Tree diff
  useEffect(() => {
    let cancelled = false
    if (activeProjectId === null) return

    window.forge.changeset
      .list(activeProjectId)
      .then((res) => {
        if (!cancelled) {
          setChangeSets(unwrap(res).changeSets)
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to load changesets:', err)
      })

    window.forge.git
      .getWorkingDiff(activeProjectId)
      .then((res) => {
        if (!cancelled) {
          const diff = unwrap(res)
          setWorkingFiles(diff.files)
          setWorkingPatch(diff.patch)
        }
      })
      .catch((err: unknown) => {
        console.error('Failed to load working tree diff:', err)
      })

    // The whole tree, for browsing context a diff does not contain (#107). Loaded
    // alongside the diff rather than on tab switch, so switching views is instant and
    // a workflow event refreshes both.
    window.forge.git
      .listFiles(activeProjectId)
      .then((res) => {
        if (!cancelled) setAllFiles(unwrap(res).files)
      })
      .catch((err: unknown) => {
        console.error('Failed to list repository files:', err)
      })

    const unsubscribe = window.forge.onWorkflowEvent(() => {
      setReloadTrigger((prev) => prev + 1)
    })

    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [activeProjectId, reloadTrigger])

  // Derive current file list, patch, and discrepancies based on selected source
  const selectedChangeSet = changeSets.find((cs) => cs.id === selectedSource)
  const isWorking = selectedSource === 'working'

  const currentFiles: readonly ChangedFileView[] = isWorking
    ? workingFiles
    : (selectedChangeSet?.files ?? [])
  const currentPatch: string = isWorking ? workingPatch : (selectedChangeSet?.patch ?? '')
  const currentDiscrepancies: readonly DiscrepancyView[] = isWorking
    ? []
    : (selectedChangeSet?.discrepancies ?? [])

  // Auto-select first file if none selected or selected file not in list
  const isSelectedValid =
    selectedFilePath !== null &&
    (view === 'explorer'
      ? allFiles.includes(selectedFilePath)
      : currentFiles.some((f) => f.path === selectedFilePath))

  const effectiveSelectedPath = isSelectedValid
    ? selectedFilePath
    : view === 'explorer'
      ? (allFiles[0] ?? currentFiles[0]?.path ?? null)
      : (currentFiles[0]?.path ?? null)

  // 2. Fetch File Content when effectiveSelectedPath changes
  useEffect(() => {
    let cancelled = false
    if (activeProjectId === null || effectiveSelectedPath === null) {
      return
    }

    window.forge.git
      .readFile(activeProjectId, effectiveSelectedPath)
      .then((res) => {
        if (!cancelled) {
          setFileContent(unwrap(res).content)
        }
      })
      .catch(() => {
        if (!cancelled) {
          setFileContent('')
        }
      })

    return () => {
      cancelled = true
    }
  }, [activeProjectId, effectiveSelectedPath, reloadTrigger])

  const handleSaveFile = async (path: string, content: string): Promise<void> => {
    if (activeProjectId === null) return
    setIsSaving(true)
    try {
      await window.forge.git.writeFile(activeProjectId, path, content).then(unwrap)
      show({
        tone: 'success',
        title: 'File Saved (User Edit)',
        description: `Changes written directly to working tree: ${path}`,
      })
      setReloadTrigger((prev) => prev + 1)
    } catch (err) {
      show({
        tone: 'danger',
        title: 'Failed to Save File',
        description: err instanceof Error ? err.message : 'Unknown error',
      })
    } finally {
      setIsSaving(false)
    }
  }

  // Extract patch for the selected file from the unified patch
  const filePatch = extractFilePatch(currentPatch, effectiveSelectedPath)

  return (
    <div className="flex h-full flex-col overflow-hidden bg-(--color-canvas)">
      {/* Header */}
      <header className="flex shrink-0 flex-col gap-3 border-b border-(--color-border) bg-(--color-surface) p-4 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-(length:--text-xl) font-bold text-(--color-text)">Changes</h1>
          <p className="text-(length:--text-xs) text-(--color-text-muted)">
            Inspect repository diffs, agent changesets, and discrepancies with read-only default and
            opt-in editing.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setReloadTrigger((p) => p + 1)
            }}
          >
            Refresh Git
          </Button>
        </div>
      </header>

      {/* Main Split Layout */}
      {/* The Explorer stays reachable on a clean tree: browsing the repository for
          context is useful precisely when there is nothing to review yet (#107). */}
      {currentFiles.length === 0 && changeSets.length === 0 && allFiles.length === 0 ? (
        <div className="flex-1 p-6">
          <EmptyState
            icon={<ChangesIcon />}
            title="Working tree is clean"
            description="No modified, added, or deleted files in the repository. When agents perform steps or you make changes, they appear here."
          />
        </div>
      ) : (
        <div className="flex flex-1 overflow-hidden">
          {/* Left Sidebar: Source Selector & FileTree */}
          <div className="flex w-80 shrink-0 flex-col border-r border-(--color-border) bg-(--color-surface)">
            {/* View switcher: the diff, or the whole tree for context (#107). */}
            <div
              role="tablist"
              aria-label="File source"
              className="flex border-b border-(--color-border)"
            >
              {(['changes', 'explorer'] as const).map((candidate) => (
                <button
                  key={candidate}
                  type="button"
                  role="tab"
                  aria-selected={view === candidate}
                  onClick={() => {
                    setView(candidate)
                  }}
                  className={
                    view === candidate
                      ? 'flex-1 border-b-2 border-(--color-accent) px-3 py-2 text-(length:--text-xs) font-semibold text-(--color-text)'
                      : 'flex-1 px-3 py-2 text-(length:--text-xs) text-(--color-text-muted) hover:text-(--color-text)'
                  }
                >
                  {candidate === 'changes' ? 'Changes' : 'Explorer'}
                </button>
              ))}
            </div>

            {/* Source Switcher */}
            <div className={view === 'changes' ? 'border-b border-(--color-border) p-3' : 'hidden'}>
              <label className="mb-1.5 block text-(length:--text-2xs) font-semibold uppercase tracking-wider text-(--color-text-muted)">
                Changeset / Source
              </label>
              <select
                className="w-full rounded-(--radius-md) border border-(--color-border) bg-(--color-surface-raised) px-2.5 py-1.5 text-(length:--text-xs) text-(--color-text)"
                value={selectedSource}
                onChange={(e) => {
                  setSelectedSource(e.target.value)
                }}
              >
                <option value="working">
                  Working Tree (Uncommitted) ({workingFiles.length} files)
                </option>
                {changeSets.map((cs, idx) => (
                  <option key={cs.id} value={cs.id}>
                    Changeset #{String(idx + 1)} · {cs.authorActor} ({cs.files.length} files)
                  </option>
                ))}
              </select>

              {!isWorking && selectedChangeSet !== undefined && (
                <div className="mt-2 flex flex-wrap items-center gap-1.5 text-(length:--text-2xs)">
                  <Badge
                    tone={
                      selectedChangeSet.reviewVerdict === 'pass'
                        ? 'success'
                        : selectedChangeSet.reviewVerdict === 'fail'
                          ? 'danger'
                          : 'neutral'
                    }
                    size="sm"
                  >
                    review: {selectedChangeSet.reviewVerdict ?? 'pending'}
                  </Badge>
                  <Badge tone="neutral" size="sm">
                    {selectedChangeSet.authorActor}
                  </Badge>
                  {selectedChangeSet.discrepancies.length > 0 && (
                    <Badge tone="danger" size="sm">
                      {selectedChangeSet.discrepancies.length} discrepancy
                    </Badge>
                  )}
                </div>
              )}
            </div>

            {/* Files Tree */}
            <div className="flex-1 overflow-y-auto p-2">
              {view === 'changes' ? (
                <FileTree
                  files={currentFiles}
                  selectedPath={effectiveSelectedPath}
                  discrepancies={currentDiscrepancies}
                  mode="flat"
                  onSelectFile={(path) => {
                    setSelectedFilePath(path)
                  }}
                />
              ) : (
                <FileTree
                  allFiles={allFiles}
                  files={currentFiles}
                  selectedPath={effectiveSelectedPath}
                  discrepancies={currentDiscrepancies}
                  mode="tree"
                  onSelectFile={(path) => {
                    setSelectedFilePath(path)
                  }}
                />
              )}
            </div>
          </div>

          {/* Right Pane: Code Viewer, Diff & Editor */}
          <div className="flex-1 overflow-hidden">
            {effectiveSelectedPath !== null ? (
              <CodeViewer
                filePath={effectiveSelectedPath}
                content={fileContent}
                patch={filePatch}
                discrepancies={currentDiscrepancies}
                isSaving={isSaving}
                defaultMode={view === 'changes' ? 'diff' : 'code'}
                // Omitted in the Explorer view, which makes the viewer read-only.
                // Browsing the tree for context must not become a general-purpose
                // editor: A2 says the agent owns the worktree during a run, and the
                // opt-in edit affordance belongs to the reviewed changeset (#41).
                {...(view === 'changes' ? { onSaveFile: handleSaveFile } : {})}
              />
            ) : (
              <div className="flex h-full items-center justify-center p-6 text-(--color-text-muted)">
                Select a file from the list to view its code
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

function extractFilePatch(fullPatch: string, filePath: string | null): string {
  if (filePath === null || !fullPatch) return ''
  const sections = fullPatch.split(/(?=diff --git )/g)
  for (const sec of sections) {
    if (sec.includes(`b/${filePath}`) || sec.includes(`a/${filePath}`)) {
      return sec
    }
  }
  return fullPatch
}
