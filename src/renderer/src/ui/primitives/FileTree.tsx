import type { ChangedFileView, DiscrepancyView } from '@shared/ipc'
import { Badge } from './Badge'
import { cn } from '../cn'

export interface FileTreeProps {
  readonly files: readonly ChangedFileView[]
  readonly selectedPath: string | null
  readonly onSelectFile: (path: string) => void
  readonly discrepancies?: readonly DiscrepancyView[] | undefined
  readonly className?: string | undefined
}

export function FileTree({
  files,
  selectedPath,
  onSelectFile,
  discrepancies = [],
  className,
}: FileTreeProps): React.JSX.Element {
  const discrepanciesByPath = new Map<string, DiscrepancyView[]>()
  for (const d of discrepancies) {
    const list = discrepanciesByPath.get(d.path) ?? []
    list.push(d)
    discrepanciesByPath.set(d.path, list)
  }

  return (
    <div className={cn('flex flex-col gap-1 overflow-y-auto text-(length:--text-xs)', className)}>
      {files.map((file) => {
        const isSelected = file.path === selectedPath
        const fileDiscrepancies = discrepanciesByPath.get(file.path) ?? []
        const hasDiscrepancy = fileDiscrepancies.length > 0

        const statusTone =
          file.changeType === 'added'
            ? 'success'
            : file.changeType === 'deleted'
              ? 'danger'
              : file.changeType === 'renamed'
                ? 'accent'
                : 'warning'

        const statusLetter =
          file.changeType === 'added'
            ? 'A'
            : file.changeType === 'deleted'
              ? 'D'
              : file.changeType === 'renamed'
                ? 'R'
                : 'M'

        return (
          <button
            key={file.path}
            type="button"
            onClick={() => {
              onSelectFile(file.path)
            }}
            className={cn(
              'group flex items-center justify-between gap-2 rounded-(--radius-md) px-3 py-2 text-left transition-colors',
              isSelected
                ? 'bg-(--color-surface-selected) text-(--color-text) font-medium ring-1 ring-(--color-border-focus)'
                : 'text-(--color-text-muted) hover:bg-(--color-surface-hover) hover:text-(--color-text)',
            )}
          >
            <div className="flex min-w-0 items-center gap-2">
              <Badge tone={statusTone} size="sm" className="font-mono">
                {statusLetter}
              </Badge>
              <span className="truncate" title={file.path}>
                {file.path}
              </span>
              {hasDiscrepancy && (
                <span
                  className="size-2 shrink-0 rounded-(--radius-full) bg-(--color-danger) animate-pulse"
                  title="Discrepancy detected on this file"
                />
              )}
            </div>

            <div className="flex shrink-0 items-center gap-1.5 font-mono text-(length:--text-2xs)">
              {file.insertions > 0 && (
                <span className="text-(--color-success)">+{file.insertions}</span>
              )}
              {file.deletions > 0 && (
                <span className="text-(--color-danger)">-{file.deletions}</span>
              )}
            </div>
          </button>
        )
      })}
    </div>
  )
}
