import { useState } from 'react'
import type { ToolCallEntry } from '@shared/domain'
import type { ArtifactMetadataView, ChangeSetView } from '@shared/ipc'
import { agentSessionKey } from '@shared/domain'
import {
  AgentTerminal,
  Badge,
  Button,
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
  DiffViewer,
  Icon,
  MarkdownRenderer,
  RealTerminal,
  Spinner,
  cn,
} from '@renderer/ui'
import { formatDurationMs, type ThreadLogLine } from './threadProjection'

export function InlineReasoningBlock({
  text,
  streaming,
}: {
  readonly text: string
  readonly streaming: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(streaming)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-(--radius-lg) border border-(--color-edge-muted) bg-(--color-surface-inset)">
        <CollapsibleTrigger className="px-3 py-1.5 typography-meta text-(--color-text-muted) hover:text-(--color-text)">
          <span className="flex items-center gap-2">
            <Icon
              name="sparkles"
              className={cn(
                'size-3.5 text-(--color-text-muted)',
                streaming && 'animate-pulse text-(--color-accent)',
              )}
            />
            <span className="font-medium">
              {streaming ? 'Streaming activity & reasoning' : 'Execution transcript'}
            </span>
          </span>
          <span className="ml-auto flex items-center gap-2 font-mono typography-micro text-(--color-text-subtle)">
            <span>{String(text.length)} chars</span>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} className="size-3.5" />
          </span>
        </CollapsibleTrigger>
        <CollapsibleContent className="border-t border-(--color-edge-muted) px-3 py-2">
          <div
            className="max-h-72 overflow-y-auto typography-meta text-(--color-text)"
            data-selectable
          >
            <MarkdownRenderer content={text} />
          </div>
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export function InlineToolStreamBlock({
  tools,
  isRunning,
}: {
  readonly tools: readonly ToolCallEntry[]
  readonly isRunning: boolean
}): React.JSX.Element {
  const [open, setOpen] = useState(isRunning || tools.length <= 4)
  const [expandedToolId, setExpandedToolId] = useState<string | null>(null)

  const runningCount = tools.filter((tool) => tool.status === 'running').length
  const failedCount = tools.filter((tool) => tool.status === 'failed').length

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-(--radius-lg) border border-(--color-edge) bg-(--color-surface-inset)">
        <CollapsibleTrigger className="px-3 py-1.5 typography-meta text-(--color-text-muted) hover:text-(--color-text)">
          <span className="flex items-center gap-2">
            <Icon name="tool" className="size-3.5 text-(--color-accent)" />
            <span className="font-medium text-(--color-text)">Tool calls</span>
            <Badge tone="neutral" size="sm" className="font-mono">
              {String(tools.length)}
            </Badge>
            {runningCount > 0 ? (
              <Badge tone="accent" size="sm">
                {String(runningCount)} running
              </Badge>
            ) : null}
            {failedCount > 0 ? (
              <Badge tone="danger" size="sm">
                {String(failedCount)} failed
              </Badge>
            ) : null}
          </span>

          <span className="ml-auto flex items-center gap-2">
            {/* Axiom A3 demarcation: tool calls are claims, not verified physical proof */}
            <Badge tone="warning" size="sm" className="hidden sm:inline-flex">
              Agent Claim
            </Badge>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} className="size-3.5" />
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent className="border-t border-(--color-edge-muted) divide-y divide-(--color-edge-muted)">
          {tools.map((tool) => {
            const duration = formatDurationMs(tool.startedAt, tool.finishedAt)
            const hasDetail = tool.detail.length > 0 && tool.detail !== tool.target
            const isExpanded = expandedToolId === tool.id

            return (
              <div key={tool.id} className="px-3 py-1.5">
                <div className="flex items-center justify-between gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      if (!hasDetail) return
                      setExpandedToolId((cur) => (cur === tool.id ? null : tool.id))
                    }}
                    className={cn(
                      'flex min-w-0 flex-1 items-center gap-2 text-left',
                      hasDetail && 'cursor-pointer',
                    )}
                  >
                    {tool.status === 'running' ? (
                      <Spinner size="sm" className="shrink-0" />
                    ) : tool.status === 'failed' ? (
                      <Icon name="status-fail" className="size-3.5 text-(--color-danger)" />
                    ) : (
                      <Icon name="status-pass" className="size-3.5 text-(--color-success)" />
                    )}
                    <Badge tone="neutral" size="sm" className="font-mono">
                      {tool.name}
                    </Badge>
                    <span className="truncate font-mono typography-micro text-(--color-text)">
                      {tool.target || tool.name}
                    </span>
                  </button>

                  <div className="flex shrink-0 items-center gap-2">
                    {duration !== null ? (
                      <span className="font-mono typography-micro text-(--color-text-subtle)">
                        {duration}
                      </span>
                    ) : null}
                    {hasDetail ? (
                      <Icon
                        name={isExpanded ? 'chevron-down' : 'chevron-right'}
                        className="size-3 text-(--color-text-subtle)"
                      />
                    ) : null}
                  </div>
                </div>

                {hasDetail && isExpanded ? (
                  <pre
                    className="mt-1.5 max-h-48 overflow-auto rounded-(--radius-md) border border-(--color-edge-muted) bg-(--color-surface) p-2 font-mono typography-micro text-(--color-text-muted)"
                    data-selectable
                  >
                    {tool.detail}
                  </pre>
                ) : null}
              </div>
            )
          })}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export function InlineArtifactChips({
  artifacts,
  onOpenArtifact,
}: {
  readonly artifacts: readonly ArtifactMetadataView[]
  readonly onOpenArtifact: (artifact: ArtifactMetadataView) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {artifacts.map((artifact) => (
        <Button
          key={artifact.id}
          variant="outline"
          size="xs"
          onClick={() => {
            onOpenArtifact(artifact)
          }}
          className="gap-1.5 border-(--color-edge) bg-(--color-surface) text-(--color-text)"
        >
          <Icon name="plan" className="size-3 text-(--color-accent)" />
          <span className="font-mono">{artifact.name}</span>
          <Badge tone="neutral" size="sm" className="px-1 py-0 typography-micro">
            {artifact.kind}
          </Badge>
        </Button>
      ))}
    </div>
  )
}

export function InlineDiffPreviewBlock({
  changeSet,
}: {
  readonly changeSet: ChangeSetView
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const [selectedFile, setSelectedFile] = useState<string>(
    changeSet.files[0]?.path ?? 'changeset.patch',
  )

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-(--radius-lg) border border-(--color-edge) bg-(--color-surface-inset)">
        <CollapsibleTrigger className="px-3 py-1.5 typography-meta text-(--color-text-muted) hover:text-(--color-text)">
          <span className="flex items-center gap-2">
            <Icon name="diff" className="size-3.5 text-(--color-info)" />
            <span className="font-medium text-(--color-text)">Captured repository changes</span>
            <Badge tone="info" size="sm" className="font-mono">
              {String(changeSet.files.length)} files
            </Badge>
            {changeSet.reviewVerdict !== null ? (
              <Badge tone={changeSet.reviewVerdict === 'pass' ? 'success' : 'warning'} size="sm">
                {changeSet.reviewVerdict}
              </Badge>
            ) : null}
            {changeSet.discrepancies.length > 0 ? (
              <Badge tone="danger" size="sm">
                {String(changeSet.discrepancies.length)} discrepancies
              </Badge>
            ) : null}
          </span>

          <Icon name={open ? 'chevron-down' : 'chevron-right'} className="ml-auto size-3.5" />
        </CollapsibleTrigger>

        <CollapsibleContent className="border-t border-(--color-edge-muted) p-3 space-y-2.5">
          {changeSet.files.length > 0 ? (
            <div className="flex flex-wrap gap-1.5">
              {changeSet.files.map((file) => (
                <Button
                  key={file.path}
                  variant={selectedFile === file.path ? 'secondary' : 'ghost'}
                  size="xs"
                  onClick={() => {
                    setSelectedFile(file.path)
                  }}
                  className="font-mono"
                >
                  <span className="truncate max-w-52">{file.path}</span>
                  <span className="text-(--color-success)">+{String(file.insertions)}</span>
                  <span className="text-(--color-danger)">-{String(file.deletions)}</span>
                </Button>
              ))}
            </div>
          ) : null}

          {changeSet.patch.length > 0 ? (
            <DiffViewer
              filePath={selectedFile}
              patch={changeSet.patch}
              discrepancies={changeSet.discrepancies}
              className="max-h-72"
            />
          ) : (
            <p className="typography-meta text-(--color-text-subtle)">
              Empty diff patch recorded for this change set.
            </p>
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}

export function InlineTerminalDrawer({
  projectId,
  workflowId,
  stepIndex,
  persona,
  runtimeId,
  repositoryPath,
  isRunning,
  logs,
}: {
  readonly projectId: string
  readonly workflowId: string
  readonly stepIndex: number
  readonly persona: string
  readonly runtimeId: string | null
  readonly repositoryPath: string
  readonly isRunning: boolean
  readonly logs: readonly ThreadLogLine[]
}): React.JSX.Element {
  const [open, setOpen] = useState(isRunning)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <div className="rounded-(--radius-lg) border border-(--color-edge) bg-(--color-surface-inset) overflow-hidden">
        <CollapsibleTrigger className="px-3 py-1.5 typography-meta text-(--color-text-muted) hover:text-(--color-text)">
          <span className="flex items-center gap-2">
            <Icon name="terminal" className="size-3.5 text-(--color-accent)" />
            <span className="font-medium text-(--color-text)">
              {isRunning ? `Live Terminal — ${persona}` : `Step Console — ${persona}`}
            </span>
            {runtimeId !== null ? (
              <Badge tone="neutral" size="sm" className="font-mono">
                {runtimeId}
              </Badge>
            ) : null}
          </span>
          <span className="ml-auto flex items-center gap-2 typography-micro text-(--color-text-subtle)">
            <span>{isRunning ? 'Interactive PTY' : `${String(logs.length)} lines`}</span>
            <Icon name={open ? 'chevron-down' : 'chevron-right'} className="size-3.5" />
          </span>
        </CollapsibleTrigger>

        <CollapsibleContent className="border-t border-(--color-edge-muted)">
          {isRunning ? (
            <RealTerminal
              projectId={projectId}
              attachSessionKey={agentSessionKey(workflowId, stepIndex)}
              title={`Live Agent Terminal — ${persona}`}
              personaName={persona}
              runtimeId={runtimeId}
              className="h-64 border-0 rounded-none"
            />
          ) : (
            <AgentTerminal
              logs={logs}
              title={`${persona} Terminal`}
              personaName={persona}
              runtimeId={runtimeId}
              repositoryPath={repositoryPath}
              isRunning={false}
              className="h-56 border-0 rounded-none"
            />
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  )
}
