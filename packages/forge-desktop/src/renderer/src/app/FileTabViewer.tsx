import React, { useEffect, useState } from 'react'
import { Badge, Button, CodeViewer, Icon, Spinner } from '../ui'
import { useProjectStore } from './projectStore'
import { unwrap } from '../ipc'
import type { WorkspaceTab } from './overviewStore'

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
      return <Icon name="file" className="size-3.5 shrink-0 text-(--color-text-muted)" />
    }
    return <Icon name="file-code" className="size-3.5 shrink-0 text-(--color-text-muted)" />
  }

  return (
    <div className="flex h-full flex-col overflow-hidden bg-(--color-canvas)">
      {/* ── Breadcrumb & Action Bar ── */}
      <div className="flex h-10 shrink-0 items-center justify-between border-b border-(--color-border) bg-(--color-surface-raised)/30 px-4 select-none typography-ui-label">
        {/* Breadcrumb Navigation */}
        <div className="no-scrollbar flex min-w-0 items-center gap-1.5 overflow-x-auto font-mono typography-micro text-(--color-text-muted)">
          <span className="font-semibold text-(--color-text)">{projectName}</span>
          {pathSegments.map((segment, idx) => (
            <React.Fragment key={`${segment}-${String(idx)}`}>
              <Icon name="chevron-right" className="size-3 text-(--color-text-subtle)" />
              <span className="cursor-default hover:text-(--color-text)">{segment}</span>
            </React.Fragment>
          ))}
          <Icon name="chevron-right" className="size-3 text-(--color-text-subtle)" />
          <div className="flex shrink-0 items-center gap-1.5 font-semibold text-(--color-text)">
            {renderBadge()}
            <span>{fileName}</span>
          </div>

          {tab.subtitle && (
            <Badge tone="neutral" size="sm" className="ml-1 font-sans">
              {tab.subtitle}
            </Badge>
          )}
        </div>

        {/* Right Tools: Copy Path / Content */}
        <div className="flex shrink-0 items-center gap-2">
          <Button size="xs" variant="ghost" title="Copy relative path" onClick={handleCopyPath}>
            {copied ? (
              <Icon name="check" className="size-3 text-(--color-success)" />
            ) : (
              <Icon name="copy" className="size-3" />
            )}
            <span>{copied ? 'Copied' : 'Copy Path'}</span>
          </Button>
        </div>
      </div>

      {/* ── Code / Diff Viewer Body ── */}
      <div className="flex-1 overflow-hidden">
        {loading && !content ? (
          <div className="flex h-full items-center justify-center">
            <Spinner label={`Loading ${fileName}...`} />
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
