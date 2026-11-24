import { useMemo, useState } from 'react'
import type { ChangedFileView, DiscrepancyView } from '@shared/ipc'
import { Badge } from './Badge'
import { FileIcon, FolderChevron } from './FileIcons'
import {
  buildFileTree,
  collectAllDirectoryPaths,
  filterFileTree,
  getAncestorsOfPath,
  normalizePath,
  type TreeNode,
} from './fileTreeModel'
import { cn } from '../cn'

export interface FileTreeProps {
  /** List of changed files from git or changeset */
  readonly files?: readonly ChangedFileView[] | undefined
  /** Full list of repository file paths for tree exploration */
  readonly allFiles?: readonly string[] | undefined
  readonly selectedPath: string | null
  readonly onSelectFile: (path: string) => void
  readonly discrepancies?: readonly DiscrepancyView[] | undefined
  readonly mode?: 'tree' | 'flat' | undefined
  readonly className?: string | undefined
}

export function FileTree({
  files = [],
  allFiles,
  selectedPath,
  onSelectFile,
  discrepancies = [],
  mode,
  className,
}: FileTreeProps): React.JSX.Element {
  // If allFiles is provided or mode is 'tree', use tree view; otherwise default to flat if only changed files passed
  const isTreeMode =
    mode === 'tree' || (mode === undefined && allFiles !== undefined && allFiles.length > 0)

  if (!isTreeMode) {
    return (
      <FlatFileTree
        files={files}
        selectedPath={selectedPath}
        onSelectFile={onSelectFile}
        discrepancies={discrepancies}
        className={className}
      />
    )
  }

  return (
    <HierarchicalFileTree
      allFiles={allFiles ?? files.map((f) => f.path)}
      changedFiles={files}
      selectedPath={selectedPath}
      onSelectFile={onSelectFile}
      discrepancies={discrepancies}
      className={className}
    />
  )
}

function HierarchicalFileTree({
  allFiles,
  changedFiles,
  selectedPath,
  onSelectFile,
  discrepancies,
  className,
}: {
  readonly allFiles: readonly string[]
  readonly changedFiles: readonly ChangedFileView[]
  readonly selectedPath: string | null
  readonly onSelectFile: (path: string) => void
  readonly discrepancies: readonly DiscrepancyView[]
  readonly className?: string | undefined
}): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState('')
  const [userExpandedFolders, setUserExpandedFolders] = useState<Set<string>>(() => {
    return new Set(selectedPath ? getAncestorsOfPath(selectedPath) : [])
  })

  // Build the complete hierarchical tree
  const rootNodes = useMemo(() => {
    return buildFileTree(allFiles, changedFiles, discrepancies)
  }, [allFiles, changedFiles, discrepancies])

  const allDirPaths = useMemo(() => {
    return collectAllDirectoryPaths(rootNodes)
  }, [rootNodes])

  // Filter tree when searching
  const filteredNodes = useMemo(() => {
    return filterFileTree(rootNodes, searchQuery)
  }, [rootNodes, searchQuery])

  // Derive effective expanded folders without cascading render effects
  const effectiveExpandedFolders: ReadonlySet<string> = useMemo(() => {
    if (searchQuery.trim()) {
      return new Set(collectAllDirectoryPaths(filteredNodes))
    }
    const combined = new Set(userExpandedFolders)
    if (selectedPath) {
      for (const a of getAncestorsOfPath(selectedPath)) {
        combined.add(a)
      }
    }
    return combined
  }, [searchQuery, filteredNodes, userExpandedFolders, selectedPath])

  const toggleFolder = (dirPath: string) => {
    setUserExpandedFolders((prev) => {
      const next = new Set(prev)
      if (effectiveExpandedFolders.has(dirPath)) {
        next.delete(dirPath)
      } else {
        next.add(dirPath)
      }
      return next
    })
  }

  const expandAll = () => {
    setUserExpandedFolders(new Set(allDirPaths))
  }

  const collapseAll = () => {
    setUserExpandedFolders(new Set())
  }

  const totalFiles = allFiles.length

  return (
    <div className={cn('flex h-full flex-col overflow-hidden text-(length:--text-xs)', className)}>
      {/* Search and Action Toolbar */}
      <div className="flex flex-col gap-2 border-b border-(--color-border) p-2">
        <div className="relative flex items-center">
          <input
            type="text"
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value)
            }}
            placeholder="Filter files (e.g. .tsx, src)..."
            className="w-full rounded-(--radius-md) border border-(--color-border) bg-(--color-surface-inset) px-2.5 py-1 text-(length:--text-xs) text-(--color-text) placeholder:text-(--color-text-subtle) focus:border-(--color-border-focus) focus:outline-none"
          />
          {searchQuery && (
            <button
              type="button"
              onClick={() => {
                setSearchQuery('')
              }}
              className="absolute right-2 text-(--color-text-muted) hover:text-(--color-text)"
              title="Clear filter"
            >
              ✕
            </button>
          )}
        </div>

        <div className="flex items-center justify-between px-1 text-(length:--text-2xs) text-(--color-text-muted)">
          <span>{totalFiles} files</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={expandAll}
              className="hover:text-(--color-text)"
              title="Expand All Folders"
            >
              Expand All
            </button>
            <span>•</span>
            <button
              type="button"
              onClick={collapseAll}
              className="hover:text-(--color-text)"
              title="Collapse All Folders"
            >
              Collapse All
            </button>
          </div>
        </div>
      </div>

      {/* Tree Content */}
      <div className="flex-1 overflow-y-auto overflow-x-hidden p-1 select-none">
        {filteredNodes.length === 0 ? (
          <div className="p-4 text-center text-(--color-text-muted)">
            {searchQuery ? 'No matching files' : 'No files found'}
          </div>
        ) : (
          filteredNodes.map((node) => (
            <TreeNodeItem
              key={node.id}
              node={node}
              level={0}
              selectedPath={selectedPath ? normalizePath(selectedPath) : null}
              expandedFolders={effectiveExpandedFolders}
              onToggleFolder={toggleFolder}
              onSelectFile={onSelectFile}
            />
          ))
        )}
      </div>
    </div>
  )
}

function TreeNodeItem({
  node,
  level,
  selectedPath,
  expandedFolders,
  onToggleFolder,
  onSelectFile,
}: {
  readonly node: TreeNode
  readonly level: number
  readonly selectedPath: string | null
  readonly expandedFolders: ReadonlySet<string>
  readonly onToggleFolder: (path: string) => void
  readonly onSelectFile: (path: string) => void
}): React.JSX.Element {
  const isExpanded = expandedFolders.has(node.path)
  const isSelected = !node.isDirectory && node.path === selectedPath

  if (node.isDirectory) {
    return (
      <div className="flex flex-col">
        <button
          type="button"
          onClick={() => {
            onToggleFolder(node.path)
          }}
          className={cn(
            'group flex w-full items-center gap-1.5 rounded-(--radius-sm) px-1.5 py-1 text-left text-(length:--text-xs) text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text) transition-colors',
          )}
          style={{ paddingLeft: `${String(level * 12 + 6)}px` }}
        >
          <FolderChevron isOpen={isExpanded} />
          <FileIcon fileName={node.name} isFolder isOpen={isExpanded} />
          <span className="truncate font-medium">{node.name}</span>

          {node.changedDescendantsCount !== undefined && node.changedDescendantsCount > 0 && (
            <span
              className="ml-auto flex size-4 items-center justify-center rounded-full bg-(--color-accent-muted) text-[10px] font-semibold text-(--color-accent)"
              title={`${String(node.changedDescendantsCount)} changed file(s) inside`}
            >
              {node.changedDescendantsCount}
            </span>
          )}
        </button>

        {isExpanded && node.children.length > 0 && (
          <div className="relative flex flex-col">
            {/* Subtle guide line */}
            <div
              className="absolute bottom-0 top-0 border-l border-(--color-border)/30"
              style={{ left: `${String(level * 12 + 12)}px` }}
            />
            {node.children.map((child) => (
              <TreeNodeItem
                key={child.id}
                node={child}
                level={level + 1}
                selectedPath={selectedPath}
                expandedFolders={expandedFolders}
                onToggleFolder={onToggleFolder}
                onSelectFile={onSelectFile}
              />
            ))}
          </div>
        )}
      </div>
    )
  }

  const statusTone =
    node.changeType === 'added'
      ? 'success'
      : node.changeType === 'deleted'
        ? 'danger'
        : node.changeType === 'renamed'
          ? 'accent'
          : node.changeType === 'modified'
            ? 'warning'
            : null

  const statusLetter =
    node.changeType === 'added'
      ? 'A'
      : node.changeType === 'deleted'
        ? 'D'
        : node.changeType === 'renamed'
          ? 'R'
          : node.changeType === 'modified'
            ? 'M'
            : null

  return (
    <button
      type="button"
      onClick={() => {
        onSelectFile(node.path)
      }}
      className={cn(
        'group flex w-full items-center justify-between gap-1.5 rounded-(--radius-sm) px-1.5 py-1 text-left text-(length:--text-xs) transition-colors',
        isSelected
          ? 'bg-(--color-surface-selected,rgba(77,141,255,0.15)) text-(--color-text) font-medium ring-1 ring-(--color-border-focus)'
          : 'text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text)',
      )}
      style={{ paddingLeft: `${String(level * 12 + 16)}px` }}
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <FileIcon fileName={node.name} />
        <span
          className={cn(
            'truncate',
            statusTone === 'warning' ? 'text-(--color-warning)' : '',
            statusTone === 'success' ? 'text-(--color-success)' : '',
            statusTone === 'danger' ? 'text-(--color-danger)' : '',
          )}
          title={node.path}
        >
          {node.name}
        </span>
        {node.hasDiscrepancy && (
          <span
            className="size-1.5 shrink-0 rounded-full bg-(--color-danger) animate-pulse"
            title="Discrepancy detected"
          />
        )}
      </div>

      {/* Change indicator and diff stats */}
      <div className="flex shrink-0 items-center gap-1 font-mono text-[10px]">
        {statusLetter && statusTone && (
          <Badge
            tone={statusTone}
            size="sm"
            className="font-mono text-[9px] px-1 py-0 h-4 min-w-4 flex items-center justify-center"
          >
            {statusLetter}
          </Badge>
        )}
        {node.insertions !== undefined && node.insertions > 0 && (
          <span className="text-(--color-success)">+{node.insertions}</span>
        )}
        {node.deletions !== undefined && node.deletions > 0 && (
          <span className="text-(--color-danger)">-{node.deletions}</span>
        )}
      </div>
    </button>
  )
}

function FlatFileTree({
  files,
  selectedPath,
  onSelectFile,
  discrepancies,
  className,
}: {
  readonly files: readonly ChangedFileView[]
  readonly selectedPath: string | null
  readonly onSelectFile: (path: string) => void
  readonly discrepancies: readonly DiscrepancyView[]
  readonly className?: string | undefined
}): React.JSX.Element {
  const [filterQuery, setFilterQuery] = useState('')

  const discrepanciesByPath = new Map<string, DiscrepancyView[]>()
  for (const d of discrepancies) {
    const list = discrepanciesByPath.get(d.path) ?? []
    list.push(d)
    discrepanciesByPath.set(d.path, list)
  }

  const filteredFiles = useMemo(() => {
    const q = filterQuery.trim().toLowerCase()
    if (!q) return files
    return files.filter((f) => f.path.toLowerCase().includes(q))
  }, [files, filterQuery])

  return (
    <div className={cn('flex h-full flex-col overflow-hidden text-(length:--text-xs)', className)}>
      {files.length > 3 && (
        <div className="border-b border-(--color-border) p-2">
          <input
            type="text"
            value={filterQuery}
            onChange={(e) => {
              setFilterQuery(e.target.value)
            }}
            placeholder="Filter changed files..."
            className="w-full rounded-(--radius-md) border border-(--color-border) bg-(--color-surface-inset) px-2.5 py-1 text-(length:--text-xs) text-(--color-text) placeholder:text-(--color-text-subtle) focus:border-(--color-border-focus) focus:outline-none"
          />
        </div>
      )}

      <div className="flex flex-1 flex-col gap-1 overflow-y-auto p-1">
        {filteredFiles.length === 0 ? (
          <div className="p-4 text-center text-(--color-text-muted)">
            {filterQuery ? 'No matching changed files' : 'No changed files'}
          </div>
        ) : (
          filteredFiles.map((file) => {
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
                  'group flex items-center justify-between gap-2 rounded-(--radius-md) px-2.5 py-1.5 text-left transition-colors',
                  isSelected
                    ? 'bg-(--color-surface-selected,rgba(77,141,255,0.15)) text-(--color-text) font-medium ring-1 ring-(--color-border-focus)'
                    : 'text-(--color-text-muted) hover:bg-(--color-surface-raised) hover:text-(--color-text)',
                )}
              >
                <div className="flex min-w-0 items-center gap-2">
                  <Badge
                    tone={statusTone}
                    size="sm"
                    className="font-mono text-[9px] px-1 py-0 h-4 min-w-4 flex items-center justify-center"
                  >
                    {statusLetter}
                  </Badge>
                  <FileIcon fileName={file.path} />
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

                <div className="flex shrink-0 items-center gap-1 font-mono text-[10px]">
                  {file.insertions > 0 && (
                    <span className="text-(--color-success)">+{file.insertions}</span>
                  )}
                  {file.deletions > 0 && (
                    <span className="text-(--color-danger)">-{file.deletions}</span>
                  )}
                </div>
              </button>
            )
          })
        )}
      </div>
    </div>
  )
}
