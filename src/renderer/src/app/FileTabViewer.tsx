import React, { useEffect, useState } from 'react'
import { CodeViewer } from '../ui/primitives/CodeViewer'
import { useProjectStore } from './projectStore'
import { unwrap } from '../ipc'
import type { WorkspaceTab } from './overviewStore'
import { CheckIcon, ChevronRightIcon, CodeFileIcon, CopyIcon, DocumentIcon } from './icons'

export interface FileTabViewerProps {
  readonly tab: WorkspaceTab
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

export function FileTabViewer({ tab }: FileTabViewerProps): React.JSX.Element {
  const selectedProjectId = useProjectStore((state) => state.selectedProjectId)
  const detail = useProjectStore((state) => state.detail)

  const [content, setContent] = useState<string>(tab.content ?? '')
  const [patch, setPatch] = useState<string>('')
  const [loading, setLoading] = useState<boolean>(false)
  const [copied, setCopied] = useState<boolean>(false)

  // Relative file path from repo root
  const rawPath = tab.filePath ?? tab.title
  const cleanPath = rawPath.replace(/\\/g, '/').replace(/^\//, '')
  const pathSegments = cleanPath.split('/')
  const fileName = pathSegments.pop() ?? tab.title

  const projectName = detail?.project.name ?? 'Forge'

  useEffect(() => {
    let cancelled = false
    if (selectedProjectId === null) return

    window.forge.git
      .readFile(selectedProjectId, cleanPath)
      .then((res) => {
        if (!cancelled) {
          setContent(unwrap(res).content)
          setLoading(false)
        }
      })
      .catch(() => {
        if (!cancelled) {
          if (!tab.content) {
            setContent('// File content unavailable or newly created.')
          }
          setLoading(false)
        }
      })

    // Load working tree diff
    window.forge.git
      .getWorkingDiff(selectedProjectId)
      .then((res) => {
        if (!cancelled) {
          const diff = unwrap(res)
          const filePatch = extractFilePatch(diff.patch, cleanPath)
          setPatch(filePatch)
        }
      })
      .catch(() => {
        // ignore diff error
      })

    return () => {
      cancelled = true
    }
  }, [selectedProjectId, cleanPath, tab.content])

  const handleCopyPath = () => {
    navigator.clipboard
      .writeText(cleanPath)
      .then(() => {
        setCopied(true)
        setTimeout(() => {
          setCopied(false)
        }, 1500)
      })
      .catch(() => {
        // ignore
      })
  }

  const renderBadge = () => {
    const lower = fileName.toLowerCase()
    if (lower.endsWith('.md') || lower.endsWith('.txt')) {
      return <DocumentIcon className="size-3.5 text-(--color-text-muted) shrink-0" />
    }
    return <CodeFileIcon className="size-3.5 text-(--color-text-muted) shrink-0" />
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-(--color-canvas)">
      {/* ── Breadcrumb & Action Bar (Matching Antigravity Image 4) ── */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-(--color-border) bg-(--color-surface-raised)/30 px-4 select-none text-[12px]">
        {/* Breadcrumb Navigation */}
        <div className="flex items-center gap-1.5 min-w-0 overflow-x-auto no-scrollbar font-mono text-[11.5px] text-(--color-text-muted)">
          <span className="font-semibold text-(--color-text)">{projectName}</span>
          {pathSegments.map((segment, idx) => (
            <React.Fragment key={`${segment}-${String(idx)}`}>
              <ChevronRightIcon className="size-2.5 text-(--color-text-subtle)" />
              <span className="hover:text-(--color-text) cursor-default">{segment}</span>
            </React.Fragment>
          ))}
          <ChevronRightIcon className="size-2.5 text-(--color-text-subtle)" />
          <div className="flex items-center gap-1.5 font-semibold text-(--color-text) shrink-0">
            {renderBadge()}
            <span>{fileName}</span>
          </div>

          {tab.subtitle && (
            <span className="ml-1 rounded bg-(--color-surface-inset) px-1.5 py-0.2 text-[10px] text-(--color-text-subtle) font-sans">
              {tab.subtitle}
            </span>
          )}
        </div>

        {/* Right Tools: Copy Path / Content */}
        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            title="Copy relative path"
            onClick={handleCopyPath}
            className="flex items-center gap-1.5 rounded px-2 py-1 text-[11px] text-(--color-text-muted) hover:bg-(--color-surface-inset) hover:text-(--color-text) transition-colors cursor-pointer"
          >
            {copied ? (
              <CheckIcon className="size-3 text-emerald-400" />
            ) : (
              <CopyIcon className="size-3" />
            )}
            <span>{copied ? 'Copied' : 'Copy Path'}</span>
          </button>
        </div>
      </div>

      {/* ── Code / Diff Viewer Body ── */}
      <div className="flex-1 overflow-hidden">
        {loading && !content ? (
          <div className="flex h-full items-center justify-center text-[12px] text-(--color-text-muted)">
            <span className="animate-spin mr-2">↻</span> Loading {fileName}...
          </div>
        ) : (
          <CodeViewer
            filePath={cleanPath}
            content={content}
            patch={patch}
            defaultMode={patch ? 'diff' : 'code'}
            className="h-full"
          />
        )}
      </div>
    </div>
  )
}
