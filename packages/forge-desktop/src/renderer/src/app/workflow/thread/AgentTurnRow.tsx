import type { ArtifactMetadataView, WorkflowStepView } from '@shared/ipc'
import { AlertBanner, Badge, Button, Card, Icon, MarkdownRenderer, Spinner, cn } from '@renderer/ui'
import { formatDurationMs, type ThreadEntry } from './threadProjection'
import {
  InlineArtifactChips,
  InlineDiffPreviewBlock,
  InlineReasoningBlock,
  InlineTerminalDrawer,
  InlineToolStreamBlock,
} from './ThreadExecutionBlocks'

type AgentTurnEntry = Extract<ThreadEntry, { readonly kind: 'agent_turn' }>

export interface AgentTurnRowProps {
  readonly entry: AgentTurnEntry
  readonly projectId: string
  readonly workflowId: string
  readonly repositoryPath: string
  readonly onInspectStep: (step: WorkflowStepView) => void
  readonly onOpenArtifact: (artifact: ArtifactMetadataView) => void
}

function stepStatusTone(
  state: string,
): 'neutral' | 'accent' | 'info' | 'warning' | 'success' | 'danger' {
  switch (state) {
    case 'running':
      return 'accent'
    case 'completed':
      return 'success'
    case 'awaiting_user':
      return 'warning'
    case 'failed':
    case 'halted':
      return 'danger'
    default:
      return 'neutral'
  }
}

/**
 * Renders one chronological stage/agent turn inside the execution thread,
 * embedding streamed prose/reasoning, tool call accordions, artifacts, diffs,
 * and an expandable PTY/console drawer cleanly in one block.
 */
export function AgentTurnRow({
  entry,
  projectId,
  workflowId,
  repositoryPath,
  onInspectStep,
  onOpenArtifact,
}: AgentTurnRowProps): React.JSX.Element {
  const {
    step,
    persona,
    stageLabel,
    badgeClass,
    streamedText,
    usage,
    errors,
    tools,
    artifacts,
    changeSet,
    logs,
    isRunning,
  } = entry

  const duration = formatDurationMs(step.startedAt, step.finishedAt)
  const tokenStatsLabel =
    usage === null
      ? null
      : [
          usage.inputTokens !== null || usage.outputTokens !== null
            ? `${String(usage.inputTokens ?? 0)}→${String(usage.outputTokens ?? 0)} tok`
            : null,
          usage.costUsd !== null ? `$${usage.costUsd.toFixed(4)}` : null,
        ]
          .filter((part): part is string => part !== null)
          .join(' • ') || null

  return (
    <Card
      tone={isRunning ? 'raised' : 'default'}
      className={cn(
        'flex flex-col gap-3 p-4 transition-colors duration-(--duration-fast)',
        isRunning && 'border-(--color-accent)/45',
      )}
    >
      {/* Turn Header */}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span
            className={cn(
              'inline-flex items-center gap-1.5 rounded-(--radius-md) px-2 py-0.5 typography-meta font-semibold',
              badgeClass,
            )}
          >
            <Icon name="subagent" className="size-3.5" />
            <span>{persona}</span>
          </span>

          <span className="typography-meta text-(--color-text-muted)">
            Stage {String(step.index + 1)} • {stageLabel}
          </span>

          <Badge tone={stepStatusTone(step.state)} size="sm" className="gap-1">
            {isRunning ? <Spinner size="sm" /> : null}
            <span>{step.state}</span>
          </Badge>

          {step.runtimeId !== null ? (
            <Badge tone="neutral" size="sm" className="font-mono">
              {step.runtimeId}
            </Badge>
          ) : null}

          {step.simulated === true ? (
            <Badge tone="warning" size="sm">
              Simulated (#101)
            </Badge>
          ) : null}

          {step.verdict !== null ? (
            <Badge
              tone={
                step.verdict === 'pass' ? 'success' : step.verdict === 'fail' ? 'danger' : 'neutral'
              }
              size="sm"
            >
              verdict: {step.verdict}
            </Badge>
          ) : null}
        </div>

        <div className="flex items-center gap-2">
          {duration !== null ? (
            <span className="inline-flex items-center gap-1 font-mono typography-micro text-(--color-text-subtle)">
              <Icon name="clock" className="size-3" />
              {duration}
            </span>
          ) : null}

          {tokenStatsLabel !== null ? (
            <span className="font-mono typography-micro text-(--color-text-subtle)">
              {tokenStatsLabel}
            </span>
          ) : null}

          <Button
            variant="ghost"
            size="xs"
            onClick={() => {
              onInspectStep(step)
            }}
          >
            Inspect
          </Button>
        </div>
      </div>

      {/* Primary Agent Report / Blueprint Output */}
      {step.reportStatus !== null && step.reportStatus.trim().length > 0 ? (
        <div
          className="rounded-(--radius-lg) border border-(--color-edge-muted) bg-(--color-surface-inset)/55 px-3.5 py-2.5 text-(--color-text)"
          data-selectable
        >
          <MarkdownRenderer content={step.reportStatus} />
        </div>
      ) : null}

      {/* Streamed Prose / Reasoning Trace */}
      {streamedText.trim().length > 0 ? (
        <InlineReasoningBlock text={streamedText} streaming={isRunning} />
      ) : null}

      {/* Runtime Errors */}
      {errors.map((errMsg, idx) => (
        <AlertBanner
          key={`${step.id}-err-${String(idx)}`}
          tone="danger"
          title="Runtime error reported"
          description={errMsg}
        />
      ))}

      {/* Inline Tool Stream */}
      {tools.length > 0 ? <InlineToolStreamBlock tools={tools} isRunning={isRunning} /> : null}

      {/* Artifacts Produced (planning.md, specs, reports) */}
      {artifacts.length > 0 ? (
        <InlineArtifactChips artifacts={artifacts} onOpenArtifact={onOpenArtifact} />
      ) : null}

      {/* Diff / ChangeSet Preview */}
      {changeSet !== null ? <InlineDiffPreviewBlock changeSet={changeSet} /> : null}

      {/* Inline Interactive Terminal / Console Drawer */}
      {isRunning || logs.length > 0 ? (
        <InlineTerminalDrawer
          projectId={projectId}
          workflowId={workflowId}
          stepIndex={step.index}
          persona={persona}
          runtimeId={step.runtimeId}
          repositoryPath={repositoryPath}
          isRunning={isRunning}
          logs={logs}
        />
      ) : null}
    </Card>
  )
}
